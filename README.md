# Uzawa Reisa Studio

以 Agent 会话为主入口，通过独立功能模块扩展能力的 AI 聚合应用。

当前状态：主应用（宿主）运行层已完整实现并通过真实模型验证——Electron 桌面入口、会话与流式事件、模型连接配置（含凭据加密）、会话持久化、模块生命周期与能力调用入口、依赖边界检查。功能模块当前未包含（`modules/` 目录按规划预留为空，此前原型的四个模块界面已移除，代码可在 git 历史 93577ee 找回）；模块接入协议与宿主侧全部机制已就绪，新增模块无需修改宿主代码。

## 开始使用

环境：Node.js 22.12+、pnpm 11（仓库固定 `pnpm@11.22.0`）。

```sh
pnpm install
pnpm dev             # 浏览器预览：http://127.0.0.1:5173
pnpm dev:desktop     # Electron 桌面开发窗口
```

```sh
pnpm build           # 类型检查、依赖边界检查、前端及 Electron 编译
pnpm start           # 打开已构建的桌面应用
pnpm test            # 导航搜索、启停过滤与排序测试
pnpm test:desktop    # 构建后，以隐藏窗口检查 Electron renderer/preload
pnpm format:check    # 代码格式检查
```

当前提供本地构建与启动，尚未制作安装包。页面本地交互和功能占位、组件位置及后续接入说明见 [界面实现说明](docs/ui-implementation.md)。

## 设计文档

- [架构设计](docs/architecture.md)：已确认的产品边界、模块协议、工具注册、数据隔离、配置、UI、生命周期和实施验收。
- [界面设计](docs/ui-design.md)：会话优先布局、模块管理、独立工作区、设置、结果展示和交互规范。
- [独立模块工作空间](docs/module-ui-design.md)：知识库、绘图、项目和翻译的直接操作界面与交互。
- [Agent 框架选型](docs/agent-framework-selection.md)：候选框架对比、AI SDK 推荐理由、接入要点与 spike 验收清单。

核心约定：主应用把全部已启用模块的公开能力交给 Agent 框架；框架负责会话及工具调用循环；主应用和模块的数据分别管理，跨边界访问只能通过明确公开的能力接口。

## 仓库结构

目录划分来自架构设计 §11；`modules/` 目录为功能模块预留（workspace 通配、tsconfig 与边界检查均已覆盖）。

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

modules/                       预留目录（workspace 已包含；当前未包含任何功能模块）
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
- 功能模块当前按规划不实现；宿主侧协议与机制已就绪，模块可在不动宿主代码的情况下接入（§14.1 第 3 步的验证以内联测试模块完成）。
- 待办备选：凭据加密的 `safeStorage` 已接入（历史明文重存后自动升级）；会话消息 Markdown 渲染、会话搜索/分页等待定。
- 文档解析与索引、绘图生成与导出、项目保存及翻译服务。
- 数据库、文件读写、配置持久化与受限 IPC 业务接口。
- 运行期数据目录 `app-data/`（架构设计 §7.2）：属运行产物，已加入 `.gitignore`，不入库。
