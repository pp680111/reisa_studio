import type { ModuleContribution } from '@reisa/module-sdk';
import { knowledgeModule } from '@reisa/module-knowledge';
import { imageModule } from '@reisa/module-image';
import { projectModule } from '@reisa/module-project';
import { translationModule } from '@reisa/module-translation';
/** The only host entry point for builtin module UI. Runtime activation is a later phase. */
export const modules: readonly ModuleContribution[] = [
  knowledgeModule,
  imageModule,
  projectModule,
  translationModule,
];
