/**
 * 代码仓库设置页客户端（renderer 侧）。
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
  const result = await client.invoke<T>('repo-explorer', action, input);
  if (!result.ok || result.error !== undefined) {
    throw new Error(result.error?.message ?? '页面服务调用失败');
  }
  return result.value as T;
}

export async function pickDirectory(): Promise<string | null> {
  const client = bridge();
  if (client === undefined) return null;
  return client.pickPath('directory');
}

// ---- 页面服务数据结构（与 runtime 页面服务输出对齐） ----

export interface RepoJson {
  id: string;
  name: string;
  path: string;
  tags: string[];
  description: string;
  enabled: boolean;
  createdAt: number;
}

export interface RepoTestJson {
  ok: boolean;
  isGit?: boolean;
  error?: string;
}
