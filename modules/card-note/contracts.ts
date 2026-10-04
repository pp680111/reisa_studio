/**
 * 卡片笔记模块契约（迁移设计文档：M0 骨架）。
 * v1 不注册 Agent 能力（决策 Q10）；页面动作经宿主受限通道 `reisa/module/page`
 * 访问 runtime 页面服务，动作常量在此集中，runtime 与 UI 两侧共用。
 * 管理面操作（增删改、同步）绝不注册为 Agent 能力：宿主 listEnabledCapabilities()
 * 无筛选，注册即对模型全量可见（知识库迁移设计文档 §5.3 安全分层）。
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
  saveSyncAuto: 'save_sync_auto',
  listTags: 'list_tags',
  getNoteTags: 'get_note_tags',
  ensureTag: 'ensure_tag',
  renameTag: 'rename_tag',
  deleteTag: 'delete_tag',
} as const;

export type PageAction = (typeof PAGE_ACTIONS)[keyof typeof PAGE_ACTIONS];
