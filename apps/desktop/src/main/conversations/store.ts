import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ModelMessage } from 'ai';

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export const DEFAULT_CONVERSATION_TITLE = '新会话';

export interface ToolRecordInput {
  readonly invocationId: string;
  readonly toolName: string;
  readonly status: 'success' | 'error';
  readonly errorCode?: string;
}

export interface ToolRecord extends ToolRecordInput {
  readonly conversationId: string;
  readonly createdAt: number;
}

/**
 * 主应用会话存储（架构设计 §7.1、§7.4）：会话、消息与工具交互记录归主应用所有。
 * 保存的是已返回数据的副本；不授予对模块原始数据的持续访问。
 */
export class ConversationStore {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static async open(filePath: string): Promise<ConversationStore> {
    await mkdir(dirname(filePath), { recursive: true });
    const db = new DatabaseSync(filePath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, seq);
      CREATE TABLE IF NOT EXISTS tool_records (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    return new ConversationStore(db);
  }

  createConversation(title = DEFAULT_CONVERSATION_TITLE): ConversationSummary {
    const now = Date.now();
    const summary: ConversationSummary = {
      id: `conv_${randomUUID()}`,
      title,
      createdAt: now,
      updatedAt: now,
    };
    this.#db
      .prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(summary.id, summary.title, summary.createdAt, summary.updatedAt);
    return summary;
  }

  listConversations(): readonly ConversationSummary[] {
    return this.#db
      .prepare(
        'SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC',
      )
      .all()
      .map((row) => ({
        id: String(row.id),
        title: String(row.title),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      }));
  }

  /** 读取会话完整历史；消息 content 为框架 ModelMessage 的 JSON 副本。 */
  getMessages(conversationId: string): ModelMessage[] {
    return this.#db
      .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY seq')
      .all(conversationId)
      .map(
        (row) =>
          ({ role: String(row.role), content: JSON.parse(String(row.content)) }) as ModelMessage,
      );
  }

  getConversation(conversationId: string): ConversationSummary | undefined {
    const row = this.#db
      .prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?')
      .get(conversationId);
    if (!row) return undefined;
    return {
      id: String(row.id),
      title: String(row.title),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  renameConversation(conversationId: string, title: string): void {
    this.#db
      .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, Date.now(), conversationId);
  }

  /** 删除会话及其消息与工具记录；属主应用数据操作，不影响任何模块数据。 */
  deleteConversation(conversationId: string): void {
    this.#db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
    this.#db.prepare('DELETE FROM tool_records WHERE conversation_id = ?').run(conversationId);
    this.#db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId);
  }

  appendMessages(conversationId: string, messages: readonly ModelMessage[]): void {
    const now = Date.now();
    const nextSeq = this.#nextSeq(conversationId);
    const insert = this.#db.prepare(
      'INSERT INTO messages (id, conversation_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    messages.forEach((message, index) => {
      insert.run(
        `msg_${randomUUID()}`,
        conversationId,
        nextSeq + index,
        message.role,
        JSON.stringify(message.content),
        now,
      );
    });
    this.touch(conversationId);
  }

  recordTool(conversationId: string, record: ToolRecordInput): void {
    this.#db
      .prepare(
        'INSERT INTO tool_records (id, conversation_id, invocation_id, tool_name, status, error_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        `tool_${randomUUID()}`,
        conversationId,
        record.invocationId,
        record.toolName,
        record.status,
        record.errorCode ?? null,
        Date.now(),
      );
  }

  listToolRecords(conversationId: string): readonly ToolRecord[] {
    return this.#db
      .prepare(
        'SELECT conversation_id, invocation_id, tool_name, status, error_code, created_at FROM tool_records WHERE conversation_id = ? ORDER BY created_at',
      )
      .all(conversationId)
      .map((row) => ({
        conversationId: String(row.conversation_id),
        invocationId: String(row.invocation_id),
        toolName: String(row.tool_name),
        status: String(row.status) as 'success' | 'error',
        errorCode: row.error_code === null ? undefined : String(row.error_code),
        createdAt: Number(row.created_at),
      }));
  }

  touch(conversationId: string): void {
    this.#db
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(Date.now(), conversationId);
  }

  #nextSeq(conversationId: string): number {
    const row = this.#db
      .prepare('SELECT COALESCE(MAX(seq), -1) AS max_seq FROM messages WHERE conversation_id = ?')
      .get(conversationId);
    return Number(row?.max_seq ?? -1) + 1;
  }
}
