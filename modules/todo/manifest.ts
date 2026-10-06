import type { ModuleContribution } from '@reisa/module-sdk';
import { MODULE_ID, MODULE_VERSION, TODO_CAPABILITIES } from './contracts.ts';
import { TodoPage } from './ui/TodoPage.tsx';

/**
 * 待办模块贡献（迁移设计文档 §10.1）：
 * 能力 = 源 MCP 的 5 个只读/改状态工具（R3/Q6，附录 B）；
 * v1 无模块设置面板（Q3/Q4 落定后无配置项）；
 * 页面经受限通道访问 runtime 页面服务（动作白名单见 contracts.ts PAGE_ACTIONS）。
 */
export const todoManifest: ModuleContribution = {
  id: MODULE_ID,
  name: '待办事项',
  description: '本地待办管理：任务、分类与进度记录（迁移自 todo_manage）。',
  version: MODULE_VERSION,
  protocolVersion: '1',
  source: 'builtin',
  capabilities: [...TODO_CAPABILITIES],
  navigation: {
    icon: 'list',
    aliases: ['Todo', '待办', '任务'],
    keywords: ['待办', '任务', '清单', '进度'],
    page: TodoPage,
  },
};
