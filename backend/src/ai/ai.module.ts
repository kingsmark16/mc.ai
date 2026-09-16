import { Module } from '@nestjs/common';
import { AiService } from './ai.service.js';
import { AiController } from './ai.controller.js';
import { EmbeddingService } from './embedding.service.js';

@Module({
  providers: [AiService, EmbeddingService],
  controllers: [AiController],
  exports: [EmbeddingService, AiService],
})
export class AiModule {}
