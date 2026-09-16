import { Injectable } from '@nestjs/common';
import { AiService } from './ai/ai.service.js';
import type { ChatHistoryMessage } from './ai/ai.service.js';
import {
  VectorStoreService,
  type StoredDocument,
} from './vector-store/vector-store.service.js';

const retrievalSettings = {
  allDocuments: {
    limit: 12,
    minScore: 0.45,
  },
  selectedDocument: {
    limit: 16,
    minScore: 0.25,
  },
} as const;

export type RagSourceScope = string | string[] | undefined;

export type RagSource = {
  score?: number;
  content: string;
  metadata: Record<string, any>;
};

export type RagStreamEvent =
  | { type: 'token'; token: string }
  | { type: 'sources'; sources: RagSource[] }
  | { type: 'error'; message: string }
  | { type: 'done' };

@Injectable()
export class RagService {
  constructor(
    private readonly aiService: AiService,
    private readonly vectorStoreService: VectorStoreService,
  ) {}

  async ask(
    question: string,
    ownerId: string,
    source?: RagSourceScope,
    history: ChatHistoryMessage[] = [],
  ) {
    const selectedSources = this.normalizeSources(source);
    const sourceFilter = this.toSourceFilter(selectedSources);

    if (selectedSources.length === 0 && this.isSummaryQuestion(question)) {
      return {
        answer:
          'Please select at least one document before requesting a full summary.',
        sources: [],
      };
    }

    if (selectedSources.length > 0 && this.isSummaryQuestion(question)) {
      const documents =
        selectedSources.length === 1
          ? await this.vectorStoreService.getDocumentsBySource(
              selectedSources[0],
              ownerId,
            )
          : await this.vectorStoreService.getDocumentsBySources(
              selectedSources,
              ownerId,
            );

      if (documents.length === 0) {
        return {
          answer: 'I do not have any relevant documents.',
          sources: [],
        };
      }

      const answer = await this.aiService.summarizeDocuments(documents);

      return {
        answer,
        sources: this.buildSummarySources(documents, selectedSources),
      };
    }

    if (selectedSources.length > 1) {
      const documents = await this.vectorStoreService.getDocumentsBySources(
        selectedSources,
        ownerId,
      );

      if (documents.length === 0) {
        return {
          answer: 'I do not have any relevant documents.',
          sources: [],
        };
      }

      const answer = await this.aiService.askAcrossDocuments(
        question,
        documents,
        history,
      );

      return {
        answer,
        sources: this.buildSummarySources(documents, selectedSources),
      };
    }

    const retrievalQuery = [
      ...history
        .slice(-4)
        .map((message) => `${message.role}: ${message.content}`),
      `user: ${question}`,
    ].join('\n');

    const retrieval = this.getRetrievalSettings(selectedSources);
    const documents = await this.vectorStoreService.search(
      retrievalQuery,
      ownerId,
      retrieval.limit,
      retrieval.minScore,
      sourceFilter,
    );

    if (documents.length === 0) {
      return {
        answer: 'I do not have any relevant documents.',
        sources: [],
      };
    }

    const context = this.buildContext(documents);

    const answer = await this.aiService.askWithContext(
      question,
      context,
      history,
    );

    return {
      answer,
      sources: documents,
    };
  }

  async *streamAsk(
    question: string,
    ownerId: string,
    source?: RagSourceScope,
    history: ChatHistoryMessage[] = [],
    signal?: AbortSignal,
  ): AsyncGenerator<RagStreamEvent> {
    if (signal?.aborted) {
      return;
    }

    const selectedSources = this.normalizeSources(source);
    const sourceFilter = this.toSourceFilter(selectedSources);

    if (selectedSources.length === 0 && this.isSummaryQuestion(question)) {
      yield {
        type: 'token',
        token:
          'Please select at least one document before requesting a full summary.',
      };
      yield { type: 'sources', sources: [] };
      yield { type: 'done' };
      return;
    }

    if (selectedSources.length > 0 && this.isSummaryQuestion(question)) {
      const documents =
        selectedSources.length === 1
          ? await this.vectorStoreService.getDocumentsBySource(
              selectedSources[0],
              ownerId,
            )
          : await this.vectorStoreService.getDocumentsBySources(
              selectedSources,
              ownerId,
            );

      if (signal?.aborted) {
        return;
      }

      if (documents.length === 0) {
        yield {
          type: 'token',
          token: 'I do not have any relevant documents.',
        };
        yield { type: 'sources', sources: [] };
        yield { type: 'done' };
        return;
      }

      for await (const token of this.aiService.streamSummaryDocuments(
        documents,
        signal,
      )) {
        yield { type: 'token', token };
      }

      yield {
        type: 'sources',
        sources: this.buildSummarySources(documents, selectedSources),
      };
      yield { type: 'done' };
      return;
    }

    if (selectedSources.length > 1) {
      const documents = await this.vectorStoreService.getDocumentsBySources(
        selectedSources,
        ownerId,
      );

      if (signal?.aborted) {
        return;
      }

      if (documents.length === 0) {
        yield {
          type: 'token',
          token: 'I do not have any relevant documents.',
        };
        yield { type: 'sources', sources: [] };
        yield { type: 'done' };
        return;
      }

      for await (const token of this.aiService.streamAcrossDocuments(
        question,
        documents,
        history,
        signal,
      )) {
        yield { type: 'token', token };
      }

      yield {
        type: 'sources',
        sources: this.buildSummarySources(documents, selectedSources),
      };
      yield { type: 'done' };
      return;
    }

    const retrievalQuery = [
      ...history
        .slice(-4)
        .map((message) => `${message.role}: ${message.content}`),
      `user: ${question}`,
    ].join('\n');

    const retrieval = this.getRetrievalSettings(selectedSources);
    const documents = await this.vectorStoreService.search(
      retrievalQuery,
      ownerId,
      retrieval.limit,
      retrieval.minScore,
      sourceFilter,
    );

    if (signal?.aborted) {
      return;
    }

    if (documents.length === 0) {
      yield {
        type: 'token',
        token: 'I do not have any relevant documents.',
      };
      yield { type: 'sources', sources: [] };
      yield { type: 'done' };
      return;
    }

    const context = this.buildContext(documents);

    if (signal?.aborted) {
      return;
    }

    for await (const token of this.aiService.streamWithContext(
      question,
      context,
      history,
      signal,
    )) {
      yield { type: 'token', token };
    }

    yield { type: 'sources', sources: documents };
    yield { type: 'done' };
  }

  private isSummaryQuestion(question: string): boolean {
    return (
      /\b(summary|summarize|summarise|overview)\b/i.test(question) ||
      /\bwhat\s+(?:is|does)\s+(?:(?:this|the)\s+)?(?:document|file|report|it)\s+about\s*[?!.]*$/i.test(
        question.trim(),
      ) ||
      /\ball\s+(?:the\s+)?content\b/i.test(question)
    );
  }

  private normalizeSources(source?: RagSourceScope): string[] {
    const sources = Array.isArray(source) ? source : source ? [source] : [];

    return [...new Set(sources.map((item) => item.trim()).filter(Boolean))];
  }

  private toSourceFilter(sources: string[]): string | string[] | undefined {
    if (sources.length === 0) {
      return undefined;
    }

    return sources.length === 1 ? sources[0] : sources;
  }

  private getRetrievalSettings(sources: string[]) {
    if (sources.length === 0) {
      return retrievalSettings.allDocuments;
    }

    return retrievalSettings.selectedDocument;
  }

  private buildContext(
    documents: Array<{
      content: string;
      metadata: Record<string, any>;
    }>,
  ): string {
    return documents
      .map((document, index) => {
        const source = String(document.metadata?.source ?? 'unknown');
        const page = this.getPageNumber(document.metadata);
        const location = page ? `, page ${page}` : '';
        return `Source ${index + 1} (${source}${location}):\n${document.content}`;
      })
      .join('\n\n');
  }

  private buildSummarySources(
    documents: StoredDocument[],
    selectedSources: string[] = [],
  ): RagSource[] {
    const seen = new Set<string>();
    const uniqueSources = documents
      .filter((document, index) => {
        const source = String(document.metadata?.source ?? 'unknown');
        const page = this.getPageNumber(document.metadata);
        const key = page
          ? `${source}:page:${page}`
          : `${source}:chunk:${index}`;

        if (seen.has(key)) {
          return false;
        }

        seen.add(key);
        return true;
      })
      .map(({ content, metadata }) => ({ content, metadata }));

    if (selectedSources.length === 0) {
      return uniqueSources.slice(0, 20);
    }

    const firstEvidenceBySource = new Map<string, RagSource>();

    for (const source of uniqueSources) {
      const filename = String(source.metadata?.source ?? 'unknown');

      if (!firstEvidenceBySource.has(filename)) {
        firstEvidenceBySource.set(filename, source);
      }
    }

    const requiredEvidence = selectedSources.flatMap((source) => {
      const evidence = firstEvidenceBySource.get(source);

      return evidence ? [evidence] : [];
    });
    const requiredEvidenceSet = new Set(requiredEvidence);

    return [
      ...requiredEvidence,
      ...uniqueSources.filter((source) => !requiredEvidenceSet.has(source)),
    ].slice(0, Math.max(20, selectedSources.length));
  }

  private getPageNumber(metadata: Record<string, any>): number | undefined {
    const page = metadata?.loc?.pageNumber;

    return typeof page === 'number' ? page : undefined;
  }
}
