import {
  GoogleGenerativeAI,
  type GenerativeModel,
} from '@google/generative-ai';
import {
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { ConfigService } from '@nestjs/config';

const embeddingBatchSize = 100;
const embeddingRetryDelaysMs = [2_000, 5_000, 10_000] as const;
const minimumEmbeddingRequestIntervalMs = 750;

type EmbeddingError = {
  message?: unknown;
  status?: unknown;
  response?: {
    status?: unknown;
    headers?: {
      get?: (name: string) => string | null;
      [key: string]: unknown;
    };
  };
};

function getEmbeddingErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const message = (error as EmbeddingError).message;

    if (typeof message === 'string') {
      return message;
    }
  }

  return error instanceof Error ? error.message : String(error);
}

function getEmbeddingErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const candidate = error as EmbeddingError;
  const status = candidate.status ?? candidate.response?.status;

  return typeof status === 'number' ? status : undefined;
}

function getRetryAfterMs(error: unknown, fallbackMs: number): number {
  const message = getEmbeddingErrorMessage(error);
  const messageDelay = message.match(/retry(?: in| after)\s+(\d+(?:\.\d+)?)\s*s/i);

  if (messageDelay) {
    return Math.min(
      Math.max(Math.ceil(Number(messageDelay[1]) * 1_000), 1_000),
      60_000,
    );
  }

  if (error && typeof error === 'object') {
    const headers = (error as EmbeddingError).response?.headers;
    const retryAfter = headers?.get?.('retry-after') ?? headers?.['retry-after'];

    if (typeof retryAfter === 'string') {
      const seconds = Number(retryAfter);

      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.min(Math.ceil(seconds * 1_000), 60_000);
      }
    }
  }

  return fallbackMs;
}

function isRetryableEmbeddingError(error: unknown): boolean {
  const status = getEmbeddingErrorStatus(error);
  const message = getEmbeddingErrorMessage(error);

  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    /quota|rate limit|temporarily unavailable|overloaded|timed out|timeout/i.test(
      message,
    )
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

@Injectable()
export class EmbeddingService {
  private readonly model: GenerativeModel;
  private embeddingQueue: Promise<void> = Promise.resolve();
  private lastEmbeddingRequestStartedAt = 0;

  constructor(configService: ConfigService) {
    const apiKey = configService.getOrThrow<string>('GOOGLE_API_KEY');
    const modelName =
      configService.get<string>('GOOGLE_EMBEDDING_MODEL') ??
      'gemini-embedding-001';

    this.model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: modelName,
    });
  }

  async embedQuery(text: string): Promise<number[]> {
    const response = await this.runWithRetry(() =>
      this.model.embedContent({
        content: {
          role: 'user',
          parts: [{ text: this.normalizeText(text) }],
        },
      }),
    );

    return response.embedding.values ?? [];
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];

    for (let offset = 0; offset < texts.length; offset += embeddingBatchSize) {
      const batch = texts.slice(offset, offset + embeddingBatchSize);
      const response = await this.runWithRetry(async () => {
        const result = await this.model.batchEmbedContents({
          requests: batch.map((text) => ({
            content: {
              role: 'user',
              parts: [{ text: this.normalizeText(text) }],
            },
          })),
        });
        const batchVectors = result.embeddings?.map(
          (embedding) => embedding.values ?? [],
        );

        if (
          !batchVectors ||
          batchVectors.length !== batch.length ||
          batchVectors.some((vector) => vector.length === 0)
        ) {
          throw new ServiceUnavailableException(
            'The embedding service returned an incomplete batch.',
          );
        }

        return batchVectors;
      });

      vectors.push(...response);
    }

    return vectors;
  }

  getEmbeddings(): EmbeddingsInterface {
    return this;
  }

  private normalizeText(text: string): string {
    return text.replace(/\n/g, ' ');
  }

  private async runWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (
      let attempt = 0;
      attempt <= embeddingRetryDelaysMs.length;
      attempt += 1
    ) {
      try {
        return await this.enqueueEmbeddingRequest(operation);
      } catch (error) {
        lastError = error;
        const errorMessage = getEmbeddingErrorMessage(error);
        const isRateLimited =
          getEmbeddingErrorStatus(error) === 429 ||
          /quota|rate limit/i.test(errorMessage);

        if (
          !isRetryableEmbeddingError(error) ||
          attempt === embeddingRetryDelaysMs.length ||
          (isRateLimited && attempt >= 1)
        ) {
          break;
        }

        await wait(
          getRetryAfterMs(
            error,
            embeddingRetryDelaysMs[attempt] ??
              embeddingRetryDelaysMs[embeddingRetryDelaysMs.length - 1],
          ),
        );
      }
    }

    throw this.toUserFacingError(lastError);
  }

  private async enqueueEmbeddingRequest<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previousRequest = this.embeddingQueue;
    let releaseQueue!: () => void;

    this.embeddingQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previousRequest;

    try {
      const elapsed = Date.now() - this.lastEmbeddingRequestStartedAt;

      if (
        this.lastEmbeddingRequestStartedAt > 0 &&
        elapsed < minimumEmbeddingRequestIntervalMs
      ) {
        await wait(minimumEmbeddingRequestIntervalMs - elapsed);
      }

      this.lastEmbeddingRequestStartedAt = Date.now();

      return await operation();
    } finally {
      releaseQueue();
    }
  }

  private toUserFacingError(error: unknown): Error {
    const status = getEmbeddingErrorStatus(error);
    const message = getEmbeddingErrorMessage(error);

    if (status === 429 || /quota|rate limit/i.test(message)) {
      return new HttpException(
        'The document service has reached its temporary embedding limit. Please wait about a minute and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (isRetryableEmbeddingError(error)) {
      return new ServiceUnavailableException(
        'Document indexing is temporarily unavailable. Please wait a moment and try again.',
      );
    }

    return error instanceof Error
      ? error
      : new ServiceUnavailableException(
          'Document indexing could not be completed. Please try again.',
        );
  }
}
