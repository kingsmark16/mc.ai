import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  Delete,
  Get,
  Logger,
  NotFoundException,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { DeleteSourceDto } from '../dto/delete-source.dto.js';
import { AddDocumentDto } from '../dto/add-document.dto.js';
import { SearchDocumentsDto } from '../dto/search-documents.dto.js';
import { VectorStoreService } from './vector-store.service.js';
import { FileInterceptor } from '@nestjs/platform-express';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import { Document } from '@langchain/core/documents';
import type { VisitorRequest } from '../security/visitor-access.middleware.js';

const maxDocumentSizeBytes = 10 * 1024 * 1024;

@Controller('documents')
export class VectorStoreController {
  private readonly logger = new Logger(VectorStoreController.name);

  constructor(private readonly vectorStoreService: VectorStoreService) {}

  @Get('sources')
  async listSources(@Req() request: VisitorRequest) {
    return {
      sources: await this.vectorStoreService.listSources(request.visitorId),
    };
  }

  @Delete('source')
  async deleteSource(
    @Body() body: DeleteSourceDto,
    @Req() request: VisitorRequest,
  ) {
    const source = body.source.trim();

    if (!source) {
      throw new BadRequestException('Source is required');
    }

    const deletedChunks = await this.vectorStoreService.deleteBySource(
      source,
      request.visitorId,
    );

    if (deletedChunks === 0) {
      throw new NotFoundException('Document not found');
    }

    return {
      message: 'Document deleted successfully',
      source,
      deletedChunks,
    };
  }

  @Post()
  async addDocument(
    @Body() body: AddDocumentDto,
    @Req() request: VisitorRequest,
  ) {
    const text = body.text.trim();

    if (!text) {
      throw new BadRequestException('Text is required');
    }

    const chunks = await this.vectorStoreService.addText(
      text,
      'manual',
      request.visitorId,
    );

    return {
      message: 'Document indexed successfully',
      chunks,
    };
  }

  @Post('search')
  async search(
    @Body() body: SearchDocumentsDto,
    @Req() request: VisitorRequest,
  ) {
    const query = body.query.trim();

    if (!query) {
      throw new BadRequestException('Query is required');
    }

    const results = await this.vectorStoreService.search(
      query,
      request.visitorId,
    );

    return {
      query,
      results,
    };
  }

  @Post('file')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: maxDocumentSizeBytes },
    }),
  )
  async addFile(
    @UploadedFile() file: Express.Multer.File,
    @Req() request: VisitorRequest,
  ) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    const filename = file.originalname.toLowerCase();
    const isPdf =
      file.mimetype === 'application/pdf' || filename.endsWith('.pdf');
    const isDocx =
      file.mimetype ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      filename.endsWith('.docx');
    const isText = file.mimetype === 'text/plain' || filename.endsWith('.txt');

    if (!isPdf && !isDocx && !isText) {
      throw new BadRequestException(
        'Only PDF, DOCX, and TXT files are supported.',
      );
    }

    if (
      await this.vectorStoreService.hasSource(
        file.originalname,
        request.visitorId,
      )
    ) {
      throw new ConflictException(
        'This filename is already indexed. Delete the existing document before uploading a replacement.',
      );
    }

    let chunks: number;

    if (isPdf || isDocx) {
      const documentBytes = Uint8Array.from(file.buffer);
      const documentBlob = new Blob([documentBytes.buffer], {
        type: isPdf
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });

      const loader = isPdf
        ? new PDFLoader(documentBlob)
        : new DocxLoader(documentBlob, { type: 'docx' });

      let extractedDocuments: Awaited<ReturnType<typeof loader.load>>;

      try {
        extractedDocuments = await loader.load();
      } catch {
        throw new BadRequestException(
          `Could not read this ${isPdf ? 'PDF' : 'DOCX'} file. Make sure it is not corrupted.`,
        );
      }

      if (extractedDocuments.length === 0) {
        throw new BadRequestException('No readable text found in document.');
      }

      const documents = extractedDocuments.map(
        (document) =>
          new Document({
            pageContent: document.pageContent,
            metadata: {
              ...document.metadata,
              source: file.originalname,
            },
          }),
      );

      try {
        chunks = await this.vectorStoreService.addDocuments(
          documents,
          request.visitorId,
        );
      } catch (error) {
        await this.clearPartialUpload(file.originalname, request.visitorId);
        throw error;
      }
    } else {
      const text = file.buffer.toString('utf8');

      if (!text.trim()) {
        throw new BadRequestException('File is empty');
      }

      try {
        chunks = await this.vectorStoreService.addText(
          text,
          file.originalname,
          request.visitorId,
        );
      } catch (error) {
        await this.clearPartialUpload(file.originalname, request.visitorId);
        throw error;
      }
    }

    return {
      message: 'File indexed successfully',
      filename: file.originalname,
      chunks,
    };
  }

  private async clearPartialUpload(
    source: string,
    ownerId: string,
  ): Promise<void> {
    try {
      await this.vectorStoreService.deleteBySource(source, ownerId);
    } catch (cleanupError) {
      this.logger.warn(
        `Could not clean up a partial upload for ${source}.`,
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      );
    }
  }
}
