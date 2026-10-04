/**
 * 卡片笔记模块受控公开入口（架构设计 §11）：宿主 renderer 只能从这里取 UI 贡献。
 * 运行入口在 `./runtime`（仅允许组合根导入）。
 */
export { cardNoteManifest } from './manifest.ts';
export { MODULE_ID, MODULE_VERSION, PAGE_ACTIONS, type PageAction } from './contracts.ts';
