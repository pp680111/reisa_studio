/**
 * 知识库页面服务客户端（renderer 侧）。
 * 结构化访问宿主暴露的受限通道 window.reisa.modulePage；
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
  /** 同一文件版本连续自动索引失败次数；达上限后暂停自动重试。 */
  retryCount: number;
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

/** test_connection 结果（永不抛错；失败以 ok:false + 面向用户的中文错误返回）。 */
export interface EmbeddingConnectionTestJson {
  ok: boolean;
  model?: string;
  dimensions?: number;
  latencyMs?: number;
  error?: string;
}

/** 一条索引类 embedding 接口调用记录（每次真实请求一行，含子批与重试）。 */
export interface EmbeddingCallJson {
  id: string;
  triggeredAt: string;
  status: string;
  model: string;
  /** 同一轮 embed() 调用的唯一标识（一次索引可能拆多个子批、各子批可能重试）。 */
  roundId: string;
  /** 子批序号（0 起）。 */
  batchIndex: number;
  /** 该子批内的尝试序号（0 起；重试递增）。 */
  attempt: number;
  textCount: number;
  tokenCount: number | null;
  durationMs: number;
  errorCode: string | null;
  errorMessage: string | null;
  documentId: string;
  relPath: string;
  documentName: string;
}

export interface EmbeddingCallItemJson {
  textIndex: number;
  chunkId: string | null;
  ordinal: number | null;
  contentHash: string | null;
  contentPreview: string | null;
  tokenCount: number | null;
  sectionPath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
}

export interface EmbeddingCallDetailJson {
  call: EmbeddingCallJson;
  items: EmbeddingCallItemJson[];
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
  'test_connection',
  'list_embedding_calls',
  'get_embedding_call',
  'clear_embedding_calls',
] as const;

/** 测试 embedding 连接：传入表单草稿，缺省字段回退已保存配置。 */
export function testEmbeddingConnection(draft: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
}): Promise<EmbeddingConnectionTestJson> {
  return callPage<EmbeddingConnectionTestJson>('test_connection', draft);
}

/** 索引类 embedding 调用记录（仅文档索引；检索与连接测试不记录）。 */
export function listEmbeddingCalls(
  input: { status?: string; limit?: number; offset?: number } = {},
): Promise<{ total: number; items: EmbeddingCallJson[] }> {
  return callPage<{ total: number; items: EmbeddingCallJson[] }>('list_embedding_calls', input);
}

export function getEmbeddingCall(callId: string): Promise<EmbeddingCallDetailJson> {
  return callPage<EmbeddingCallDetailJson>('get_embedding_call', { callId });
}

export function clearEmbeddingCalls(): Promise<{ cleared: boolean }> {
  return callPage<{ cleared: boolean }>('clear_embedding_calls', {});
}
