import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module.js';
import { VectorStoreModule } from './vector-store/vector-store.module.js';
import { RagController } from './rag.controller.js';
import { RagService } from './rag.service.js';

@Module({
  imports: [AiModule, VectorStoreModule],
  controllers: [RagController],
  providers: [RagService],
})
export class RagModule {}
