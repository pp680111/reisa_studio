# Uzawa Reisa Studio

以 Agent 会话为主入口，通过独立功能模块扩展能力的 AI 聚合应用。

当前状态：主应用（宿主）运行层已完整实现并通过真实模型验证——Electron 桌面入口、会话与流式事件（Markdown 渲染、附件、token 用量展示）、模型连接配置（含凭据加密）、会话持久化（搜索/重命名/分页）、窗口状态记忆、模块生命周期与能力调用入口、依赖边界检查；`pnpm dist` 可产出安装包。已接入两个功能模块：知识库（`modules/knowledge/`，迁移自 simple-knowledge-base，含来源管理、增量索引、混合检索与 Agent 能力）与卡片笔记（`modules/card-note/`，迁移自 Card Note，本地优先的阅读笔记卡片，含 Git 同步与导出导入）；新增模块无需修改宿主代码。

## 开始使用

环境：Node.js 22.12+、pnpm 11（仓库固定 `pnpm@11.22.0`）。

```sh
pnpm install
pnpm dev             # 浏览器预览：http://127.0.0.1:5173
pnpm dev:desktop     # Electron 桌面开发窗口
```

```sh
pnpm build           # 类型检查、依赖边界检查、前端及 Electron 编译
pnpm dist            # 构建后经 electron-builder 打包安装包
pnpm start           # 打开已构建的桌面应用
pnpm test            # 单元与集成测试（基础包、agent-adapter、模块宿主、知识库、卡片笔记、桌面）
pnpm test:desktop    # 构建后，以隐藏窗口检查 Electron renderer/preload
pnpm format:check    # 代码格式检查
```

早期占位界面与组件位置说明见 [界面实现说明](docs/ui-implementation.md)。

## 设计文档

- [架构设计](docs/architecture.md)：已确认的产品边界、模块协议、工具注册、数据隔离、配置、UI、生命周期和实施验收。
- [界面设计](docs/ui-design.md)：会话优先布局、模块管理、独立工作区、设置、结果展示和交互规范。
- [独立模块工作空间](docs/module-ui-design.md)：知识库、绘图、项目和翻译的直接操作界面与交互。
- [Agent 框架选型](docs/agent-framework-selection.md)：候选框架对比、AI SDK 推荐理由、接入要点与 spike 验收清单。
- [知识库模块迁移设计](docs/knowledge-base-migration.md)：simple-knowledge-base 源码分析（行为规格基准）与模块化迁移方案、映射表、实施阶段。
- [卡片笔记迁移分析](docs/card-note-migration-analysis.md)：card_note 源项目完整代码分析、迁移范围决策、分阶段实施与验收记录。

核心约定：主应用把全部已启用模块的公开能力交给 Agent 框架；框架负责会话及工具调用循环；主应用和模块的数据分别管理，跨边界访问只能通过明确公开的能力接口。

## 仓库结构

目录划分来自架构设计 §11；`modules/` 目前承载知识库与卡片笔记两个功能模块（workspace 通配、tsconfig 与边界检查均已覆盖）。

```text
apps/
  desktop/                     桌面主应用（Electron 宿主，@reisa/desktop）
    src/main/                  Electron 主进程及运行入口
    src/preload/               有类型的受限 IPC 桥接
    src/renderer/shell/        导航、工作区和模块 UI 挂载
    src/renderer/conversation/ 会话 UI
    src/composition/           内置模块清单与组合根

packages/
  module-sdk/                  纯契约、Schema 类型和模块上下文（@reisa/module-sdk）
  module-host/                 生命周期和能力注册（@reisa/module-host）
  agent-adapter/               Agent 框架及模型工具适配（@reisa/agent-adapter）
  foundation/                  基础配置、凭据、平台及作用域存储机制（@reisa/foundation）
  ui/                          共享 UI 组件与设计 Token（@reisa/ui）

modules/                       功能模块（@reisa/module-knowledge、@reisa/module-card-note）
  knowledge/                   文档来源管理与混合检索（迁移自 simple-knowledge-base）
    manifest.ts / contracts.ts 模块贡献清单与能力契约（TypeBox Schema）
    runtime/                   主进程运行层：同步对账、LanceDB 索引、SQLite 元数据
    ui/                        来源 / 文档 / 检索测试工作区与模块设置
  card-note/                   阅读笔记卡片：书籍、摘录、备注、页码与全局标签（迁移自 Card Note）
    manifest.ts / contracts.ts 模块贡献清单与页面动作白名单（v1 不注册 Agent 能力）
    runtime/                   主进程运行层：SQLite 存储、Markdown/公式、附件、Git 同步、导出导入
    ui/                        书籍 / 标签 / 笔记编辑工作区与同步设置面板
```

各目录的职责与边界写在对应包的 README 中。

## 依赖方向

以下规则来自架构设计 §11，后续通过包导出与 lint 依赖检查落实，不依赖目录命名自觉：

1. 模块只依赖 SDK、约定的基础服务、UI 组件及必要的公共能力契约。
2. 模块之间不导入私有实现，协作通过能力调用入口。
3. 基础包不导入业务模块。
4. 宿主只通过组合根导入模块公开入口，不引用模块私有数据库或配置实现。
5. UI 代码不导入 Node、数据库驱动或模块运行层；平台能力经类型化 IPC 调用。
6. 共享契约包不引入应用框架运行实例、数据库连接或私有对象。

## 后续接入内容

- [Agent 框架选型](docs/agent-framework-selection.md) 已确认（AI SDK v7 + TypeBox），`agent-adapter` 已实现；真实模型（DeepSeek OpenAI 兼容端点）端到端验证通过（§14.1 第 1 步）。
- `module-host`（生命周期/注册中心/调用入口）、`foundation`（布局/配置/凭据，驱动选型 `node:sqlite`）、会话持久化（`conversations.sqlite`）、组合根运行时激活、受限 IPC 与 renderer 真实接入均已完成（§14.1 第 2 步）。
- 功能模块：知识库（`modules/knowledge/`）已接入运行时——来源管理、后台增量索引（LanceDB 混合检索 + SQLite 元数据）、四个 Agent 能力（search / list_documents / read_document / upload_document）与模块工作区页面；接入方式见 [知识库模块迁移设计](docs/knowledge-base-migration.md)。
- 功能模块：卡片笔记（`modules/card-note/`）迁移完成——书籍/摘录/标签管理、列表与网格双视图、Markdown 与 KaTeX 公式、附件、JSON 导出导入、Git 同步与旧仓库克隆导入；v1 不注册 Agent 能力，页面经受限通道访问运行层，同步设置在模块设置面板；设计与验收记录见 [卡片笔记迁移分析](docs/card-note-migration-analysis.md)。
- 宿主侧通用受限 IPC：模块页面服务（`reisa/module/page`）、模块配置（`reisa/module/config/*`）、文件与保存路径对话框（`reisa/module/pickPath`、`reisa/module/pickSavePath`）；设置页支持内嵌模块配置区。
- 待接入功能模块：绘图生成与导出、项目保存、翻译服务。
- 运行期数据目录 `app-data/`（架构设计 §7.2）：属运行产物，已加入 `.gitignore`，不入库。
