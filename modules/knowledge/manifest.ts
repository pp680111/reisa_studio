import type { ModuleContribution } from '@reisa/module-sdk';
import { KNOWLEDGE_CAPABILITIES, MODULE_ID, MODULE_VERSION } from './contracts.ts';
import { KnowledgePage } from './ui/KnowledgePage.tsx';
import { KnowledgeSettings } from './ui/KnowledgeSettings.tsx';

/**
 * 知识库模块 UI 贡献（架构设计 §9）：
 * 一个模块管理多个本地来源（skb 多来源模型，迁移设计文档决策 D2）；
 * 页面表单经受限 IPC 通道访问模块页面服务，绝不注册为 Agent 能力。
 */
export const knowledgeManifest: ModuleContribution = {
  id: MODULE_ID,
  name: '知识库',
  description: '管理本地文档来源，后台增量索引，支持混合检索并核对返回片段。',
  version: MODULE_VERSION,
  protocolVersion: '1',
  source: 'builtin',
  capabilities: [...KNOWLEDGE_CAPABILITIES],
  navigation: {
    icon: 'book',
    aliases: ['Knowledge', '资料库'],
    keywords: ['文档', '检索', '索引', '资料'],
    page: KnowledgePage,
  },
  settings: KnowledgeSettings,
};
