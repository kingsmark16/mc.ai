import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Document } from '@langchain/core/documents';
import { EmbeddingService } from '../ai/embedding.service.js';
import { VectorStoreService } from './vector-store.service.js';

describe('VectorStoreService', () => {
  let service: VectorStoreService;
  let embeddingService: {
    embedDocuments: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    embeddingService = {
      embedDocuments: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VectorStoreService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: () => 'test-value',
          },
        },
        {
          provide: EmbeddingService,
          useValue: embeddingService,
        },
      ],
    }).compile();

    service = module.get<VectorStoreService>(VectorStoreService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('tags every indexed chunk with the server-provided visitor ID', async () => {
    const vectorStore = {
      addVectors: vi.fn().mockResolvedValue(undefined),
    };
    embeddingService.embedDocuments.mockResolvedValue([[0.1, 0.2, 0.3]]);
    vi.spyOn(service as any, 'getVectorStore').mockResolvedValue(vectorStore);

    await service.addText('A short document.', 'guide.pdf', 'visitor-1');

    const [, documents] = vectorStore.addVectors.mock.calls[0];

    expect(documents[0]).toBeInstanceOf(Document);
    expect(documents[0].metadata).toMatchObject({
      ownerId: 'visitor-1',
      source: 'guide.pdf',
    });
  });

  it('indexes long documents in bounded embedding batches', async () => {
    const vectorStore = {
      addVectors: vi.fn().mockResolvedValue(undefined),
    };
    embeddingService.embedDocuments.mockImplementation(async (texts: string[]) =>
      texts.map(() => [0.1, 0.2, 0.3]),
    );
    vi.spyOn(service as any, 'getVectorStore').mockResolvedValue(vectorStore);

    const documents = Array.from(
      { length: 101 },
      (_, index) =>
        new Document({
          pageContent: `Document passage ${index}`,
          metadata: { source: 'long-guide.pdf' },
        }),
    );

    await expect(service.addDocuments(documents, 'visitor-1')).resolves.toBe(
      101,
    );

    expect(embeddingService.embedDocuments).toHaveBeenCalledTimes(2);
    expect(embeddingService.embedDocuments.mock.calls.map(([texts]) => texts.length)).toEqual([
      100,
      1,
    ]);
    expect(vectorStore.addVectors).toHaveBeenCalledTimes(2);
  });

  it('rejects incomplete embedding batches instead of storing partial vectors', async () => {
    const vectorStore = {
      addVectors: vi.fn().mockResolvedValue(undefined),
    };
    embeddingService.embedDocuments.mockResolvedValue([[]]);
    vi.spyOn(service as any, 'getVectorStore').mockResolvedValue(vectorStore);

    await expect(
      service.addText('A document that could not be embedded.', 'guide.pdf', 'visitor-1'),
    ).rejects.toThrow('Document indexing is temporarily unavailable');

    expect(vectorStore.addVectors).not.toHaveBeenCalled();
  });

  it('scopes source listing to the current visitor', async () => {
    const collection = {
      find: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ source: 'guide.pdf' }]),
      }),
    };
    vi.spyOn(service as any, 'getVectorStore').mockResolvedValue({});
    vi.spyOn(service as any, 'getAstraCollection').mockReturnValue(collection);

    await expect(service.listSources('visitor-1')).resolves.toEqual([
      'guide.pdf',
    ]);

    expect(collection.find).toHaveBeenCalledWith(
      { ownerId: 'visitor-1' },
      { projection: { source: 1 } },
    );
  });

  it('scopes deletion to both source and visitor', async () => {
    const collection = {
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 4 }),
    };
    vi.spyOn(service as any, 'getVectorStore').mockResolvedValue({});
    vi.spyOn(service as any, 'getAstraCollection').mockReturnValue(collection);

    await expect(
      service.deleteBySource('guide.pdf', 'visitor-1'),
    ).resolves.toBe(4);

    expect(collection.deleteMany).toHaveBeenCalledWith({
      ownerId: 'visitor-1',
      source: 'guide.pdf',
    });
  });

  it('deletes every indexed chunk belonging to one visitor', async () => {
    const collection = {
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 9 }),
    };
    vi.spyOn(service as any, 'getVectorStore').mockResolvedValue({});
    vi.spyOn(service as any, 'getAstraCollection').mockReturnValue(collection);

    await expect(service.deleteByOwner('visitor-1')).resolves.toBe(9);

    expect(collection.deleteMany).toHaveBeenCalledWith({
      ownerId: 'visitor-1',
    });
  });

  it('scopes vector search and does not expose the internal visitor ID', async () => {
    const vectorStore = {
      similaritySearchWithScore: vi.fn().mockResolvedValue([
        [
          new Document({
            pageContent: 'Only this visitor can retrieve this.',
            metadata: {
              ownerId: 'visitor-1',
              source: 'guide.pdf',
            },
          }),
          0.93,
        ],
      ]),
    };
    vi.spyOn(service as any, 'getVectorStore').mockResolvedValue(vectorStore);

    await expect(
      service.search('What is in the guide?', 'visitor-1', 3, 0.6, 'guide.pdf'),
    ).resolves.toEqual([
      {
        score: 0.93,
        content: 'Only this visitor can retrieve this.',
        metadata: { source: 'guide.pdf' },
      },
    ]);

    expect(vectorStore.similaritySearchWithScore).toHaveBeenCalledWith(
      'What is in the guide?',
      3,
      { ownerId: 'visitor-1', source: 'guide.pdf' },
    );
  });

  it('scopes multi-document vector search to the selected sources and visitor', async () => {
    const vectorStore = {
      similaritySearchWithScore: vi.fn().mockResolvedValue([]),
    };
    vi.spyOn(service as any, 'getVectorStore').mockResolvedValue(vectorStore);

    await service.search('Compare the documents', 'visitor-1', 24, 0.25, [
      'guide.pdf',
      'policy.pdf',
      'guide.pdf',
    ]);

    expect(vectorStore.similaritySearchWithScore).toHaveBeenCalledWith(
      'Compare the documents',
      24,
      {
        ownerId: 'visitor-1',
        source: { $in: ['guide.pdf', 'policy.pdf'] },
      },
    );
  });
});
