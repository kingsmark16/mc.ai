import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Document } from '@langchain/core/documents';
import {
  AstraDBVectorStore,
  type AstraLibArgs,
} from '@langchain/community/vectorstores/astradb';
import { DataAPIClient } from '@datastax/astra-db-ts';
import { EmbeddingService } from '../ai/embedding.service.js';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

export type StoredDocument = {
  content: string;
  metadata: Record<string, any>;
};

// Astra serverless databases can pause after a period of inactivity. The
// first request after that pause may need several attempts while the database
// resumes. Keep the retry policy here for connection checks and short database
// operations. Long document indexing intentionally does not use the short
// wake-up timeout because embedding and inserting a large file can take much
// longer than the database's resume request.
const astraRetryDelaysMs = [1_000, 3_000, 6_000, 10_000] as const;
const astraOperationTimeoutMs = 10_000;
// Gemini's batch endpoint accepts up to 100 inputs. Using the full bounded
// batch keeps long documents within the provider's request quota while the
// embedding service still serializes requests and retries temporary limits.
const embeddingBatchSize = 100;

@Injectable()
export class VectorStoreService {
  private readonly logger = new Logger(VectorStoreService.name);
  private vectorStorePromise?: Promise<AstraDBVectorStore>;
  private readonly splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1_500,
    chunkOverlap: 225,
  });

  constructor(
    private readonly configService: ConfigService,
    private readonly embeddingService: EmbeddingService,
  ) {}

  private getVectorStore(): Promise<AstraDBVectorStore> {
    if (!this.vectorStorePromise) {
      const astraConfig: AstraLibArgs = {
        token: this.configService.getOrThrow<string>(
          'ASTRA_DB_APPLICATION_TOKEN',
        ),
        endpoint: this.configService.getOrThrow<string>(
          'ASTRA_DB_API_ENDPOINT',
        ),
        keyspace: this.configService.getOrThrow<string>('ASTRA_DB_KEYSPACE'),
        collection: this.configService.getOrThrow<string>(
          'ASTRA_DB_COLLECTION',
        ),
        collectionOptions: {
          vector: {
            dimension: 3072,
            metric: 'cosine',
          },
          indexing: {
            allow: ['source', 'ownerId'],
          },
        },
      };

      this.vectorStorePromise = this.withAstraRetry(() =>
        AstraDBVectorStore.fromExistingIndex(
          this.embeddingService.getEmbeddings(),
          astraConfig,
        ),
      ).catch((error: unknown) => {
        this.vectorStorePromise = undefined;
        throw error;
      });
    }

    return this.vectorStorePromise;
  }

  private getAstraCollection() {
    const client = new DataAPIClient(
      this.configService.getOrThrow<string>('ASTRA_DB_APPLICATION_TOKEN'),
    );

    const database = client.db(
      this.configService.getOrThrow<string>('ASTRA_DB_API_ENDPOINT'),
      {
        keyspace: this.configService.getOrThrow<string>('ASTRA_DB_KEYSPACE'),
      },
    );

    return database.collection<{
      _id?: string;
      ownerId?: string;
      text?: string;
      source?: string;
      loc?: Record<string, unknown>;
    }>(this.configService.getOrThrow<string>('ASTRA_DB_COLLECTION'));
  }

  private async withAstraRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= astraRetryDelaysMs.length; attempt += 1) {
      try {
        return await this.withAstraTimeout(operation);
      } catch (error) {
        lastError = error;

        if (
          !this.isAstraResumingError(error) ||
          attempt === astraRetryDelaysMs.length
        ) {
          break;
        }

        await new Promise<void>((resolve) => {
          setTimeout(resolve, astraRetryDelaysMs[attempt]);
        });
      }
    }

    if (this.isAstraResumingError(lastError)) {
      throw new ServiceUnavailableException(
        'Astra DB is waking up. Please wait a few seconds and try again.',
      );
    }

    throw lastError;
  }

  private async withAstraTimeout<T>(operation: () => Promise<T>): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        operation(),
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => {
            const timeoutError = new Error(
              'Astra DB did not respond while waking up.',
            ) as Error & { status: number };
            timeoutError.status = 503;
            reject(timeoutError);
          }, astraOperationTimeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private isAstraResumingError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const candidate = error as {
      status?: unknown;
      message?: unknown;
      body?: unknown;
      raw?: {
        status?: unknown;
        body?: unknown;
      };
    };
    const details = [candidate.message, candidate.body, candidate.raw?.body]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');

    return (
      candidate.status === 503 ||
      candidate.raw?.status === 503 ||
      /resum(?:e|ing)/i.test(details)
    );
  }

  async addDocuments(documents: Document[], ownerId: string): Promise<number> {
    const vectorStore = await this.getVectorStore();

    const ownerScopedDocuments = documents.map(
      (document) =>
        new Document({
          pageContent: document.pageContent,
          metadata: {
            ...document.metadata,
            ownerId,
          },
        }),
    );
    const chunks = await this.splitter.splitDocuments(ownerScopedDocuments);

    for (let offset = 0; offset < chunks.length; offset += embeddingBatchSize) {
      const batch = chunks.slice(offset, offset + embeddingBatchSize);
      const vectors = await this.embeddingService.embedDocuments(
        batch.map((document) => document.pageContent),
      );

      if (
        vectors.length !== batch.length ||
        vectors.some((vector) => vector.length === 0)
      ) {
        throw new ServiceUnavailableException(
          'Document indexing is temporarily unavailable because embeddings could not be generated. Please try again in a moment.',
        );
      }

      // Keep each database write bounded as well. In particular, do not wrap
      // the whole file in the 10-second Astra wake-up timeout above: a large
      // document is expected to take longer while these batches are processed.
      try {
        await vectorStore.addVectors(vectors, batch);
      } catch (error) {
        this.logger.warn(
          `Could not index document batch ${offset + 1}-${offset + batch.length}.`,
        );
        throw error;
      }
    }

    return chunks.length;
  }

  async checkConnection(): Promise<void> {
    await this.getVectorStore();
  }

  async addText(
    text: string,
    source: string,
    ownerId: string,
  ): Promise<number> {
    const documents = [
      new Document({
        pageContent: text,
        metadata: {
          source,
        },
      }),
    ];

    return this.addDocuments(documents, ownerId);
  }

  async listSources(ownerId: string): Promise<string[]> {
    await this.getVectorStore();

    const collection = this.getAstraCollection();
    const documents = await this.withAstraRetry(() =>
      collection.find({ ownerId }, { projection: { source: 1 } }).toArray(),
    );

    return [
      ...new Set(
        documents
          .map((document) => document.source)
          .filter((source): source is string => Boolean(source)),
      ),
    ].sort((first, second) => first.localeCompare(second));
  }

  async hasSource(source: string, ownerId: string): Promise<boolean> {
    const sources = await this.listSources(ownerId);

    return sources.includes(source);
  }

  async deleteBySource(source: string, ownerId: string): Promise<number> {
    await this.getVectorStore();

    const collection = this.getAstraCollection();
    const result = await this.withAstraRetry(() =>
      collection.deleteMany({ source, ownerId }),
    );

    return result.deletedCount;
  }

  async deleteByOwner(ownerId: string): Promise<number> {
    await this.getVectorStore();

    const collection = this.getAstraCollection();
    const result = await this.withAstraRetry(() =>
      collection.deleteMany({ ownerId }),
    );

    return result.deletedCount;
  }

  async getDocumentsBySource(
    source: string,
    ownerId: string,
  ): Promise<StoredDocument[]> {
    return this.getDocumentsBySources([source], ownerId);
  }

  async getDocumentsBySources(
    sources: string[],
    ownerId: string,
  ): Promise<StoredDocument[]> {
    await this.getVectorStore();

    const normalizedSources = [
      ...new Set(sources.map((source) => source.trim()).filter(Boolean)),
    ];

    if (normalizedSources.length === 0) {
      return [];
    }

    const collection = this.getAstraCollection();
    const sourceFilter =
      normalizedSources.length === 1
        ? normalizedSources[0]
        : { $in: normalizedSources };
    const documents = await this.withAstraRetry(() =>
      collection
        .find(
          { source: sourceFilter, ownerId },
          {
            projection: {
              text: 1,
              source: 1,
              loc: 1,
            },
          },
        )
        .toArray(),
    );

    const storedDocuments = documents.flatMap((document) => {
      if (typeof document.text !== 'string' || !document.text.trim()) {
        return [];
      }

      return [
        {
          content: document.text,
          metadata: {
            source: document.source ?? normalizedSources[0],
            ...(document.loc ? { loc: document.loc } : {}),
          },
        },
      ];
    });

    return storedDocuments.sort((first, second) => {
      const firstPage = first.metadata.loc?.pageNumber;
      const secondPage = second.metadata.loc?.pageNumber;

      if (typeof firstPage !== 'number' || typeof secondPage !== 'number') {
        return 0;
      }

      return firstPage - secondPage;
    });
  }

  async search(
    query: string,
    ownerId: string,
    limit = 3,
    minScore = 0.6,
    source?: string | string[],
  ) {
    const vectorStore = await this.getVectorStore();

    const sources = Array.isArray(source)
      ? [...new Set(source.map((item) => item.trim()).filter(Boolean))]
      : source?.trim()
        ? [source.trim()]
        : [];
    const sourceFilter = sources.length === 1 ? sources[0] : { $in: sources };
    const filter = sources.length
      ? { ownerId, source: sourceFilter }
      : { ownerId };
    const results = await this.withAstraRetry(() =>
      vectorStore.similaritySearchWithScore(query, limit, filter),
    );

    return results
      .filter(([, score]) => score >= minScore)
      .map(([document, score]) => {
        const metadata = { ...document.metadata };
        delete metadata.ownerId;

        return {
          score,
          content: document.pageContent,
          metadata,
        };
      });
  }
}
