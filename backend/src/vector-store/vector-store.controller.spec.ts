import { Test, TestingModule } from '@nestjs/testing';
import { VectorStoreController } from './vector-store.controller.js';
import { VectorStoreService } from './vector-store.service.js';

describe('VectorStoreController', () => {
  const visitorRequest = {
    visitorId: 'visitor-1',
    csrfToken: 'csrf-token',
  };
  let controller: VectorStoreController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [VectorStoreController],
      providers: [
        {
          provide: VectorStoreService,
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<VectorStoreController>(VectorStoreController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('deletes a trimmed source and returns the removed chunk count', async () => {
    const vectorStoreService = {
      deleteBySource: vi.fn().mockResolvedValue(28),
    };
    const testController = new VectorStoreController(
      vectorStoreService as unknown as VectorStoreService,
    );

    await expect(
      testController.deleteSource({ source: '  guide.pdf  ' }, visitorRequest),
    ).resolves.toEqual({
      message: 'Document deleted successfully',
      source: 'guide.pdf',
      deletedChunks: 28,
    });

    expect(vectorStoreService.deleteBySource).toHaveBeenCalledWith(
      'guide.pdf',
      visitorRequest.visitorId,
    );
  });

  it('reports when the source does not exist', async () => {
    const testController = new VectorStoreController({
      deleteBySource: vi.fn().mockResolvedValue(0),
    } as unknown as VectorStoreService);

    await expect(
      testController.deleteSource({ source: 'missing.pdf' }, visitorRequest),
    ).rejects.toThrow('Document not found');
  });

  it('blocks uploads that reuse an indexed filename', async () => {
    const vectorStoreService = {
      hasSource: vi.fn().mockResolvedValue(true),
    };
    const testController = new VectorStoreController(
      vectorStoreService as unknown as VectorStoreService,
    );

    await expect(
      testController.addFile(
        {
          originalname: 'guide.pdf',
        } as Express.Multer.File,
        visitorRequest,
      ),
    ).rejects.toThrow(
      'This filename is already indexed. Delete the existing document before uploading a replacement.',
    );

    expect(vectorStoreService.hasSource).toHaveBeenCalledWith(
      'guide.pdf',
      visitorRequest.visitorId,
    );
  });

  it('rejects unsupported file types before indexing', async () => {
    const vectorStoreService = {
      hasSource: vi.fn(),
    };
    const testController = new VectorStoreController(
      vectorStoreService as unknown as VectorStoreService,
    );

    await expect(
      testController.addFile(
        {
          originalname: 'malware.exe',
          mimetype: 'application/octet-stream',
          buffer: Buffer.from('not a supported document'),
        } as Express.Multer.File,
        visitorRequest,
      ),
    ).rejects.toThrow('Only PDF, DOCX, and TXT files are supported.');

    expect(vectorStoreService.hasSource).not.toHaveBeenCalled();
  });

  it('trims manually submitted text before indexing', async () => {
    const vectorStoreService = {
      addText: vi.fn().mockResolvedValue(3),
    };
    const testController = new VectorStoreController(
      vectorStoreService as unknown as VectorStoreService,
    );

    await expect(
      testController.addDocument(
        { text: '  A short document.  ' },
        visitorRequest,
      ),
    ).resolves.toEqual({
      message: 'Document indexed successfully',
      chunks: 3,
    });

    expect(vectorStoreService.addText).toHaveBeenCalledWith(
      'A short document.',
      'manual',
      visitorRequest.visitorId,
    );
  });

  it('trims search queries before searching', async () => {
    const vectorStoreService = {
      search: vi.fn().mockResolvedValue([]),
    };
    const testController = new VectorStoreController(
      vectorStoreService as unknown as VectorStoreService,
    );

    await expect(
      testController.search({ query: '  find this  ' }, visitorRequest),
    ).resolves.toEqual({
      query: 'find this',
      results: [],
    });

    expect(vectorStoreService.search).toHaveBeenCalledWith(
      'find this',
      visitorRequest.visitorId,
    );
  });

  it('cleans up partial text uploads when indexing fails', async () => {
    const vectorStoreService = {
      hasSource: vi.fn().mockResolvedValue(false),
      addText: vi.fn().mockRejectedValue(new Error('Embedding service failed')),
      deleteBySource: vi.fn().mockResolvedValue(2),
    };
    const testController = new VectorStoreController(
      vectorStoreService as unknown as VectorStoreService,
    );

    await expect(
      testController.addFile(
        {
          originalname: 'long-guide.txt',
          mimetype: 'text/plain',
          buffer: Buffer.from('A long document.'),
        } as Express.Multer.File,
        visitorRequest,
      ),
    ).rejects.toThrow('Embedding service failed');

    expect(vectorStoreService.deleteBySource).toHaveBeenCalledWith(
      'long-guide.txt',
      visitorRequest.visitorId,
    );
  });
});
