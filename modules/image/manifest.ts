import { defineCapability, type ModuleContribution } from '@reisa/module-sdk';
import { ImageWorkspace } from './ui/ImageWorkspace';
import { ImageSettings } from './settings/ImageSettings';
export const imageModule: ModuleContribution = {
  id: 'image',
  name: '绘图',
  description: '把画面描述变成视觉灵感。',
  version: '0.1.0',
  protocolVersion: '1',
  source: 'builtin',
  capabilities: [
    defineCapability('image', 'generate', '根据描述生成图片'),
    defineCapability('image', 'read', '读取已生成图片的内容'),
    defineCapability('image', 'list', '查询绘图模块的生成记录'),
  ],
  navigation: {
    icon: 'image',
    aliases: ['Image', '画布'],
    keywords: ['图片', '生成', '设计', '绘画'],
    page: ImageWorkspace,
  },
  settings: ImageSettings,
};
