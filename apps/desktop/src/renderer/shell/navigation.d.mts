import type { ModuleContribution } from '@reisa/module-sdk';
export function navigationModules(
  modules: readonly ModuleContribution[],
  enabled: readonly string[],
  pinned?: readonly string[],
  recent?: readonly string[],
  query?: string,
): ModuleContribution[];
