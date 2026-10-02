import { defineCapability, type ModuleContribution } from '@reisa/module-sdk';
import { ProjectWorkspace } from './ui/ProjectWorkspace';
import { ProjectSettings } from './settings/ProjectSettings';
export const projectModule: ModuleContribution = {
  id: 'project',
  name: '项目',
  description: '将素材、笔记和创作成果归于一处。',
  version: '0.1.0',
  protocolVersion: '1',
  source: 'builtin',
  capabilities: [
    defineCapability('project', 'list', '列出可接收素材的项目'),
    defineCapability('project', 'add_asset', '将明确提供的内容保存为项目素材'),
  ],
  navigation: {
    icon: 'folder',
    aliases: ['Project'],
    keywords: ['素材', '笔记', '归档', '项目'],
    page: ProjectWorkspace,
  },
  settings: ProjectSettings,
};
