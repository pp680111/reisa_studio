/**
 * 卡片笔记页面服务客户端（renderer 侧）。
 * 结构化访问宿主受限通道 window.reisa.modulePage；
 * 不导入宿主代码（边界检查：模块 UI 只依赖 SDK 与共享 UI 包）。
 * DTO 类型与 runtime 页面服务的 JSON 输出逐一对应（单一真源）。
 */
import { MODULE_ID, PAGE_ACTIONS } from '../contracts.ts';

export interface ModulePageResult<T> {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string };
}

interface ModulePageBridge {
  invoke<T>(moduleId: string, action: string, input?: unknown): Promise<ModulePageResult<T>>;
  pickPath(mode: 'directory' | 'file', extensions?: string[]): Promise<string | null>;
  pickSavePath(suggestedName?: string, extensions?: string[]): Promise<string | null>;
}

function bridge(): ModulePageBridge | undefined {
  return (window as unknown as { reisa?: { modulePage?: ModulePageBridge } }).reisa?.modulePage;
}

export function pageBridgeAvailable(): boolean {
  return bridge() !== undefined;
}

async function callPage<T>(action: string, input?: unknown): Promise<T> {
  const client = bridge();
  if (client === undefined) {
    throw new Error('页面服务仅在桌面应用内可用');
  }
  const result = await client.invoke<T>(MODULE_ID, action, input);
  if (!result.ok || result.error !== undefined) {
    throw new Error(result.error?.message ?? '页面服务调用失败');
  }
  return result.value as T;
}

/** 渲染侧错误提示统一出口。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function pickPath(
  mode: 'directory' | 'file',
  extensions?: string[],
): Promise<string | null> {
  const client = bridge();
  if (client === undefined) return null;
  return client.pickPath(mode, extensions);
}

export async function pickSavePath(
  suggestedName?: string,
  extensions?: string[],
): Promise<string | null> {
  const client = bridge();
  if (client === undefined) return null;
  return client.pickSavePath(suggestedName, extensions);
}

// ---- DTO（与 runtime toXJson 输出对齐） ----

export interface BookJson {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface NoteJson {
  id: string;
  bookId: string;
  quote: string;
  comment: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  contentRevision: number;
  createdAt: number;
  updatedAt: number;
}

export interface TagJson {
  id: string;
  name: string;
  normalizedName: string;
  createdAt: number;
  updatedAt: number;
}

export interface AttachmentJson {
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
}

export interface AttachmentDraftInput {
  /** 草稿 ID（新建时由 renderer 生成；保存时即附件行 ID）。 */
  id: string;
  /** 新附件的本地源路径；既有附件不携带。 */
  sourcePath?: string;
  originalFileName?: string;
}

export interface ProbeImageResultJson {
  ok: boolean;
  originalFileName: string;
  byteSize: number;
  previewDataUrl: string | null;
  error: string | null;
}

export interface StatsJson {
  books: number;
  notes: number;
  tags: number;
}

export interface SaveNoteResultJson {
  id: string;
  contentRevision: number;
}

export type ExportFormatJson = 'markdown' | 'json';

export interface ExportPreviewJson {
  content: string;
  suggestedFileName: string;
}

export interface ExportWrittenJson {
  written: true;
  byteSize: number;
}

export interface ImportResultJson {
  bookId: string;
  title: string;
  noteCount: number;
}

// ---- 类型化页面服务方法 ----

export const listBooks = () => callPage<BookJson[]>(PAGE_ACTIONS.listBooks);
export const getBook = (bookId: string) =>
  callPage<BookJson | null>(PAGE_ACTIONS.getBook, { bookId });
export const createBook = (title: string) => callPage<BookJson>(PAGE_ACTIONS.createBook, { title });
export const renameBook = (bookId: string, title: string) =>
  callPage<BookJson>(PAGE_ACTIONS.renameBook, { bookId, title });
export const deleteBook = (bookId: string) =>
  callPage<{ deleted: boolean }>(PAGE_ACTIONS.deleteBook, { bookId });

export const listNotes = (bookId: string, query = '') =>
  callPage<NoteJson[]>(PAGE_ACTIONS.listNotes, { bookId, query });
export const getNote = (noteId: string) =>
  callPage<NoteJson | null>(PAGE_ACTIONS.getNote, { noteId });
export const saveNote = (input: {
  noteId: string | null;
  bookId: string;
  quote: string;
  comment: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  tagIds: string[];
  /** 附件草稿（按展示顺序）；编辑器保存时必传（可为空数组），其他调用方不传则不动附件。 */
  attachments?: AttachmentDraftInput[];
}) => callPage<SaveNoteResultJson>(PAGE_ACTIONS.saveNote, input);
export const deleteNote = (noteId: string) =>
  callPage<{ deleted: boolean }>(PAGE_ACTIONS.deleteNote, { noteId });

export const listAttachments = (noteId: string) =>
  callPage<AttachmentJson[]>(PAGE_ACTIONS.listAttachments, { noteId });
export const probeAttachment = (path: string) =>
  callPage<ProbeImageResultJson>(PAGE_ACTIONS.probeAttachment, { path });
export const readAttachment = (attachmentId: string) =>
  callPage<{ dataUrl: string } | null>(PAGE_ACTIONS.readAttachment, { attachmentId });

export const listTags = () => callPage<TagJson[]>(PAGE_ACTIONS.listTags);
export const getNoteTags = (noteId: string) =>
  callPage<TagJson[]>(PAGE_ACTIONS.getNoteTags, { noteId });
export const ensureTag = (name: string) => callPage<TagJson>(PAGE_ACTIONS.ensureTag, { name });
export const renameTag = (tagId: string, name: string) =>
  callPage<TagJson>(PAGE_ACTIONS.renameTag, { tagId, name });
export const deleteTag = (tagId: string) =>
  callPage<{ deleted: boolean }>(PAGE_ACTIONS.deleteTag, { tagId });

/** 生成导出内容并返回建议文件名（不落盘）。 */
export const previewExport = (bookId: string, format: ExportFormatJson) =>
  callPage<ExportPreviewJson>(PAGE_ACTIONS.exportBook, { bookId, format });

/** 生成并写入用户经保存对话框确认的目标路径。 */
export const exportBookToFile = (bookId: string, format: ExportFormatJson, targetPath: string) =>
  callPage<ExportWrittenJson>(PAGE_ACTIONS.exportBook, { bookId, format, targetPath });

export const importBook = (sourcePath: string) =>
  callPage<ImportResultJson>(PAGE_ACTIONS.importBook, { sourcePath });

// ---- 同步（M5） ----

export interface SyncStatusJson {
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
}

export interface SyncRunResultJson {
  exportedDocuments: number;
  validatedDocuments: number;
  head: string;
  createdCommit: boolean;
}

export const getSyncStatus = () => callPage<SyncStatusJson>(PAGE_ACTIONS.getSyncStatus);
export const initializeSyncWorkspace = (workspacePath: string, remoteUrl: string) =>
  callPage<{ initialized: true }>(PAGE_ACTIONS.initializeSyncWorkspace, {
    workspacePath,
    remoteUrl,
  });
export const cloneSyncRepository = (workspacePath: string, remoteUrl: string) =>
  callPage<{ importedDocuments: number }>(PAGE_ACTIONS.cloneSyncRepository, {
    workspacePath,
    remoteUrl,
  });
export const syncNow = () => callPage<SyncRunResultJson>(PAGE_ACTIONS.syncNow);
export const saveSyncAuto = (autoSync: boolean, intervalMinutes: number) =>
  callPage<{ saved: true }>(PAGE_ACTIONS.saveSyncAuto, { autoSync, intervalMinutes });
