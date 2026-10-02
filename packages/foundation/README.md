# @reisa/foundation

基础服务层：提供机制，不含业务逻辑（架构设计 §3、§7、§8）。Node/Electron 主进程部分已实现。

## 已实现

- `appDataLayout`：运行期数据布局（§7.2）——`foundation/`（共享配置与凭据）、`main/`（会话库与附件）、`modules/<id>/`（模块私有存储）。
- `createFileConfigService`：JSON 文件配置（原子写入），承载公共基础配置（主题、语言、服务商连接等）。
- `createFileCredentialStore`：凭据存储（引用名 → 加密密文，原子写入）；加密器可注入，正式运行应接入 Electron `safeStorage`，缺省直通模式仅限开发测试并会警告。
- `createNodeModuleServices`：模块作用域服务工厂（`settings.json` + `files/`），经 `ModuleHostOptions.servicesFactory` 注入 module-host。
- SQLite 驱动选型：`node:sqlite`——已在 Electron 41 主进程（Node 24）与本机 Node 22 实证可用，零原生依赖，免 ABI 重编译。

## 边界

- 不成为跨模块读取数据的旁路：不提供 `getDatabase(moduleId)`、全局文件枚举或私有配置查询接口（§7.2）。
- 不导入业务模块；基础包不依赖任何 `modules/*` 包。
- 日志不采集模块私有数据、密钥或未公开配置（§9）。

## 测试

`pnpm test` 包含 `test/foundation.test.mjs`：布局路径、配置持久化与重载、凭据加解密与落盘、模块作用域隔离。
