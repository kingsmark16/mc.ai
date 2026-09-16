import { Injectable } from '@nestjs/common';
import { ChatGoogle } from '@langchain/google/node';
import { ConfigService } from '@nestjs/config';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';

export type ChatHistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type AiDocument = {
  content: string;
  metadata: Record<string, any>;
};

const multiDocumentGroupCharacters = 24_000;

@Injectable()
export class AiService {
  private readonly model: ChatGoogle;

  private readonly answerSystemPrompt = `You are an expert document analyst and a thorough question-answering assistant.

Use only the supplied document context to answer the user's question.

Use the conversation history only to understand follow-up questions.
Use the document context for every factual claim. Synthesize information
across all relevant context sections instead of relying on only the first
matching passage.

Give a detailed, complete answer by default. Start with a direct answer, then
explain the relevant details, reasoning, steps, examples, conditions,
exceptions, and implications that are supported by the documents. If the
question has multiple parts, answer every part. Use clear Markdown headings,
numbered steps, bullet points, or a table when they make the explanation
easier to follow.

Preserve important names, dates, numbers, definitions, requirements, and
relationships from the documents. Do not reduce a substantial answer to a
short paragraph when the context contains more relevant information. Match
the length to the question: be concise for a simple fact, but for broad or
explanatory questions provide several well-developed paragraphs or sections.
Do not add filler just to make the answer longer.

Do not add facts from outside the context. If the context does not contain
enough information, clearly say:
"I don't know based on the provided documents."

When available, mention the source filename and page number for important
claims.

Document context:
{context}`;

  constructor(private readonly configService: ConfigService) {
    this.model = new ChatGoogle({
      model:
        this.configService.get<string>('GOOGLE_MODEL') ??
        'gemini-3.1-flash-lite',
      apiKey: this.configService.getOrThrow<string>('GOOGLE_API_KEY'),
      maxOutputTokens: 8_192,
      temperature: 0.2,
      maxRetries: 0,
    });
  }

  async ask(question: string): Promise<string> {
    const response = await this.model.invoke([new HumanMessage(question)]);

    return response.text;
  }

  async askWithContext(
    question: string,
    context: string,
    history: ChatHistoryMessage[] = [],
  ): Promise<string> {
    const prompt = ChatPromptTemplate.fromMessages([
      ['system', this.answerSystemPrompt],
      new MessagesPlaceholder('history'),
      ['human', '{question}'],
    ]);

    const chain = prompt.pipe(this.model).pipe(new StringOutputParser());

    return chain.invoke({
      question,
      context,
      history: history.map((message) =>
        message.role === 'user'
          ? new HumanMessage(message.content)
          : new AIMessage(message.content),
      ),
    });
  }

  async *streamWithContext(
    question: string,
    context: string,
    history: ChatHistoryMessage[] = [],
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const prompt = ChatPromptTemplate.fromMessages([
      ['system', this.answerSystemPrompt],
      new MessagesPlaceholder('history'),
      ['human', '{question}'],
    ]);

    const chain = prompt.pipe(this.model).pipe(new StringOutputParser());
    const stream = await chain.stream(
      {
        question,
        context,
        history: history.map((message) =>
          message.role === 'user'
            ? new HumanMessage(message.content)
            : new AIMessage(message.content),
        ),
      },
      { signal },
    );

    for await (const chunk of stream) {
      yield chunk;
    }
  }

  async askAcrossDocuments(
    question: string,
    documents: AiDocument[],
    history: ChatHistoryMessage[] = [],
  ): Promise<string> {
    const groups = this.groupDocumentContext(documents);

    if (groups.length === 0) {
      return 'I do not have any relevant documents.';
    }

    let context = groups[0];

    if (groups.length > 1) {
      const sectionAnalyses: string[] = [];

      for (const group of groups) {
        sectionAnalyses.push(
          await this.runMultiDocumentPrompt(question, group, history, false),
        );
      }

      context = sectionAnalyses.join('\n\n');
    }

    return this.runMultiDocumentPrompt(question, context, history, true);
  }

  async *streamAcrossDocuments(
    question: string,
    documents: AiDocument[],
    history: ChatHistoryMessage[] = [],
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    if (signal?.aborted) {
      return;
    }

    const groups = this.groupDocumentContext(documents);

    if (groups.length === 0) {
      yield 'I do not have any relevant documents.';
      return;
    }

    let context = groups[0];

    if (groups.length > 1) {
      const sectionAnalyses: string[] = [];

      for (const group of groups) {
        if (signal?.aborted) {
          return;
        }

        sectionAnalyses.push(
          await this.runMultiDocumentPrompt(
            question,
            group,
            history,
            false,
            signal,
          ),
        );
      }

      context = sectionAnalyses.join('\n\n');
    }

    yield* this.streamMultiDocumentPrompt(question, context, history, signal);
  }

  async summarizeDocuments(
    documents: Array<{
      content: string;
      metadata: Record<string, any>;
    }>,
  ): Promise<string> {
    const formattedDocuments = documents.map((document) => {
      const source = String(document.metadata?.source ?? 'unknown');
      const page = document.metadata?.loc?.pageNumber;
      const location = page ? `, page ${page}` : '';

      return `Source (${source}${location}):\n${document.content}`;
    });

    const maxGroupCharacters = 30_000;
    const groups: string[][] = [];
    let currentGroup: string[] = [];
    let currentLength = 0;

    for (const document of formattedDocuments) {
      if (
        currentGroup.length > 0 &&
        currentLength + document.length > maxGroupCharacters
      ) {
        groups.push(currentGroup);
        currentGroup = [];
        currentLength = 0;
      }

      currentGroup.push(document);
      currentLength += document.length;
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    if (groups.length === 1) {
      return this.runSummaryPrompt(groups[0].join('\n\n'), true);
    }

    const partialSummaries: string[] = [];

    for (const group of groups) {
      partialSummaries.push(
        await this.runSummaryPrompt(group.join('\n\n'), false),
      );
    }

    return this.runSummaryPrompt(partialSummaries.join('\n\n'), true);
  }

  async *streamSummaryDocuments(
    documents: Array<{
      content: string;
      metadata: Record<string, any>;
    }>,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const formattedDocuments = documents.map((document) => {
      const source = String(document.metadata?.source ?? 'unknown');
      const page = document.metadata?.loc?.pageNumber;
      const location = page ? `, page ${page}` : '';

      return `Source (${source}${location}):\n${document.content}`;
    });

    const maxGroupCharacters = 30_000;
    const groups: string[][] = [];
    let currentGroup: string[] = [];
    let currentLength = 0;

    for (const document of formattedDocuments) {
      if (
        currentGroup.length > 0 &&
        currentLength + document.length > maxGroupCharacters
      ) {
        groups.push(currentGroup);
        currentGroup = [];
        currentLength = 0;
      }

      currentGroup.push(document);
      currentLength += document.length;
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    if (groups.length === 1) {
      yield* this.streamSummaryPrompt(groups[0].join('\n\n'), true, signal);
      return;
    }

    const partialSummaries: string[] = [];

    for (const group of groups) {
      if (signal?.aborted) {
        return;
      }

      partialSummaries.push(
        await this.runSummaryPrompt(group.join('\n\n'), false, signal),
      );
    }

    yield* this.streamSummaryPrompt(
      partialSummaries.join('\n\n'),
      true,
      signal,
    );
  }

  private groupDocumentContext(documents: AiDocument[]): string[] {
    const groups: string[] = [];
    let currentGroup = '';

    for (const document of documents) {
      const source = String(document.metadata?.source ?? 'unknown');
      const page = document.metadata?.loc?.pageNumber;
      const location = page ? `, page ${page}` : '';
      const formattedDocument = `Source (${source}${location}):\n${document.content}`;
      const separator = currentGroup ? '\n\n' : '';

      if (
        currentGroup &&
        currentGroup.length + separator.length + formattedDocument.length >
          multiDocumentGroupCharacters
      ) {
        groups.push(currentGroup);
        currentGroup = '';
      }

      currentGroup += (currentGroup ? '\n\n' : '') + formattedDocument;
    }

    if (currentGroup) {
      groups.push(currentGroup);
    }

    return groups;
  }

  private async runMultiDocumentPrompt(
    question: string,
    context: string,
    history: ChatHistoryMessage[],
    isFinal: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    const prompt = ChatPromptTemplate.fromMessages([
      ['system', this.getMultiDocumentSystemPrompt(isFinal)],
      ['human', '{question}'],
    ]);
    const chain = prompt.pipe(this.model).pipe(new StringOutputParser());
    const input = {
      question: this.formatQuestionWithHistory(question, history),
      context,
    };

    return signal ? chain.invoke(input, { signal }) : chain.invoke(input);
  }

  private async *streamMultiDocumentPrompt(
    question: string,
    context: string,
    history: ChatHistoryMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const prompt = ChatPromptTemplate.fromMessages([
      ['system', this.getMultiDocumentSystemPrompt(true)],
      ['human', '{question}'],
    ]);
    const chain = prompt.pipe(this.model).pipe(new StringOutputParser());
    const input = {
      question: this.formatQuestionWithHistory(question, history),
      context,
    };
    const stream = signal
      ? await chain.stream(input, { signal })
      : await chain.stream(input);

    for await (const chunk of stream) {
      yield chunk;
    }
  }

  private formatQuestionWithHistory(
    question: string,
    history: ChatHistoryMessage[],
  ): string {
    const recentHistory = history.slice(-4);

    if (recentHistory.length === 0) {
      return question;
    }

    const formattedHistory = recentHistory
      .map((message) => `${message.role}: ${message.content}`)
      .join('\n');

    return `Question:\n${question}\n\nRecent conversation (use only to resolve follow-up references):\n${formattedHistory}`;
  }

  private getMultiDocumentSystemPrompt(isFinal: boolean): string {
    if (!isFinal) {
      return `You are analyzing one section from a document selected by the user.

Use only the supplied section and the user's question. Extract every fact that
could help answer the question, including definitions, requirements,
procedures, examples, conditions, exceptions, dates, numbers, and relationships.
Preserve the source filename and page number when present. Do not use outside
knowledge, invent missing details, or discard relevant information merely to be
brief. These notes will be combined with analyses from the other selected
documents.

If the section contains no information relevant to the question, say that
clearly. Otherwise, write dense, well-structured factual notes.

Document section:
{context}`;
    }

    return `You are an expert multi-document analyst and a meticulous question-answering assistant.

Use only the supplied document content or section analyses. Answer the user's
question with a very detailed and complete response. The selected documents
are the complete scope of this request.

Coverage is required: address every selected document represented in the
context. Use a separate heading or clearly labeled subsection for each source
when appropriate, then add a comparison or synthesis section when the question
benefits from it. Do not let one document replace another, and do not merge
different documents into an unattributed generalization. If a selected source
does not contain relevant information, state that explicitly.

Preserve all supported names, dates, numbers, definitions, requirements,
procedures, examples, conditions, exceptions, risks, and conclusions. Explain
important relationships and differences. Attribute factual claims to the
source filename and page number whenever available. Answer every part of a
multi-part question. If the supplied documents do not provide enough
information, say: "I don't know based on the provided documents."

Use clear Markdown headings, bullet points, numbered steps, and comparison
tables when they improve completeness. Be thorough rather than brief, but do
not add filler or outside knowledge.

Document content or section analyses:
{context}`;
  }

  private async runSummaryPrompt(
    context: string,
    isFinalSummary: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    const prompt = ChatPromptTemplate.fromMessages([
      ['system', this.getSummarySystemPrompt(isFinalSummary)],
      [
        'human',
        isFinalSummary
          ? 'Write a detailed final document summary.'
          : 'Write detailed notes for this document section.',
      ],
    ]);

    const chain = prompt.pipe(this.model).pipe(new StringOutputParser());

    return chain.invoke({ context }, { signal });
  }

  private async *streamSummaryPrompt(
    context: string,
    isFinalSummary: boolean,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const prompt = ChatPromptTemplate.fromMessages([
      ['system', this.getSummarySystemPrompt(isFinalSummary)],
      [
        'human',
        isFinalSummary
          ? 'Write a detailed final document summary.'
          : 'Write detailed notes for this document section.',
      ],
    ]);

    const chain = prompt.pipe(this.model).pipe(new StringOutputParser());
    const stream = await chain.stream({ context }, { signal });

    for await (const chunk of stream) {
      yield chunk;
    }
  }

  private getSummarySystemPrompt(isFinalSummary: boolean): string {
    if (isFinalSummary) {
      return `You are an expert document summarization assistant.

Use only the supplied document content or section summaries. Create a detailed,
accurate, and well-structured summary rather than a short abstract.

Begin with a concise executive summary. Then organize the available
information under useful headings such as purpose and scope, major topics,
important facts, procedures or requirements, examples, risks or limitations,
and conclusions. Include a heading only when the supplied content supports it.
When the content comes from multiple selected files, include a clearly labeled
section for every source before synthesizing shared themes, differences, and
relationships. Do not omit a selected source because another source is more
substantial.
Preserve specific names, dates, numbers, definitions, decisions, conditions,
exceptions, and relationships. Explain how the major parts fit together and
identify the most important takeaways for someone who has not read the full
document.

For a substantial document, aim for a comprehensive response of roughly
1,200-2,500 words when the supplied content supports that level of detail. Do
not pad the answer or invent information to reach a word count. Do not omit
important details merely to keep the summary short.

Do not use outside knowledge. Clearly distinguish conclusions stated in the
document from reasonable explanations supported by it. Mention source
filenames and page numbers when available.

Document content or section summaries:
{context}`;
    }

    return `You are creating detailed notes for one section of a document.

Use only the supplied section content. Extract and explain the important
topics, facts, definitions, names, dates, numbers, requirements, procedures,
examples, conditions, exceptions, and conclusions present in this section.
Preserve enough detail for a later model to combine these notes into a
complete document summary. Do not compress the section into a vague or
one-sentence description, and do not invent information or add outside
knowledge.

Use clear headings or bullet points when useful. Preserve source filenames and
page numbers when available.

Document section:
{context}`;
  }
}
