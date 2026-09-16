import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { SessionCleanupService } from './security/session-cleanup.service.js';
import { VectorStoreService } from './vector-store/vector-store.service.js';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: VectorStoreService,
          useValue: {
            checkConnection: vi.fn(),
          },
        },
        {
          provide: SessionCleanupService,
          useValue: {
            clear: vi.fn(),
            scheduleClose: vi.fn(),
            touch: vi.fn(),
          },
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('confirms that the MC.AI API is running', () => {
      expect(appController.getHello()).toBe('MC.AI API is running');
    });
  });

  describe('session', () => {
    it('returns the CSRF token without exposing the visitor identifier', () => {
      expect(
        appController.getSession({
          visitorId: 'visitor-1',
          csrfToken: 'csrf-token',
        }),
      ).toEqual({ csrfToken: 'csrf-token' });
    });

    it('deletes the current visitor chunks and clears both session cookies', async () => {
      const vectorStoreService = {
        deleteByOwner: vi.fn(),
      };
      const sessionCleanupService = {
        clear: vi.fn().mockResolvedValue(12),
      };
      const testController = new AppController(
        new AppService(),
        vectorStoreService as unknown as VectorStoreService,
        sessionCleanupService as unknown as SessionCleanupService,
      );
      const response = {
        clearCookie: vi.fn(),
      };

      await expect(
        testController.clearSession(
          { visitorId: 'visitor-1', csrfToken: 'csrf-token' },
          response as any,
        ),
      ).resolves.toEqual({
        message: 'Session cleared successfully',
        deletedChunks: 12,
      });

      expect(sessionCleanupService.clear).toHaveBeenCalledWith(
        'visitor-1',
      );
      expect(response.clearCookie).toHaveBeenCalledWith('rag_visitor', {
        path: '/',
      });
      expect(response.clearCookie).toHaveBeenCalledWith('rag_csrf', {
        path: '/',
      });
    });

    it('refreshes the current visitor session lease', () => {
      const sessionCleanupService = {
        touch: vi.fn(),
      };
      const testController = new AppController(
        new AppService(),
        {} as VectorStoreService,
        sessionCleanupService as unknown as SessionCleanupService,
      );

      expect(
        testController.heartbeat({
          visitorId: 'visitor-1',
          csrfToken: 'csrf-token',
        }),
      ).toEqual({ message: 'Session heartbeat accepted' });
      expect(sessionCleanupService.touch).toHaveBeenCalledWith('visitor-1');
    });

    it('schedules cleanup after a page session closes', () => {
      const sessionCleanupService = {
        scheduleClose: vi.fn(),
      };
      const testController = new AppController(
        new AppService(),
        {} as VectorStoreService,
        sessionCleanupService as unknown as SessionCleanupService,
      );

      expect(
        testController.scheduleSessionClose({
          visitorId: 'visitor-1',
          csrfToken: 'csrf-token',
        }),
      ).toEqual({ message: 'Session cleanup scheduled' });
      expect(sessionCleanupService.scheduleClose).toHaveBeenCalledWith(
        'visitor-1',
      );
    });
  });

  describe('health', () => {
    it('reports when Astra is ready', async () => {
      await expect(appController.getHealth()).resolves.toEqual({
        status: 'ok',
        api: 'ok',
        astra: 'ready',
      });
    });

    it('reports a degraded state when Astra is unavailable', async () => {
      const vectorStoreService = {
        checkConnection: vi
          .fn()
          .mockRejectedValue(new Error('Astra DB is waking up.')),
      };
      const controller = new AppController(
        new AppService(),
        vectorStoreService as unknown as VectorStoreService,
        {} as SessionCleanupService,
      );

      await expect(controller.getHealth()).resolves.toEqual({
        status: 'degraded',
        api: 'ok',
        astra: 'unavailable',
        message: 'Astra DB is waking up.',
      });
    });
  });
});
