# 知识库模块迁移设计

> 状态：**已实施**（2026-10-03，全部阶段完成；`pnpm test` 107/107、`pnpm build` 通过、Electron 冒烟与打包后应用冒烟通过）。
> 源项目：`simple-knowledge-base`（下称 skb，v0.2.0，位于 `D:\pyCode\simple-knowledge-base`）；目标：以功能模块身份接入本应用（`modules/knowledge/`）。
>
> §1–§5 记录 skb 现状规格（迁移时的行为基准），§6–§10 是迁移设计与实施指引。§6 的四个决策点已确认：TypeScript 重写（HTTP/MCP/admin 由模块界面与模块对主应用的接口取代，embedding 配置留在子模块并经主设置页"模块设置"区维护）；保持 skb 的多来源模型（module-ui-design.md §3 已随之修正）；HTTP/MCP/admin 不迁移。字段名、函数名、常量均摘自 skb 源码，实施时按此对照。

## 1. 目标项目概览

skb 是一个单进程私有文档知识库服务：后台索引本地 TXT/Markdown 文件，通过稠密向量与 BM25 混合检索返回命中的原文片段，刻意不向 Agent 暴露服务端文件路径。设计取向是"小而精"：单写者、无任务队列、无版本化重建、启动即完成（无迁移步骤）。

- **规模**：扁平布局 Python 源码约 3,100 行（含管理后台），测试约 1,900 行，全程离线（FakeEmbedder）。
- **技术栈**：Python 3.12（硬钉 `>=3.12,<3.13`）+ FastAPI + SQLite（元数据）+ LanceDB（向量/全文索引）+ watchdog（文件监听）+ MCP SDK。
- **两个入口**：`skb-server`（唯一进程、唯一写者：HTTP API + MCP streamable HTTP + 管理页面 + 后台同步循环）；`skb-mcp`（stdio 瘦客户端，纯 HTTP 调用 server，不碰数据）。

```text
skb-server（唯一进程，唯一写者）
  ├── FastAPI HTTP API      /api/search、/api/sources、/api/documents、/api/upload
  ├── MCP streamable HTTP   /mcp，与 HTTP API 同端口同 token（进程内 ASGI 回环，不占真实网络）
  ├── 管理页面 /admin/       概览、文档与正文、检索调试、来源与排除规则维护
  ├── 后台同步循环           watchdog 事件唤醒 + 防抖 + 周期全量对账（无任务表）
  ├── SQLite（data/kb.db）   sources / documents / meta 三张表，启动时自动建表
  └── LanceDB（data/index/） chunks 表：分块原文 + 向量 + BM25 全文，RRF 混合检索
```

### 1.1 死代码结论（迁移时直接忽略）

`src/simple_knowledge_base/` 下 8 个旧分层目录 —— `api/`、`application/`、`cli/`、`domain/`、`infrastructure/`、`jobs/`、`mcp/`、`web/` —— **全部只含 `__pycache__`，没有任何 .py 源文件，未被任何现有代码 import**。这是旧版 DDD 分层（含 aliyun embedding、alembic 迁移）重构为扁平布局后的残留。同理：`migrations/`（仅空 `versions/`）、`deploy/`（docker/nginx/systemd 三个空目录）、`data/lancedb/`（旧数据目录）均为空壳。有效代码只有扁平文件 + `admin/` 子包。

## 2. 代码结构与依赖

| 文件（`src/simple_knowledge_base/`） | 行数 | 职责 | 迁移处置 |
| --- | --- | --- | --- |
| `main.py` | 121 | 组装根与启动：建库、embedding 指纹校验、构建 SyncService/KnowledgeBase、lifespan、uvicorn | 拆入模块 runtime 的 activate 流程 |
| `api.py` | 337 | HTTP API 装配（闭包路由）+ 全部 Pydantic 请求/响应模型 | 不迁移；模型转为 TypeBox Schema |
| `service.py` | 279 | 唯一应用层 `KnowledgeBase`：search/add_source/update_source_rules/remove_source/list_documents/submit_for_index/document_content/upload | 移植为模块核心服务 |
| `sync.py` | 410 | 后台对账/索引循环 `SyncService` + 文件监听编排（防抖、增量判断、manual_required、单飞行锁） | 移植（最核心） |
| `store.py` | 227 | LanceDB 封装 `ChunkStore`：replace_document/delete_document/delete_source/search/ensure_indexes | 移植（Node SDK 需 spike，见 §10） |
| `db.py` | 317 | SQLite 元数据 `MetadataDB`：三张表、WAL、老库 ALTER 迁移、`document_identity` | 移植为 node:sqlite |
| `embedding.py` | 235 | OpenAI 兼容 embedding 客户端：批量/并发/错误分类/重试退避 | 移植（openai npm 或 AI SDK） |
| `parsing.py` | 120 | 文本/Markdown 解析：UTF-8(-sig)、归一化、标题栈、`ParsedSection` | 移植（纯函数，最先做） |
| `chunking.py` | 74 | `RecursiveChunker(max_tokens=600, overlap_tokens=80)`，自定义 token 定义，确定性 chunk_id | 移植（纯函数） |
| `scanner.py` | 56 | 目录扫描 `scan_directory` → `FileSnapshot(rel_path, size, mtime_ns)`，排除规则剪枝 | 移植 |
| `watcher.py` | 105 | watchdog 封装 `ChangeWatcher`：watch_existing/unwatch/stop，事件回调跨线程 | 移植为 chokidar |
| `ignore.py` | 37 | gitignore 排除规则 `IgnoreRules`（pathspec `GitIgnoreSpec`）+ 默认排除集 | 移植为 `ignore` npm 包 |
| `config.py` | 115 | `Settings`（pydantic-settings，只读 config.toml，不读环境变量） | 不迁移；转为模块 settings.json |
| `security.py` | 41 | Bearer token 依赖、`is_loopback_host` | 不迁移（无 HTTP 面） |
| `logging.py` | 33 | JSON 行日志 + 8MB 轮转 | 不迁移；用 ModuleLogger |
| `mcp_server.py` | 283 | MCP 工具定义 + ASGI 挂载 + Bearer 中间件 + stdio 入口 | 不迁移（能力直接注册为宿主工具）；其输出模型字段是能力契约的基准 |
| `admin/routes.py` + templates/static | ~800 | 管理后台（页面路由、cookie 登录、无障碍高对比主题、深浅色切换） | 不迁移；由模块工作区 UI 取代 |

**import 依赖方向**（无循环）：`main → api → admin.routes → service → sync → {db, chunking, embedding, ignore, parsing, scanner, store, watcher}`；`api → mcp_server/security/db`；叶子模块：`db、store、parsing、embedding、ignore、config、security、logging`。迁移后的 TS 版应保持同样的单向分层：runtime 内 `storage/`（db+store）、`sync/`、`indexing/`（parsing+chunking+embedding）、`service/`，`index.ts` 作受控公开入口。

## 3. 数据模型

### 3.1 SQLite（db.py，`data/kb.db`，实际三张表）

```sql
CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,            -- uuid4().hex
    type TEXT NOT NULL,             -- "local_file" | "local_dir"（历史遗留 "upload"）
    path TEXT NOT NULL,             -- resolve(strict=True) 后的 OS 原生绝对路径字符串
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,       -- ISO 秒级 UTC
    ignore_rules TEXT NOT NULL DEFAULT ''   -- 规则原样保存（保留注释与顺序），≤64000 字符
);
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,            -- uuid5(NAMESPACE_URL, "{source_id}:{rel_path}").hex
    source_id TEXT NOT NULL,
    rel_path TEXT NOT NULL,         -- posix 分隔；单文件来源 = 文件名
    name TEXT NOT NULL,
    content_hash TEXT,              -- 归一化后全文 sha256（解析成功才写入）
    status TEXT NOT NULL,           -- "indexed" | "error" | "manual_required"
    error TEXT,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    mtime_ns INTEGER NOT NULL DEFAULT 0,
    indexed_at TEXT,
    UNIQUE(source_id, rel_path)
);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,           -- 现有唯一键："embedding_identity"
    value TEXT NOT NULL
);
```

连接方式：单连接 + `threading.RLock` + `PRAGMA journal_mode=WAL`；启动时建表，老库缺 `ignore_rules` 列时 `ALTER TABLE` 补列。TS 侧用 `node:sqlite` `DatabaseSync`（同步 API 天然串行，可省去显式锁，参照 `apps/desktop/src/main/conversations/store.ts` 的模式）。

### 3.2 LanceDB（store.py，表名 `chunks`，位于 `data/index/`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `chunk_id` | string 非 null | sha256(`{document_key}:{doc.content_hash}:{ordinal}:{chunk内容hash}`)，确定性、重建幂等 |
| `document_id` / `source_id` | string 非 null | |
| `ordinal` | int32 非 null | 块序号 |
| `content` | string 非 null | 块原文 |
| `content_hash` | string 非 null | 块级 sha256 |
| `token_count` | int32 非 null | |
| `document_name` | string 非 null | |
| `section_path` | string 可空 | `"标题A > 标题B"` |
| `line_start` / `line_end` | int32 可空 | |
| `mime_type` | string 非 null | `text/markdown` / `text/plain` |
| `modified_at` | timestamp(us, UTC) 非 null | 写入前强制 UTC |
| `vector` | fixed-size-list(float32) 非 null | 维度 = 配置 `embedding_dimensions`（默认 1024） |

索引：`content_fts`（FTS，`base_tokenizer="icu"`，`with_position=True`，`stem=False`，不停用词）与 `vector_ann`（`IvfFlat, distance_type="cosine"`，仅 `count_rows() > 0` 时创建），创建等待 60s。写入：`replace_document` 在锁内按 `document_id` 先删后加；`_escape` 仅转义单引号。维度与已有表不符 → 直接 ValueError 拒绝（由指纹重建兜底）。

## 4. 核心流程规格（迁移必须原样保留的行为）

### 4.1 同步对账（sync.py）

- **循环**：`_run_forever` 用 `asyncio.wait_for(wake.wait(), interval_seconds)` —— watcher 事件唤醒，超时即周期全量对账兜底；唤醒后先 `sleep(debounce_seconds)`（默认 2s）合并连续写入；`async with self._lock` 保证单飞行（手动索引也持同一把锁，不与对账交错）。
- **来源级对账 `reconcile_source`**：目标不存在 → unwatch + 删除该来源全部文档与向量；目录来源 `scan_directory`，单文件来源以父目录为扫描根、文件名为 rel_path。
- **增量判断**：已知文档且 `size` 与 `mtime_ns` 都相等且 `status=="indexed"` → 跳过；`manual_required` 且仍超 `auto_index_max_bytes` → 继续等待不重写状态；否则进入 `_index_file`。
- **`_index_file`**：无 embedder → `status="error"`（"Embedding service is not configured"）；非 force 且 `size > auto_index_max_bytes`（默认 5 MiB，0 表示不限制）→ **先清旧向量**再落 `manual_required`；解析失败（OSError/UnicodeDecodeError/ValueError）→ `error`，消息 NFKC 归一化 + 截断 300 字符；解析成功后 `content_hash` 与已 indexed 的相同 → 只更新 size/mtime_ns/name，**保留旧向量**（touch 不重嵌入）；否则 chunk → embed → `replace_document` → `indexed`。
- **收尾**：本轮未见的 rel_path → 删除（原因区分"被排除规则命中"与"文件已删除"）；每来源处理后 `watch_existing` 纳入监听；有数据则 `ensure_indexes()`。单个来源异常 `logger.exception` 后继续，不中断其他来源。
- **手动单篇 `index_document`**：`force=True` 绕过大小限制但**不绕过排除规则**（命中 → `DocumentExcludedError`）。
- **uploads 来源**：`ensure_uploads_source` 按路径幂等注册 `data/uploads` 为 `local_dir` 来源（name="uploads"），删除后下次上传或重启自动恢复；上传 = 写文件 + wake，同名覆盖自动重索引；手动放入的文件同样被索引。

### 4.2 解析与分块（parsing.py / chunking.py）

- 仅支持 UTF-8 的 `.md` / `.txt`（`SUPPORTED_SUFFIXES`）；读取 `decode("utf-8-sig")` 容忍 BOM；归一化：CRLF/CR → LF、NFC、删除控制字符（保留 `\n` `\t`）。
- Markdown：ATX 标题 `^(#{1,6})\s+(.+?)\s*$`，标题栈 `headings[level-1:] = [heading]`（低级标题截断高级），`section_path = " > ".join(headings)`；纯文本整篇一个 section，`section_path=None`。每节记录正文首行行号与起始字符偏移。
- `content_hash` = sha256(归一化全文)；`mime_type` 按后缀。
- **token 定义**（中文检索效果的关键，不可改动语义）：`[\u3400-\u4dbf\u4e00-\u9fff]` 单个 CJK 字符 = 1 token；`[A-Za-z0-9_]+` 连续串 = 1 token；其余单个非空白字符 = 1 token。
- `RecursiveChunker(max_tokens=600, overlap_tokens=80)`：滑动窗口 `step = 520`，每窗取 600 token 的字符区间；`line_start/line_end` 由 section 起始行 + 区间内换行数推得；校验 `0 <= overlap_tokens < max_tokens`。

### 4.3 向量化（embedding.py）

- 请求：`model, input, dimensions, encoding_format="float"`；按 `batch_size`（默认 20，上限 20）切片，`Semaphore(max_concurrency)`（默认 2）并发；**任一子批失败则整轮 raise**（保证失败批次不会提前释放对账锁）。
- 错误分类 `_classify_error`：401/403 → `authentication_failed`（不可重试）；429 → `rate_limited`；408/Timeout → `timeout`；409 或 ≥500 → `provider_unavailable`；其余 → `request_failed`（不可重试）。可重试错误最多 `max_retries=4` 次：429 退避下限 `embedding_rate_limit_retry_delay_seconds=30s`，其余指数退避 `0.25 * 2**attempt`，统一上限 300s。
- 响应校验：条数一致、按 `item.index` 重排且不允许重复/越界、维度必须等于 `dimensions`、全部 isfinite；违例 → `invalid_response`（不可重试）。`EmbeddingError` 文案不携带响应体与输入文本。
- **配置指纹**：`embedding_identity` = sha256(`base_url.strip() \0 model.strip() \0 str(dimensions)`)，存 meta 表。启动时不一致且有数据 → `rmtree(index_path)` + 删除全部文档记录（**保留 sources**）→ 全量重建；batch/concurrency/timeout 不参与指纹。

### 4.4 检索（store.py / service.py）

- 三模式：`hybrid`（默认，向量 + BM25 经 LanceDB `RRFReranker(K=60)` 融合）、`vector`、`full_text`。
- **降级语义**：查询向量获取失败时 —— `vector` 模式报 `embedding_unavailable`（HTTP 503）；`hybrid` 自动降级为 `full_text` 并在响应中标记 `degraded: true`；未配置 embedder 时同理。
  - **有意偏差（已实施）**：skb 中"未配置 embedding + hybrid"实际会抛 ValueError（HTTP 500），与其 README 的降级承诺矛盾；迁移实现统一走降级路径（`degraded: true`），保证 Agent 检索能力在未配置 embedding 时始终可用。
- 得分：full_text 取 BM25 `_relevance_score`；vector 取 `1.0 - cosine_distance`；hybrid 取 RRF 相关性分。
- 入参约束：query 1–4000 字符；`top_k` 1–100（API 默认 10，MCP 默认 8 且上限 50）。

### 4.5 排除规则引擎（ignore.py）

- 语法：gitignore 方言（`*`、`?`、`**`、`/` 锚定、`!` 反选、`#` 注释行），后写规则优先；**不会自动读取 `.gitignore`/`.kbignore`**。
- 语义要点：**祖先剪枝** —— 对路径每级前缀检查，任一级以 `.` 开头、或属于 `{"node_modules","__pycache__"}`（不可覆盖的默认排除，负向规则无法恢复）、或命中规则 → 整枝排除；要恢复子目录中文件必须先恢复父目录。目录剪枝在扫描侧同步生效。
- 工程约束：整段 ≤ 64000 字符；含 `\x00` 拒绝；单行编译失败报"排除规则第 N 行无效"，**无效规则无法保存**；规则编译失败或扫描遇错时**不清理已有索引**；每次同步使用固定规则快照，中途修改排队下一轮。

## 5. 对外接口现状与安全语义

### 5.1 HTTP API（api.py，迁移后大部分由宿主机制取代，此处为行为基准）

| 方法 路径 | 请求 | 响应 / 状态码 |
| --- | --- | --- |
| GET `/health`（无鉴权） | — | sources/documents/indexed/failed/chunks 统计 + `sync{running, pending, runs, interval_seconds, last_run_at, last_run_seconds}` |
| GET/POST `/api/sources` | `{path, name?, ignore_rules?}` | 201；`source_exists`/`source_overlaps`（嵌套/重叠检测）→ 409 |
| PATCH `/api/sources/{id}` | `{ignore_rules}`（空串清空） | 修改后触发后台同步 |
| DELETE `/api/sources/{id}` | — | 级联删除文档与索引 |
| POST `/api/sources/{id}/scan` | — | 仅 `sync.wake()`（异步执行） |
| GET `/api/documents` | `source_id?/status_filter?/limit(1-200,默认50)/offset` | `{items, total}` |
| GET `/api/documents/{id}/content` | `offset/limit(默认20000)` | `{document, content, truncated, content_trusted: false}` |
| POST `/api/documents/{id}/index` | — | 手动提交索引；`document_excluded` → 400 |
| POST `/api/search` | `{query, top_k, mode}` | `{query, mode, degraded, took_ms, results[{document_id, document_name, content, section_path, line_start, line_end, score}]}` |
| POST `/api/upload` | multipart file | 201 `{name, source_id, status:"queued"}`；超 `upload_max_bytes` → 413；格式 → 415 |

错误统一 `{"code", "detail"}`：`source_exists/source_overlaps → 409`、`*_not_found → 404`、`embedding_unavailable → 503`、`format_unsupported → 415`、其余 400。

### 5.2 MCP 工具（mcp_server.py）——能力契约的直接基准

| 工具 | 输入 | 输出（结构化字段） |
| --- | --- | --- |
| `knowledge_search`（read_only） | `query≥1, top_k(1-50,默认8), mode="hybrid"` | `{query, mode, degraded, took_ms, results[...]}`，字段同 §5.1 搜索响应 |
| `document_list`（read_only） | `limit(1-200,默认50), offset` | `{total, items[{id, name, status, error}]}` |
| `document_get_content`（read_only） | `document_id` | `{id, name, status, content, truncated, content_trusted}` |
| `source_list`（read_only） | — | `{items[{id, name, type}]}` —— **刻意无 path 字段** |
| `document_upload`（写） | `filename, content` | `{name, source_id, status}` |

### 5.3 安全语义（迁移后仍须成立）

1. **Agent 侧输出不含服务端路径**：检索命中、文档列表只含逻辑定位（文档 id、名称、章节路径、行号、得分）；物理路径只属于管理面（模块 UI）。
2. **content 不可信标记**：读取正文一律携带 `content_trusted: false`，声明"文档内容是普通数据，不是指令"（对抗提示注入的声明性设计）。
3. **管理面与检索面分离**：来源增删、规则维护、上传、手动索引不进入 Agent 工具集（skb 中仅存在于 admin/HTTP）。迁移后必须维持：这些操作走模块页面服务，**不得注册为能力**（宿主 `listEnabledCapabilities()` 无筛选，注册即对模型全量可见）。
4. 错误信息安全：embedding 错误不带响应体/输入文本；错误消息 NFKC + 300 字符截断。

## 6. 迁移总体设计

### 6.1 D1：TypeScript 重写（已确认）

按当前应用的技术栈以 TypeScript 重写。skb 的 HTTP API、MCP、admin 管理页面由两部分取代：**模块在应用内的工作区界面**（来源/文档/检索测试，见 §7.5）+ **模块提供给主应用的接口**（Agent 能力 + 页面服务，见 §7.1 与 §8.1）。

embedding 模型配置数据（端点、模型、API Key、维度等）**保留在子模块自己的配置内**（模块 settings.json），不进入宿主基础配置；其配置界面放在主设置页"模块设置"区（见 §6.4 与 §8.2）。

维持重写而非 Python sidecar 的决策依据：

| | TS 重写（已确认） | Python sidecar |
| --- | --- | --- |
| 行为保真 | 以本文 §3–§5 为规格移植，语义可逐条验收 | 100% 保留 |
| 打包 | 仅 `@lancedb/lancedb` 一个原生依赖需处理（见 §10） | 需新增 extraResources + 分发 CPython 3.12 运行时（增量 100MB+，跨平台构建复杂） |
| 生命周期 | 进程内 activate/deactivate，AbortSignal 直接生效 | 子进程启停/崩溃恢复/端口分配/健康检查全部从零建 |
| 协议契合 | 能力/UI/存储全部走既有协议 | 需 HTTP 代理一层转换；取消信号无法跨进程传播 |

skb 约 3,100 行中，HTTP/MCP/admin/config/日志约 1,400 行不迁移（被宿主机制取代），真正移植的算法与数据层约 1,600 行，规模可控。独立部署的 skb 与本应用的模块实现自此分叉，skb 仓库转为参考实现，行为规格以本文 §3–§5 为准。

### 6.2 D2：保持 skb 的多来源模型（已确认）

知识库是一个子模块（`modules/knowledge/`），在**一个模块内管理多个来源**（本地目录 / 单文件 / 内置 uploads 来源），与 skb 现状一致；不采用"每个来源呈现为一个独立知识库"的方案。[module-ui-design.md](module-ui-design.md) §3 原按"知识库列表 + 新建知识库"的库模型编写，属错误设计，已随本决策修正为"来源列表 + 添加来源"（见该文件更新说明）。未来如确需多库（collection 维度），再扩展 sources 表（加 `collection_id` 列）与能力入参（可选参数，向后兼容），当前不设计。

### 6.3 D3：外部接入面（已确认：第一阶段不迁移）

skb 的 HTTP API、MCP（streamable HTTP + stdio）、token 鉴权、admin 登录页全部不迁移。宿主内 Agent 经能力调用；模块页面经页面服务（§8.1）。"宿主可选暴露 MCP 端点供局域网 Agent 使用"与桌面形态冲突（应用未运行即无服务），列为独立后续项，不在本迁移范围。

### 6.4 D4：embedding 配置存模块内（已确认，随 D1）

embedding 全部配置（**含 API Key**）存放在模块私有配置 `app-data/modules/knowledge/settings.json`，经 `ModuleConfigScope` 读写，不使用宿主凭据存储，本迁移不做凭据句柄协议扩展。配置界面为主设置页"模块设置"区内嵌的知识库配置块（§8.2）。若未来需要加密，`packages/module-sdk/src/module.ts` L32 预留的凭据句柄扩展点仍可用作升级路径，届时仅需迁移存储位置，配置项不变。

## 7. 映射表

### 7.1 能力映射（沿用 93577ee 原型命名，补 TypeBox Schema——宿主仅对 TypeBox 做完整校验）

| 能力 ID（工具名） | 对应 skb 接口 | 输入要点 | 输出要点 |
| --- | --- | --- | --- |
| `knowledge/search`（`knowledge__search`） | `POST /api/search` + `knowledge_search` | `{query: 1-4000, topK?: 1-50, mode?: 'hybrid'\|'vector'\|'full_text'}` | `{query, mode, degraded, results[{documentId, documentName, content, sectionPath, lineStart, lineEnd, score}]}`；无 path 字段 |
| `knowledge/list_documents` | `document_list` + `GET /api/documents` | `{limit?: 1-200, offset?}` | `{total, items[{id, name, status, error}]}` |
| `knowledge/read_document` | `document_get_content` + content API | `{documentId}` | `{id, name, status, content, truncated, contentTrusted: false}` |
| `knowledge/upload_document`（新增，对齐 MCP `document_upload`） | `POST /api/upload` | `{filename, content}` | `{name, sourceId, status: 'queued'}` |

`source_list` 不单独设能力（文档元信息已含来源维度）；错误复用 SDK 五个错误码：`INVALID_INPUT` / `RESOURCE_NOT_FOUND` / `EXECUTION_FAILED` / `CAPABILITY_UNAVAILABLE` / `CANCELLED`；`embedding_unavailable` 映射为 `EXECUTION_FAILED` + `retryable: true`。

### 7.2 配置映射（`config.toml` → `app-data/modules/knowledge/settings.json`）

| skb 配置 | 去向 |
| --- | --- |
| `host` / `port` / `api_url` / `api_token` | 删除（无 HTTP 面） |
| `data_dir` | 固定为 `context.storage.dataDir` |
| `upload_max_bytes`(25MiB) / `auto_index_max_bytes`(5MiB, 0=不限) | `upload.maxBytes` / `index.autoMaxBytes` |
| `sync_interval_seconds`(600, ≥30) / `sync_debounce_seconds`(2.0) | `sync.intervalSeconds` / `sync.debounceSeconds` |
| `embedding_base_url` / `embedding_model` / `embedding_dimensions`(1024) / `embedding_batch_size`(20) / `embedding_max_concurrency`(2) / `embedding_timeout_seconds`(30) / `embedding_max_retries`(4) / `embedding_rate_limit_retry_delay_seconds`(30) / `embedding_api_key` | `embedding.*` 同名驼峰，**全部存模块 settings.json（含 api_key，D4）** |
| `log_level` | 用模块 logger，不单独配置 |

### 7.3 存储映射

| skb | 迁移后 |
| --- | --- |
| `data/kb.db` | `<dataDir>/data.sqlite`（node:sqlite；表结构 §3.1 原样，含 UNIQUE 约束与 rel_path posix 分隔） |
| `data/index/` | `<dataDir>/index/`（LanceDB chunks 表，schema §3.2 原样） |
| `data/uploads/` | `<dataDir>/files/uploads/`（`createNodeModuleServices` 已自动创建 `files/`） |
| `data/logs/service.log` | ModuleLogger |
| 来源 `path` 绝对路径 | 仍存绝对路径（本机应用无跨机迁移诉求）；旧库导入不做自动迁移，提供"重新添加来源"即可 |

> **实施案例（2026-10-03）**：某用户 userData 中残留旧原型（git 93577ee 知识库模块）创建的同名 `data.sqlite`，其 `documents` 表为旧结构（id/name/content/created_at）。`CREATE TABLE IF NOT EXISTS` 对已存在的异构表无效，激活时 `ORDER BY rel_path` 报 `no such column: rel_path`。修复：`MetadataDB` 建表前校验 sources/documents/meta 的必需列，不兼容的旧表 `ALTER TABLE ... RENAME TO <表>_legacy_<时间戳>` 改名保留并按当前 Schema 重建（`quarantineForeignTables`，含回归测试）；确认归档不再需要后可手动删除。

### 7.4 依赖替代

| Python | TypeScript 替代 | 说明 |
| --- | --- | --- |
| fastapi / uvicorn / jinja2 / python-multipart | 删除 | 宿主 IPC + `@reisa/ui` |
| mcp | 删除 | 能力直接注册为宿主 Agent 工具 |
| sqlite3 | `node:sqlite`（DatabaseSync） | Electron 41 主进程已实证可用 |
| lancedb + pyarrow | `@lancedb/lancedb` | **原生依赖，P0 spike 前置**（§10） |
| openai（AsyncOpenAI） | `openai` npm 或 AI SDK `embedMany` | 保留自管重试/分类语义（§4.3） |
| watchdog | chokidar | 跨平台行为接近；`watcher_unavailable` 仅告警 + 周期对账兜底 |
| pathspec（GitIgnoreSpec） | `ignore` npm 包 | gitignore 方言实现 |
| pydantic-settings | ModuleConfigScope | settings.json |
| uuid5 | `uuid` npm（v5） | document_identity 一致性不跨库要求，实现可自选 |

### 7.5 UI 映射（skb admin → 知识库模块工作区，按 module-ui-design §3 已修正的多来源模型实施）

| skb admin 页面 / 配置 | 模块工作区形态 |
| --- | --- |
| dashboard（统计 + 同步状态） | 来源列表卡片统计 + 文档视图顶部同步状态条（空闲/已排队/同步中、上次同步时间） |
| documents（添加来源表单 + 文档列表 + 状态/来源筛选 + 分页） | 左侧来源列表（本地目录、单文件、内置"上传"来源，各来源文档数/失败数 + "添加来源"）；"文档"Tab：文档列表（状态筛选）+ 预览并列，窄窗口预览下移 |
| document_detail（正文 + content_trusted 提示） | 文档预览面板，标注"内容不可信"，可展开索引片段 |
| search（三模式 + 得分 + 降级提示） | "检索测试"Tab；术语对齐：`semantic=vector`、`keyword=full_text` |
| source_settings（排除规则编辑 + 语法帮助） | 来源扫描设置（规则编辑保留"第 N 行无效"即时校验语义，保存后自动触发后台同步） |
| config.toml 的 embedding 配置 | 主设置页"模块设置"区内嵌的知识库配置块（端点/模型/API Key/向量维度/检索方式默认值/自动索引门槛，§6.4） |
| login / 主题切换 / skip link | 删除（无 HTTP；宿主统一主题与无障碍基线） |

## 8. 宿主侧改动与前置机制

### 8.1 前置：模块配置与页面服务通道（本迁移新增的宿主通用机制，P4 前必须就位）

现状：renderer 无 Node；模块页面没有访问主进程模块业务的通道（现有 IPC 仅会话/能力列表/模块启停/设置），模块设置组件也无法读写模块自己的配置（`ModuleSettingsProps` 目前只有 `notify`）。需要新增两条**通用**受限通道（主进程侧校验 moduleId 已注册且启用；后续绘图/项目模块同样使用，不硬编码 knowledge）：

- **模块配置通道**（标准，所有模块免费获得）：`reisa/module-config`，`{moduleId, key?, value?}` get/set，读写该模块的 `settings.json`（与 `ModuleConfigScope` 同一存储）。各模块的设置组件经它读写自己的独有配置。
- **模块页面服务通道**（业务操作）：`reisa/module-page`，`{moduleId, action, input}` → 调用模块 runtime 注册的页面服务处理函数（按模块声明白名单校验）。知识库的管理操作走这里：`list_sources / add_source / remove_source / update_rules / scan_now / reindex_document / get_sync_status / upload_file`。

两点约束：

- **能力复用**：`search / list_documents / read_document` 在页面内可经页面服务通道转发 `host.invoke(本模块能力)`（与 Agent 同一路径，语义一致），也可直接由页面服务实现，P4 定型时二选一。
- **管理操作不得注册为能力**：宿主 `listEnabledCapabilities()` 无筛选，注册即对模型全量可见；skb 的安全分层（§5.3）要求管理面只属于页面服务。

**主设置页"模块设置"区**：`apps/desktop/src/renderer/shell/SettingsPage.tsx` 已有"模块设置"分区，但当前只是每模块一个"设置"按钮弹出全局 Dialog。按本迁移需求升级为**内嵌式**——该分区直接渲染每个已启用模块的 `settings` 组件（每模块一个配置块），与模块工作区 `openSettings` 弹窗复用同一组件与同一份配置存储（经模块配置通道读写）。知识库的 embedding 配置表单（KnowledgeSettings）即出现在这里。

添加本地目录来源另需宿主目录选择对话框的受限封装（主进程 `dialog.showOpenDialog`，经页面服务通道触发）。

### 8.2 必改清单

1. `apps/desktop/src/composition/modules.ts`：加入 knowledge 的 `ModuleContribution`（`navigation.icon: 'book'`，aliases/keywords 沿用原型）。
2. `apps/desktop/src/composition/runtime.ts`：`RUNTIME_MODULE_FACTORIES` 加入 runtime 工厂。
3. `modules/knowledge/package.json`：声明 `exports` 的 `"."` 与 `"./runtime"` 子路径（边界检查约定：`@reisa/module-*/runtime` 仅允许被 composition 导入）。
4. `apps/desktop/src/main/index.ts` + `src/preload/index.ts` + `src/renderer/bridge.ts`：新增模块配置通道与模块页面服务通道（§8.1）。
5. `apps/desktop/src/renderer/shell/SettingsPage.tsx`："模块设置"分区升级为内嵌渲染各已启用模块的 `settings` 组件（现有实现仅提供弹出 Dialog 的跳转按钮）。
6. `apps/desktop/src/main/smoke.ts`：L83-86 `assert.deepEqual(capabilityIds, [])` 会因首个运行时模块而失败，需同步更新。
7. 根 `package.json` 的 `pnpm test` glob 追加新模块测试文件。
8. 依赖边界：模块只依赖 `@reisa/module-sdk`、`@reisa/ui`、react（+ 自身依赖）；不 import 其他模块与 Node 内建于 UI 层；数据库/LanceDB 代码只在 runtime 层。

## 9. 实施阶段与验收

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 spike | D1–D4 已确认（§6）。按 §10.1 的 spike 清单执行：skb 用例对拍 + `pnpm dist` 安装包实测 | 实测结论（含得分列名等）回填 §10.1；功能项与打包项全部通过则锁定 LanceDB 方案，否则按 §10.1 启用兜底 A/B |
| P1 纯函数层 | `modules/knowledge` 包骨架（manifest/runtime/exports）；移植 parsing/chunking/ignore/scanner + `node --test` 单测（用例对齐 skb tests） | 标题栈/行号/CRLF-BOM/确定性 chunk_id/排除规则语义（含祖先剪枝与不可覆盖默认排除）逐条通过 |
| P2 存储与同步引擎 | node:sqlite 建表；LanceDB store；embedding 客户端（错误分类/重试退避/指纹重建）；SyncService（chokidar + 防抖 + 单飞行对账 + manual_required + uploads 自恢复）；FakeEmbedder 离线测试 | skb `test_sync` / `test_embedding_identity` / `test_store` 的等价用例通过 |
| P3 能力接线 | §7.1 四个能力 + TypeBox Schema；e2e-chain 式端到端；smoke 断言更新 | 会话中模型可调用 `knowledge__search` 并返回片段；停用模块后能力 CAPABILITY_UNAVAILABLE、数据保留 |
| P4 页面与配置面 | §8.1 两条通用通道（main/preload/bridge）；主设置页"模块设置"区内嵌渲染（§8.2 第 5 条），含 KnowledgeSettings（embedding 端点/模型/API Key/维度、检索方式默认值、自动索引门槛）；多来源工作区五组件：KnowledgeWorkspace / SourceNavigation / DocumentList / DocumentPreview / RetrievalTest | 来源管理 → 索引 → 检索测试闭环；主设置页可完成 embedding 配置并即时生效；空/执行中/失败/未配置 embedding/停用各状态有展示 |
| P5 打包与收尾 | electron-builder 原生依赖处理；`pnpm dist` 验证；文档更新；（可选）旧 skb data 导入脚本 | 安装包内功能完整；README 设计文档区更新 |

## 10. 风险清单

| # | 风险 | 等级 | 缓解 |
| --- | --- | --- | --- |
| 1 | LanceDB：功能对等性已核实（§10.1，2026-10-03 对照 `@lancedb/lancedb@0.39.0` 类型定义：icu/jieba 分词、RRFReranker、cosine IvfFlat、固定维度列均存在，Python/JS 共享同一 Rust 核心）；剩余硬点为**原生二进制打包**（仓库首次引入原生依赖，安装包现不含 node_modules）与行为细节实测 | 中 | §10.1：P0 spike 清单（含 `pnpm dist` 实测）；兜底 A（自实现 BM25 + 手动 RRF）/ 兜底 B（去 LanceDB 纯 JS）；保持 ChunkStore 接缝使替换不外溢 |
| 2 | 主进程事件循环阻塞：DatabaseSync 同步、大目录扫描同步；skb 的 `asyncio.to_thread` 对应物是 worker_threads | 中 | 对账引擎置于模块 runtime 内部 worker（架构 §11 允许，对外能力契约不变）；AbortSignal 经 MessagePort 传递 |
| 3 | 模块页面服务通道缺失是 P4 的硬前置 | 高 | §8.1 按通用机制提前实现 |
| 4 | embedding API Key 明文存模块 settings.json（无加密） | 低（已接受） | D4 已确认配置存模块内；未来如需加密，走 `module-sdk/src/module.ts` L32 预留的凭据句柄扩展点，届时仅迁移存储位置 |
| 5 | 能力全量暴露给模型（`listEnabledCapabilities` 无筛选） | 安全 | 管理操作绝不注册为能力（§5.3） |
| 6 | `enabledModules` 未配置时默认启用全部运行模块 —— 模块激活即可能开始全量对账 | 低 | 与 skb"启动即服务"语义一致，可接受；skb 本就无来源时无事发生 |

### 10.1 LanceDB 风险详析与 P0 spike 基准（2026-10-03 对照 `@lancedb/lancedb@0.39.0` 核实）

> 实现时先读本节：功能对等性基于类型定义核对，**核对不等于实测**——按下方 spike 清单逐项确认后，把实测结论（尤其是得分列名）回填到本节。
>
> **✅ Spike 已执行（2026-10-03，`node modules/knowledge/test/spike-lancedb.mjs`，11/11 通过）**。实测结论：① FTS 查询得分列为 **`_score`**（非 Python 的 `_relevance_score`）；② hybrid 结果同时返回 `_score` 与 `_relevance_score`，skb 的取分防御链原样适用；③ icu 分词下中文查询命中正常；④ 固定维度列、谓词删除、复合谓词、schema 往返全部可用；⑤ 包导出形态为 `lancedb.rerankers.RRFReranker.create(k)`（命名空间）；⑥ arrow v18 无 `Type.equals`，schema 比较用类型字符串 `FixedSizeList[1024]<Float32>`。
> **✅ Spike 第 7 步（打包实测）已完成**：`@lancedb/lancedb` 与 `apache-arrow` 列入 esbuild external 与 desktop 的 production dependencies，`electron-builder.yml` 增加 node_modules 子集与 `asarUnpack: "**/*.node"`；`pnpm dist:dir` 产出中 `lancedb.win32-x64-msvc.node` 位于 `app.asar.unpacked`，且**打包后的应用冒烟测试通过**（模块激活、四能力注册、页面服务通道可用）。

**skb 对 LanceDB 的使用面（仅此七项；`ChunkStore` 是唯一接缝）**：显式 schema 建表（向量列为固定维度 `list(float32, 1024)`）；`delete("document_id = '...'")` 谓词删除 + `add`（同文档先删后加）；FTS 索引 `FTS(with_position=True, base_tokenizer="icu", stem=False, remove_stop_words=False, ascii_folding=False)`；`IvfFlat(distance_type="cosine")`（仅 `count_rows() > 0` 时创建）；`fts / vector(+cosine) / hybrid(+RRFReranker(K=60))` 三种查询；得分列防御链 `_relevance_score → _score → 1-_distance → 1.0`；打开旧表时比较向量列类型防维度漂移。

**API 对照（Python ↔ JS 0.39.0，已核对包内类型定义）**：

| skb（Python） | JS SDK | 结论 |
| --- | --- | --- |
| `base_tokenizer="icu"` | `FtsOptions.baseTokenizer`：`"simple"` / `"whitespace"` / `"raw"` / `"ngram"` / `"icu"` / `"icu/split"` / `` `jieba/${string}` `` / `` `lindera/${string}` `` | ✅ 支持 icu；另可选 jieba 中文词典分词（增强项，非必需） |
| `with_position / stem / remove_stop_words / ascii_folding` | `withPosition / stem / removeStopWords / asciiFolding` | ✅ 一一对应 |
| `RRFReranker(K=60)` | `RRFReranker.create(k?): Promise<RRFReranker>`（异步工厂，注意 await） | ✅ 存在 |
| `search(query_type="hybrid").vector(v).text(t).rerank(...)` | `search(v, "vector")` → `.fullTextSearch(t)` → `.rerank(rrf)` | ✅ 链式形态不同，能力等价 |
| `search(text, query_type="fts")` | `search(text, "fts", ftsColumns?)` | ✅ |
| `IvfFlat(distance_type="cosine")` | `Index` IvfFlat 配置 + 查询 `.distanceType("cosine")` | ✅（flat 具体参数名 spike 确认） |
| `pa.list_(pa.float32(), n)` 固定维度向量列 | apache-arrow `new Field("vector", new FixedSizeList(n, new Field("item", new Float32())))` | ✅ |
| `list_indices / count_rows / delete / add / create_index(wait_timeout=60s)` | `listIndices() / countRows(filter?) / delete(predicate) / add(data) / createIndex(column, options)` | ✅ 全部存在 |

结构性事实：**Python 与 JS SDK 共享同一 Rust 核心**（pyo3 / napi 只是绑定层），BM25 打分、icu 分词、RRF、IvfFlat 的算法行为理论一致——"中文分词质量对不齐"的担忧基本不成立；skb 的得分防御链原样移植即可吸收字段名差异。

剩余风险（详析）：

1. **原生二进制打包（最硬，必须实测）**。`@lancedb/lancedb` 经 optionalDependencies 分发平台二进制（`@lancedb/lancedb-win32-x64-msvc` 等，Windows x64 有官方预编译包）。本仓库现状：安装包 `files` 仅 `dist/**` + `dist-electron/**`（不含 node_modules），主进程经 esbuild 打成单文件。需三步：esbuild 将 `@lancedb/lancedb` 标记 external；electron-builder 把平台包带入安装包；对 `.node` 做 asarUnpack（asar 内无法加载原生模块）。dev 模式跑通不算数，必须 `pnpm dist` 产出安装包实测——这是仓库首次走通原生依赖链路。
2. **行为细节差异（中，有兜底写法）**。hybrid/FTS 结果得分列的实际名称（`_relevance_score` 是运行时列，类型定义里查不到）、rerank 前 hybrid 的组装顺序、`delete` 谓词语法边界、`createIndex` 的等待参数。skb 的取分防御链与"先删后加 + 外部锁"写法均不依赖这些细节的精确形态。
3. **版本节奏（低）**。skb 钉 Python 版 `<0.39`，JS 当前 0.39.0；迁移后模块使用独立 index 目录（`app-data/modules/knowledge/index/`），不存在跨版本数据兼容问题。

**P0 spike 清单**（以 skb `tests/.../test_store.py` 用例为模板，预计 0.5–1 天）：

1. 建表：skb 原版 schema、1024 维固定向量列；
2. 写入 → 按 `document_id` 删除 → 重写 roundtrip；
3. icu 分词建 FTS 索引，中文查询，记录实际得分列名（回填本节）；
4. 有数据后建 cosine IvfFlat，确认 `_distance` 语义与 `1 - distance` 得分换算；
5. hybrid：vector 查询 + `fullTextSearch` + `await RRFReranker.create(60)`，与 Python 版对拍融合排序；
6. 打开不同维度的旧表，验证拒绝路径（arrow Field 类型比较实现 `_validate_schema`）；
7. 打包：依赖接入 apps/desktop（`build-electron.mjs` external + electron-builder asarUnpack），`pnpm dist` 后在**安装后的应用**中完成一次检索。

**兜底方案**（保持 `ChunkStore` 七方法接缝不变，替换不外溢到同步引擎与能力层）：

- **兜底 A（部分替换）**：向量检索保留 LanceDB；FTS/BM25 自实现——用 skb 分块器的 token 正则（CJK 单字 = 1 token）分词，RRF 手动融合（`score = Σ 1/(60+rank)`）。
- **兜底 B（彻底去原生依赖）**：向量存 `node:sqlite` 的 Blob，查询时以 Float32Array 暴力计算 cosine（5 万 chunk × 1024 维 ≈ 5000 万次乘加，数十毫秒量级；代价为约 200MB 内存驻留，实施时实测），BM25 用纯 JS 方案（如 MiniSearch + 自定义分词器）。打包从此零原生风险。

## 11. 行为语义保留清单（迁移验收 checklist）

- [ ] 增量判断：size + mtime_ns 相同且 indexed → 跳过；内容哈希不变（仅触碰时间戳）→ 保留旧向量不重嵌
- [ ] embedding 指纹（base_url\0model\0dimensions 的 sha256）变更 → 清索引（保留 sources）全量重建
- [ ] hybrid 降级：查询向量失败 → full_text + `degraded: true`；vector 模式失败 → `embedding_unavailable`
- [ ] RRF K=60；vector 得分 = 1 − cosine 距离；topK/长度入参约束同 §4.4
- [ ] 分块：max_tokens=600、overlap=80、CJK 单字 token、确定性 chunk_id；解析：UTF-8-sig、NFC、CRLF 归一、ATX 标题栈、`" > "` 路径、行号
- [ ] 排除规则：gitignore 方言后写优先；隐藏目录/node_modules/__pycache__ 不可覆盖；祖先剪枝；恢复须先恢复父目录；64KB 上限；无效规则拒存；编译/扫描失败不清索引
- [ ] manual_required：>5MiB（0 不限）先清旧向量；手动提交绕过大小不绕过排除
- [ ] 单文档失败不阻塞同来源其他文件，下一轮对账自动重试；单来源异常不中断整体对账
- [ ] 上传：25MiB 上限、同名覆盖自动重索引、uploads 内置来源删除后自恢复、手动放入亦被索引
- [ ] 来源：路径存在性校验、嵌套/重叠拒绝（409 语义 → INVALID_INPUT/EXECUTION_FAILED）、删除级联清理
- [ ] Agent 输出无服务端路径；正文读取恒带 `content_trusted: false`；管理操作不在能力表
- [ ] 一个知识库模块管理多来源（目录/单文件/内置上传来源），来源增删改与 skb 语义一致
- [ ] 主设置页"模块设置"区内嵌知识库配置块：embedding 端点/模型/Key/维度等存模块 settings.json，修改后按指纹语义触发重建（§4.3）
- [ ] 停用模块：在途调用收 CANCELLED，数据与索引保留，重启用后对账自动追平停机期间变更
