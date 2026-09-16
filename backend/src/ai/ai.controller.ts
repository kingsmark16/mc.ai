import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiQuestionDto } from '../dto/ai-question.dto.js';
import { AiService } from './ai.service.js';
import { EmbeddingService } from './embedding.service.js';

@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly embeddingService: EmbeddingService,
    private readonly configService: ConfigService,
  ) {}

  @Get('embedding-test')
  async embeddingTest() {
    this.ensureDiagnosticsEnabled();

    const vector = await this.embeddingService.embedQuery(
      'This is a test document',
    );

    return {
      dimensions: vector.length,
    };
  }

  @Post('ask')
  async ask(@Body() body: AiQuestionDto) {
    this.ensureDiagnosticsEnabled();

    const question = body.question.trim();

    if (!question) {
      throw new BadRequestException('Question is required');
    }

    const answer = await this.aiService.ask(question);

    return { answer };
  }

  private ensureDiagnosticsEnabled(): void {
    const environment = this.configService.get<string>('NODE_ENV');
    const explicitlyEnabled =
      this.configService.get<string>('ENABLE_DIAGNOSTIC_ENDPOINTS') === 'true';

    if (
      (environment === 'production' || environment === 'prod') &&
      !explicitlyEnabled
    ) {
      throw new NotFoundException();
    }
  }
}
