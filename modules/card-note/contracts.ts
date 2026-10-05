/**
 * 卡片笔记模块契约（迁移设计文档：M0 骨架）。
 * v1 不注册 Agent 能力（决策 Q10）；页面动作经宿主受限通道 `reisa/module/page`
 * 访问 runtime 页面服务，动作常量在此集中，runtime 与 UI 两侧共用。
 * 管理面操作（增删改、同步）绝不注册为 Agent 能力：宿主 listEnabledCapabilities()
 * 无筛选，注册即对模型全量可见（知识库迁移设计文档 §5.3 安全分层）。
 *
 * 页面服务 DTO 也以此为单一真源（R7）：runtime 以这些类型构造跨进程返回值，
 * ui 经 client.ts 引用同一份类型；字段增删改会使至少一侧编译失败，而非静默漂移。
 * DTO 一律用 type 而非 interface：类型别名的隐式索引签名使其可直接赋给 JsonValue，
 * 序列化边界不需要断言。
 */

export const MODULE_ID = 'card-note';
export const MODULE_VERSION = '0.1.0';

/** 页面服务动作名（受限通道白名单的模块侧定义）。 */
export const PAGE_ACTIONS = {
  getStats: 'get_stats',
  listBooks: 'list_books',
  getBook: 'get_book',
  createBook: 'create_book',
  renameBook: 'rename_book',
  deleteBook: 'delete_book',
  listNotes: 'list_notes',
  getNote: 'get_note',
  saveNote: 'save_note',
  deleteNote: 'delete_note',
  listAttachments: 'list_attachments',
  probeAttachment: 'probe_attachment',
  readAttachment: 'read_attachment',
  exportBook: 'export_book',
  importBook: 'import_book',
  getSyncStatus: 'get_sync_status',
  initializeSyncWorkspace: 'initialize_sync_workspace',
  cloneSyncRepository: 'clone_sync_repository',
  syncNow: 'sync_now',
  saveSyncConnection: 'save_sync_connection',
  saveSyncAuto: 'save_sync_auto',
  listTags: 'list_tags',
  getNoteTags: 'get_note_tags',
  ensureTag: 'ensure_tag',
  renameTag: 'rename_tag',
  deleteTag: 'delete_tag',
} as const;

export type PageAction = (typeof PAGE_ACTIONS)[keyof typeof PAGE_ACTIONS];

// ---- 页面服务 DTO（ui 与 runtime 共享的真源） ----

/** 受限通道返回封装（宿主 preload 注入的调用结果）。 */
export type ModulePageResult<T> = {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string };
};

export type BookJson = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type NoteJson = {
  id: string;
  bookId: string;
  quote: string;
  comment: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  contentRevision: number;
  createdAt: number;
  updatedAt: number;
};

export type TagJson = {
  id: string;
  name: string;
  normalizedName: string;
  createdAt: number;
  updatedAt: number;
};

export type AttachmentJson = {
  id: string;
  noteId: string;
  storedFileName: string;
  originalFileName: string;
  mimeType: string;
  byteSize: number;
  sortOrder: number;
  contentHash: string;
  createdAt: number;
  updatedAt: number;
};

/** 附件草稿（ui → runtime 的保存输入）。 */
export type AttachmentDraftInput = {
  /** 草稿 ID（新建时由 renderer 生成；保存时即附件行 ID）。 */
  id: string;
  /** 新附件的本地源路径；既有附件不携带。 */
  sourcePath?: string;
  originalFileName?: string;
};

export type ProbeImageResultJson = {
  ok: boolean;
  originalFileName: string;
  byteSize: number;
  previewDataUrl: string | null;
  error: string | null;
};

export type StatsJson = {
  books: number;
  notes: number;
  tags: number;
};

export type SaveNoteResultJson = {
  id: string;
  contentRevision: number;
};

// 轻量动作回执也走契约：避免 ui 调用签名与 runtime 返回值各自内联字面量而静默漂移
export type DeletedResultJson = {
  deleted: boolean;
};

export type SavedResultJson = {
  saved: true;
};

export type InitializedResultJson = {
  initialized: true;
};

export type CloneSyncResultJson = {
  importedDocuments: number;
};

export type ReadAttachmentResultJson = {
  dataUrl: string;
};

export type ExportFormatJson = 'markdown' | 'json';

export type ExportPreviewJson = {
  content: string;
  suggestedFileName: string;
};

export type ExportWrittenJson = {
  written: true;
  byteSize: number;
};

export type ImportResultJson = {
  bookId: string;
  title: string;
  noteCount: number;
};

export type SyncStatusJson = {
  workspacePath: string;
  remoteUrl: string;
  deviceId: string;
  lastSyncedHead: string;
  autoSync: boolean;
  intervalMinutes: number;
  configured: boolean;
  gitAvailable: boolean;
  gitError: string | null;
  workspaceIsRepository: boolean;
  pendingChanges: number;
};

export type SyncRunResultJson = {
  exportedDocuments: number;
  validatedDocuments: number;
  head: string;
  createdCommit: boolean;
};
