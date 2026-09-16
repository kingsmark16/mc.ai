import { Controller, Delete, Get, Post, Req, Res } from '@nestjs/common';
import {
  csrfCookieName,
  visitorCookieName,
  type VisitorRequest,
} from './security/visitor-access.middleware.js';
import type { Response } from 'express';
import { AppService } from './app.service.js';
import { SessionCleanupService } from './security/session-cleanup.service.js';
import { VectorStoreService } from './vector-store/vector-store.service.js';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly vectorStoreService: VectorStoreService,
    private readonly sessionCleanupService: SessionCleanupService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('session')
  getSession(@Req() request: VisitorRequest) {
    return {
      csrfToken: request.csrfToken,
    };
  }

  @Post('session/heartbeat')
  heartbeat(@Req() request: VisitorRequest) {
    this.sessionCleanupService.touch(request.visitorId);

    return {
      message: 'Session heartbeat accepted',
    };
  }

  @Post('session/close')
  scheduleSessionClose(@Req() request: VisitorRequest) {
    this.sessionCleanupService.scheduleClose(request.visitorId);

    return {
      message: 'Session cleanup scheduled',
    };
  }

  @Delete('session')
  async clearSession(
    @Req() request: VisitorRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const deletedChunks = await this.sessionCleanupService.clear(
      request.visitorId,
    );

    response.clearCookie(visitorCookieName, { path: '/' });
    response.clearCookie(csrfCookieName, { path: '/' });

    return {
      message: 'Session cleared successfully',
      deletedChunks,
    };
  }

  @Get('health')
  async getHealth() {
    try {
      await this.vectorStoreService.checkConnection();

      return {
        status: 'ok',
        api: 'ok',
        astra: 'ready',
      };
    } catch (error) {
      return {
        status: 'degraded',
        api: 'ok',
        astra: 'unavailable',
        message:
          error instanceof Error
            ? error.message
            : 'Astra DB is currently unavailable.',
      };
    }
  }
}
