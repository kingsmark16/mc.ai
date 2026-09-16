import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ConfigModule } from '@nestjs/config';
import { AiModule } from './ai/ai.module.js';
import { VectorStoreModule } from './vector-store/vector-store.module.js';
import { RagModule } from './rag.module.js';
import { validateEnvironment } from './config/env.validation.js';
import { VisitorAccessMiddleware } from './security/visitor-access.middleware.js';
import { SessionCleanupService } from './security/session-cleanup.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    AiModule,
    VectorStoreModule,
    RagModule,
  ],
  controllers: [AppController],
  providers: [AppService, SessionCleanupService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(VisitorAccessMiddleware).forRoutes('*');
  }
}
