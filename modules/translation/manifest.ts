import { defineCapability, type ModuleContribution } from '@reisa/module-sdk';
import { TranslationWorkspace } from './ui/TranslationWorkspace';
import { TranslationSettings } from './settings/TranslationSettings';
export const translationModule: ModuleContribution = {
  id: 'translation',
  name: '翻译',
  description: '跨越语言，让表达保留原本的温度。',
  version: '0.1.0',
  protocolVersion: '1',
  source: 'builtin',
  capabilities: [
    defineCapability('translation', 'translate', '按指定语言、表达风格与术语翻译文本'),
  ],
  navigation: {
    icon: 'translation',
    aliases: ['Translation', 'Translate'],
    keywords: ['语言', '英文', '日文', '术语'],
    page: TranslationWorkspace,
  },
  settings: TranslationSettings,
};
