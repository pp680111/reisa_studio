# Card Note 目标项目分析与迁移设计指引

> 版本：0.4（2026-10-03）
> v0.2 变更：按范围决策移除 AI 辅助与画板视图。
> v0.3 变更：R4 补充决策——移除书籍内双向链接（见《迁移范围决策记录》）。
> v0.4 变更：Q1/Q2 按推荐决策落地；新增附录 C 展开 Q4 数据通道方案对比。
> 用途：本文档是 card_note 项目（`D:\otherCode\card_note`）的完整代码分析，作为"把 Card Note 迁移为 Reisa Studio 内置模块"这一后续工作的**设计基线**。后续的模块设计文档、迁移实施计划均以本文档的事实为准。
>
> 阅读约定：`lib/...` 路径均指 `D:\otherCode\card_note\lib\`；行号以当前代码为准。

---

## 目录

- [迁移范围决策记录（v0.3）](#迁移范围决策记录v03)

1. [项目概览](#1-项目概览)
2. [技术栈清单与宿主差异](#2-技术栈清单与宿主差异)
3. [架构与代码组织](#3-架构与代码组织)
4. [数据模型（schema v3）](#4-数据模型schema-v3)
5. [核心业务规则清单（迁移必须保真）](#5-核心业务规则清单迁移必须保真)
6. [功能域详解](#6-功能域详解)
7. [UI 页面与交互清单](#7-ui-页面与交互清单)
8. [测试资产清单](#8-测试资产清单)
9. [设计文档与实现的偏差（迁移以代码为准）](#9-设计文档与实现的偏差迁移以代码为准)
10. [宿主模块系统对接分析](#10-宿主模块系统对接分析)
11. [迁移策略建议](#11-迁移策略建议)
12. [分阶段迁移路线](#12-分阶段迁移路线)
13. [待决策问题清单](#13-待决策问题清单)

---

## 迁移范围决策记录（v0.3）

2026-10-03，基于 v0.1 分析确认以下范围调整（R1–R3 定于 v0.2，R4 为 v0.3 补充）。**第 1–9 节保留对 card_note 源项目的完整事实记录**（M6 旧数据导入仍需了解被移除的部分），带【移除】标记的内容不进入迁移目标；第 10–13 节与附录已按新范围更新。

| # | 决策 | 性质 | 范围影响 |
|---|---|---|---|
| R1 | 移除 AI 辅助生成标签（源 FR-04） | 用户明确 | 删除 `ai_tag_suggestions` 表、建议确认 UI、`tag_note` 任务类型 |
| R2 | 移除 AI 链接自动发现（源 FR-06），即**整个 AI 子系统退出迁移范围** | **推断**（标签建议与链接发现共用同一套 AI 基础设施，用户未确认边界；按 v0.1 分析的推荐项执行） | 删除 `ai_jobs` 表、AI 设置页、`AiClient`/`OpenAiAiService`/`AiScheduler`、API Key 凭据存储（宿主扩展点 H3 不再需要）、AI 相关设置项 |
| R3 | 移除画板视图（源 FR-10） | 用户明确 | 删除 `features/canvas/`、书页画板视图与切换项（三视图 → 列表/网格双视图）；画板坐标本就不持久化，无数据遗留 |
| R4 | 移除书籍内双向链接（源 FR-05 及 FR-12 的关联部分） | 用户明确（v0.3 补充：画板移除后链接失去主要消费场景） | 删除 `note_links` 表、`features/links/`、编辑页关联笔记区、链接规则与相关测试；同步仓库 `links/` 目录与 link 文档类型随之消失 |

**R2 的连锁影响**：

- 【R4 更新】双向链接已整体移除（见 R4）；`note_tags.source` 字段保留（同步文档格式的组成部分），取值恒为 `manual`（旧库中 `ai_accepted` 值原样保留，仅作来源标记）。
- `content_revision` 仍保留并维持"每次保存递增"：它是同步文档与 JSON 导出格式的组成部分。
- `markdownToPlainText`（仅 AI 提示词使用）随之移除；`tabularTextToMarkdown`（编辑器粘贴表格）保留。
- 同步子系统不受影响：AI 任务队列与待确认建议本就被排除在同步仓库之外（源设计即如此）。
- 将来如需笔记智能（自动标签/关联/问答），建议走宿主主 Agent 的能力注册路径（见 Q10），不在模块内重建私有 AI 栈。

**R4 的连锁影响**：

- 详情页/编辑页不再有关联卡片区域，笔记间关系数据在目标中彻底不存在。
- 同步仓库无 `links/` 目录，`SyncDocument` 类型集合收窄为 book/note/tag/note-tag/attachment；旧 card_note 同步仓库中的 `links/` 目录会被目标校验器静默忽略（校验器只读已知类型目录），无需迁移处理。
- 导出/导入格式本就不含链接（源实现即如此），M4 不受影响。
- M6 旧库导入跳过 `note_links` 表。

**R2 回退说明（R4 生效后更新）**：R4 移除链接后，AI 链接自动发现已无数据载体；R1 又已明确移除标签建议——AI 功能在目标范围内已无附着点，R2 不再存在回退场景。若未来重新需要笔记智能，应基于 Q10 的宿主主 Agent 能力路径重新设计，而非恢复 card_note 的私有 AI 栈。

---

## 1. 项目概览

**Card Note** 是一个 Windows 本地优先的阅读笔记卡片应用（Flutter 桌面端）：

- 以"书籍"为隔离容器，逐条录入**笔记卡片**：书籍原文（Markdown，必填）+ 用户备注（可选）+ 页码（可选，单页或范围）+ 全局标签 + 书内双向链接 + 图片附件。
- 三种浏览方式：列表、卡片网格、画板（可缩放平移、显示链接连线、会话内拖动）。
- 当前书籍内搜索（原文 + 备注，不区分大小写子串匹配）。
- AI 辅助：OpenAI 兼容接口的**标签建议**（人工确认后生效）与**书内链接自动发现**（直接生效），基于数据库持久化任务队列异步调度。
- 导出单本书为 Markdown / JSON，JSON 可再导入为副本。
- Git 文本同步（v1）：业务数据以每实体一个 JSON 文件的形式同步到用户自选的私有 Git 仓库。

> **迁移范围说明**：迁移目标应用不包含 AI 辅助（标签建议、链接自动发现）与画板视图，见《迁移范围决策记录》。本节及第 2–9 节仍按源项目全貌记录。

**代码规模**（不含 `.g.dart` 生成代码、构建产物）：

| 范围 | 规模 |
|---|---|
| `lib/` 生产代码 | 约 7,360 行 Dart，42 个文件 |
| `test/` 测试 | 15 个文件，约 1,725 行 |
| 最大的文件 | `lib/core/database/app_database.dart`（1,080 行，业务规则真源）、`lib/features/notes/presentation/note_editor_page.dart`（1,139 行） |

**交付形态**：Windows 便携目录 + NSIS 安装包；数据库在用户 AppData 支持目录（`card_note.sqlite`），附件在 `media/`，日志在 `logs/card_note.log`。

**产品文档**（`docs/` 下，质量很高但与实现有偏差，见第 9 节）：`requirements.md`（产品需求）、`design.md`（技术设计）、`implementation-plan.md`（P0–P12 实施计划）、`git-sync-design.md`（同步设计）、`README.md`（用户视角功能说明）。

---

## 2. 技术栈清单与宿主差异

### 2.1 card_note 技术栈

| 领域 | 选型 | 说明 |
|---|---|---|
| UI 框架 | Flutter 3.27.x / Dart 3.6.x | 仅 Windows Desktop |
| 状态管理 | flutter_riverpod 2.6 | 大量 `StreamProvider.autoDispose` 绑定 Drift `watch()` 流 |
| 路由 | go_router 14.6 | 5 条路由（见第 7 节） |
| 数据库 | drift 2.25 + sqlite3_flutter_libs | SQLite，schema v3，手写迁移 |
| HTTP | dio 5.7 | 仅 AI 客户端使用 |
| 安全存储 | flutter_secure_storage 9.2 | Windows Credential Manager，仅存 AI API Key |
| Markdown/公式 | flutter_markdown_plus 1.0.12 + flutter_markdown_plus_latex 1.0.5 + flutter_math_fork 0.7.4 | 预览渲染；解析用 markdown 7.3（GFM） |
| 网格 | flutter_staggered_grid_view 0.7 | 卡片瀑布流视图 |
| 其他 | uuid 4.5、path、path_provider、file_selector、crypto（附件 SHA-256） | |

### 2.2 与宿主（Reisa Studio）的差异对照

宿主：Electron 41 + React 19 + TS 5.9 + Vite 7 monorepo（pnpm），数据库用 Node 内置 `node:sqlite`（`DatabaseSync`），agent 框架为 AI SDK v7。

| card_note（Flutter/Dart） | 宿主对应物 | 差异等级 |
|---|---|---|
| Drift/SQLite（schema v3） | `node:sqlite`（主进程已有 `conversations.sqlite` 先例） | **低**：DDL/SQL 几乎可直译；无 watch 流，需换刷新机制 |
| Riverpod `StreamProvider` + Drift `watch()` | 主进程服务 + 类型化 IPC（查询 + 变更事件推送） | **高**：响应式模型需重新设计 |
| go_router 5 页面 | 模块页面内部视图状态机（宿主侧栏只提供模块级导航） | 中 |
| flutter_markdown_plus(+latex) | react-markdown + remark-gfm（宿主已有）+ remark-math/rehype-katex（需新增） | 中 |
| flutter_staggered_grid_view | CSS grid/columns 自实现 | 低 |
| InteractiveViewer + CustomPainter（画板） | 无现成库，需自研（SVG 或 Canvas）或引 konva | **高**（随 R3 移除） |
| Dio | 主进程 `fetch`（Node 22 内置）或 `@ai-sdk/openai-compatible` | 低（仅 AI 客户端使用，随 R2 移除） |
| flutter_secure_storage（凭据） | 宿主 credentials（safeStorage/DPAPI 加密 JSON），但 **ModuleContext 未暴露凭据句柄** | 中（随 R2 移除） |
| `Process.run('git')`（同步） | `child_process.execFile('git')` | 低 |
| file_selector | Electron `dialog` IPC（宿主现无此通道） | 中（需宿主扩展） |
| uuid 4.5 | `crypto.randomUUID()` | 零 |
| UTC 毫秒时间戳 / UUID 主键 | 相同约定 | 零 |

---

## 3. 架构与代码组织

### 3.1 分层

```text
Presentation   features/*/presentation/*.dart（Riverpod Consumer 页面）
                     │
Data           features/*/data/*_repository.dart（薄封装，几乎无逻辑）
                     │
AppDatabase    core/database/app_database.dart（★ 全部业务事务与规则都在这层）
                     │
Infrastructure Drift/SQLite、Dio、flutter_secure_storage、Process.run(git)、文件系统
```

**关键事实：card_note 的仓储层是纯透传**（如 `book_repository.dart` 仅 18 行），而所有跨表事务、级联删除、同步 outbox 记录、AI 任务排队、链接端点规范化等业务规则**全部集中在 `app_database.dart`（1,080 行）**。迁移时这份文件就是"业务规则真源"，应逐段对照移植，而不是依赖 design.md 的描述（两者有偏差，见第 9 节）。

### 3.2 启动装配（`lib/main.dart`）

手工构造依赖，无 DI 框架：

```text
AppLogger（文件日志，失败降级 Noop）
AppDatabase.open()                    ← 支持目录 card_note.sqlite，PRAGMA foreign_keys=ON
AiSettingsRepository(db, SecureApiKeyStore)
AiScheduler(db, settingsRepo, OpenAiAiService(AiClient(logger)), logger)
SyncSettingsRepository(db)
SyncCoordinator(exporterFactory, validator, importer, settingsRepo, GitClient, logger)
SyncScheduler(db, settingsRepo, synchronize: () => coordinator.synchronize())
→ ProviderScope(overrides: database/aiScheduler/syncCoordinator/syncScheduler)
→ CardNoteApp
→ unawaited(scheduler.start())        ← 启动即恢复遗留任务并跑一轮
→ unawaited(syncScheduler.start())
```

对应到宿主模块：这段装配应翻译为模块 **runtime（主进程侧）`activate(context)` 内的服务构造**，`deactivate()` 内反向清理（Timer、AbortController）。

### 3.3 目录映射

```text
lib/app/                  app.dart(19)/providers.dart(161)/router.dart(56)/theme.dart(30)
lib/core/database/        app_database.dart(1080) + app_database.g.dart（生成）
lib/core/logging/         app_logger.dart(106)：文件日志、2MB 轮转、脱敏
lib/features/books/       data/book_repository.dart(18) + presentation/(list 279 + detail 661)
lib/features/notes/       data/(33) domain/(markdown_text 39 + note_validation 54)
                          presentation/(note_editor_page 1139 + latex_markdown_body 69)
lib/features/tags/        data/(22) + presentation/tag_management_page(159)
lib/features/links/       data/link_repository.dart(25) 【R4 移除】
lib/features/attachments/ data/attachment_repository.dart(172)
lib/features/canvas/      domain/canvas_graph.dart(49) + data/canvas_graph_repository.dart(58) 【R3 移除】
lib/features/ai/          domain/(service 7 + models 47 + settings 62 + client_exception 19)
                          data/(client 217 + service 124 + scheduler 208 + job_repo 24
                                + settings_repo 34 + secure_store 19)
                          presentation/(settings_page 240 + queue_status 102)
lib/features/export/      data/book_export_service.dart(251)
lib/features/sync/        domain/(document 181 + settings 36)
                          data/(workspace 622 + coordinator 149 + git_client 236
                                + scheduler 62 + settings_repo 61)
                          presentation/sync_settings_page.dart(352)
```

---

## 4. 数据模型（schema v3）

数据库文件：`<Application Support>/card_note.sqlite`，`PRAGMA foreign_keys = ON`。所有主键为 UUID 字符串，时间为 UTC 毫秒整数。定义见 `lib/core/database/app_database.dart:11-216`。

### 4.1 表清单

| 表 | 主键 | 外键级联 | 唯一约束 | 用途 |
|---|---|---|---|---|
| `books` | id (UUID) | — | — | 书名 title |
| `notes` | id (UUID) | book_id → books CASCADE | — | quote(Markdown 必填)、comment(可空)、page_start/page_end(可空)、content_revision(默认 1) |
| `note_attachments` | id (UUID) | note_id → notes CASCADE | — | stored_file_name(SHA-256 命名)、original_file_name、mime_type、byte_size、width/height(可空，**未填充**)、sort_order、content_hash |
| `tags` | id (UUID) | — | normalizedName | name、normalizedName(trim+lowercase) |
| `note_tags` | (note_id, tag_id) | 双 CASCADE | PK 即唯一 | source: `manual` \| `ai_accepted` |
| `note_links`【R4 移除】 | id (UUID) | book_id、note_a_id、note_b_id 均 CASCADE | (note_a_id, note_b_id) | 无向边，端点按 `compareTo` 升序存储；source: `manual` \| `ai` |
| `ai_tag_suggestions`【R1 移除】 | id (UUID) | note_id → notes CASCADE | (note_id, normalizedName, content_revision) | display_name、reason(可空)、status: `pending`\|`accepted`\|`rejected`、decided_at |
| `ai_jobs`【R2 移除】 | id (UUID) | —（**无外键**） | (job_type, entity_id) | job_type: `tag_note`\|`link_book`；status: `pending`\|`running`\|`retry_wait`；attempts、next_run_at、last_error_code |
| `app_settings` | key (TEXT) | — | — | KV 设置（AI 配置 + 同步配置，**不含 API Key**） |
| `sync_outbox` | (entity_type, entity_id) | — | — | operation: `upsert`\|`tombstone`；changed_at；同实体只保留最新一条 |

> v0.2/v0.3 注：`ai_tag_suggestions`（R1）、`ai_jobs`（R2）与 `note_links`（R4）不进入迁移目标库——目标库直接建精简 schema（附录 A），无需复刻 v1→v3 迁移路径；M6 旧库导入时识别并跳过这些表。

### 4.2 迁移历史

```text
v1：核心 7 表（books/notes/tags/note_tags/note_links/ai_tag_suggestions/ai_jobs/app_settings）
v2：+ sync_outbox
v3：+ note_attachments
```

`app_settings` 实际使用的 key（`ai_settings_repository.dart`、`sync_settings_repository.dart`）：

```text
ai_base_url / ai_model_name / ai_auto_process / ai_interval_minutes
sync.workspace_path / sync.remote_url / sync.device_id / sync.last_synced_head
sync.auto_sync / sync.interval_minutes
```

API Key 不在任何表中，只在 Windows Credential Manager（key：`card_note_ai_api_key`，空值即删除）。

### 4.3 实体关系与删除策略

```text
BOOKS 1─* NOTES 1─* NOTE_TAGS *─1 TAGS（全局共享）
BOOKS 1─* NOTE_LINKS（无向边，同书内）【R4 移除】
NOTES 1─* NOTE_ATTACHMENTS
NOTES 1─* AI_TAG_SUGGESTIONS【R1 移除】
AI_JOBS：entity_id 指向 note（tag_note）或 book（link_book），无外键【R2 移除】
```

- 删除书籍 → 同事务写 book/note/note-tag/attachment/link 五类 tombstone outbox → 清该 book 的 ai_jobs → 级联删行（`app_database.dart:275-317`）。
- 删除笔记 → note/note-tag/attachment/link tombstone → 清该 note 的 ai_jobs → 级联删行（`app_database.dart:599-631`）。
- 删除标签 → tag tombstone + note-tag tombstone → 级联删关联，**不删笔记**；不清理失去引用的其他标签（由用户在标签管理处理）。
- v0.2/v0.3 目标：上述删除流程不再包含 AI 任务清理与链接 tombstone 步骤，其余不变。

---

## 5. 核心业务规则清单（迁移必须保真）

以下是散落在 `app_database.dart`、各 repository/scheduler 中的行为规则，属于迁移时的"验收清单"。**每一项在 card_note 的测试中基本都有覆盖**（见第 8 节），迁移时应把对应测试一并移植。

### 5.1 校验规则

| # | 规则 | 出处 |
|---|---|---|
| V1 | 书名/标签名 trim 后非空 | `createBook`/`ensureTag` |
| V2 | 标签名归一化 = trim + lowercase；归一化名全局唯一（重命名冲突时报错"已有同名标签"） | `_normalizeTagName`、`renameTag` |
| V3 | 原文 quote trim 后非空，否则拒绝保存 | `note_validation.dart:47` |
| V4 | 页码正则 `^(\d+)(?:\s*-\s*(\d+))?$`；正整数；end ≥ start；起止同空或同非空；单页存为 start=end | `parsePageRange` |
| V5 | 附件 ≤10MB；仅 PNG/JPEG/WebP；内容 SHA-256 命名（`.jpeg`→`.jpg`） | `attachment_repository.dart:12,39-53` |
| V6 | 【R2 移除】AI 设置：Base URL 必须 http(s)、host 非空、无 userinfo/query/fragment；非 localhost/127.0.0.1 强制 HTTPS；模型名非空；间隔 1–1440 分钟 | `ai_settings.dart:47-62` |
| V7 | 同步：初始化/克隆目录必须为空；workspace 必须是 Git 仓库才能同步 | `git_client.dart:70,89` |

### 5.2 笔记保存事务（`saveNote`，`app_database.dart:478-597`）

单事务内依序：

1. 插入或更新笔记；`contentRevision = 旧值 + 1`（**每次保存都递增，即使内容未变**）。
2. 全删重插 `note_tags`（source 一律 `manual`）；校验 tagIds 全部存在，否则抛"存在无效的标签"。
3. 写 outbox：note upsert；被移除的旧标签写 note-tag tombstone，新标签写 note-tag upsert。
4. 删除并重建 `tag_note` 任务（targetRevision = 新 revision，nextRunAt = now）——**同类型同实体只有一个未完成任务，天然合并连续编辑**。
5. 删除并重建 `link_book` 任务（entity=bookId，nextRunAt = now + 30s）——**书级防抖**。

> v0.2 注：迁移目标中步骤 4、5 随 AI 移除而删除，保存事务仅剩步骤 1–3；`contentRevision` 仍每次保存递增。

### 5.3 链接规则【R4 移除】（`createLink`/`deleteLink`/`writeAiLinks`）

- 端点按 `String.compareTo` 排序存储 `note_a_id < note_b_id`；无向边靠此去重。
- `createLink`：拒自链接 → 校验两端存在且同书 → 已存在则静默 no-op。
- `writeAiLinks`（AI 批量写）：单事务内校验每个端点都属于本书、非自链接，去重后插入 `source='ai'`；任何结构校验失败整批抛异常不写入。
- AI 只新增链接，永不删除已有链接。

### 5.4 AI 建议规则【R1+R2 移除】

- `writeAiTagSuggestions`（`app_database.dart:723-757`）：写入前核对 note.contentRevision == 传入 revision（不匹配抛"笔记内容已更新，AI 结果已过期"）；先删该笔记全部 pending 再插入；按归一化名去重。
- `acceptAiTagSuggestion`（`app_database.dart:777-848`）：单事务内 ensureTag（复用同归一化名标签或新建）→ `note_tags` upsert（source=`ai_accepted`）→ 建议置 accepted → 重建该书 `link_book` 任务（30s 防抖）。建议过期（笔记已改版本）则拒绝接受。
- 建议 ≠ 标签：AI 结果永远只进 `ai_tag_suggestions`，人工接受后才成为正式标签。

### 5.5 AI 调度器【R2 移除】（`ai_scheduler.dart`）

- `start()` = `restart()`：取消 Timer → `recoverRunningAiJobs()`（running→retry_wait，error='interrupted'）→ 加载设置；autoProcess 关或无 Key 则不启动 → 立即 `runOnce()` → `Timer.periodic(interval)`。
- 单飞锁 `_running`；同一时刻最多一个 AI 请求。
- `runNow()`（force）绕过 autoProcess 开关但**不绕过**配置校验与单飞锁。
- 任务领取 `claimNextDueAiJob`（`app_database.dart:948-979`）：取 nextRunAt ≤ now 的最早 pending/retry_wait 任务，条件 UPDATE 置 running（更新数 ≠ 1 即放弃，防并发重复领取），attempts+1。
- 失败退避 `retryAiJob`（`app_database.dart:998-1017`）：`delayMinutes = configurationError ? 360 : 2^attempts`（attempts 已在领取时 +1，即实际序列 **2,4,8,16,32,64 分钟封顶**；配置错误 360 分钟）。⚠️ design.md 写的是 1/5/15/60，实现是 2^n。
- **authentication / configuration 错误**：暂停自动处理（取消 Timer + `_pausedForConfiguration`），保存设置后 `restart()` 恢复。
- tag_note 处理：笔记不存在 → 完成任务；版本不符 → 直接返回（等下一次）；调 AI 前后各核对一次版本。
- link_book 处理：书内 <2 条笔记 → 完成；候选召回见 5.6。

### 5.6 链接候选召回【R2 移除】（`ai_scheduler.dart:500-544`）

- 同书两两组合（O(n²)），排除：已有链接对、无共享信号的配对。
- **共享信号 = 关键词交集**：正则 `[A-Za-z0-9\u4e00-\u9fff]{2,}` 从 `quote + comment` 提词（lowercase，每侧最多 40 词）。⚠️ design.md 提到的"共同标签"信号**未实现**。
- 候选上限 40 对（截断即止）；无候选不调 AI，直接完成任务。

### 5.7 同步规则（`sync_workspace.dart`、`sync_coordinator.dart`）

- 所有可同步用例在业务事务内追加/覆盖 outbox（`(entity_type, entity_id)` 主键 → 同实体只保留最新变更）。
- 导出器只产文件不碰 Git；协调器独占写序：exportPendingChanges → `git add --all` + commit（空变更 no-op）→ fetch + rebase origin/main → readAndValidate → importDocuments → push → ack outbox → 记录 last_synced_head。
- 单飞锁；Git 失败保留 outbox，下轮自动重试。
- **导入不走编辑用例**：直接 `insertOnConflictUpdate`，不产生 outbox（不回环）、不创建 AI 任务。
- 导入事务顺序：建标签别名表（按归一化名分组，winner = updatedAt 最新、平局取小 id；canonical 优先复用本地已有标签）→ 先应用全部 tombstone（note-tag → link【R4 移除】 → attachment → note → book → tag）→ 再 upsert（books → tags(合并) → notes → note-tags → links【R4 移除】 → attachments）；孤儿关联（引用不存在的 note/tag/book）静默跳过。
- 附件导入强校验：文件名 = basename 且以 contentHash 开头、MIME 与扩展名匹配、大小 ≤10MB、实际字节数与 SHA-256 均匹配，然后才复制入 `media/`。
- 同步文档格式：2 空格缩进 + 末尾换行的确定性 JSON；解析时检测 Git 冲突标记（`<<<<<<<`/`=======`/`>>>>>>>`）即拒绝；noteTag 文档 id 必须 == `noteId--tagId`；link 端点必须升序【随 R4 移除】。

### 5.8 其他

- Markdown → 纯文本（供 AI 提示词）：GFM 解析取 textContent（`markdown_text.dart`）【随 R2 移除】。
- 粘贴 TSV（≥2 行且每行含 `\t`、列数一致）→ 自动转 Markdown 表格。
- 日志：2MB 轮转到 `.1`；redact `Bearer ***` 与 URL userinfo；写日志失败静默吞掉。
- Git 凭据永不出现在命令行参数（交给 Git Credential Manager / SSH）；错误信息脱敏 URL 中的凭据。

---

## 6. 功能域详解

### 6.1 AI 子系统【R1+R2 整体移除，以下为源项目记录】

```text
AiClient.completeJson(settings, systemPrompt, userPrompt)
  → POST {baseUrl}/chat/completions（末尾无 /chat/completions 则拼接）
  → Authorization: Bearer <key>；temperature=0；response_format={type:'json_object'}
  → 超时 15s/30s；响应 content ≤256KB；choices[0].message.content 必须 JSON 对象
  → 状态码映射：401/403→authentication；429→rateLimited；≥500→server；其他 4xx/5xx→unknown；无响应→network

OpenAiAiService（openai_ai_service.dart）
  suggestTags(NoteContext{note, tags, globalTagNames≤200})
    system: "你是阅读笔记整理助手。只返回 JSON，不要 Markdown。标签应简短、可复用、避免同义重复。"
    user:   已有标签列表 + markdownToPlainText(quote) + comment
    ← {"suggestions":[{name, reason}]}；≤8 条；name ≤64 字；reason ≤256 字；归一化去重
  discoverLinks(BookLinkContext{candidates≤40})
    user: 每对 "idA|idB\nA: <quoteA>\nB: <quoteB>"，以 \n---\n 分隔
    ← {"links":[{noteAId,noteBId}]}；≤40 条；必须落在候选集合内，否则整批 FormatException
  testConnection：max_tokens=4 的 "Reply with OK."
```

设置默认值：`https://api.openai.com/v1` / `gpt-4o-mini` / autoProcess=true / interval=10 分钟。

### 6.2 Git 同步子系统

工作区格式（format `card-note-sync` v1）：

```text
<workspace>/
  card-note.json                {"format":"card-note-sync","formatVersion":1,"createdAt":...}
  books/<uuid>.json  notes/<uuid>.json  tags/<uuid>.json
  note-tags/<noteId>--<tagId>.json  links/<uuid>.json【R4 移除】  attachments/<uuid>.json
  assets/<sha256>.<ext>         附件二进制
```

同步设置无独立表（设计文档中的 `sync_state`/`sync_conflicts` 未实现），全部在 `app_settings`；deviceId 首次 load 时生成并持久化。

初始化两条路径：`initializeNewWorkspace`（空目录 init + 全量快照导出）、`cloneAndImport`（克隆 → 校验 → 导入；要求本地库为空或已备份，重试时复用已克隆干净的工作区）。

### 6.3 导出 / 导入（`book_export_service.dart`）

- Markdown：`# 书名` + 导出时间/数量 + 逐条 `## 笔记 N`（创建时间、页码、标签、`### 原文`、`### 备注`）。
- JSON：`formatVersion: 1` + book + notes[]（含 id/quote/comment/pageStart/pageEnd/tags/contentRevision/createdAt/updatedAt）。**导出不包含链接与附件**。
- JSON 导入（实现超出原需求文档）：解析校验逐条报错；作为**新书副本**导入（笔记生成新 UUID；标签按名复用/创建；走 `saveNote` → 会触发 AI 任务排队）。

### 6.4 画板【R3 移除，以下为源项目记录】

- 数据：`CanvasGraphRepository.watch(bookId)` 合并 `watchNotes` + `watchBookLinks` 两条流，过滤指向不存在节点的边。
- 初始布局 `computeInitialLayout`（`canvas_graph.dart:22-49`）：确定性圆形布局（center 420,320、radius 240、按 id 排序、起始角 -π/2），0/1/N 节点均安全。
- 交互：InteractiveViewer 平移缩放；CustomPainter 先画边再画卡片；拖动节点实时跟随连线；点击打开笔记编辑页；坐标仅存内存，退出即弃。

### 6.5 基础设施

- 数据布局：`<support>/card_note.sqlite`、`<support>/media/`、`<support>/logs/card_note.log`。
- 附件存储：内容寻址（SHA-256），tmp+rename 原子写，并发/重复安全；`reorderAttachments` 单事务重排序号。

---

## 7. UI 页面与交互清单

路由（`app/router.dart`）：

| 路由 | 页面 | 主要内容 |
|---|---|---|
| `/books` | BookListPage | 书籍列表（updatedAt 倒序）、创建、重命名、删除（级联警告）、JSON 导入、空态/错误态 |
| `/books/:bookId` | BookDetailPage | 工具栏：搜索框（**250ms 防抖**）、视图切换（列表/网格；画板【R3 移除】）、新建笔记、导出 MD/JSON；AI 立即处理与队列状态卡【R2 移除】；笔记摘要（原文/备注截断、页码、标签）；画板视图（含 `_CanvasEdgesPainter`）【R3 移除】 |
| `/books/:bookId/notes/new` | NoteEditorPage | 见下 |
| `/books/:bookId/notes/:noteId/edit` | NoteEditorPage | 同上（编辑复用同页） |
| `/tags` | TagManagementPage | 全局标签库：创建/重命名/删除（删除仅解除关联） |
| `/settings/ai` | AiSettingsPage【R2 移除】 | BaseURL/模型/API Key/自动处理开关/间隔、测试连接、立即处理；保存后 `scheduler.restart()` |
| `/settings/sync` | SyncSettingsPage | 状态卡、选择工作区、初始化新仓库 / 克隆已有仓库、立即同步、自动同步开关+间隔、安全说明；变更后 `syncScheduler.restart()` |

**NoteEditorPage 是"编辑 + 详情"合一的大页**（1,139 行），包含：

- Markdown 编辑器 + 格式工具栏（`_insertMarkdown(prefix, suffix, placeholder)`）+ TSV 粘贴转表格 + 预览切换；
- 附件区：file_selector 选图（≤10MB）、排序（上移/下移）、删除、卡片预览（草稿态 `_AttachmentDraft`，随保存落库）；
- 备注、页码（单页/范围）、标签区（多选 + 新建）；
- 关联笔记区：书内候选选择器（排除自身与已链接卡片）、跳转、删除链接【R4 移除】；
- AI 建议区：逐条接受/拒绝（含理由展示）【R1 移除】；
- 保存（含校验与版本递增）/ 删除。

状态供给（`app/providers.dart`）：全部为 `StreamProvider.autoDispose` 绑定 Drift `watch`，数据一变 UI 自动刷新 —— 这是迁移时**最需要重新设计的响应式链路**。

---

## 8. 测试资产清单

`test/` 共 15 个文件（约 1,725 行），迁移时是最有价值的"行为规约"：

| 测试文件 | 覆盖 |
|---|---|
| `database_test.dart`（323 行） | CRUD、级联删除、重复边/自链接/跨书链接防护、任务合并 |
| `sync_workspace_test.dart`（319 行） | 快照/增量导出、校验、导入、tombstone、标签合并 |
| `sync_git_test.dart`（233 行） | GitClient（假 runner）、协调器流程 |
| `book_export_test.dart`（138 行） | MD/JSON 构建、JSON 导入校验 |
| `book_detail_page_test.dart`（133 行） | 视图切换、搜索 |
| `ai_response_test.dart`（127 行） | 标签/链接响应解析与非法数据过滤 |
| `note_editor_scroll_test.dart`（87 行） | 编辑器滚动行为 |
| `canvas_layout_test.dart` / `canvas_graph_test.dart` | 布局稳定性、图构建 |
| `latex_markdown_body_test.dart` | LaTeX 渲染 |
| `attachment_repository_test.dart` | 哈希命名、MIME/大小限制 |
| `sync_scheduler_test.dart` / `ai_settings_test.dart` / `note_validation_test.dart` / `widget_test.dart` | 其余单元 |

> v0.2/v0.3 注：AI 相关（`ai_response_test`、`ai_settings_test`）与画板相关（`canvas_layout_test`、`canvas_graph_test`）测试不迁移；`database_test` 的 AI 任务合并与链接防护用例、`sync_workspace_test` 的链接导入用例、`book_detail_page_test` 的画板用例随 R2/R3/R4 裁剪。

---

## 9. 设计文档与实现的偏差（迁移以代码为准）

Card Note 的 docs/ 质量很高，但**代码已演进，下列偏差已逐一核实**。后续迁移设计一律以代码行为为准，不要照抄 design.md：

| # | 主题 | 文档说法 | 代码实际 |
|---|---|---|---|
| D1 | 同步冲突中心 | `sync_conflicts` 表 + ConflictResolutionPage，用户逐条裁决 | **未实现**：Git rebase 冲突/校验失败直接抛错，outbox 保留等待重试 |
| D2 | 同步状态表 | `sync_state` 表 | 未建表，配置存 `app_settings`（`sync.*` key） |
| D3 | 导入前 SQLite 备份 | 每次导入前备份 | 未实现 |
| D4 | AI 重试退避 | 1/5/15/60 分钟 | `2^attempts` 分钟（2→64 封顶），配置错误 360 分钟 |
| D5 | 链接召回信号 | 共同标签 + 共同关键词 + 最近修改 | 仅关键词交集；无共同标签、无"最近修改"信号 |
| D6 | 笔记排序 | 列表按 updatedAt 倒序 | `watchNotes` 按 **createdAt DESC, id ASC** |
| D7 | 保存不产生无意义版本 | contentRevision 仅内容变化时递增 | **每次保存都 +1** |
| D8 | 笔记详情独立页 | 编辑页 + 详情页分开 | 编辑详情合一（NoteEditorPage） |
| D9 | 导入 | MVP 明确"不包含笔记导入" | 已实现 JSON 导入（新书副本） |
| D10 | 附件尺寸 | — | schema 有 width/height 列但从不填充 |
| D11 | 迁移内容 | schema v2 增 3 张同步表 | v2 只加 `sync_outbox`；v3 加 `note_attachments` |
| D12 | 同步仓库清单 | 含 createdAt | 实现写入时不含 createdAt 字段（校验也不查） |

---

## 10. 宿主模块系统对接分析

### 10.1 宿主现状（结论摘要）

宿主 Reisa Studio 的模块系统**协议完整但当前没有任何模块**（`composition/modules.ts` 与 `RUNTIME_MODULE_FACTORIES` 均为空数组；`modules/` 目录不存在但 pnpm workspace / tsconfig / check-boundaries 均已预留通配）。

模块体系关键点：

- **RuntimeModule**（主进程）：`activate(context: ModuleContext) → ModuleActivation{tools, deactivate}`；`ModuleContext = { moduleId, protocolVersion:'1', storage:{dataDir}, config:{get,set}, logger, invoke }`。生命周期状态机 `disabled→activating→active→deactivating`，失败置 `failed` 不阻断他人。
- **ModuleContribution**（renderer）：`{ id, name, description, version, source:'builtin'|'external', capabilities(仅声明), navigation{icon,aliases,keywords,page}, settings?, resultRenderers? }`。
- 组装：UI 侧在 `apps/desktop/src/composition/modules.ts` 加清单项；运行侧在 `composition/runtime.ts` 的 `RUNTIME_MODULE_FACTORIES` 加工厂函数（约定 `@reisa/<pkg>/runtime` 子路径入口，只允许组合根导入）。
- 模块私有数据布局：`app-data/modules/<id>/`（settings.json 由 foundation 自动持久化；dataDir 自理，宿主建议 data.sqlite + files/）。
- 主 Agent 能力调用：模块注册的 capability 自动成为主会话工具（AI SDK v7，宿主管理循环）。
- 数据持久化先例：主进程 `node:sqlite`（`DatabaseSync`）存会话，**零原生依赖**；凭据走 safeStorage(DPAPI) 加密 JSON。
- 工程约束（check-boundaries）：模块 renderer 代码禁 `node:*`/`electron`；模块间禁止互引；renderer 只能 import `@reisa/module-sdk` 与 `@reisa/ui`。

### 10.2 迁移 Card Note 需要的宿主扩展点（宿主侧唯一需要动的代码）

| # | 扩展 | 说明 |
|---|---|---|
| H1 | **模块数据 IPC 通道**（最重要） | 模块页面组件只能拿到 `ModulePageProps{openSettings,notify,availableModuleIds}`，renderer 与模块 runtime 之间没有任何数据通道。需仿照现有白名单模式新增类型化通道（`main/index.ts` registerIpc + `preload/index.ts` + `renderer/bridge.ts` 三处），或设计一个通用的 `reisa/module/<id>/<command>` 分发通道 |
| H2 | 文件选择/保存对话框 IPC | 附件选择、导出保存、同步目录选择都需要 Electron dialog；宿主现无此通道 |
| H3 | ~~凭据句柄~~ **已随 R2/R4 取消** | 模块内不再持有任何凭据；未来的笔记智能走宿主主 Agent 能力路径（Q10），无需恢复此项 |
| H4 | （可选）UI 图标 | 侧栏图标是 lucide 名称字符串，`book`/`file`/`grid`/`list` 等已存在，大概率无需新增 |
| H5 | （可选）能力注册 | 把笔记检索/CRUD 注册为主 Agent 能力（第二阶段再做，不阻塞迁移） |

### 10.3 迁移映射表

| card_note 组件 | 宿主模块内对应位置（建议 `modules/card-note/`） |
|---|---|
| `core/database/app_database.dart`（业务真源） | `src/runtime/database.ts`（node:sqlite，DDL + 事务 + 规则直译） |
| 各 `*_repository.dart` | 并入 `database.ts` 或拆 `src/runtime/repositories.ts` |
| `ai/`（client/service/scheduler/settings/secure_store） | 【R2 移除】 |
| `sync/`（workspace/coordinator/git_client/scheduler/settings） | `src/runtime/sync/`（child_process 调 git） |
| `export/book_export_service.dart` | `src/runtime/export.ts` |
| `app/providers.dart` 的流 | runtime 查询服务 + IPC（初始拉取 + 变更事件推送，或轮询） |
| go_router 5 页面 | 模块页面内部视图状态机（列表 → 详情 → 编辑器；同步设置 → 模块 settings Dialog） |
| `presentation/*`（6 个页面组件） | `src/ui/` React 组件（对齐 `@reisa/ui` tokens，双主题） |
| flutter_markdown(+latex) | react-markdown + remark-gfm（宿主已有）+ remark-math + rehype-katex（新增依赖） |
| flutter_staggered_grid_view | CSS 自实现 |
| InteractiveViewer + CustomPainter | 【R3 移除】 |
| file_selector / path_provider / secure_storage | 宿主 IPC（H2）/ `storage.dataDir`；secure_storage 随 R2 移除 |
| 测试 15 个 | `node --test`（runtime 侧直译）+ 组件测试（按宿主测试习惯 .mjs） |

---

## 11. 迁移策略建议

**核心结论：以"宿主内置模块 + React/TS 重写"的方式迁移，而不是以 git submodule 嵌入 Flutter 源码。**

理由：

1. 宿主是 Electron/Chromium renderer，无法承载 Flutter UI；Flutter 产物只能作为独立 exe 进程存在，嵌入即意味着"另一个窗口"，与宿主的侧栏/主题/模块管理完全割裂。
2. 宿主的模块协议（能力注册、生命周期、作用域存储、导航贡献）与 card_note 的功能边界高度契合：书籍/笔记/同步设置天然是"模块私有数据"，同步调度天然是"模块 runtime 服务"，笔记检索天然可拆为能力（供宿主主 Agent 使用，见 Q10）。
3. card_note 的价值密度集中在**数据模型与业务规则**（第 4、5 节），而非 Flutter UI 本身；规则可以近乎逐行直译为 TS（SQLite 事务、Git 命令、JSON 协议都是技术栈无关的）。

**保真原则**（迁移验收的基准）：

- 数据层：schema v3 的 10 张表、约束、索引、迁移语义一一对应（DDL 草案见附录 A）；UUID 主键与 UTC 毫秒时间戳不变——这让旧数据导入成为可能。
- 行为层：第 5 节规则清单 + 第 8 节测试全部移植并通过（AI/画板部分随 R1–R3 裁剪）。
- 允许偏离：UI 视觉（对齐 `@reisa/ui` 设计语言）、页面组织（合并/拆分）、实现载体（watch 流 → IPC）。偏离需记录，类似本文第 9 节的偏差表。

---

## 12. 分阶段迁移路线

建议按"数据核心 → 普通功能 → 同步"的顺序，每个里程碑可独立验收：

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0 模块骨架 + 数据层** | `modules/card-note/` 包骨架（runtime/ui/contracts）、宿主组合根两处注册、H1 数据 IPC 通道、`database.ts`（精简 schema，见附录 A + 事务规则）、**第 5 节规则对应单测移植（AI/画板/链接部分除外）** | 建库/级联删除等测试通过；模块可启停且数据保留 |
| **M1 书籍/笔记/标签/搜索** | 书籍列表页、笔记编辑器（含校验/版本递增/标签多选）、标签管理、书内搜索（LIKE + 250ms 防抖） | FR-01、FR-02、FR-03、FR-08、FR-11 对应行为可用 |
| **M2 Markdown/公式 + 附件** | react-markdown + katex 渲染、附件（H2 对话框 + SHA-256 存储） | FR-12 剩余部分（详情完整展示原文/备注/页码/标签）；附件校验测试通过 |
| **M3 列表/网格视图** | 列表/卡片网格切换（原三视图裁去画板） | FR-09；窗口缩放无重叠溢出 |
| **M4 导出/导入** | MD/JSON 导出、JSON 导入 | 与 card_note 产物格式一致（可用旧版导出文件做回归） |
| **M5 Git 同步（可选，见 Q6）** | sync_workspace/coordinator/git_client 直译（仓库格式无 `links/`，文档类型收窄）+ 同步设置页 | `sync_workspace_test`/`sync_git_test` 移植通过（裁去链接用例） |
| **M6 旧数据导入工具** | 读旧 `card_note.sqlite`（node:sqlite 可直接打开）→ 写入模块库；**跳过旧库 `ai_jobs`/`ai_tag_suggestions`/`note_links` 表**，其余表 UUID/时间戳兼容、近似纯拷贝 | 旧库书籍/笔记/标签/附件/设置全量迁入，AI 与链接数据按预期丢弃 |

原 M5（AI）阶段随 R2 取消，"画板与 AI 可并行"的说明随之失效。M0 仍是关键路径（宿主 IPC 通道 H1 是全局阻塞项）。

---

## 13. 待决策问题清单

| # | 问题 | 选项与建议 |
|---|---|---|
| Q1 | ~~迁移方式确认~~ | **已决策（2026-10-03，按推荐）**：内置模块 + TS 重写（第 11 节） |
| Q2 | ~~模块 id / 包名~~ | **已决策（2026-10-03，按推荐）**：`card-note`（`modules/card-note/`，`@reisa/module-card-note`，目录名即模块 id） |
| Q3 | ~~API Key 存放~~ | **已随 R2 关闭**：模块内不再持有任何凭据 |
| Q4 | renderer↔runtime 数据通道形态 | a) 通用模块 IPC 分发（`reisa/module/<id>/<command>`，一次扩展所有模块受益）；b) 逐模块专用通道。**倾向 a；完整方案对比见附录 C** |
| Q5 | 实时刷新机制 | Drift watch 流的替代：a) 变更后由 runtime 推事件（复杂度高、体验最好）；b) 操作返回后前端主动刷新（简单，推荐先 b）；c) 定时轮询（兜底） |
| Q6 | Git 同步是否随迁 | 功能完整可用但存在 D1–D3 缺陷；Electron 主进程可无障碍调 git。建议随迁但排最后（M5），并顺手补齐备份（D3） |
| Q7 | ~~画板实现选型~~ | **已随 R3 关闭** |
| Q8 | LaTeX 支持等级 | katex 全量 vs 按需；确认笔记中公式使用频率后再定（M2 再决策） |
| Q9 | 旧数据迁移 | 是否提供 card_note.sqlite 一键导入（建议提供，M6；schema 兼容使成本低）。注意跳过旧库 AI 表与 `note_links`（见 R2/R4）；旧库中 `ai_accepted` 来源的标签已是正式标签，随标签一起迁移 |
| Q10 | 模块能力注册范围 | AI 移除后，若将来需要笔记智能（自动标签/关联/问答），推荐走宿主主 Agent 能力注册路径（只读检索类能力先行），不在模块内重建私有 AI 栈；首版仍建议不注册 |
| Q11 | 搜索方案 | node:sqlite 的 LIKE 起步（与现状等价）；FTS5 需验证 Node 内置 SQLite 是否编译了 FTS5 模块，不作为首版依赖 |
| Q12 | 迁移期间 card_note 仓库的角色 | 冻结只读作为参考，还是继续演进？（建议冻结，避免规则真源漂移） |

---

## 附录 A：迁移目标库 DDL 草案（node:sqlite，源 schema v3 精简版）

> 迁移目标库不含 `ai_tag_suggestions`、`ai_jobs`（R1/R2）与 `note_links`（R4），可直接以 schema v1 起步（`schemaVersion = 1`），无需复刻源项目的 v1→v3 迁移路径；其余表结构与约束与源项目逐字段等价，以支撑 M6 旧库直接导入。M6 导入时旧库的 `ai_jobs`/`ai_tag_suggestions`/`note_links` 被跳过，`note_tags.source` 中的 `ai_accepted` 值原样保留（仅作来源标记）。

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY, title TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  quote TEXT NOT NULL, comment TEXT,
  page_start INTEGER, page_end INTEGER,
  content_revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS note_attachments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  stored_file_name TEXT NOT NULL, original_file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL,
  width INTEGER, height INTEGER, sort_order INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, tag_id));

-- note_links（R4）与 ai_tag_suggestions / ai_jobs（R1/R2）：不建表。

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS sync_outbox (
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  operation TEXT NOT NULL, changed_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id));
```

（列名按 SQLite 惯例转 snake_case；drift 默认同样做此转换，字段语义不变。）

## 附录 B：关键算法速查

```text
标签归一化   normalizedName = name.trim().toLowerCase()
页码解析     /^(\d+)(?:\s*-\s*(\d+))?$/ → start>0 且 end>=start；单页 start==end
版本递增     contentRevision 每次保存 +1（保留：同步文档与 JSON 导出格式的组成部分）
```

（AI 退避、关键词提词、任务防抖/合并随 R2 移除；画板布局随 R3 移除；链接端点规范化随 R4 移除。）

## 附录 C：Q4 数据通道方案对比（renderer ↔ 模块 runtime）

### C.1 问题的由来

宿主把一个模块拆成两半，运行在两个进程里：

- **runtime 半**（主进程）：持有模块私有数据（`dataDir` 下的 SQLite/settings.json/files），向主 Agent 注册能力（工具）；
- **UI 半**（renderer）：React 页面组件，运行在沙箱里（`contextIsolation` + `sandbox`，禁止 node/electron；check-boundaries 亦禁止模块 UI import 平台模块）。

这两半之间**今天没有任何通道**：

1. 页面组件能拿到的全部输入是 `ModulePageProps { openSettings, notify, availableModuleIds }`，没有数据接口；
2. `ModuleHost.invoke` 只存在于主进程，仅供 Agent 循环调用能力；
3. 宿主现有 IPC（`reisa/conversations/*`、`reisa/settings/*` 等）是宿主自身业务的固定白名单，与模块无关。

因此模块页面无法读写自己模块的数据——这就是宿主扩展点 H1，是迁移 Card Note 的全局阻塞项（Card Note 的 UI 是纯数据驱动的）。补这条通道有两种形态，即 Q4 的 a/b 两个选项。

### C.2 方案 a：通用模块 IPC 分发（推荐）

一次扩展、四处改动，之后所有模块复用：

1. **module-sdk**：增加与"能力/工具"对称的第二个注册面——UI 命令：

   ```ts
   interface UiCommandDefinition {
     command: string;               // 模块内唯一，如 'books/list'
     description: string;
     inputSchema: JsonSchema;       // 建议强制
     outputSchema: JsonSchema;      // 建议强制
   }
   interface ModuleActivation {
     tools: readonly ToolRegistration[];
     uiCommands?: readonly UiCommandRegistration[];   // 新增
     deactivate(): Promise<void>;
   }
   ```

2. **module-host**：新增 `invokeUiCommand(moduleId, command, input)`，完全复用 `invoke()` 的既有机制（模块须 active → TypeBox 输入校验 → 执行 → 输出校验 → 错误归一），注册表按模块分组的结构也现成。
3. **主进程**：`registerIpc` 新增**一个**通道 `reisa/module/call`（payload: `{ moduleId, command, input }`）；将来若做变更推送（Q5 方案 a），同族再加 `reisa/module/onEvent`。
4. **preload / bridge**：新增模块无关的 `module.call(moduleId, command, input)` 与 `module.onEvent(moduleId, listener)`——preload 的 `window.reisa` 永远不出现具体模块的名字。

类型安全靠**契约文件**：`modules/card-note/contracts/` 导出命令名常量、载荷 TS 类型与 JSON Schema，runtime 与 UI 两侧共用；UI 侧再包一层类型化 client（如 `cardNoteClient.listBooks()`），页面代码不直接拼命令名。

- ✅ 宿主只付一次成本；architecture.md §11/§13 明确承诺"新增模块只加包和组合根注册，不改宿主业务分支"，a 是唯一能兑现该承诺的形态
- ✅ 与能力/工具同一套心智模型与校验路径，安全检查集中在 module-host 一处
- ✅ 后续模块（module-ui-design 规划的知识库/绘图/翻译）直接受益
- ❌ 一次性基建量大（sdk + host + IPC + preload + bridge 五处联动）
- ❌ 跨进程类型安全靠约定（contracts + 强制 Schema），需要工程纪律维持

### C.3 方案 b：逐模块专用通道

完全照搬现有 `reisa/conversations/*` 模式：每个命令一条 `ipcMain.handle('reisa/card-note/...')` + 一条 preload 条目 + bridge 里的对应类型。

- ✅ 零新抽象；每一跳都是编译期类型；只做 card-note 时改动面最小
- ❌ 每加一个模块都要改宿主三个文件（main/index.ts、preload、bridge.ts），与架构承诺直接冲突
- ❌ `window.reisa` 出现模块专有 API，宿主代码开始"认识"具体模块，形成耦合
- ❌ bridge.ts（renderer）需要 import 模块契约或复制类型——前者触碰 check-boundaries 第 3 条（renderer 只走组合根），后者必然漂移
- ❌ 模块数量预期 >1，成本随模块数线性放大

### C.4 结论与关联

**推荐 a。** 决定性理由：宿主自身的架构承诺 + 模块数量预期 + 校验集中。配套纪律：UI 命令的输入/输出 Schema 设为强制，运行时校验兜住跨进程漂移；命令粒度保持粗（查询类合并成少数命令），避免通道数量膨胀。

与 Q5 的关系：a 的 call 通道天然支持 Q5 方案 b（操作返回后主动刷新）先落地；将来升级 Q5 方案 a（变更推送）时在同一通道族上加事件通道即可，无需返工。

实现备注（M2 会遇到）：附件预览图不能在 renderer 直接用 `file://` 引用（开发模式页面是 http 源；sandbox 也限制任意文件读取），需要在主进程注册自定义协议（如 `reisa-file://`）或经 IPC 返回 data URL。这是 H1/H2 的具体化细节，不影响 a/b 的选择。
