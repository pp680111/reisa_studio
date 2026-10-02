import { defineCapability, type ModuleContribution } from '@reisa/module-sdk';
import { KnowledgeWorkspace } from './ui/KnowledgeWorkspace';
import { KnowledgeSettings } from './settings/KnowledgeSettings';
export const knowledgeModule: ModuleContribution = {
  id: 'knowledge',
  name: '知识库',
  description: '让资料成为可查阅、可连接的知识。',
  version: '0.1.0',
  protocolVersion: '1',
  source: 'builtin',
  capabilities: [
    defineCapability('knowledge', 'search', '检索知识库中的相关片段'),
    defineCapability('knowledge', 'read_document', '读取指定文档的公开内容'),
    defineCapability('knowledge', 'list_documents', '列出指定知识库的文档'),
  ],
  navigation: {
    icon: 'book',
    aliases: ['Knowledge', '资料库'],
    keywords: ['文档', '检索', '索引', '资料'],
    page: KnowledgeWorkspace,
  },
  settings: KnowledgeSettings,
};
