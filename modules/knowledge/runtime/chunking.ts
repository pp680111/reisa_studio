import { sha256, type ParsedDocument } from './parsing.ts';

/**
 * 确定性分块器（迁移自 skb chunking.py）。
 * token 定义是中文检索效果的关键语义（迁移设计文档 §4.2），不可改动：
 * 单个 CJK 字符 = 1 token；连续英文字母/数字/下划线 = 1 token；其余单个非空白字符 = 1 token。
 */
const TOKEN = /[\u3400-\u4dbf\u4e00-\u9fff]|[A-Za-z0-9_]+|[^\s]/gu;

export const DEFAULT_MAX_TOKENS = 600;
export const DEFAULT_OVERLAP_TOKENS = 80;

export interface TextChunk {
  readonly chunkId: string;
  readonly ordinal: number;
  readonly content: string;
  readonly contentHash: string;
  readonly tokenCount: number;
  readonly sectionPath: string | null;
  readonly lineStart: number;
  readonly lineEnd: number;
}

interface TokenSpan {
  readonly start: number;
  readonly end: number;
}

export class RecursiveChunker {
  readonly #maxTokens: number;
  readonly #overlapTokens: number;

  constructor(options: { maxTokens?: number; overlapTokens?: number } = {}) {
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const overlapTokens = options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
    if (maxTokens < 1) throw new Error('max_tokens must be positive');
    if (overlapTokens < 0 || overlapTokens >= maxTokens) {
      throw new Error('overlap_tokens must be between 0 and max_tokens - 1');
    }
    this.#maxTokens = maxTokens;
    this.#overlapTokens = overlapTokens;
  }

  chunk(document: ParsedDocument, documentKey: string): TextChunk[] {
    const chunks: TextChunk[] = [];
    for (const section of document.sections) {
      const spans: TokenSpan[] = [];
      for (const match of section.content.matchAll(TOKEN)) {
        spans.push({ start: match.index, end: match.index + match[0].length });
      }
      if (spans.length === 0) continue;
      const step = this.#maxTokens - this.#overlapTokens;
      for (let tokenStart = 0; tokenStart < spans.length; tokenStart += step) {
        const selected = spans.slice(tokenStart, tokenStart + this.#maxTokens);
        if (selected.length === 0) break;
        const charStart = selected[0]?.start ?? 0;
        const charEnd = selected[selected.length - 1]?.end ?? 0;
        const content = section.content.slice(charStart, charEnd);
        const ordinal = chunks.length;
        const contentHash = sha256(content);
        const identity = `${documentKey}:${document.contentHash}:${ordinal}:${contentHash}`;
        chunks.push({
          chunkId: sha256(identity),
          ordinal,
          content,
          contentHash,
          tokenCount: selected.length,
          sectionPath: section.sectionPath,
          lineStart: section.startLine + countNewlines(section.content, charStart),
          lineEnd: section.startLine + countNewlines(section.content, charEnd),
        });
        if (tokenStart + this.#maxTokens >= spans.length) break;
      }
    }
    return chunks;
  }
}

function countNewlines(text: string, end: number): number {
  let count = 0;
  for (let i = 0; i < end; i += 1) if (text[i] === '\n') count += 1;
  return count;
}
