/**
 * 同步文档（迁移自 card_note `lib/features/sync/domain/sync_document.dart`）。
 * 版本化的业务实体文本表示：只含领域数据，凭据/本地 AI 工作/Git 配置绝不入内。
 * 迁移偏差（有意）：实体类型集合不含 link（决策 R4——双向链接已移除），
 * 旧 card_note 同步仓库中的 links/ 目录会被校验器静默忽略。
 */

const FORMAT_NAME = 'card-note-sync';
const FORMAT_VERSION = 1;

/** 与源 SyncEntityType 一致（减 link）。 */
export const SYNC_ENTITY_TYPES = ['book', 'note', 'tag', 'note-tag', 'attachment'] as const;
export type SyncEntityTypeValue = (typeof SYNC_ENTITY_TYPES)[number];

export function syncDirectoryFor(type: SyncEntityTypeValue): string {
  switch (type) {
    case 'book':
      return 'books';
    case 'note':
      return 'notes';
    case 'tag':
      return 'tags';
    case 'note-tag':
      return 'note-tags';
    case 'attachment':
      return 'attachments';
  }
}

export interface SyncDocument {
  readonly type: SyncEntityTypeValue;
  readonly id: string;
  readonly deleted: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly updatedBy: string | null;
  readonly fields: Record<string, unknown>;
}

/** 清单（源实现不含 createdAt——design.md 有但代码没有，以代码为准，见偏差表 D12）。 */
export const SYNC_MANIFEST = { format: FORMAT_NAME, formatVersion: FORMAT_VERSION } as const;

export function encodeManifest(): string {
  return `${JSON.stringify(SYNC_MANIFEST, null, 2)}\n`;
}

export function validateManifest(source: string): void {
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch {
    throw new Error('不支持的 Card Note 同步仓库格式');
  }
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    (decoded as Record<string, unknown>)['format'] !== FORMAT_NAME ||
    (decoded as Record<string, unknown>)['formatVersion'] !== FORMAT_VERSION
  ) {
    throw new Error('不支持的 Card Note 同步仓库格式');
  }
}

/**
 * 确定性序列化：2 空格缩进 + 末尾换行 + 固定字段顺序（envelope 在前，业务字段随后），
 * 序列化器不写随机字段或本机绝对路径，减少 Git diff 噪音。
 */
export function encodeDocument(document: SyncDocument): string {
  const ordered: Record<string, unknown> = {
    type: document.type,
    id: document.id,
    deleted: document.deleted,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
  if (document.updatedBy !== null) {
    ordered['updatedBy'] = document.updatedBy;
  }
  for (const [key, value] of Object.entries(document.fields)) {
    ordered[key] = value;
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function requiredString(json: Record<string, unknown>, key: string): string {
  const value = json[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`同步文档字段 ${key} 必须是非空字符串`);
  }
  return value;
}

function nullableString(json: Record<string, unknown>, key: string): void {
  const value = json[key];
  if (value !== null && value !== undefined && typeof value !== 'string') {
    throw new Error(`同步文档字段 ${key} 必须是字符串或 null`);
  }
}

function nullableInt(json: Record<string, unknown>, key: string): void {
  const value = json[key];
  if (value !== null && value !== undefined && !Number.isInteger(value)) {
    throw new Error(`同步文档字段 ${key} 必须是整数或 null`);
  }
}

function validateFields(
  type: SyncEntityTypeValue,
  deleted: boolean,
  fields: Record<string, unknown>,
): void {
  if (deleted) return;
  switch (type) {
    case 'book':
      requiredString(fields, 'title');
      break;
    case 'note': {
      requiredString(fields, 'bookId');
      requiredString(fields, 'quote');
      if (
        !Number.isInteger(fields['contentRevision']) ||
        (fields['contentRevision'] as number) < 1
      ) {
        throw new Error('笔记 contentRevision 无效');
      }
      nullableString(fields, 'comment');
      nullableInt(fields, 'pageStart');
      nullableInt(fields, 'pageEnd');
      break;
    }
    case 'tag':
      requiredString(fields, 'name');
      requiredString(fields, 'normalizedName');
      break;
    case 'note-tag':
      requiredString(fields, 'noteId');
      requiredString(fields, 'tagId');
      requiredString(fields, 'source');
      break;
    case 'attachment': {
      requiredString(fields, 'noteId');
      requiredString(fields, 'storedFileName');
      requiredString(fields, 'originalFileName');
      requiredString(fields, 'mimeType');
      requiredString(fields, 'contentHash');
      if (
        !Number.isInteger(fields['byteSize']) ||
        (fields['byteSize'] as number) <= 0 ||
        !Number.isInteger(fields['sortOrder']) ||
        (fields['sortOrder'] as number) < 0
      ) {
        throw new Error('附件大小或顺序无效');
      }
      nullableInt(fields, 'width');
      nullableInt(fields, 'height');
      break;
    }
  }
}

/** 解析并校验（源 SyncDocument.decode；Git 冲突标记直接拒绝）。 */
export function decodeDocument(source: string): SyncDocument {
  if (source.includes('<<<<<<<') || source.includes('=======') || source.includes('>>>>>>>')) {
    throw new Error('同步文档包含未解决的 Git 冲突标记');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch {
    throw new Error('同步文档必须是 JSON 对象');
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('同步文档必须是 JSON 对象');
  }
  const json = decoded as Record<string, unknown>;
  const type = requiredString(json, 'type');
  if (!SYNC_ENTITY_TYPES.includes(type as SyncEntityTypeValue)) {
    throw new Error(`不支持的同步实体类型：${type}`);
  }
  const id = requiredString(json, 'id');
  const deleted = json['deleted'];
  const createdAt = json['createdAt'];
  const updatedAt = json['updatedAt'];
  const updatedBy = json['updatedBy'];
  if (
    typeof deleted !== 'boolean' ||
    !Number.isInteger(createdAt) ||
    !Number.isInteger(updatedAt)
  ) {
    throw new Error('同步文档缺少有效的版本字段');
  }
  if ((createdAt as number) < 0 || (updatedAt as number) < (createdAt as number)) {
    throw new Error('同步文档时间戳无效');
  }
  if (updatedBy !== null && updatedBy !== undefined && typeof updatedBy !== 'string') {
    throw new Error('updatedBy 必须是字符串');
  }
  const envelopeKeys = new Set(['type', 'id', 'deleted', 'createdAt', 'updatedAt', 'updatedBy']);
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(json)) {
    if (!envelopeKeys.has(key)) {
      fields[key] = value;
    }
  }
  validateFields(type as SyncEntityTypeValue, deleted as boolean, fields);
  if (!deleted && type === 'note-tag' && id !== `${fields['noteId']}--${fields['tagId']}`) {
    throw new Error('标签关联文档身份不匹配');
  }
  return {
    type: type as SyncEntityTypeValue,
    id,
    deleted: deleted as boolean,
    createdAt: createdAt as number,
    updatedAt: updatedAt as number,
    updatedBy: typeof updatedBy === 'string' ? updatedBy : null,
    fields,
  };
}

/** note-tag 同步身份（与数据库 noteTagSyncId 一致）。 */
export function noteTagDocumentId(noteId: string, tagId: string): string {
  return `${noteId}--${tagId}`;
}
