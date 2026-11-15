# 知识库 Embedding 接口调用记录设计（仅文档索引）

> 状态：**已实施**（2026-11-08；`pnpm test` 311/311、`pnpm build` 通过）。
> 修订记录：2026-11-08 初版（按需求裁剪范围——只记录文档索引调用，检索与连接测试不记录）。
> 修订：2026-11-08 实施前评审修正——统一 Recorder 构造签名并复用 `TextChunk` 类型；activate 清理与开关无关且 best-effort；补全 UI 联动点。
> 修订：2026-11-08 **记录粒度变更（需求澄清）**：由"一次 `embed()` 方法调用一条记录"改为"**每一次真实发生的接口请求一条记录**"（含子批拆分与每一次重试）。记录点从 `sync.ts` 下沉到 `OpenAICompatibleEmbeddingClient` 内部的 `onRequest` 遥测钩子，chunk 身份经 `embed(texts, { context })` 透传。
> 修订：2026-11-08 实施完成。顺带修复既有边界 bug：首次配置 embedding（尚无文档）时指纹变更未清理按默认维度建出的空索引目录，导致重配置因维度不符失败（`runtime/index.ts` 指纹变更块改为无条件重建索引目录）。
> 关联文档：`knowledge-base-migration.md`（迁移设计，下称"迁移设计"）、`architecture.md`。

## 1. 背景与目标

知识库模块在文档索引时发起 embedding API 调用，但目前没有任何结构化的调用记录：成功调用完全不可见（哪个文件的哪些 chunk 被送进过接口、每次请求消耗多少 token、耗时多久）；失败信息散落在模块日志与 `document.error` 文案中，看不到子批拆分与重试过程。

**目标**

1. **每一次真实发生的 embedding 接口请求**产生一条结构化记录：时间、状态（成功/失败）、模型、该请求携带的文本数、token 用量、耗时、尝试序号、错误分类与脱敏错误文案。
2. 每条记录附 **chunk 级明细**：该请求实际发送的每个 chunk 的 `chunkId`、序号、行区间、token 数、内容哈希与内容预览（取自实际发送文本）。
3. `roundId`/`batchIndex`/`attempt` 三元组可完整重建一次索引的请求序列：哪些请求属于同一轮、各自是第几个子批、第几次尝试。
4. 提供页面查看（筛选、分页、明细展开）与清理入口，带保留期自动清理。

**非目标**

- 不记录检索（query 向量化）与连接测试的请求（遥测事件照发，由记录器按上下文过滤；恢复路径见 §11）。
- 不做成本/配额统计与告警。
- 不记录响应向量本身。
- 不作为 Agent 能力暴露（迁移设计 §5.3 安全分层）。
- 不补录历史数据。

## 2. 现状：调用链路盘点

| # | 调用点 | 位置 | 输入 | 是否纳入记录 |
| --- | --- | --- | --- | --- |
| 1 | 文档索引 | `SyncService.#indexFile` → `embedder.embed(chunks.map((c) => c.content), { context })`（`sync.ts`） | 一个文件全部 chunk 的原文 + 文档/chunk 身份 | **是** |
| 2 | 检索向量化 | `KnowledgeBase.search` → `embedder.embed([query], { signal })`（`service.ts`） | 单条检索词 | 否（无 context，记录器跳过） |
| 3 | 连接测试 | `KnowledgeRuntime.#testEmbeddingConnection` → 一次性 `client.embed(['连接测试'], { signal })`（`index.ts`） | 固定测试文本 | 否（一次性客户端不挂记录器） |

关键事实：

1. **真实请求只发生在 client 内部**：`OpenAICompatibleEmbeddingClient.embed()` 按 `batchSize`（≤20）把文本切成子批、以 `maxConcurrency` 并发、按错误分类重试，任一子批失败则整轮抛出。要记录"每一次接口调用"，遥测点必须在 `#createWithRetry` 的每次尝试处，而不是 `embed()` 出入口。
2. **chunk 身份只在调用点可知**：client 层只见 `string[]`。因此 `embed()` 契约扩展为 `embed(texts, { signal, context })`，调用点随调用传入文档身份与 chunk 明细（`items`，与 texts 等长对齐），client 按子批切片后随每次请求进入遥测。
3. **对调用方的整体成败语义不变**：一次 `embed()` 仍要么全成要么全抛（成功才 `replaceDocument` 落库）；接口级记录只是把内部过程拆开可见。

## 3. 可行性分析（要点）

**结论：可行，记录点唯一（client 内部），改动集中在 `modules/knowledge/`。**

- **遥测钩子无侵入**：`EmbeddingClientOptions.onRequest` 是可选回调，`#createWithRetry` 在每次尝试成功/失败后各 emit 一次；重试、退避、批量、并发、响应校验逻辑零改动，`EmbeddingsClientLike` 测试注入模式不受影响。
- **上下文透传成本小**：`EmbedOptions.context` 是纯数据（文档身份 + items），client 仅做等长校验与按批切片；`TextChunk` 结构上满足 `EmbedTextItem`，调用点直接传 `chunks`，无需复制。
- **过滤收敛在记录器**：client 对所有请求（含检索、连接测试）照发事件，`EmbeddingCallRecorder.recordRequest` 按"context 携带 documentId 且 items 非空"过滤——client 保持通用，记录范围由消费方决定。
- **不触发索引重建**：`embeddingCallLog` 设置不进入 `embeddingIdentity` 指纹（只含 baseUrl/model/dimensions）。
- **性能**：索引请求频率低；每条记录一次 SQLite INSERT；记录器整体吞错，遥测失败绝不影响请求流程（契约写入 `onRequest` 注释）。

**风险与对策**

| 风险 | 对策 |
| --- | --- |
| 遥测/落库失败影响请求流程 | `recordRequest` 内部整体 try/catch + `logger.warn('embedding_call_log_failed')`，绝不抛出；`onRequest` 契约注明实现方必须自行吞错 |
| 事件误用（items 与 texts 错位） | `embed()` 入口校验 `items.length === texts.length`，不符直接抛错（数据完整性防线，宁可失败也不记错账） |
| 检索高频事件开销 | 事件构造仅是几个对象字面量；记录器按上下文跳过，无落库开销 |
| `content_preview` 泄露面 | 取自实际发送文本（截 120 字符、按码点），存本地 userData，与 chunk 原文落盘 LanceDB 同级敏感度 |
| 记录与文档状态不一致 | 记录是"曾发起该请求"的事实留存；文档终态由 `documents` 表独立表达（`recordFailure` 路径不变） |

## 4. 总体设计

```text
SyncService.#indexFile
   │  embedder.embed(chunkContents, { context: { documentId, relPath, documentName, items: chunks } })
   ▼
OpenAICompatibleEmbeddingClient.embed()
   │  校验 items 与 texts 等长 → 按 batchSize 切子批（items 同步切片）→ 生成 roundId
   │  每个子批 #createWithRetry：每次 HTTP 尝试结束（成功/失败/放弃）emit 一次
   ▼
EmbeddingCallRecorder.recordRequest(event)          ← onRequest 钩子，旁路，绝不抛出
   │  过滤：context.documentId 存在且 items 非空（否则跳过——检索/连接测试）
   ▼
MetadataDB（data.sqlite：embedding_calls / embedding_call_items，单事务）
   └─ 保留期清理（activate 时与开关无关 + 每 100 条顺带）

页面 UI（KnowledgePage「调用记录」页签）
   ◀── pageService（list_embedding_calls / get_embedding_call / clear_embedding_calls）
```

## 5. 数据模型（SQLite）

```sql
CREATE TABLE IF NOT EXISTS embedding_calls (
    id TEXT PRIMARY KEY,            -- crypto.randomUUID().hex
    triggered_at TEXT NOT NULL,     -- 该次尝试结束时刻（ISO UTC）
    status TEXT NOT NULL,           -- 'success' | 'failed'
    model TEXT NOT NULL DEFAULT '',
    round_id TEXT NOT NULL DEFAULT '',   -- 同一轮 embed() 的所有请求共享
    batch_index INTEGER NOT NULL DEFAULT 0,  -- 子批序号（0 起）
    attempt INTEGER NOT NULL DEFAULT 0,      -- 该子批内的尝试序号（0 起；重试递增）
    text_count INTEGER NOT NULL DEFAULT 0,   -- 本请求发送的文本数
    token_count INTEGER,            -- 本请求 usage.prompt_tokens；provider 未返回时为 NULL
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,                -- EmbeddingErrorCode；成功为 NULL
    error_message TEXT,             -- 分类后的错误文案（刻意不含响应体与输入文本）
    document_id TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    document_name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embedding_calls_time ON embedding_calls (triggered_at);

CREATE TABLE IF NOT EXISTS embedding_call_items (
    call_id TEXT NOT NULL,
    text_index INTEGER NOT NULL,    -- 本请求内文本序号（0 起）
    chunk_id TEXT,
    ordinal INTEGER,                -- 文档内 chunk 序号
    content_hash TEXT,
    content_preview TEXT,           -- 实际发送文本前 120 字符（按码点截断）
    token_count INTEGER,            -- chunk 本地 token 估算（RecursiveChunker 口径）
    section_path TEXT,
    line_start INTEGER,
    line_end INTEGER
);
CREATE INDEX IF NOT EXISTS idx_embedding_call_items_call ON embedding_call_items (call_id);
```

语义约定：

- **一行 = 一次 HTTP 请求尝试**。一次索引 = 1 行（chunks ≤ batchSize 且无重试）到 N×M 行（N 个子批 × 平均 M 次尝试）。同一 chunk 可以出现在多行（重试时每次尝试都真实发了请求）。
- **失败尝试照记**：`status='failed'` 行携带分类错误（如 `rate_limited`）与耗时；它对应的重试成功是另一行。
- **中止的尝试不计**：请求被 AbortSignal 取消时是否已达服务端未知，不发事件（当前记录路径不传 signal，此为前瞻约定）。
- 失败调用的 items 照写（部分子批可能已真实发出）。
- 与现有表一致不使用外键；清理先删 items 再删 call 行（单事务）。
- `content_preview` 按**码点**截断（`Array.from` + slice），不切断代理对。

`MetadataDB` 方法：`insertEmbeddingCall(call, items)`（单事务）、`listEmbeddingCalls({ status?, limit, offset })`（triggered_at 倒序）、`getEmbeddingCall(id)`（含 items，按 text_index 排序）、`countEmbeddingCalls()`、`deleteEmbeddingCallsBefore(cutoffIso)`、`clearEmbeddingCalls()`。

## 6. 记录点接入

### 6.1 client 层（`embedding.ts`）

- `Embedder` 契约：`embed(texts, options?: EmbedOptions)`，`EmbedOptions = { signal?, context? }`。
- `EmbeddingClientOptions.onRequest?: (event: EmbeddingRequestEvent) => void`。
- `embed()`：校验 items 等长 → 切子批并同步切片 items → `roundId = crypto.randomUUID()` → 各子批并发 `#embedBatch`。
- `#createWithRetry`：每次尝试结束 emit `{ attempt, status, latencyMs, tokenCount, errorCode, errorMessage }`；错误文案取分类后的 `EmbeddingError.message`（skb 语义：不带响应体与输入文本）；`#embedBatch` 补齐 `roundId/batchIndex/model/texts/items/context` 成完整事件。

### 6.2 记录器（`runtime/embedding-call-log.ts`）

`EmbeddingCallRecorder`（构造 `{ database, retentionDays, logger? }`）：

- `recordRequest(event)`：过滤非索引请求 → 单事务落库 call + items → 每 100 条顺带清理。
- `embeddingCallCutoffIso(retentionDays)`：activate 清理与周期清理共用；`<= 0` 返回 null（永久保留）。
- `contentPreview(text)`：按码点截 120 字符。

### 6.3 调用点与组装

- **`sync.ts #indexFile`**：`embed(chunks.map((c) => c.content), { context: { documentId, relPath: snapshot.relPath, documentName: base.name, items: chunks } })`；既有失败路径（`recordFailure`、`#logDocumentFailure`）保持不变。
- **`service.ts search`**：`embed([query], { signal })`（无 context → 不记录）。
- **`index.ts #buildServices`**：`callRecorder = enabled && status.enabled ? new EmbeddingCallRecorder(...) : undefined`；作为 `onRequest` 传入 `OpenAICompatibleEmbeddingClient`。activate 保留期清理在 database 建好后一律执行（与开关无关），best-effort try/catch + `logger.warn('embedding_call_log_prune_failed')`，绝不进入 `#buildServices` 失败路径。
- **`index.ts #testEmbeddingConnection`**：一次性客户端不挂记录器，天然不记录。

## 7. 配置与保留策略

```ts
export interface EmbeddingCallLogSettings {
  readonly enabled: boolean;        // 默认 true
  readonly retentionDays: number;   // 默认 30；0 = 永久保留
}
```

- normalize：`enabled` 缺省 true（`!== false`）；`retentionDays` clamp 到 [0, 3650]。不进入 embedding 指纹。
- 清理时机：activate 时（与开关无关——否则"关闭"隐含"历史冻结"，与保留期语义矛盾）+ 记录器每 100 条顺带；`retentionDays = 0` 仅保留手动清空。
- 容量：行大小与 chunk 数成正比（items 约 0.3 KB/chunk）；重度使用（每天重建 50 篇 × 50 chunk × 1.2 次尝试均值）≈ 1 MB/天，30 天 ≈ 30 MB；一般使用远小于此。暂不设行数硬上限。

## 8. 页面服务与 UI

### 8.1 页面服务动作（模块锁内）

| 动作 | 输入 | 输出 |
| --- | --- | --- |
| `list_embedding_calls` | `{ status?, limit?, offset? }`（limit ≤ 200，默认 50） | `{ total, items: EmbeddingCallJson[] }` |
| `get_embedding_call` | `{ callId }` | `{ call, items }` |
| `clear_embedding_calls` | `{}` | `{ cleared: true }` |

`EmbeddingCallJson` 含 `roundId/batchIndex/attempt`；`relPath` 与 `toDocumentJson` 同级（页面 DTO 本就含路径，仅 Agent 契约不含）。

### 8.2 UI（`KnowledgePage.tsx` / `KnowledgeSettings.tsx`）

- 第三个页签「调用记录」；联动点：`view` 状态三值、标题三分支、"上传文档"按钮按视图显隐。
- 列表行：时间、文件名（悬停 relPath）、`{textCount} 片段 · tokens · 耗时`、`attempt > 0` 时显示"第 N 次尝试"、状态 Badge。
- 行展开：失败文案（errorCode + errorMessage）；chunk 明细表（序号/行区间/章节/tokens/内容预览）。
- 空状态 `EmptyState`；不页签标题区放描述文案（AGENTS.md 约定）。
- 设置组：开关、保留天数、"清空记录"（Dialog 确认）。

## 9. 安全与隐私

- 记录仅落本地 `data.sqlite`，只经页面服务受限 IPC 访问；不注册 Agent 能力。
- 错误文案取 client 分类后的 `EmbeddingError.message`（构造上不含响应体与输入文本）；`content_preview` 是唯一原文类字段（120 字符、实际发送文本、本地存储）。
- 清理/清空是唯一删除入口；删除来源不级联清理历史记录（记录是过去事实的留存）。

## 10. 测试计划（已实施）

| 层 | 用例 |
| --- | --- |
| `db-store.test.mjs` | 两表建表、insert/list 倒序与筛选分页、get 含明细排序、保留期清理、clear |
| `embedding.test.mjs` | `onRequest`：批次拆分逐请求事件 + items 切片对齐 + roundId 归组；items 等长校验抛错；每次重试独立事件（failed→success，错误取分类文案）；无 context 事件照发；重试耗尽逐次失败事件且最终抛出；既有取消信号用例迁移到 `embed(texts, { signal })` |
| `embedding-call-log.test.mjs` | 落库对齐（round/batch/attempt + items）；失败请求落库；无上下文/空明细跳过；旁路吞错（库已关闭不抛）；每 100 条清理与 retentionDays=0；码点截断；cutoff 语义 |
| `sync.test.mjs` | sync 透传 context（documentId/relPath/items 与 texts 对齐）；embed 失败路径不变（documents error + retryCount 推进） |
| `runtime.test.mjs` | e2e（假 embeddings 服务 + batchSize=1）：记录数 = chunkCount、roundId 唯一、batchIndex 覆盖 0..n-1、attempt 全 0、usage 校验；开关关闭停记录且旧记录保留；`embeddingCallLog` 变更不触发重建；清空 |

## 11. 实施结果与可选扩展

**实施状态**：全部完成（后端 + UI + 测试；`pnpm test` 311/311、`pnpm build` 通过）。

**可选扩展**（本期不做）

- **恢复检索/连接测试记录**：调用点补 `context` 即可，`embedding_calls` 可 `ALTER TABLE ADD COLUMN` 补 `kind`/`query_text` 列。
- **轮次聚合视图**：UI 按 `roundId` 折叠同轮请求（数据已支持）。
- 调用统计聚合（按天/类型汇总 token），作为成本统计前置。
