import type { ModuleLogger } from '@reisa/module-sdk';
import type { EmbeddingRequestEvent } from './embedding.ts';
import {
  utcNow,
  type EmbeddingCallInput,
  type EmbeddingCallItemInput,
  type MetadataDB,
} from './db.ts';

/**
 * 索引类 embedding 接口调用记录器（设计文档 docs/knowledge-embedding-call-log.md）。
 * 记录粒度是"每一次真实发生的接口请求"（含子批切分与每一次重试），
 * 由 OpenAICompatibleEmbeddingClient 的 onRequest 钩子逐请求驱动；
 * 旁路写入：recordRequest() 内部整体吞错只 warn，绝不影响请求流程。
 */

const CONTENT_PREVIEW_CHARS = 120;
const PRUNE_EVERY_RECORDS = 100;
const DAY_MS = 86_400_000;

/**
 * 保留期截止时间；retentionDays <= 0 表示永久保留（返回 null，不清理）。
 * activate 清理与 Recorder 周期清理共用，保证同一语义。
 */
export function embeddingCallCutoffIso(retentionDays: number): string | null {
  if (!(retentionDays > 0)) return null;
  return new Date(Date.now() - retentionDays * DAY_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 按码点截断，避免切断代理对（emoji 等）产生无效 UTF-16。 */
export function contentPreview(content: string): string {
  const chars = Array.from(content);
  return chars.length <= CONTENT_PREVIEW_CHARS
    ? content
    : chars.slice(0, CONTENT_PREVIEW_CHARS).join('');
}

export class EmbeddingCallRecorder {
  readonly #database: MetadataDB;
  readonly #retentionDays: number;
  readonly #logger: ModuleLogger | undefined;
  #writes = 0;

  constructor(options: {
    database: MetadataDB;
    /** 保留天数；0 = 永久保留（与 EmbeddingCallLogSettings.retentionDays 同源）。 */
    retentionDays: number;
    logger?: ModuleLogger;
  }) {
    this.#database = options.database;
    this.#retentionDays = options.retentionDays;
    this.#logger = options.logger;
  }

  /**
   * 落库一次接口请求；同步方法（DatabaseSync 同步 API），内部整体 try/catch，绝不抛出。
   * 仅记录索引调用：context 携带文档身份且 items 与请求文本对齐；检索/连接测试无上下文，跳过。
   */
  recordRequest(event: EmbeddingRequestEvent): void {
    try {
      const context = event.context;
      if (
        context?.documentId === undefined ||
        event.items === undefined ||
        event.items.length === 0
      ) {
        return;
      }
      const id = crypto.randomUUID().replaceAll('-', '');
      const call: EmbeddingCallInput = {
        id,
        triggeredAt: utcNow(),
        status: event.status,
        model: event.model,
        roundId: event.roundId,
        batchIndex: event.batchIndex,
        attempt: event.attempt,
        textCount: event.texts.length,
        tokenCount: event.tokenCount,
        durationMs: event.latencyMs,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
        documentId: context.documentId,
        relPath: context.relPath ?? '',
        documentName: context.documentName ?? '',
      };
      const items: EmbeddingCallItemInput[] = event.texts.map((text, textIndex) => {
        const item = event.items?.[textIndex];
        return {
          callId: id,
          textIndex,
          chunkId: item?.chunkId ?? null,
          ordinal: item?.ordinal ?? null,
          contentHash: item?.contentHash ?? null,
          contentPreview: contentPreview(text),
          tokenCount: item?.tokenCount ?? null,
          sectionPath: item?.sectionPath ?? null,
          lineStart: item?.lineStart ?? null,
          lineEnd: item?.lineEnd ?? null,
        };
      });
      this.#database.insertEmbeddingCall(call, items);
      this.#writes += 1;
      if (this.#writes % PRUNE_EVERY_RECORDS === 0) this.#prune();
    } catch (error) {
      this.#logger?.warn('embedding_call_log_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #prune(): void {
    const cutoff = embeddingCallCutoffIso(this.#retentionDays);
    if (cutoff === null) return;
    try {
      this.#database.deleteEmbeddingCallsBefore(cutoff);
    } catch (error) {
      this.#logger?.warn('embedding_call_log_prune_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
