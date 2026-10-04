import type { ModuleContribution } from '@reisa/module-sdk';
import { MODULE_ID, MODULE_VERSION } from './contracts.ts';
import { CardNotePage } from './ui/CardNotePage.tsx';
import { CardNoteSettings } from './ui/CardNoteSettings.tsx';

/**
 * 卡片笔记模块 UI 贡献（迁移设计文档 M0/M5）。
 * v1 不注册能力（决策 Q10）；同步设置经模块设置面板（settings 组件）提供；
 * 页面经受限通道访问 runtime 页面服务（动作白名单见 contracts.ts PAGE_ACTIONS）。
 */
export const cardNoteManifest: ModuleContribution = {
  id: MODULE_ID,
  name: '卡片笔记',
  description: '本地优先的阅读笔记卡片：书籍、摘录、备注、页码与全局标签（迁移自 Card Note）。',
  version: MODULE_VERSION,
  protocolVersion: '1',
  source: 'builtin',
  capabilities: [],
  navigation: {
    icon: 'book',
    aliases: ['Card Note', '笔记卡片'],
    keywords: ['笔记', '读书', '摘录', '卡片'],
    page: CardNotePage,
  },
  settings: CardNoteSettings,
};
