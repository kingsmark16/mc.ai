import { RagService } from './rag.service.js';
import { AiService } from './ai/ai.service.js';
import { VectorStoreService } from './vector-store/vector-store.service.js';

async function* emitTokens(tokens: string[]) {
  for (const token of tokens) {
    yield token;
  }
}

describe('RagService', () => {
  let service: RagService;
  let aiService: {
    askWithContext: ReturnType<typeof vi.fn>;
    askAcrossDocuments: ReturnType<typeof vi.fn>;
    summarizeDocuments: ReturnType<typeof vi.fn>;
    streamWithContext: ReturnType<typeof vi.fn>;
    streamAcrossDocuments: ReturnType<typeof vi.fn>;
    streamSummaryDocuments: ReturnType<typeof vi.fn>;
  };
  let vectorStoreService: {
    search: ReturnType<typeof vi.fn>;
    getDocumentsBySource: ReturnType<typeof vi.fn>;
    getDocumentsBySources: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    aiService = {
      askWithContext: vi.fn(),
      askAcrossDocuments: vi.fn(),
      summarizeDocuments: vi.fn(),
      streamWithContext: vi.fn(),
      streamAcrossDocuments: vi.fn(),
      streamSummaryDocuments: vi.fn(),
    };

    vectorStoreService = {
      search: vi.fn(),
      getDocumentsBySource: vi.fn(),
      getDocumentsBySources: vi.fn(),
    };

    service = new RagService(
      aiService as unknown as AiService,
      vectorStoreService as unknown as VectorStoreService,
    );
  });

  it('returns a fallback when no documents are relevant', async () => {
    vectorStoreService.search.mockResolvedValue([]);

    const result = await service.ask('Unknown question', 'visitor-1');

    expect(result).toEqual({
      answer: 'I do not have any relevant documents.',
      sources: [],
    });
    expect(aiService.askWithContext).not.toHaveBeenCalled();
  });

  it('uses the selected source and conversation history during retrieval', async () => {
    const documents = [
      {
        score: 0.91,
        content: 'React is used for the frontend.',
        metadata: {
          source: 'guide.pdf',
          loc: { pageNumber: 2 },
        },
      },
    ];

    const history = [
      { role: 'user' as const, content: 'What is this system about?' },
      { role: 'assistant' as const, content: 'It is a course system.' },
    ];

    vectorStoreService.search.mockResolvedValue(documents);
    aiService.askWithContext.mockResolvedValue('It uses React.');

    const result = await service.ask(
      'What technology does it use?',
      'visitor-1',
      'guide.pdf',
      history,
    );

    expect(vectorStoreService.search).toHaveBeenCalledWith(
      'user: What is this system about?\n' +
        'assistant: It is a course system.\n' +
        'user: What technology does it use?',
      'visitor-1',
      16,
      0.25,
      'guide.pdf',
    );

    expect(aiService.askWithContext).toHaveBeenCalledWith(
      'What technology does it use?',
      'Source 1 (guide.pdf, page 2):\nReact is used for the frontend.',
      history,
    );

    expect(result).toEqual({
      answer: 'It uses React.',
      sources: documents,
    });
  });

  it('retrieves a larger context window when searching the whole library', async () => {
    const documents = [
      {
        score: 0.71,
        content: 'The document contains the requested information.',
        metadata: { source: 'guide.pdf' },
      },
    ];

    vectorStoreService.search.mockResolvedValue(documents);
    aiService.askWithContext.mockResolvedValue(
      'The document contains the requested information.',
    );

    await service.ask(
      'Explain the requested information in detail.',
      'visitor-1',
    );

    expect(vectorStoreService.search).toHaveBeenCalledWith(
      'user: Explain the requested information in detail.',
      'visitor-1',
      12,
      0.45,
      undefined,
    );
  });

  it('analyzes every selected document while preserving the visitor scope', async () => {
    const documents = [
      {
        content: 'The policy applies to remote employees.',
        metadata: { source: 'policy.pdf' },
      },
      {
        content: 'The handbook defines the remote-work schedule.',
        metadata: { source: 'handbook.pdf' },
      },
    ];

    vectorStoreService.getDocumentsBySources.mockResolvedValue(documents);
    aiService.askAcrossDocuments.mockResolvedValue(
      'The selected documents describe remote work.',
    );

    const result = await service.ask(
      'Compare the remote-work guidance.',
      'visitor-1',
      [' policy.pdf ', 'handbook.pdf', 'policy.pdf'],
    );

    expect(vectorStoreService.getDocumentsBySources).toHaveBeenCalledWith(
      ['policy.pdf', 'handbook.pdf'],
      'visitor-1',
    );
    expect(aiService.askAcrossDocuments).toHaveBeenCalledWith(
      'Compare the remote-work guidance.',
      documents,
      [],
    );
    expect(aiService.askWithContext).not.toHaveBeenCalled();
    expect(result).toEqual({
      answer: 'The selected documents describe remote work.',
      sources: [
        {
          content: 'The policy applies to remote employees.',
          metadata: { source: 'policy.pdf' },
        },
        {
          content: 'The handbook defines the remote-work schedule.',
          metadata: { source: 'handbook.pdf' },
        },
      ],
    });
  });

  it('passes conversation history into multi-document analysis', async () => {
    const documents = [
      {
        content: 'The policy applies to remote employees.',
        metadata: { source: 'policy.pdf' },
      },
      {
        content: 'The handbook defines the remote-work schedule.',
        metadata: { source: 'handbook.pdf' },
      },
    ];
    const history = [
      { role: 'user' as const, content: 'What is the work policy?' },
      { role: 'assistant' as const, content: 'It covers remote work.' },
    ];

    vectorStoreService.getDocumentsBySources.mockResolvedValue(documents);
    aiService.askAcrossDocuments.mockResolvedValue('The schedule is defined.');

    await service.ask(
      'What about the schedule?',
      'visitor-1',
      ['policy.pdf', 'handbook.pdf'],
      history,
    );

    expect(aiService.askAcrossDocuments).toHaveBeenCalledWith(
      'What about the schedule?',
      documents,
      history,
    );
  });

  it('returns source evidence for every selected document', async () => {
    const documents = [
      {
        content: 'Policy content.',
        metadata: { source: 'policy.pdf', loc: { pageNumber: 1 } },
      },
      {
        content: 'Handbook content.',
        metadata: { source: 'handbook.pdf', loc: { pageNumber: 4 } },
      },
    ];

    vectorStoreService.getDocumentsBySources.mockResolvedValue(documents);
    aiService.askAcrossDocuments.mockResolvedValue('Detailed answer.');

    const result = await service.ask(
      'Explain the selected documents.',
      'visitor-1',
      ['policy.pdf', 'handbook.pdf'],
    );

    expect(result.sources).toEqual([documents[0], documents[1]]);
  });

  it('summarizes every chunk for a selected summary request', async () => {
    const documents = [
      {
        content: 'The system manages courses.',
        metadata: {
          source: 'guide.pdf',
          loc: { pageNumber: 1 },
        },
      },
      {
        content: 'The system also manages enrollments.',
        metadata: {
          source: 'guide.pdf',
          loc: { pageNumber: 2 },
        },
      },
    ];

    vectorStoreService.getDocumentsBySource.mockResolvedValue(documents);
    aiService.summarizeDocuments.mockResolvedValue(
      'The system manages courses and enrollments.',
    );

    const result = await service.ask(
      'Can you summarize all the content?',
      'visitor-1',
      'guide.pdf',
    );

    expect(vectorStoreService.getDocumentsBySource).toHaveBeenCalledWith(
      'guide.pdf',
      'visitor-1',
    );
    expect(vectorStoreService.search).not.toHaveBeenCalled();
    expect(aiService.summarizeDocuments).toHaveBeenCalledWith(documents);
    expect(result).toEqual({
      answer: 'The system manages courses and enrollments.',
      sources: documents,
    });
  });

  it('requires a selected source for a full summary', async () => {
    const result = await service.ask(
      'Can you summarize all documents?',
      'visitor-1',
    );

    expect(result).toEqual({
      answer:
        'Please select at least one document before requesting a full summary.',
      sources: [],
    });
    expect(vectorStoreService.search).not.toHaveBeenCalled();
    expect(vectorStoreService.getDocumentsBySource).not.toHaveBeenCalled();
  });

  it('summarizes all selected documents when a multi-document summary is requested', async () => {
    const documents = [
      {
        content: 'The policy requires manager approval.',
        metadata: { source: 'policy.pdf', loc: { pageNumber: 1 } },
      },
      {
        content: 'The handbook describes the approval workflow.',
        metadata: { source: 'handbook.pdf', loc: { pageNumber: 4 } },
      },
    ];

    vectorStoreService.getDocumentsBySources.mockResolvedValue(documents);
    aiService.summarizeDocuments.mockResolvedValue(
      'The selected documents explain the approval process.',
    );

    const result = await service.ask(
      'Summarize these documents.',
      'visitor-1',
      ['policy.pdf', 'handbook.pdf'],
    );

    expect(vectorStoreService.getDocumentsBySources).toHaveBeenCalledWith(
      ['policy.pdf', 'handbook.pdf'],
      'visitor-1',
    );
    expect(aiService.summarizeDocuments).toHaveBeenCalledWith(documents);
    expect(result.sources).toHaveLength(2);
  });

  it('streams answer tokens, sources, and completion in order', async () => {
    const documents = [
      {
        score: 0.91,
        content: 'React is used for the frontend.',
        metadata: {
          source: 'guide.pdf',
          loc: { pageNumber: 2 },
        },
      },
    ];

    vectorStoreService.search.mockResolvedValue(documents);
    aiService.streamWithContext.mockReturnValue(
      emitTokens(['React ', 'is used for the frontend.']),
    );

    const events = [];

    for await (const event of service.streamAsk(
      'What is used for the frontend?',
      'visitor-1',
      'guide.pdf',
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'token', token: 'React ' },
      { type: 'token', token: 'is used for the frontend.' },
      { type: 'sources', sources: documents },
      { type: 'done' },
    ]);
  });

  it('streams a detailed answer across all selected documents', async () => {
    const documents = [
      {
        content: 'The policy requires manager approval.',
        metadata: { source: 'policy.pdf', loc: { pageNumber: 1 } },
      },
      {
        content: 'The handbook describes the approval workflow.',
        metadata: { source: 'handbook.pdf', loc: { pageNumber: 4 } },
      },
    ];

    vectorStoreService.getDocumentsBySources.mockResolvedValue(documents);
    aiService.streamAcrossDocuments.mockReturnValue(
      emitTokens(['Policy details. ', 'Handbook details.']),
    );

    const events = [];

    for await (const event of service.streamAsk(
      'Explain the approval process.',
      'visitor-1',
      ['policy.pdf', 'handbook.pdf'],
    )) {
      events.push(event);
    }

    expect(aiService.streamAcrossDocuments).toHaveBeenCalledWith(
      'Explain the approval process.',
      documents,
      [],
      undefined,
    );
    expect(events).toEqual([
      { type: 'token', token: 'Policy details. ' },
      { type: 'token', token: 'Handbook details.' },
      {
        type: 'sources',
        sources: documents,
      },
      { type: 'done' },
    ]);
  });

  it('streams a selected document summary with deduplicated sources', async () => {
    const documents = [
      {
        content: 'The system manages courses.',
        metadata: {
          source: 'guide.pdf',
          loc: { pageNumber: 1 },
        },
      },
      {
        content: 'The system also manages enrollments.',
        metadata: {
          source: 'guide.pdf',
          loc: { pageNumber: 1 },
        },
      },
    ];

    vectorStoreService.getDocumentsBySource.mockResolvedValue(documents);
    aiService.streamSummaryDocuments.mockReturnValue(
      emitTokens(['The system manages ', 'courses and enrollments.']),
    );

    const events = [];

    for await (const event of service.streamAsk(
      'Can you summarize this document?',
      'visitor-1',
      'guide.pdf',
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'token', token: 'The system manages ' },
      { type: 'token', token: 'courses and enrollments.' },
      {
        type: 'sources',
        sources: [documents[0]],
      },
      { type: 'done' },
    ]);
  });
});
