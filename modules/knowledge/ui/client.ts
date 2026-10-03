/**
 * 知识库页面服务客户端（renderer 侧）。
 * 结构化访问宿主暴露的受限通道 window.reisa.modulePage / moduleConfig；
 * 不导入宿主代码（边界检查：模块 UI 只依赖 SDK 与共享 UI 包）。
 */

export interface ModulePageResult<T> {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string };
}

interface ModulePageBridge {
  invoke<T>(moduleId: string, action: string, input?: unknown): Promise<ModulePageResult<T>>;
  pickPath(mode: 'directory' | 'file'): Promise<string | null>;
}

function bridge(): ModulePageBridge | undefined {
  return (window as unknown as { reisa?: { modulePage?: ModulePageBridge } }).reisa?.modulePage;
}

export function pageBridgeAvailable(): boolean {
  return bridge() !== undefined;
}

export async function callPage<T>(action: string, input?: unknown): Promise<T> {
  const client = bridge();
  if (client === undefined) {
    throw new Error('页面服务仅在桌面应用内可用');
  }
  const result = await client.invoke<T>('knowledge', action, input);
  if (!result.ok || result.error !== undefined) {
    throw new Error(result.error?.message ?? '页面服务调用失败');
  }
  return result.value as T;
}

export async function pickPath(mode: 'directory' | 'file'): Promise<string | null> {
  const client = bridge();
  if (client === undefined) return null;
  return client.pickPath(mode);
}

// ---- 页面服务数据结构（与 runtime 页面服务输出对齐） ----

export interface SourceJson {
  id: string;
  type: string;
  path: string;
  name: string;
  createdAt: string;
  ignoreRules: string;
}

export interface DocumentJson {
  id: string;
  sourceId: string;
  relPath: string;
  name: string;
  status: string;
  error: string | null;
  chunkCount: number;
  size: number;
  mtimeNs: string;
  indexedAt: string | null;
}

export interface SyncStatusJson {
  running: boolean;
  pending: boolean;
  runs: number;
  intervalSeconds: number;
  lastRunAt: string | null;
  lastRunSeconds: number | null;
}

export interface SourceStatsJson {
  sourceId: string;
  documents: number;
  indexedDocuments: number;
  failedDocuments: number;
  manualRequiredDocuments: number;
}

export interface StatsJson {
  sources: number;
  documents: number;
  indexedDocuments: number;
  failedDocuments: number;
  manualRequiredDocuments: number;
  perSource: SourceStatsJson[];
}

export interface SearchHitJson {
  documentId: string;
  documentName: string;
  content: string;
  sectionPath: string | null;
  lineStart: number;
  lineEnd: number;
  score: number;
}

export interface SearchResultJson {
  query: string;
  mode: string;
  degraded: boolean;
  results: SearchHitJson[];
}

export interface DocumentContentJson {
  document: DocumentJson;
  content: string;
  truncated: boolean;
  contentTrusted: boolean;
}

export const PAGE_ACTIONS = [
  'get_stats',
  'get_sync_status',
  'list_sources',
  'add_source',
  'update_rules',
  'remove_source',
  'scan_now',
  'reindex_document',
  'list_documents',
  'get_document_content',
  'search',
  'upload_file',
  'get_config',
  'update_config',
] as const;
