# Uzawa Reisa Studio

以 Agent 会话为主入口，通过独立功能模块扩展能力的 AI 聚合应用。

当前状态：已按设计文档完成第一阶段界面与代码搭建，采用 React + TypeScript + Vite，并提供 Electron 桌面入口。会话、模块管理、知识库、绘图、项目、翻译与设置均可预览；业务服务、Agent 框架和数据持久化留待后续接入。界面中的示例内容与未接入操作均有明确标记。

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

核心约定：主应用把全部已启用模块的公开能力交给 Agent 框架；框架负责会话及工具调用循环；主应用和模块的数据分别管理，跨边界访问只能通过明确公开的能力接口。

## 仓库结构

目录划分来自架构设计 §11；翻译模块依据 [独立模块工作空间](docs/module-ui-design.md) §6 列入第一批内置模块。

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

modules/                       第一批内置模块（manifest / contracts / runtime / storage / settings / ui / index.ts）
  knowledge/                   知识库（@reisa/module-knowledge）
  image/                       绘图（@reisa/module-image）
  project/                     项目（@reisa/module-project）
  translation/                 翻译（@reisa/module-translation）
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

- Agent 框架选型与 `agent-adapter` 的具体实现（架构设计 §15）。
- 能力输入/输出 Schema、运行层注册、模块初始化与真实启停生命周期。
- 文档解析与索引、绘图生成与导出、项目保存及翻译服务。
- 数据库、文件读写、配置持久化与受限 IPC 业务接口。
- 运行期数据目录 `app-data/`（架构设计 §7.2）：属运行产物，已加入 `.gitignore`，不入库。
