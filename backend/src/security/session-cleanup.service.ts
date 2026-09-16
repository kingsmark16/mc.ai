import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { VectorStoreService } from '../vector-store/vector-store.service.js';

export const sessionCloseGracePeriodMs = 15 * 1_000;
export const sessionHeartbeatTimeoutMs = 90 * 1_000;

@Injectable()
export class SessionCleanupService implements OnModuleDestroy {
  private readonly logger = new Logger(SessionCleanupService.name);
  private readonly cleanupTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(private readonly vectorStoreService: VectorStoreService) {}

  touch(ownerId: string): void {
    this.schedule(ownerId, sessionHeartbeatTimeoutMs);
  }

  scheduleClose(ownerId: string): void {
    this.schedule(ownerId, sessionCloseGracePeriodMs);
  }

  async clear(ownerId: string): Promise<number> {
    this.cancel(ownerId);

    return this.vectorStoreService.deleteByOwner(ownerId);
  }

  onModuleDestroy(): void {
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }

    this.cleanupTimers.clear();
  }

  private schedule(ownerId: string, delayMs: number): void {
    this.cancel(ownerId);

    const timer = setTimeout(() => {
      if (this.cleanupTimers.get(ownerId) !== timer) {
        return;
      }

      this.cleanupTimers.delete(ownerId);
      void this.deleteExpiredSession(ownerId);
    }, delayMs);

    timer.unref?.();
    this.cleanupTimers.set(ownerId, timer);
  }

  private cancel(ownerId: string): void {
    const timer = this.cleanupTimers.get(ownerId);

    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.cleanupTimers.delete(ownerId);
  }

  private async deleteExpiredSession(ownerId: string): Promise<void> {
    try {
      await this.vectorStoreService.deleteByOwner(ownerId);
    } catch (error) {
      this.logger.error(
        `Could not delete expired session ${ownerId}. Retrying after the inactivity timeout.`,
        error instanceof Error ? error.stack : String(error),
      );
      this.touch(ownerId);
    }
  }
}
