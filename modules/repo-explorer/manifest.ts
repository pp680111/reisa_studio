import type { ModuleContribution } from '@reisa/module-sdk';
import { REPO_EXPLORER_CAPABILITIES, MODULE_ID, MODULE_VERSION } from './contracts.ts';
import { RepoExplorerSettings } from './ui/RepoExplorerSettings.tsx';

/**
 * 代码仓库检索模块 UI 贡献（架构设计 §9）：
 * 只提供设置区（仓库注册表管理），无独立导航页面；
 * 注册表属管理面数据，经受限页面服务通道读写，绝不注册为 Agent 能力。
 */
export const repoExplorerManifest: ModuleContribution = {
  id: MODULE_ID,
  name: '代码仓库',
  description: '注册本地代码仓库，为会话提供只读的虚拟路径代码检索工具（ls / read_file / glob / grep）。',
  version: MODULE_VERSION,
  protocolVersion: '1',
  source: 'builtin',
  capabilities: [...REPO_EXPLORER_CAPABILITIES],
  settings: RepoExplorerSettings,
};
