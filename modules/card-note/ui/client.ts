/**
 * 卡片笔记页面服务客户端（renderer 侧）。
 * 结构化访问宿主受限通道 window.reisa.modulePage；
 * 不导入宿主代码（边界检查：模块 UI 只依赖 SDK 与共享 UI 包）。
 * DTO 类型单一来源于 ../contracts.ts（runtime 侧同源），此处只做类型化调用与再导出。
 */
import {
  MODULE_ID,
  PAGE_ACTIONS,
  type AttachmentDraftInput,
  type AttachmentJson,
  type BookJson,
  type CloneSyncResultJson,
  type DeletedResultJson,
  type ExportFormatJson,
  type ExportPreviewJson,
  type ExportWrittenJson,
  type ImportResultJson,
  type InitializedResultJson,
  type ModulePageResult,
  type NoteJson,
  type ProbeImageResultJson,
  type ReadAttachmentResultJson,
  type SavedResultJson,
  type SaveNoteResultJson,
  type SyncRunResultJson,
  type SyncStatusJson,
  type TagJson,
} from '../contracts.ts';

/** 页面服务 DTO 的公开再导出：ui 组件沿用从 client 取类型的既有导入路径。 */
export type {
  AttachmentDraftInput,
  AttachmentJson,
  BookJson,
  CloneSyncResultJson,
  DeletedResultJson,
  ExportFormatJson,
  ExportPreviewJson,
  ExportWrittenJson,
  ImportResultJson,
  InitializedResultJson,
  ModulePageResult,
  NoteJson,
  ProbeImageResultJson,
  ReadAttachmentResultJson,
  SavedResultJson,
  SaveNoteResultJson,
  StatsJson,
  SyncRunResultJson,
  SyncStatusJson,
  TagJson,
} from '../contracts.ts';

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

// ---- 类型化页面服务方法（DTO 见 ../contracts.ts） ----

export const listBooks = () => callPage<BookJson[]>(PAGE_ACTIONS.listBooks);
export const getBook = (bookId: string) =>
  callPage<BookJson | null>(PAGE_ACTIONS.getBook, { bookId });
export const createBook = (title: string) => callPage<BookJson>(PAGE_ACTIONS.createBook, { title });
export const renameBook = (bookId: string, title: string) =>
  callPage<BookJson>(PAGE_ACTIONS.renameBook, { bookId, title });
export const deleteBook = (bookId: string) =>
  callPage<DeletedResultJson>(PAGE_ACTIONS.deleteBook, { bookId });

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
  callPage<DeletedResultJson>(PAGE_ACTIONS.deleteNote, { noteId });

export const listAttachments = (noteId: string) =>
  callPage<AttachmentJson[]>(PAGE_ACTIONS.listAttachments, { noteId });
export const probeAttachment = (path: string) =>
  callPage<ProbeImageResultJson>(PAGE_ACTIONS.probeAttachment, { path });
export const readAttachment = (attachmentId: string) =>
  callPage<ReadAttachmentResultJson | null>(PAGE_ACTIONS.readAttachment, { attachmentId });

export const listTags = () => callPage<TagJson[]>(PAGE_ACTIONS.listTags);
export const getNoteTags = (noteId: string) =>
  callPage<TagJson[]>(PAGE_ACTIONS.getNoteTags, { noteId });
export const ensureTag = (name: string) => callPage<TagJson>(PAGE_ACTIONS.ensureTag, { name });
export const renameTag = (tagId: string, name: string) =>
  callPage<TagJson>(PAGE_ACTIONS.renameTag, { tagId, name });
export const deleteTag = (tagId: string) =>
  callPage<DeletedResultJson>(PAGE_ACTIONS.deleteTag, { tagId });

/** 生成导出内容并返回建议文件名（不落盘）。 */
export const previewExport = (bookId: string, format: ExportFormatJson) =>
  callPage<ExportPreviewJson>(PAGE_ACTIONS.exportBook, { bookId, format });

/** 生成并写入用户经保存对话框确认的目标路径。 */
export const exportBookToFile = (bookId: string, format: ExportFormatJson, targetPath: string) =>
  callPage<ExportWrittenJson>(PAGE_ACTIONS.exportBook, { bookId, format, targetPath });

export const importBook = (sourcePath: string) =>
  callPage<ImportResultJson>(PAGE_ACTIONS.importBook, { sourcePath });

// ---- 同步（M5；DTO 见 ../contracts.ts） ----

export const getSyncStatus = () => callPage<SyncStatusJson>(PAGE_ACTIONS.getSyncStatus);
export const initializeSyncWorkspace = (workspacePath: string, remoteUrl: string) =>
  callPage<InitializedResultJson>(PAGE_ACTIONS.initializeSyncWorkspace, {
    workspacePath,
    remoteUrl,
  });
export const cloneSyncRepository = (workspacePath: string, remoteUrl: string) =>
  callPage<CloneSyncResultJson>(PAGE_ACTIONS.cloneSyncRepository, {
    workspacePath,
    remoteUrl,
  });
export const syncNow = () => callPage<SyncRunResultJson>(PAGE_ACTIONS.syncNow);
export const saveSyncConnection = (workspacePath: string, remoteUrl: string) =>
  callPage<SavedResultJson>(PAGE_ACTIONS.saveSyncConnection, { workspacePath, remoteUrl });
export const saveSyncAuto = (autoSync: boolean, intervalMinutes: number) =>
  callPage<SavedResultJson>(PAGE_ACTIONS.saveSyncAuto, { autoSync, intervalMinutes });
