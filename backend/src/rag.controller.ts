import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AskQuestionDto } from './dto/ask-question.dto.js';
import {
  RagService,
  type RagSourceScope,
  type RagStreamEvent,
} from './rag.service.js';
import type { VisitorRequest } from './security/visitor-access.middleware.js';

@Controller('rag')
export class RagController {
  constructor(private readonly ragService: RagService) {}

  @Post('ask')
  async ask(@Body() body: AskQuestionDto, @Req() request: VisitorRequest) {
    const question = body.question.trim();

    if (!question) {
      throw new BadRequestException('Question is required');
    }

    const source = this.getSourceScope(body);
    const history =
      body.history?.map(({ role, content }) => ({ role, content })) ?? [];

    return this.ragService.ask(question, request.visitorId, source, history);
  }

  @Post('stream')
  async stream(
    @Body() body: AskQuestionDto,
    @Req() request: VisitorRequest,
    @Res() response: Response,
  ): Promise<void> {
    const question = body.question.trim();

    if (!question) {
      throw new BadRequestException('Question is required');
    }

    const source = this.getSourceScope(body);
    const history =
      body.history?.map(({ role, content }) => ({ role, content })) ?? [];

    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();

    const abortController = new AbortController();
    const abortOnClose = () => abortController.abort();
    request.once('aborted', abortOnClose);
    response.once('close', abortOnClose);

    try {
      for await (const event of this.ragService.streamAsk(
        question,
        request.visitorId,
        source,
        history,
        abortController.signal,
      )) {
        if (response.writableEnded || response.destroyed) {
          break;
        }

        this.writeEvent(response, event);
      }
    } catch (error) {
      if (
        !abortController.signal.aborted &&
        !response.writableEnded &&
        !response.destroyed
      ) {
        this.writeEvent(response, {
          type: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Unable to generate a response.',
        });
      }
    } finally {
      request.off('aborted', abortOnClose);
      response.off('close', abortOnClose);

      if (!response.writableEnded && !response.destroyed) {
        response.end();
      }
    }
  }

  private writeEvent(response: Response, event: RagStreamEvent): void {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  private getSourceScope(body: AskQuestionDto): RagSourceScope {
    const sources = body.sources
      ?.map((source) => source.trim())
      .filter(Boolean);

    if (sources?.length) {
      return [...new Set(sources)];
    }

    return body.source?.trim() || undefined;
  }
}
