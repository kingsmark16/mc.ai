import { RagController } from './rag.controller.js';
import { RagService } from './rag.service.js';

describe('RagController', () => {
  const visitorRequest = {
    visitorId: 'visitor-1',
    csrfToken: 'csrf-token',
  };

  it('trims input and forwards source and history', async () => {
    const ragService = {
      ask: vi.fn().mockResolvedValue({
        answer: 'answer',
        sources: [],
      }),
    };
    const controller = new RagController(ragService as unknown as RagService);

    const history = [{ role: 'user' as const, content: 'Previous question' }];

    await controller.ask(
      {
        question: '  Current question  ',
        source: '  guide.pdf  ',
        history,
      },
      visitorRequest,
    );

    expect(ragService.ask).toHaveBeenCalledWith(
      'Current question',
      visitorRequest.visitorId,
      'guide.pdf',
      history,
    );
  });

  it('rejects a blank question', async () => {
    const controller = new RagController({
      ask: vi.fn(),
    } as unknown as RagService);

    await expect(
      controller.ask(
        {
          question: '   ',
        },
        visitorRequest,
      ),
    ).rejects.toThrow('Question is required');
  });

  it('trims and forwards multiple selected sources', async () => {
    const ragService = {
      ask: vi.fn().mockResolvedValue({
        answer: 'answer',
        sources: [],
      }),
    };
    const controller = new RagController(ragService as unknown as RagService);

    await controller.ask(
      {
        question: '  Compare the documents  ',
        sources: ['  guide.pdf  ', 'policy.pdf', 'guide.pdf'],
        history: [],
      },
      visitorRequest,
    );

    expect(ragService.ask).toHaveBeenCalledWith(
      'Compare the documents',
      visitorRequest.visitorId,
      ['guide.pdf', 'policy.pdf'],
      [],
    );
  });
});
