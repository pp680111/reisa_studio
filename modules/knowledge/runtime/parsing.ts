import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * 文档解析（迁移自 skb parsing.py）：仅支持 UTF-8 的 .md / .txt。
 * 解析语义必须与 skb 保持一致——迁移设计文档 §4.2 是行为基准。
 */

export const SUPPORTED_SUFFIXES = new Set<string>(['.md', '.txt']);

const MARKDOWN_HEADING = /^(#{1,6})\s+(.+?)\s*$/;

/** Unicode "Other" 类别（Cc/Cf/Cs/Co/Cn），对应 Python unicodedata.category 以 C 开头。 */
const CONTROL = /\p{C}/u;

export interface ParsedSection {
  readonly content: string;
  readonly sectionPath: string | null;
  readonly startLine: number;
  readonly startChar: number;
}

export interface ParsedDocument {
  readonly displayName: string;
  readonly mimeType: string;
  readonly contentHash: string;
  readonly sections: readonly ParsedSection[];
}

export function isSupportedDocument(path: string): boolean {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot >= 0 && SUPPORTED_SUFFIXES.has(name.slice(dot));
}

export function normalizeText(text: string): string {
  const unified = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const normalized = unified.normalize('NFC');
  let out = '';
  for (const char of normalized) {
    if (char === '\n' || char === '\t' || !CONTROL.test(char)) out += char;
  }
  return out;
}

export async function parseDocument(path: string): Promise<ParsedDocument> {
  const bytes = await readFile(path);
  // utf-8-sig：容忍 BOM；非 UTF-8 会抛 TypeError（对应 skb 的 UnicodeDecodeError 路径）
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(stripBom(bytes));
  const content = normalizeText(raw);
  const lower = basename(path).toLowerCase();
  if (lower.endsWith('.md')) return parseMarkdown(basename(path), content);
  return parseText(basename(path), content);
}

function stripBom(bytes: Buffer): Buffer {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.subarray(3)
    : bytes;
}

function parseText(displayName: string, content: string): ParsedDocument {
  const sections: ParsedSection[] = [];
  const trimmed = content.trim();
  if (trimmed) {
    const startChar = content.indexOf(trimmed);
    sections.push({
      content: trimmed,
      sectionPath: null,
      startLine: 1 + countNewlines(content, startChar),
      startChar,
    });
  }
  return { displayName, mimeType: 'text/plain', contentHash: sha256(content), sections };
}

function parseMarkdown(displayName: string, content: string): ParsedDocument {
  const lines = content.split('\n');
  const headings: string[] = [];
  const sections: ParsedSection[] = [];
  let body: string[] = [];
  let bodyStart = 1;
  let bodyStartChar = 0;
  let lineStartChar = 0;

  const flush = (): void => {
    const rawContent = body.join('\n');
    const sectionContent = rawContent.trim();
    if (sectionContent) {
      const leadingChars = rawContent.indexOf(sectionContent);
      sections.push({
        content: sectionContent,
        sectionPath: headings.length > 0 ? headings.join(' > ') : null,
        startLine: bodyStart + countNewlines(rawContent, leadingChars),
        startChar: bodyStartChar + leadingChars,
      });
    }
    body = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;
    const match = MARKDOWN_HEADING.exec(line);
    if (match === null) {
      body.push(line);
      lineStartChar += line.length + 1;
      continue;
    }
    flush();
    const level = (match[1] as string).length;
    const heading = (match[2] as string).trim();
    // 低级标题截断高级标题（skb 标题栈语义）
    headings.length = level - 1;
    headings.push(heading);
    bodyStart = lineNumber + 1;
    lineStartChar += line.length + 1;
    bodyStartChar = lineStartChar;
  }
  flush();

  return { displayName, mimeType: 'text/markdown', contentHash: sha256(content), sections };
}

function countNewlines(text: string, end: number): number {
  let count = 0;
  for (let i = 0; i < end; i += 1) if (text[i] === '\n') count += 1;
  return count;
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
