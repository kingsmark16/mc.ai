import { VectorStoreService } from '../vector-store/vector-store.service.js';
import {
  SessionCleanupService,
  sessionCloseGracePeriodMs,
  sessionHeartbeatTimeoutMs,
} from './session-cleanup.service.js';

describe('SessionCleanupService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('deletes a visitor after the browser close grace period', async () => {
    vi.useFakeTimers();
    const vectorStoreService = {
      deleteByOwner: vi.fn().mockResolvedValue(3),
    };
    const service = new SessionCleanupService(
      vectorStoreService as unknown as VectorStoreService,
    );

    service.scheduleClose('visitor-1');
    await vi.advanceTimersByTimeAsync(sessionCloseGracePeriodMs);

    expect(vectorStoreService.deleteByOwner).toHaveBeenCalledWith('visitor-1');
    service.onModuleDestroy();
  });

  it('keeps a session alive when a refresh heartbeat arrives', async () => {
    vi.useFakeTimers();
    const vectorStoreService = {
      deleteByOwner: vi.fn().mockResolvedValue(3),
    };
    const service = new SessionCleanupService(
      vectorStoreService as unknown as VectorStoreService,
    );

    service.scheduleClose('visitor-1');
    service.touch('visitor-1');
    await vi.advanceTimersByTimeAsync(sessionCloseGracePeriodMs);

    expect(vectorStoreService.deleteByOwner).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('uses the heartbeat timeout when the close signal is missed', async () => {
    vi.useFakeTimers();
    const vectorStoreService = {
      deleteByOwner: vi.fn().mockResolvedValue(3),
    };
    const service = new SessionCleanupService(
      vectorStoreService as unknown as VectorStoreService,
    );

    service.touch('visitor-1');
    await vi.advanceTimersByTimeAsync(sessionHeartbeatTimeoutMs);

    expect(vectorStoreService.deleteByOwner).toHaveBeenCalledWith('visitor-1');
    service.onModuleDestroy();
  });
});
