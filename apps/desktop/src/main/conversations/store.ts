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
  /** 会话绑定的角色；NULL = 默认助手（使用全局默认提示词）。创建时固定，不可切换。 */
  readonly roleId?: string;
}

export const DEFAULT_CONVERSATION_TITLE = '新会话';

/** 角色删除被拒原因：会话仍绑定该角色（提示改用停用）。 */
export class RoleInUseError extends Error {
  readonly referencedBy: number;

  constructor(referencedBy: number) {
    super(`该角色仍被 ${referencedBy} 个会话使用，请改用停用`);
    this.name = 'RoleInUseError';
    this.referencedBy = referencedBy;
  }
}

/** 角色删除/修改被拒原因：内置角色不可变更。 */
export class RoleImmutableError extends Error {
  constructor() {
    super('内置角色不可修改或删除，可复制为自定义角色后调整');
    this.name = 'RoleImmutableError';
  }
}

export interface Role {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  /** 注入时把全局默认提示词拼在角色 prompt 之前。 */
  readonly includeBasePrompt: boolean;
  readonly builtin: boolean;
  /** 停用后不进新建选择器，仍服务已绑定会话。 */
  readonly disabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateRoleInput {
  readonly name: string;
  readonly description?: string;
  readonly prompt: string;
  readonly includeBasePrompt?: boolean;
  readonly builtin?: boolean;
}

export interface UpdateRoleInput {
  readonly name?: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly includeBasePrompt?: boolean;
  readonly disabled?: boolean;
}

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
      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL DEFAULT '',
        include_base_prompt INTEGER NOT NULL DEFAULT 0,
        builtin INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
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
    const store = new ConversationStore(db, attachmentsDir ?? join(dirname(filePath), 'attachments'));
    store.#migrateConversationsRoleId();
    return store;
  }

  /** 旧库升级：conversations 表补 role_id 列（CREATE TABLE IF NOT EXISTS 不会改已有表结构）。 */
  #migrateConversationsRoleId(): void {
    const columns = this.#db.prepare('PRAGMA table_info(conversations)').all() as {
      name: unknown;
    }[];
    if (columns.some((column) => column.name === 'role_id')) return;
    this.#db.exec('ALTER TABLE conversations ADD COLUMN role_id TEXT');
  }

  createConversation(title = DEFAULT_CONVERSATION_TITLE, roleId?: string): ConversationSummary {
    if (roleId !== undefined) {
      const role = this.getRole(roleId);
      if (role === undefined) throw new Error('所选角色不存在');
      if (role.disabled) throw new Error('所选角色已停用，不能用于新会话');
    }
    const now = Date.now();
    const summary: ConversationSummary = {
      id: `conv_${randomUUID()}`,
      title,
      createdAt: now,
      updatedAt: now,
      ...(roleId !== undefined ? { roleId } : {}),
    };
    this.#db
      .prepare(
        'INSERT INTO conversations (id, title, created_at, updated_at, role_id) VALUES (?, ?, ?, ?, ?)',
      )
      .run(summary.id, summary.title, summary.createdAt, summary.updatedAt, roleId ?? null);
    return summary;
  }

  listConversations(limit?: number, offset = 0): readonly ConversationSummary[] {
    const statement =
      limit === undefined
        ? this.#db.prepare(
            'SELECT id, title, created_at, updated_at, role_id FROM conversations ORDER BY updated_at DESC LIMIT -1 OFFSET ?',
          )
        : this.#db.prepare(
            'SELECT id, title, created_at, updated_at, role_id FROM conversations ORDER BY updated_at DESC LIMIT ? OFFSET ?',
          );
    const rows = limit === undefined ? statement.all(offset) : statement.all(limit, offset);
    return rows.map((row) => toSummary(row));
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
      .prepare('SELECT id, title, created_at, updated_at, role_id FROM conversations WHERE id = ?')
      .get(conversationId);
    if (!row) return undefined;
    return toSummary(row);
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

  // ---- 角色：新建会话时选定后不可切换；管理面见 IPC roles/* ----

  listRoles(): readonly Role[] {
    return (this.#db.prepare('SELECT * FROM roles ORDER BY builtin DESC, created_at').all() as unknown as Record<string, unknown>[]).map(toRole);
  }

  getRole(roleId: string): Role | undefined {
    const row = this.#db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
    return row ? toRole(row as unknown as Record<string, unknown>) : undefined;
  }

  countConversationsWithRole(roleId: string): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS count FROM conversations WHERE role_id = ?')
      .get(roleId);
    return Number((row as { count: unknown } | undefined)?.count ?? 0);
  }

  createRole(input: CreateRoleInput): Role {
    const name = input.name.trim();
    if (name === '') throw new Error('角色名称不能为空');
    const now = Date.now();
    const role: Role = {
      id: `role_${randomUUID()}`,
      name,
      description: input.description?.trim() ?? '',
      prompt: input.prompt,
      includeBasePrompt: input.includeBasePrompt === true,
      builtin: input.builtin === true,
      disabled: false,
      createdAt: now,
      updatedAt: now,
    };
    this.#db
      .prepare(
        'INSERT INTO roles (id, name, description, prompt, include_base_prompt, builtin, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        role.id,
        role.name,
        role.description,
        role.prompt,
        role.includeBasePrompt ? 1 : 0,
        role.builtin ? 1 : 0,
        0,
        role.createdAt,
        role.updatedAt,
      );
    return role;
  }

  updateRole(roleId: string, patch: UpdateRoleInput): Role {
    const existing = this.getRole(roleId);
    if (existing === undefined) throw new Error('角色不存在');
    if (existing.builtin) throw new RoleImmutableError();
    const next: Role = {
      ...existing,
      name: patch.name !== undefined ? patch.name.trim() : existing.name,
      description: patch.description !== undefined ? patch.description.trim() : existing.description,
      prompt: patch.prompt !== undefined ? patch.prompt : existing.prompt,
      includeBasePrompt:
        patch.includeBasePrompt !== undefined ? patch.includeBasePrompt : existing.includeBasePrompt,
      disabled: patch.disabled !== undefined ? patch.disabled : existing.disabled,
      updatedAt: Date.now(),
    };
    if (next.name === '') throw new Error('角色名称不能为空');
    this.#db
      .prepare(
        'UPDATE roles SET name = ?, description = ?, prompt = ?, include_base_prompt = ?, disabled = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        next.name,
        next.description,
        next.prompt,
        next.includeBasePrompt ? 1 : 0,
        next.disabled ? 1 : 0,
        next.updatedAt,
        roleId,
      );
    return next;
  }

  /** 删除角色：内置不可删；仍被会话绑定时报 RoleInUseError（提示改用停用）。 */
  deleteRole(roleId: string): void {
    const existing = this.getRole(roleId);
    if (existing === undefined) throw new Error('角色不存在');
    if (existing.builtin) throw new RoleImmutableError();
    const referenced = this.countConversationsWithRole(roleId);
    if (referenced > 0) throw new RoleInUseError(referenced);
    this.#db.prepare('DELETE FROM roles WHERE id = ?').run(roleId);
  }

  /**
   * 播种内置角色：缺失则插入（id 固定为种子 key）；已存在则把 prompt 重置为
   * 代码内版本（内置角色不可被用户编辑，覆盖无冲突，便于随版本修复文案）。
   */
  seedBuiltinRoles(seeds: readonly { key: string; input: CreateRoleInput }[]): void {
    const now = Date.now();
    const insert = this.#db.prepare(
      'INSERT OR IGNORE INTO roles (id, name, description, prompt, include_base_prompt, builtin, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 1, 0, ?, ?)',
    );
    const resetBuiltin = this.#db.prepare(
      'UPDATE roles SET name = ?, description = ?, prompt = ?, updated_at = ? WHERE id = ? AND builtin = 1',
    );
    for (const seed of seeds) {
      insert.run(
        seed.key,
        seed.input.name,
        seed.input.description?.trim() ?? '',
        seed.input.prompt,
        now,
        now,
      );
      resetBuiltin.run(
        seed.input.name,
        seed.input.description?.trim() ?? '',
        seed.input.prompt,
        now,
        seed.key,
      );
    }
  }

  /** 关闭数据库连接（宿主退出与测试清理用）。 */
  close(): void {
    this.#db.close();
  }

  #nextSeq(conversationId: string): number {
    const row = this.#db
      .prepare('SELECT COALESCE(MAX(seq), -1) AS max_seq FROM messages WHERE conversation_id = ?')
      .get(conversationId);
    return Number(row?.max_seq ?? -1) + 1;
  }
}

function toSummary(row: Record<string, unknown>): ConversationSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.role_id !== null && row.role_id !== undefined ? { roleId: String(row.role_id) } : {}),
  };
}

function toRole(row: Record<string, unknown>): Role {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ''),
    prompt: String(row.prompt ?? ''),
    includeBasePrompt: Number(row.include_base_prompt) === 1,
    builtin: Number(row.builtin) === 1,
    disabled: Number(row.disabled) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
