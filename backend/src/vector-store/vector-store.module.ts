import { Module } from '@nestjs/common';
import { VectorStoreService } from './vector-store.service.js';
import { VectorStoreController } from './vector-store.controller.js';
import { AiModule } from '../ai/ai.module.js';

@Module({
  imports: [AiModule],
  providers: [VectorStoreService],
  controllers: [VectorStoreController],
  exports: [VectorStoreService],
})
export class VectorStoreModule {}
