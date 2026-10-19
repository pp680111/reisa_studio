# 实现方案：repo-explorer 模块与角色化 Prompt 管理

> 状态：待审核（实现级设计，评审通过后按 Phase 1 → 2 → 3 实施）
>
> 目标：参考 ops_agent（deepagents + LangGraph）的两大能力，在 reisa_studio 落地：
> 1. 通过模块注册本地代码仓库，为模型提供只读代码检索工具（ls / read_file / glob / grep / list_repos）；
> 2. 会话级"角色"机制：每套 prompt 方案是一个角色，新建会话时选定，之后不可切换。

---

## 0. 总体决策（已与需求方确认）

| 决策点 | 结论 |
| --- | --- |
| 角色归属 | 主应用（`apps/desktop`），不做模块。会话归属主应用（架构设计 §7.1/§7.4），角色与会话强关联，避免模块启停影响角色可用性 |
| 角色切换 | 不允许。仅新建会话时选择；不提供 setRole IPC 与 UI 切换入口 |
| 角色提示词语义 | 引用而非快照：会话只存 `role_id`，每轮 send 读取角色当前 prompt。编辑角色 prompt 影响所有绑定会话的后续轮次（UI 需提示） |
| 被引用角色删除 | 拒绝删除，提示使用"停用"；停用后不出现在新建选择器，但继续服务已绑定会话 |
| 无角色语义 | `role_id = NULL` 即"默认助手"，注入全局默认提示词（现 `agent.systemPrompt`），不落库角色行 |
| ops_agent 行为纠偏中间件 | 本期不移植（agent-adapter 无 wrap/after 钩子）。仅靠角色 prompt 内的规则约定；二期评估在 agent-adapter 增加中间件机制 |
| 角色绑定工具集合 | 本期不做。能力仍每轮全量提交（架构设计 §6.2/§6.3）；等工具数量增多后再评估角色→能力过滤 |
| git_inspect | **不在本期实现范围**。本期 repo-explorer 仅提供五个文件级只读工具；后续如需 Git 历史排查能力，另行评估立项 |

---

## Phase 1：repo-explorer 模块

### 1.1 目录结构与依赖

```
modules/repo-explorer/
├── package.json               # @reisa/module-repo-explorer（exports "." 与 "./runtime"）
├── contracts.ts               # 能力契约（Typebox schema，与 knowledge 模块同模式）
├── manifest.ts                # ModuleContribution（settings UI，无 navigation 页面）
├── index.ts                   # 公开入口：re-export manifest
├── runtime/
│   ├── index.ts               # RepoExplorerRuntime（activate / pageService）
│   ├── config.ts              # 注册表读写（模块私有 settings.json，key="repos"）
│   ├── sandbox.ts             # 虚拟路径解析 + 沙箱校验 + 真实路径脱敏
│   └── tools.ts               # ls / read_file / glob / grep 纯函数实现（接收已解析的绝对路径）
├── ui/
│   └── RepoExplorerSettings.tsx
└── test/
    ├── sandbox.test.mjs
    ├── tools.test.mjs
    └── registry.test.mjs
```

依赖：`@reisa/module-sdk`、`@sinclair/typebox`、`@reisa/ui`、`react`、`tinyglobby`（glob 遍历）、`ignore`（gitignore 语义，knowledge 已用同款）。

> 开放问题 A：grep 实现选纯 JS（读文件逐行正则，无外部二进制，大仓库慢但有上限兜底）还是引入 ripgrep（快但需分发二进制）。**建议纯 JS**，上限控制见 1.3，后续有性能诉求再换。

### 1.2 能力契约（contracts.ts）

工具名遵循 SDK 规则 `${moduleId}__${action}`，即 `repo-explorer__*`。所有路径参数一律使用虚拟路径（`/repos/<name>/...`，POSIX 风格），输出与错误中不出现宿主机真实路径。

```ts
// 1) list_repos —— 无入参
ListReposOutput = {
  repos: [{ name: string, path: string /* /repos/<name>/ */, tags: string[], description: string|null }],
}

// 2) ls
LsInput  = { path: string }                       // 虚拟目录路径
LsOutput = { path: string,
             entries: [{ name: string, type: 'file'|'directory', size: number|null }],
             truncated: boolean }                  // 超过 1000 条截断

// 3) read_file
ReadFileInput  = { path: string,
                   offset?: int(>=1, default 1),   // 起始行（1-based）
                   limit?:  int(1..2000, default 500) }
ReadFileOutput = { path: string, content: string,
                   startLine: int, endLine: int,
                   truncated: boolean }            // 行截断 / 单次读取超 512KB 截断

// 4) glob
GlobInput  = { pattern: string,                   // 相对 path，支持 **；禁止以 / 或盘符开头
               path: string }                     // 搜索根（虚拟目录）
GlobOutput = { matches: string[], truncated: boolean }   // 虚拟路径数组，上限 500

// 5) grep
GrepInput  = { pattern: string,                   // JS 正则（new RegExp 语义，非法正则报 INVALID_INPUT）
               path: string,                      // 搜索根
               glob?: string,                     // 文件名过滤，如 "*.ts"、"src/**"
               maxCount?: int(1..200, default 50) }
GrepOutput = { matches: [{ path: string, line: int, snippet: string }],
               truncated: boolean, filesSearched: int }
```

所有 schema 用 Typebox（`Type.Object` / `Type.String` / `Type.Integer`），与 knowledge `contracts.ts` 完全同构；输入/输出校验由 module-host 统一执行（`host.invoke`），模块内不重复校验边界以外的东西。

错误映射（沿用 SDK `toolFailure` 码）：
- 路径不合法 / 越界 / 未注册 → `INVALID_INPUT`，文案引导使用 `/repos/<name>/` 显式路径；
- repo 名不存在、目标不存在 → `RESOURCE_NOT_FOUND`；
- 正则非法 → `INVALID_INPUT`；
- OS 读失败（权限等）→ `EXECUTION_FAILED`，消息重写为通用文案 + 虚拟路径（不透传 OS 原始消息，防真实路径泄露）。

### 1.3 工具实现约束（tools.ts）

- **忽略规则**：遍历/搜索默认跳过 `.git/`、`node_modules/`、`dist/`、二进制文件（扩展名黑名单 + 读前 8KB NUL 嗅探）；读取注册仓库根的 `.gitignore` 并应用（`ignore` 库）。`ls` 与 `read_file` 不应用 ignore（用户显式指定的文件应可读）。
- **大小上限**：grep 跳过 >1MB 的文件；read_file 单次最多读 512KB 或 2000 行，`truncated=true` 提示续读 offset。
- **grep 行为**：逐文件逐行匹配（流式读取，按行 split），命中即记录 `path/line/snippet`（该行原文截断到 500 字符）；达 `maxCount` 停止并置 `truncated`；返回 `filesSearched` 供模型判断覆盖面。
- **全部只读**：不提供任何写入能力；实现层只调用 `fs/promises` 的读与目录枚举 API。

### 1.4 沙箱设计（sandbox.ts）

核心函数：

```ts
resolveVirtualPath(registry: readonly RepoRegistration[], rawPath: string):
  { repo: RepoRegistration, absolutePath: string, relativePart: string }
// 失败抛 SandboxError(code, 用户可读中文消息)
```

校验链（对齐 ops_agent `ScopedCompositeBackend._is_scoped_path` 与 git 工具的路径校验）：

1. 非空字符串；统一 `\` → `/`；trim；
2. 拒绝：`''`、`.`、`/`、`/.`、`~`、含 `..` 路径段、Windows 盘符（`/x:/` 形态）、以 `~` 开头；
3. 必须以 `/repos/` 开头；第二段 `<name>` 匹配 `^[A-Za-z0-9][A-Za-z0-9._-]*$` 且在注册表中存在且 `enabled`；
4. 余下段拼接为 repo 内相对路径：`resolve(repoPath, relativePart)` 后必须 `startsWith(resolve(repoPath) + sep)`；
5. 对已存在的目标做 `realpath` 归一并复验仍在 `realpath(repoPath)` 内（防 symlink 逃逸；不存在的路径用第 4 步的 resolve 检查）；
6. glob 的 `pattern` 同样拒绝绝对路径语义（以 `/`、盘符、`..` 开头/包含）。

**脱敏**：所有工具输出与错误只含虚拟路径；模块 logger（宿主日志，不到模型）可记真实路径。

**注册表（config.ts）**，存模块私有 settings（`ModuleContext.config`，key `repos`）：

```ts
interface RepoRegistration {
  id: string;            // repo_<uuid>
  name: string;          // 唯一，^[A-Za-z0-9][A-Za-z0-9._-]*$
  path: string;          // 宿主机绝对目录（登记时校验存在且为目录）
  tags: string[];
  description: string;
  enabled: boolean;
  createdAt: number;
}
```

`loadRegistry` 做归一化与容错（非法条目跳过 + logger warn，对齐 ops_agent `load_repo_registry` 与 knowledge `loadSettings` 风格）。

### 1.5 runtime/index.ts

照 knowledge 模式实现 `RepoExplorerRuntime implements RuntimeModule`：

- `activate(context)`：加载注册表（内存缓存）→ 返回五个 `ToolRegistration` + `deactivate`。无后台任务、无外部连接，deactivate 仅清引用与注销页面服务。
- **注册表一致性**：页面服务增删改后更新内存缓存；工具执行与页面操作共用一把 `AsyncMutex`（knowledge 同款），保证调用期间注册表不被切换。缓存语义 = 工具始终看到最新注册表，添加仓库无需重启模块。
- **页面服务**（`pageService()`，经受限通道 `reisa/module/page`，绝不注册为 Agent 能力，对齐 knowledge §5.3 安全分层）：
  - `list_repos` / `add_repo`（name、tags、description；路径经宿主 `reisa/module/pickPath` 由用户选择，服务端校验存在且为目录、name 唯一）/ `update_repo`（tags/description/enabled/改名改名需重名校验）/ `remove_repo` / `test_repo`（验证目录可读、报告是否含 `.git`）。
- 错误处理：`SandboxError` → `toolFailure(INVALID_INPUT)`；其余统一 `EXECUTION_FAILED` + 脱敏文案。

### 1.6 设置 UI（ui/RepoExplorerSettings.tsx）

对齐 knowledge 设置页交互（`ModuleSettingsProps`：`notify` / `close`）：

- 仓库列表：名称、标签、路径（只读展示）、启用开关、删除（确认）；
- 添加表单：名称（校验正则提示）、标签（逗号分隔）、描述、"选择目录…"（`window.reisa.module.pickPath`，preload 现有通道）、"测试"按钮；
- 操作经 `bridge.module.page('repo-explorer', action, input)`，成功/失败用 `notify` 反馈。

### 1.7 宿主接线（零逻辑改动，三处声明）

1. `apps/desktop/src/composition/modules.ts`：清单加入 `repoExplorerManifest`；
2. `apps/desktop/src/composition/runtime.ts`：`RUNTIME_MODULES` 加入条目（`registerPageService` 注入同 knowledge）；
3. 根 `package.json` `test` 脚本 glob 追加 `modules/repo-explorer/test/*.test.mjs`。

模块启停复用现有机制：停用即五个工具从能力集合消失（`listEnabledCapabilities` 只含 active 模块），无需宿主改动。

### 1.8 测试（node --test，fixtures 用临时目录）

- `sandbox.test.mjs`：全部拒绝用例（空/`.`/`/`/`..`/`~`/盘符/未注册名/注册目录外/symlink 逃逸 fixture）+ 合法解析用例（含 Windows 真实路径映射）；
- `tools.test.mjs`：fixture 仓库上验证 ls 截断、read_file 行窗与截断、glob 模式与上限、grep 正则/glob 过滤/maxCount/二进制跳过/`truncated`、输出不含 fixture 真实绝对路径（断言）；
- `registry.test.mjs`：增删改、name 冲突、路径不存在、非法 name、enabled 过滤对工具可见性的影响。

---

## Phase 2：角色化 Prompt 管理

### 2.1 数据层（apps/desktop/src/main/conversations/store.ts 扩展）

```sql
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,             -- role_<uuid>
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  include_base_prompt INTEGER NOT NULL DEFAULT 0,   -- 注入时把全局默认提示词拼在角色 prompt 前
  builtin INTEGER NOT NULL DEFAULT 0,               -- 内置：不可改不可删不可停用
  disabled INTEGER NOT NULL DEFAULT 0,              -- 停用：不进新建选择器，仍服务已绑定会话
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- conversations 迁移：pragma table_info 无 role_id 时执行
ALTER TABLE conversations ADD COLUMN role_id TEXT;
```

`ConversationStore` 新增方法：

- `listRoles(): Role[]` / `getRole(id)` / `createRole({name, description, prompt, includeBasePrompt})` / `updateRole(id, patch)` / `deleteRole(id)`；
- 删除保护：`builtin=1` → 抛 `ROLE_IMMUTABLE`；`countConversationsWithRole(id) > 0` → 抛 `ROLE_IN_USE`（附引用数）；
- `createConversation(title, roleId?)`：roleId 非空时校验角色存在且未停用（停用角色不可新建绑定）；
- `getConversation` / `listConversations` 返回值增加 `roleId?: string`。

迁移放在 `ConversationStore.open()` 内 `CREATE TABLE` 之后（现状 `CREATE TABLE IF NOT EXISTS` 之外新增一步 pragma 检查 + ALTER，向后兼容旧库文件）。

**内置角色种子**：首次打开 roles 表为空时插入内置"运维排查专家"（`builtin=1`）。内置角色的 prompt 以代码内常量为权威：每次启动与代码内版本比对，不一致则覆盖（builtin 不可编辑，覆盖无冲突，且便于随版本修复）。代码内常量放 `apps/desktop/src/main/roles/seed.ts`。

### 2.2 注入改造

`apps/desktop/src/main/conversation-manager.ts`：

```ts
// 签名变更：
readonly resolveSystemPrompt: (conversationId: string) => Promise<string | undefined>;
```

`send()` 内改为 `this.#options.resolveSystemPrompt(conversationId)`（`conversation-manager.ts:147-156` 处，其余流程不动；system 消息仍是每轮重建）。

`apps/desktop/src/main/index.ts` 实现（替换现 `index.ts:98` 的单行实现）：

```ts
resolveSystemPrompt: async (conversationId) => {
  const base = await runtime.config.get<string>('agent.systemPrompt');
  const conversation = store.getConversation(conversationId);
  if (!conversation?.roleId) return base;                    // 无角色 → 全局默认
  const role = store.getRole(conversation.roleId);
  if (!role) return base;                                    // 兜底：角色缺失（理论不可达）→ 全局默认 + logger.warn
  const parts = [];
  if (role.includeBasePrompt && base?.trim()) parts.push(base);
  if (role.prompt.trim()) parts.push(role.prompt);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
},
```

停用角色仍按上述路径服务已绑定会话（按 0 节决策）。

### 2.3 IPC 与 preload

`apps/desktop/src/main/index.ts` `registerIpc()` 新增：

- `reisa/roles/list` → `Role[]`（含 prompt，本地应用无脱敏需求）；
- `reisa/roles/create { name, description?, prompt, includeBasePrompt? }`；
- `reisa/roles/update { id, name?, description?, prompt?, includeBasePrompt?, disabled? }` — builtin 返回 `ROLE_IMMUTABLE` 错误；
- `reisa/roles/delete { id }` — builtin/被引用返回对应错误码与文案；
- `reisa/conversations/create` 处理器签名扩为 `(title?: string, roleId?: string)`。

不新增 `setRole`（0 节决策）。`apps/desktop/src/preload/index.ts` 与 `renderer/bridge.ts` 同步暴露 `roles` 命名空间与 `createConversation` 新签名。

### 2.4 Renderer

- **AppShell.tsx（新建会话流）**：点击"新建"弹出角色选择（小型弹层：第一项"默认助手 · 使用全局默认提示词"（虚拟项，roleId 空）+ 未停用角色列表，每项展示名称与描述）；选中后 `createConversation(undefined, roleId)`。**首次启动自动创建的初始会话保持无角色，不弹选择**。会话列表项与会话头部展示角色徽标（只读，悬停提示"角色在创建时已固定"）。
- **SettingsPage.tsx**：
  - 现"系统提示词"区块改名"默认提示词"，hint 注明"会话未选择角色时生效"（IPC `reisa/settings/getPrompt|setPrompt` 不变）；
  - 新增"角色"区块：角色列表（名称、描述、内置/停用徽标）、新建/编辑弹窗（名称、描述、"包含默认提示词"开关、prompt 多行编辑器）、"复制"（内置角色 → 生成自定义副本）、停用/启用（内置禁用该操作）、删除（被引用时展示"该角色被 N 个会话使用，请改用停用"）。编辑保存时提示"修改将影响所有使用该角色的会话"。

### 2.5 内置运维角色 prompt（seed.ts 常量）

以 ops_agent `prompts/ops_system.md` 为底稿改写，要点：

1. **工具名对齐**：`knowledge_search` → `knowledge__search`；文件工具指令改写为 `repo-explorer__list_repos / ls / read_file / glob / grep`（prompt 中工具名必须与实际注册能力名一致）；
2. **路径规则改写**：删除 `/workspace/`、`/artifacts/` 等 deepagents 表述；代码访问流程改为"先 `repo-explorer__list_repos` 获取仓库与标签 → 按名称/标签匹配单一仓库 → 文件工具显式传入 `/repos/<name>/` 路径，禁止根路径与省略路径搜索"；
3. **模块缺失容错**：新增一条"若某工具当前不可用（模块未启用），明确说明并基于已有信息继续，不臆造工具结果"；
4. **保留**：逐步追问策略、枚举约束（`## 可能原因方向` / `## 诊断结论` 标记）、备选方案要求、根因边界规则、内部状态字段说明表、检索优先级（知识库 → 代码库）、证据不可信约束（改为通用安全条款；**删除原 ops_system.md 中整个"Git 历史与版本差异"小节及 `git_inspect` 相关表述**——本期无 Git 工具，prompt 中不得引用不存在的工具）；
5. 标记协议（`备选方案：` 等）保留文本约定，但注明本期无强制纠偏（见 0 节）。

### 2.6 测试

- store：迁移（旧库打开后 role_id 生效、roles 表建成）、角色 CRUD、删除保护（builtin / 被引用）、停用角色不可绑定新会话但可服务旧会话、种子与 builtin prompt 覆盖逻辑；
- ConversationManager：注入组合矩阵（无角色→全局 / 有角色→角色 / includeBasePrompt→拼接 / 角色缺失→回退全局），mock store 与 resolveModel；
- seed：内置角色 prompt 中引用的工具名与 knowledge / repo-explorer contracts 的 `name` 字段一致性（直接 import contracts 断言，防漂移）。

---

## Phase 3：集成验收

手动清单（打包前跑一遍）：

1. repo-explorer 设置页添加 1-2 个真实仓库 → 新建会话让模型 `list_repos` → `grep` 定位一个符号 → `read_file` 读取，确认事件流与工具记录正常；
2. 沙箱负路径：让模型尝试 `/repos/不存在的仓库/`、`.`、真实 Windows 路径，确认全部拒绝且错误不含真实路径；
3. 停用 repo-explorer 模块 → 工具从能力清单消失，运维角色会话仍可对话；
4. 角色全流程：新建（选运维角色）→ 对话验证 system prompt 生效（调试手段：临时在 prompt 末尾加"在回复开头输出你的角色名"）；编辑角色 prompt → 下一轮生效；停用 → 新建列表不可见、旧会话不受影响；删除被引用角色 → 被拒；
5. 旧数据升级：用既有 userData 目录启动，确认 conversations 数据完好且可正常收发（role_id 为 NULL 走全局提示词）；
6. 全量回归：`pnpm typecheck && pnpm check:boundaries && pnpm test`，`pnpm --filter @reisa/desktop build`。

---

## 实施顺序与改动面汇总

| 步骤 | 改动文件（新增▲ / 修改●） |
| --- | --- |
| P1 模块骨架 | ▲modules/repo-explorer/**（contracts/manifest/index/runtime×4/ui/test×3/package.json）●composition/modules.ts ●composition/runtime.ts ●根 package.json（test glob） |
| P2 数据层 | ●main/conversations/store.ts（roles 表 + 迁移 + CRUD + roleId）▲main/roles/seed.ts |
| P2 注入 | ●main/conversation-manager.ts（签名）●main/index.ts（实现 + roles IPC + create 扩参）●preload/index.ts ●renderer/bridge.ts |
| P2 UI | ●renderer/shell/AppShell.tsx（角色选择弹层 + 徽标）●renderer/shell/SettingsPage.tsx（默认提示词改名 + 角色管理区） |
| P3 | ▲docs 验收记录（可选） |

估计工作量：P1 约 60%（沙箱与工具实现占大头），P2 约 30%（store/IPC/UI 常规改造 + prompt 定稿），P3 约 10%。

---

## 待拍板事项

1. **开放问题 A（grep 选型）**：纯 JS（推荐，上限兜底）vs ripgrep 二进制分发；
2. **内置运维角色文案**：Phase 2 实现时我会先按 2.5 的改写规则产出初稿，你审核后再定稿；
3. **角色选择弹层的默认项**：默认选中"默认助手"还是记住上次选择（建议前者，行为可预期）。
