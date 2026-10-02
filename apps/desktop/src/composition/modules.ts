import type { ModuleContribution } from '@reisa/module-sdk';
/**
 * 组合根：内置模块 UI 贡献的唯一清单。
 * 当前仓库按规划未包含任何功能模块（界面中的模块页曾为原型，已移除）；
 * 将来接入模块时，在此导入其公开入口并加入清单，宿主其余代码不需要改动。
 */
export const modules: readonly ModuleContribution[] = [];
