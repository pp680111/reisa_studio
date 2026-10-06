import type { ModuleContribution } from '@reisa/module-sdk';
import { knowledgeManifest } from '@reisa/module-knowledge';
import { cardNoteManifest } from '@reisa/module-card-note';
import { todoManifest } from '@reisa/module-todo';
/**
 * 组合根：内置模块 UI 贡献的唯一清单。
 * 新模块接入：在此导入其公开入口并加入清单，宿主其余代码不需要改动。
 */
export const modules: readonly ModuleContribution[] = [
  knowledgeManifest,
  cardNoteManifest,
  todoManifest,
];
