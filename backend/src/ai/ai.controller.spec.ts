import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';
import { EmbeddingService } from './embedding.service.js';

describe('AiController', () => {
  let controller: AiController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiController],
      providers: [
        { provide: AiService, useValue: {} },
        { provide: EmbeddingService, useValue: {} },
        { provide: ConfigService, useValue: { get: vi.fn() } },
      ],
    }).compile();

    controller = module.get<AiController>(AiController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('trims a question before sending it to the model', async () => {
    const aiService = {
      ask: vi.fn().mockResolvedValue('answer'),
    };
    const testController = new AiController(
      aiService as unknown as AiService,
      {} as EmbeddingService,
      { get: vi.fn() } as unknown as ConfigService,
    );

    await expect(
      testController.ask({ question: '  What is RAG?  ' }),
    ).resolves.toEqual({ answer: 'answer' });

    expect(aiService.ask).toHaveBeenCalledWith('What is RAG?');
  });

  it('rejects a blank question', async () => {
    const testController = new AiController(
      { ask: vi.fn() } as unknown as AiService,
      {} as EmbeddingService,
      { get: vi.fn() } as unknown as ConfigService,
    );

    await expect(testController.ask({ question: '   ' })).rejects.toThrow(
      'Question is required',
    );
  });

  it('hides diagnostic endpoints in production by default', async () => {
    const configService = {
      get: vi.fn((key: string) =>
        key === 'NODE_ENV' ? 'production' : undefined,
      ),
    };
    const testController = new AiController(
      {} as AiService,
      {} as EmbeddingService,
      configService as unknown as ConfigService,
    );

    await expect(
      testController.ask({ question: 'What is RAG?' }),
    ).rejects.toThrow('Not Found');
  });
});
