import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

export interface AttachmentMeta {
  readonly id: string;
  readonly conversationId: string;
  readonly name: string;
  readonly mediaType?: string;
  readonly size: number;
  readonly path: string;
  readonly createdAt: number;
}

export interface SaveAttachmentInput {
  readonly name: string;
  readonly mediaType?: string;
  readonly data: Buffer;
}

/**
 * 主应用会话存储（架构设计 §7.1、§7.4）：会话、消息、附件与工具交互记录归主应用所有。
 * 附件保存在主应用自己的附件目录，属本次输入的副本；不进入任何模块的私有文件库。
 */
export class ConversationStore {
  readonly #db: DatabaseSync;
  readonly #attachmentsDir: string;

  private constructor(db: DatabaseSync, attachmentsDir: string) {
    this.#db = db;
    this.#attachmentsDir = attachmentsDir;
  }

  static async open(filePath: string, attachmentsDir?: string): Promise<ConversationStore> {
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
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        name TEXT NOT NULL,
        media_type TEXT,
        size INTEGER NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
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
    return new ConversationStore(db, attachmentsDir ?? join(dirname(filePath), 'attachments'));
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

  listConversations(limit?: number, offset = 0): readonly ConversationSummary[] {
    const statement =
      limit === undefined
        ? this.#db.prepare(
            'SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT -1 OFFSET ?',
          )
        : this.#db.prepare(
            'SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT ? OFFSET ?',
          );
    const rows = limit === undefined ? statement.all(offset) : statement.all(limit, offset);
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  /** 保存用户提供的附件：副本写入主应用附件目录，并登记元数据。 */
  async saveAttachment(
    conversationId: string,
    input: SaveAttachmentInput,
  ): Promise<AttachmentMeta> {
    const id = `att_${randomUUID()}`;
    const safeName = input.name.replace(/[\\/:*?"<>|]/g, '_');
    const target = join(this.#attachmentsDir, conversationId, `${id}-${safeName}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, input.data);
    const meta: AttachmentMeta = {
      id,
      conversationId,
      name: input.name,
      ...(input.mediaType ? { mediaType: input.mediaType } : {}),
      size: input.data.byteLength,
      path: target,
      createdAt: Date.now(),
    };
    this.#db
      .prepare(
        'INSERT INTO attachments (id, conversation_id, name, media_type, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        meta.id,
        meta.conversationId,
        meta.name,
        meta.mediaType ?? null,
        meta.size,
        meta.path,
        meta.createdAt,
      );
    return meta;
  }

  listAttachments(conversationId: string): readonly AttachmentMeta[] {
    return this.#db
      .prepare(
        'SELECT id, conversation_id, name, media_type, size, path, created_at FROM attachments WHERE conversation_id = ? ORDER BY created_at',
      )
      .all(conversationId)
      .map((row) => ({
        id: String(row.id),
        conversationId: String(row.conversation_id),
        name: String(row.name),
        mediaType: row.media_type === null ? undefined : String(row.media_type),
        size: Number(row.size),
        path: String(row.path),
        createdAt: Number(row.created_at),
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

  /** 删除会话及其消息、附件与工具记录；属主应用数据操作，不影响任何模块数据。 */
  async deleteConversation(conversationId: string): Promise<void> {
    this.#db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
    this.#db.prepare('DELETE FROM attachments WHERE conversation_id = ?').run(conversationId);
    this.#db.prepare('DELETE FROM tool_records WHERE conversation_id = ?').run(conversationId);
    this.#db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId);
    await rm(join(this.#attachmentsDir, conversationId), { recursive: true, force: true });
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
