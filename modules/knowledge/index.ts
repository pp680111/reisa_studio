/**
 * 知识库模块受控公开入口（架构设计 §11）：宿主 renderer 只能从这里取 UI 贡献。
 * 运行入口在 `./runtime`（仅允许组合根导入）。
 */
export { knowledgeManifest } from './manifest.ts';
export {
  knowledgeSearch,
  knowledgeListDocuments,
  knowledgeReadDocument,
  knowledgeUploadDocument,
  MODULE_ID,
  MODULE_VERSION,
  type SearchModeValue,
} from './contracts.ts';
