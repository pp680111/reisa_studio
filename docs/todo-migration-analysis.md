# Todo Manage 目标项目分析与迁移设计指引

> 版本：v0.4（2026-10-06，实施完成）
> v0.4 变更：M0–M4 全部实施完成并验收通过（18 个模块测试 + 全量 247 测试 + typecheck + boundaries + 桌面冒烟）；新增 §14 实施记录（含实现期行为差异），§10.4 宿主改动清单按实际修正
> v0.3：决策落定——模块命名采纳建议（Q1）、不做旧库导入（Q3）、EXPIRED 保持源行为（Q4）、日期时间选择器引入第三方库（Q5）、取消外部 MCP 接入面（Q6）；M4 收缩为收尾阶段
> v0.2：范围变更——桌面宠物、任务气泡、系统托盘移出迁移范围（R4 修订），宿主侧扩展与附录 B（窗口协议）随之取消
> v0.1：初版分析
> 源项目：`D:\flutterCode\todo_manage`（Flutter 桌面待办应用，仅 Windows 可用）
> 目标宿主：uzawa_reisa_studio（Electron + React monorepo），新模块 `modules/todo`
> 用途：作为 todo 模块迁移实施的设计基准。§1–9 记录源项目事实（迁移以代码为准，非设计文档），§10–13 是对接分析与实施指引，§14 是实施记录。文档结构与 [card-note-migration-analysis.md](./card-note-migration-analysis.md) 保持一致。

## 目录

- [迁移范围决策记录](#迁移范围决策记录)
- [1. 项目概览](#1-项目概览)
- [2. 技术栈清单与宿主差异](#2-技术栈清单与宿主差异)
- [3. 架构与代码组织](#3-架构与代码组织)
- [4. 数据模型](#4-数据模型)
- [5. 核心业务规则清单（迁移必须保真）](#5-核心业务规则清单迁移必须保真)
- [6. 功能域详解](#6-功能域详解)
- [7. UI 页面与交互清单](#7-ui-页面与交互清单)
- [8. 测试资产清单](#8-测试资产清单)
- [9. 设计文档与实现的偏差（迁移以代码为准）](#9-设计文档与实现的偏差迁移以代码为准)
- [10. 宿主模块系统对接分析](#10-宿主模块系统对接分析)
- [11. 迁移策略建议](#11-迁移策略建议)
- [12. 分阶段迁移路线](#12-分阶段迁移路线)
- [13. 待决策问题清单](#13-待决策问题清单)
- [14. 实施记录（v0.4）](#14-实施记录v04)
- [附录 A：迁移目标库 DDL 草案（node:sqlite）](#附录-a迁移目标库-ddl-草案nodesqlite)
- [附录 B：MCP 工具 → 模块能力映射](#附录-bmcp-工具--模块能力映射)

---

## 迁移范围决策记录

| #   | 决策     | 内容                                                                                                                                                                                                                                                                                    | 状态               |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| R1  | 迁移方式 | **TypeScript 重写**为宿主功能模块 `modules/todo`，不采用 git submodule 嵌入 Flutter 工程。沿用 card-note 迁移的结论：Flutter UI 无法嵌入 Electron 渲染进程，纯 Dart 业务层体量小（约 470 行），重写成本低于双运行时共存的维护成本。"子模块"在本文中一律指宿主 `modules/` 下的功能模块   | 已定               |
| R2  | 数据层   | 新建 SQLite 库（`node:sqlite`，与 card-note 同栈），表结构语义保留但补充外键/级联与索引（源库两者皆无）；时间统一改为 UTC 毫秒整数（源库为 drift 默认的 Unix 秒）。**不做旧库导入**（Q3 已决，2026-10-06）：旧应用数据保留在原处不受影响                                                | 已定               |
| R3  | MCP 服务 | 不再运行独立 Streamable HTTP MCP 服务器（`127.0.0.1:8765/mcp`），其 5 个 tool 改为注册**模块 Agent 能力**（`todo/list_todos` 等，工具名 `todo__list_todos`），由宿主能力注册中心提供给会话主 Agent。外部接入面已取消（Q6 已决：MCP 协议服务完全不做，Agent 访问待办一律经宿主能力机制） | 已定               |
| R4  | 桌面集成 | 桌面宠物、任务气泡、系统托盘**移出迁移范围**（v0.2 决定）。三者是 Flutter 专项的桌面形态功能，脱离宿主主窗口的独立窗口/托盘需要宿主扩展（模块独立窗口机制、Electron 桥接），成本与收益不匹配；如将来需要，可基于本文档 v0.1（git 历史）的附录 B 协议规格重启                            | 已定（2026-10-06） |
| R5  | 分类层级 | `parentCategoryId` 字段（源库为 TEXT，类型错误）在任何 UI 与查询中均未使用，**不迁移**。分类保持平铺                                                                                                                                                                                    | 已定               |
| R6  | 已知缺陷 | 源项目遗留缺陷中，以下两项在迁移中顺手修复并在此记录为有意的行为变更：① 分页列表尾 item 可能为 null（返回条数 < pageSize 不置 `hasNextPage=false`）；② 删除待办不级联删进度、删除分类不解除待办关联（新库用外键级联 + ON DELETE SET NULL 解决）。其余行为以源代码为准原样保留           | 已定               |

> v0.1 的 R6 ③（宠物位置等偏好不持久化的修复）随 R4 取消，不再适用。

---

## 1. 项目概览

源项目是作者自述"学习 Flutter 的练习作"：一个**纯本地**（无网络依赖）的 Windows 桌面待办管理工具，附带桌面宠物形态。约 3,631 行非生成 Dart 代码（lib 下 36 个文件，生成代码 1,717 行）。

| 功能             | 核心交互                                                                                                                                       | 主要实现                                     | 迁移处置             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------- |
| 待办列表（全部） | 搜索栏（标题关键词实时过滤）+ 过滤栏（状态下拉 + 分类可搜索下拉）+ 新增；分页列表滚动预加载；点击状态图标直接切换状态；"⋮"菜单删除             | `lib/widget/todo_thing/todo_thing_list.dart` | 迁移                 |
| 待办详情/编辑    | 标题、状态（仅编辑态）、分类（弹窗选择）、详情多行文本、截止时间（日期时间选择器）、创建时间（只读）；保存后返回并刷新列表；编辑态内嵌进度列表 | `todo_thing_detail.dart`                     | 迁移                 |
| 进度记录         | 详情页内增删、勾选完成、点击查看全文                                                                                                           | `todo_thing/progress/`（4 文件）             | 迁移                 |
| 分类管理         | 独立 Tab：搜索 + 列表 + 增删；详情仅名称与时间                                                                                                 | `lib/widget/category/`（4 文件）             | 迁移                 |
| 分类选择弹窗     | 待办表单内弹出分页列表选择                                                                                                                     | `category_select_dialog.dart`                | 迁移                 |
| 桌面宠物         | 透明无边框置顶小窗（110×120，右下角）；单击弹/收任务气泡，双击开主窗口，按住拖动且气泡实时跟随                                                 | `desktop_pet/`                               | **不迁移**（R4）     |
| 任务气泡         | 独立子窗口（380×360）显示"今日未完成"任务（默认 5 条），可刷新、点击圆圈标记完成、点击打开主窗口；失焦自动隐藏                                 | `task_bubble_page.dart` 等                   | **不迁移**（R4）     |
| 窗口形态切换     | 同一根窗口在宠物形态 ↔ 主窗口形态（1000×720）间切换；最小化回宠物、关闭有确认                                                                  | `main.dart`、`windows_configuration.dart`    | **不迁移**（R4）     |
| 系统托盘         | 图标 + 菜单（显示窗口 / 复制 MCP 地址 / 关闭），左键显示主窗                                                                                   | `platform/windows/`                          | **不迁移**（R4）     |
| MCP 服务器       | Streamable HTTP `http://127.0.0.1:8765/mcp`，5 个 tool 供外部 Agent 客户端读写待办                                                             | `lib/mcp/todo_mcp_server.dart`               | 改造为模块能力（R3） |
| 单实例           | 重复启动聚焦已有实例后退出（Dart 层 + 原生 FindWindow 双保险）                                                                                 | `main.dart`、`windows/runner/main.cpp`       | 宿主级事项（Q8）     |

注意：源应用启动默认进入**宠物模式**（`main.dart` `_petMode = true`），主窗口是按需形态——该启动形态本身随 R4 不迁移，todo 在宿主中就是一个普通页面模块。

## 2. 技术栈清单与宿主差异

### 2.1 源技术栈

| 层       | 技术                                                                   | 说明                                                          |
| -------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| 框架     | Flutter 3.5+（Dart SDK ^3.5.3）                                        | 仅 Windows 可用（直接使用 dart:io 与 Windows 插件）           |
| 状态管理 | provider 6.1（ChangeNotifier）                                         | 无全局 store，"通知器 + 直调 DAO"模式                         |
| 数据库   | drift 2.20 + sqlite3_flutter_libs                                      | SQLite ORM，schemaVersion 1，无迁移策略                       |
| 多窗口   | desktop_multi_window 0.3                                               | 气泡子窗口（独立 Flutter Engine）+ MethodChannel 式跨窗口通信 |
| 窗口控制 | window_manager 0.5                                                     | 透明/无边框/置顶/skipTaskbar/形态切换/拖动                    |
| 托盘     | tray_manager 0.3                                                       | 图标 + 右键菜单                                               |
| 单实例   | flutter_single_instance 1.2                                            | + 原生 main.cpp 双保险                                        |
| MCP      | mcp_dart 2.4.2（锁定）                                                 | StreamableHTTP MCP server                                     |
| UI 组件  | drop_down_search_field、omni_datetime_picker、CupertinoSearchTextField | 可搜索下拉、日期时间选择、搜索框                              |

### 2.2 与宿主差异对照（替代方案）

| 源依赖                                               | 宿主对应                                          | 备注                                                        |
| ---------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| Flutter Widget                                       | React 19 + `@reisa/ui`                            | 全部 UI 重写，见 §7                                         |
| provider/ChangeNotifier                              | React 组件状态（无需引入状态库）                  | 源的"刷新信号弹"本质是重建查询，React 中即 refetch，见 §6.8 |
| drift → node:sqlite `DatabaseSync`                   | card-note 同栈                                    | 自实现 `transaction<T>`（node:sqlite 无内建事务 API）       |
| window_manager / desktop_multi_window / tray_manager | 无对应                                            | 对应功能（宠物/气泡/托盘）不迁移（R4）                      |
| flutter_single_instance                              | Electron `requestSingleInstanceLock`              | 宿主级事项，不属模块范围（Q8）                              |
| mcp_dart                                             | 宿主能力注册中心（module-sdk `defineCapability`） | R3，不再自起 HTTP 服务                                      |
| drop_down_search_field                               | `@reisa/ui` 现有组件 + 局部实现                   | 可搜索下拉局部实现                                          |
| omni_datetime_picker                                 | 第三方 React 日期时间选择器                       | Q5 已定（2026-10-06）：引入第三方库，候选 react-datepicker  |
| path_provider                                        | `ModuleContext.storage.dataDir`                   | `app-data/modules/todo/`                                    |

## 3. 架构与代码组织

### 3.1 源架构分层

```
main.dart（窗口编排 + 生命周期）──────────┐
widget/（UI 层：页面、表单、列表、宠物）    │  直调
model/（数据层：表定义 + DAO + DTO + mapper）┘
mcp/todo_mcp_server.dart（协议层，经 TodoMcpDataSource 接口隔离数据层）
```

- 无 service/repository 层：Widget 直接调用 DAO（`_doc/project_overview.md` 亦确认）。
- **唯一例外**是 MCP 层：`TodoMcpDataSource` 接口（5 方法）隔离了数据访问，`DriftTodoMcpDataSource` 为默认实现。这个接口就是现成的模块页面服务/能力层的定义，迁移时直接对应。
- 源窗口模型为"双窗口 + 单进程"（根窗口双形态复用 + 气泡独立 Engine 子窗口），相关编排逻辑随 R4 不迁移。

### 3.2 目录与行数（非生成代码）

| 源路径                                                                            | 行数 | 职责                          | 迁移处置                                                                                |
| --------------------------------------------------------------------------------- | ---- | ----------------------------- | --------------------------------------------------------------------------------------- |
| `lib/model/**`（表/DAO/DTO/mapper/query_builder/state）                           | ~470 | 业务与数据语义                | **保真重写**为 `runtime/database.ts` + `domain/`，语义逐条对照 §5                       |
| `lib/mcp/todo_mcp_server.dart`                                                    | 262  | MCP 协议层                    | 重写为模块能力注册（附录 B），分页/序列化约定保留                                       |
| `lib/widget/todo_thing/**`（不含 progress）                                       | ~700 | 列表/详情/过滤 UI             | 重写为 `ui/`                                                                            |
| `lib/widget/category/**`                                                          | ~350 | 分类 UI                       | 重写为 `ui/`                                                                            |
| `lib/widget/progress/**`                                                          | ~250 | 进度 UI                       | 重写为 `ui/`                                                                            |
| `main_page.dart` + `search_bar_component.dart` + `prefetch_scroll_list_view.dart` | ~410 | 骨架/搜索栏/分页列表          | 分页列表重写为 React hook（保留分页语义）                                               |
| `lib/widget/desktop_pet/**`（含 task_bubble_window_service.dart 217 行状态机）    | ~630 | 宠物/气泡 UI 与窗口编排状态机 | **不迁移**（R4）                                                                        |
| `main.dart` + `platform/windows/**`                                               | ~430 | 窗口编排/托盘/退出流程        | **不迁移**；其中退出前"关数据库"的顺序语义由 module-host 的 deactivate 流程承接（§5.9） |
| `lib/utils/DateTimeUtils.dart`                                                    | 12   | 格式化                        | 并入 `domain/`                                                                          |
| `test/**`                                                                         | 332  | 测试                          | 仅 MCP 测试有实质参考价值（§8）                                                         |

## 4. 数据模型

源库：SQLite，drift `schemaVersion = 1`，**无迁移策略、无显式索引、无外键约束**；位置 `getApplicationDocumentsDirectory()/zst_todo_tools/{debug|release}/app_database.sqlite`。DateTime 以 **Unix 秒整数**存储（drift 默认；旧库不做导入，此格式仅作事实存档，Q3 已决）。

### 4.1 表结构（源库真相）

**`todo_thing`**

| 列            | 类型    | 约束                      | 说明                           |
| ------------- | ------- | ------------------------- | ------------------------------ |
| id            | INTEGER | PRIMARY KEY AUTOINCREMENT |                                |
| title         | TEXT    | NOT NULL                  |                                |
| detail        | TEXT    | 可空                      |                                |
| status        | INTEGER | NOT NULL                  | 存 `TodoThingState.key`（0–3） |
| category_id   | INTEGER | 可空                      | 逻辑关联 category.id，无外键   |
| create_time   | INTEGER | NOT NULL                  | Unix 秒                        |
| deadline_time | INTEGER | 可空                      | Unix 秒                        |
| update_time   | INTEGER | NOT NULL                  | Unix 秒                        |

**`todo_thing_progress`**

| 列                        | 类型          | 约束                      | 说明                           |
| ------------------------- | ------------- | ------------------------- | ------------------------------ |
| id                        | INTEGER       | PRIMARY KEY AUTOINCREMENT |                                |
| todo_thing_id             | INTEGER       | NOT NULL                  | 无外键，逻辑关联 todo_thing.id |
| content                   | TEXT          | NOT NULL                  |                                |
| is_finished               | INTEGER(BOOL) | NOT NULL                  |                                |
| create_time / update_time | INTEGER       | NOT NULL                  | Unix 秒                        |

**`category`**（drift 内注册名 `my_category.Category`）

| 列                        | 类型     | 约束                      | 说明                           |
| ------------------------- | -------- | ------------------------- | ------------------------------ |
| id                        | INTEGER  | PRIMARY KEY AUTOINCREMENT |                                |
| name                      | TEXT     | NOT NULL                  |                                |
| parent_category_id        | **TEXT** | 可空                      | 类型错误且未使用（R5：不迁移） |
| create_time / update_time | INTEGER  | NOT NULL                  | Unix 秒                        |

### 4.2 枚举 `TodoThingState`

```text
NOT_START(0, '未开始') / EXECUTING(1, '执行中') / FINISHED(2, '已完成') / EXPIRED(3, '已超时')
```

未知 key 抛 `ArgumentError`。**EXPIRED 无任何自动赋值逻辑**——不会按截止时间自动置为超时，只能经 `update_todo_status` 能力或表单手工设置。**Q4 已定（2026-10-06）：v1 保持此行为，不做自动超时，也不做展示层超时计算。**

### 4.3 DTO 层

- `TodoThingDTO` = 表字段 + `status: TodoThingState`（枚举）+ `categoryName: String?`。
- `TodoThingDTOMapper`：async，按 `categoryId` 批量 `CategoryDao.selectById` 后**内存 map join** 填充 `categoryName`（非 SQL join）。
- `TodoThingQueryBuilder`：把过滤参数 map 转 where 子句：`searchKey` → `title LIKE '%key%'`；`categoryId`/`status` → 等值；`order` 仅实现 case 0：`status ASC, createTime DESC`。

### 4.4 DAO 方法面（= 迁移后页面服务与能力的 API 基准）

- **TodoThingDao**：`page(pageIndex, pageSize, params)`（页码从 1 起，`offset=(pi-1)*ps`）、`findById`、`findTodayUnfinished({now, limit=5})`（消费方仅任务气泡，随 R4 不迁移）、`insertOrUpdateFromMap(formMap)`（无 id 插入并初始化时间与 `status=NOT_START`；有 id 更新；`_validateFormMap` 返回中文错误消息）、`updateState(id, state)`、`deleteById(id)`。
- **CategoryDao**：`page(pageIndex, pageSize, searchKey)`（name contains，`createTime ASC`）、`selectById(ids)`、`insertOrUpdateFromMap`、`deleteById`、`validateMapForm`。
- **TodoThingProgressDao**：`getProgress(todoThingId)`（`isFinished ASC, id ASC`）、`pageForTodo(todoId, pageIndex, pageSize)`、`insert(formMap)`（默认 `isFinished=false`）、`updateIsFinished(id, bool)`、`deleteById`。

## 5. 核心业务规则清单（迁移必须保真）

以下规则从源代码提取（非设计文档），迁移时逐条对照验收：

1. **表单校验与中文错误消息**（`todo_thing_dao.dart` `_validateFormMap` / `category_dao.dart` `validateMapForm`）：title 必填非空；deadlineTime 若存在必须是 DateTime；错误消息为中文并直接展示给用户。迁移后错误消息语义保持一致（类 `NoteValidationError` 先例，可定义 `TodoValidationError`）。
2. **insertOrUpdate 语义**：表单 map 无 id → INSERT，`createTime = updateTime = now`，`status = NOT_START(0)`；有 id → UPDATE（仅更新提交字段），刷 `updateTime`。
3. **列表排序**：待办 `status ASC, createTime DESC`；分类 `createTime ASC`；进度 `isFinished ASC, id ASC`（未完成在前，同序按 id）。
4. **分页约定**：页码从 1；默认每页 20；MCP 层 pageSize 上限 100 并查 pageSize+1 条计算 `hasMore`。
5. **状态切换交互**（`todo_thing_list_item.dart` `_switchStatus`）：列表项点击状态图标——`NOT_START`/`EXECUTING`/`EXPIRED` → `FINISHED`；`FINISHED` → `NOT_START`。即"点击即完成、再点回未开始"，不存在"点击进入执行中"的路径。
6. **categoryName 填充**：批量查询后内存 join；分类不存在时 `categoryName` 为 null，待办仍正常展示（不因悬空引用报错）。
7. **MCP JSON 序列化**：时间字段 `toUtc().toIso8601String()`；单条 todo 含 `statusText`；查询结果 JSON 安全（无 Dart 对象泄漏）。改为模块能力后按附录 B 的映射输出 JSON。
8. **删除不级联**（源行为）：删除待办留下孤儿进度、删除分类留下悬空 categoryId。**R6 已决定改为级联修复**——此条记录源行为仅为存档（旧库不做导入，Q3 已决）。
9. **退出顺序**（模块相关部分）：源为"停 MCP → 移除托盘 → 关数据库"。迁移后托盘不存在，对应 deactivate 内"关数据库"，且 module-host 会先 abort 在途调用再等在途集合清空，顺序天然满足。

> v0.1 的规则 5（"今日未完成"定义）是任务气泡的消费语义，随 R4 移除；如需参考见 git 历史中 v0.1 的 §5.5 与源码 `findTodayUnfinished`。

## 6. 功能域详解

### 6.1 待办列表与过滤

- 过滤参数：`searchKey`（标题 LIKE）、`status`（下拉，含全部）、`categoryId`（可搜索下拉，数据源 `categoryDao.page(1, 50, pattern)` 远程建议）+ 重置按钮。
- 分页列表：pageSize 20，滚动接近底部（阈值 10 项 × 80px）加载下一页；返回空页置 `hasNextPage=false`；`refresh()` 重置重拉。**已知缺陷**：返回条数 < pageSize 不置 `hasNextPage=false`（R6①，迁移时修复）。
- 搜索实时过滤：输入即重建查询。

### 6.2 待办详情/编辑

- 新增/编辑共用表单（`insertMode` 标志）；状态下拉仅编辑态显示；分类经弹窗选择（可搜索分页列表，回传 DTO）；截止时间用 `omni_datetime_picker`；创建时间编辑态只读展示。
- 保存成功/失败 SnackBar → pop 返回；返回值 `hasChanged=true` 时列表刷新。

### 6.3 进度记录

- 详情页内嵌进度列表："+"弹表单添加文本；每条可勾选 isFinished、点击文本弹只读全文 AlertDialog、删除。
- 勾选/删除后经 `ProgressNotifier.notifyListeners` 触发重查。

### 6.4 分类

- 独立 Tab：搜索 + 分页列表（`createTime ASC`）+ 增删；详情仅名称与创建/更新时间。
- 删除分类不做任何关联处理（R6 改为 ON DELETE SET NULL）。

### 6.5 桌面宠物 / 任务气泡 / 托盘【移除】

v0.2 范围变更：三者在迁移中忽略（R4）。源实现要点（窗口规格、`task_bubble_window_service.dart` 的预热/握手/竞态/节流状态机、跨窗口消息协议、托盘事件处理）不再展开，规格存档于本文档 git 历史的 v0.1 附录 B，如将来重启此功能可直接取用。连带影响：

- `findTodayUnfinished` DAO 方法失去唯一消费方，不迁移（§4.4）。
- 托盘菜单"复制 MCP 地址"本已随 R3 失去意义，不再有此问题。
- `images/desktop_pet.png`、`images/logo.ico` 等资源不迁移。

### 6.6 单实例 / 退出流程

- 单实例：Flutter 层 + 原生 FindWindow 双保险。宿主级事项（Q8），不属模块范围。
- 退出顺序见 §5.9。

### 6.7 MCP 服务器（源项目的差异化功能）

- `StreamableMcpServer(host 127.0.0.1, port 8765, path /mcp)`，仅第一实例启动，端口占用不阻断应用（错误进托盘对话框）；无鉴权、无 Origin 校验（源项目明确声明此安全边界）。
- 5 个 tool：`list_todos` / `get_todo` / `update_todo_status` / `list_categories` / `list_progress`，参数 schema、annotations（readOnly / idempotent）与统一分页结构 `{items, page, pageSize, hasMore}` 见附录 B。
- 架构上 `TodoMcpDataSource`（5 方法）隔离数据层 → **迁移时这个接口直接演化为模块的 runtime 服务层**，能力注册与页面服务都从它派生。

### 6.8 状态管理与刷新机制（重写指导）

源的机制是"ChangeNotifier 信号弹 + 直调 DAO + FutureBuilder 重查"，含两处 hack：列表内隐藏高度为 0 的 `Consumer<RefreshNotifier>` 在 build 阶段触发 `controller.refresh()`；进度用 `Consumer<ProgressNotifier>` 包 `FutureBuilder` 重建。**这些在 React 中全部不需要**：对应物是页面状态机 + mutation 后 refetch（card-note `CardNotePage` 的视图状态机模式）。`PrefetchScrollListViewController` 的分页语义（§6.1）保留，实现为 React hook（IntersectionObserver 或滚动监听）。

## 7. UI 页面与交互清单

| 源 UI                               | 目标（modules/todo/ui/）                       | 组件映射                                                                                                         |
| ----------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 主页面（NavigationRail：全部/分类） | `TodoPage` 单页，内部 `Tabs` 切换"任务 / 分类" | `@reisa/ui` Tabs；页面不设标题区（v0.4 实施期调整：移除 PageHeading，"新建待办"按钮入任务视图工具栏，与分类视图对齐） |
| 搜索栏组件                          | 任务/分类视图顶部搜索行                        | `Icon` search + 原生 input + `IconButton`                                                                        |
| 过滤栏                              | 状态下拉 + 分类可搜索下拉 + 重置               | `Field` + 局部实现（可搜索下拉源无现成组件，Q5）                                                                 |
| 待办列表/列表项                     | 任务视图分页列表                               | `EmptyState`（空态）、状态图标用 `Icon` check/cancel                                                             |
| 待办详情/编辑                       | `Dialog`（或视图切换）表单                     | `Field`、`Button`；截止时间选择器用第三方组件（Q5 已定，候选 react-datepicker）                                  |
| 进度区块                            | 详情表单内进度列表                             | 勾选 + `IconButton` trash                                                                                        |
| 分类列表/详情/选择弹窗              | 分类视图 + `Dialog`                            | 同上                                                                                                             |
| 自绘标题栏（36px）                  | **不迁移**                                     | 模块页面在宿主工作区内渲染                                                                                       |
| 桌面宠物页 / 任务气泡页             | **不迁移**（R4）                               | —                                                                                                                |
| SnackBar                            | `ModulePageProps.notify()`                     | 宿主提供的通知通道                                                                                               |

样式：`@reisa/ui` tokens + 模块局部 CSS（`TodoPage.css` 等，类名 `todo-` 前缀），与 card-note 相同。

manifest 登记：`navigation: { icon: 'list', aliases: ['Todo','待办','任务'], keywords: [...] }`（`list` 图标已存在于 `@reisa/ui` Icon 映射；若需更贴切的图标可扩展共享包映射）。`capabilities` 自 M3 起登记 5 个能力；v1 无设置面板（Q3/Q4 已决后无配置项，后续需要再补 `settings`）。

## 8. 测试资产清单

| 源测试                            | 行数 | 内容                                                                                                                                      | 迁移参考价值                                     |
| --------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `test/todo_mcp_server_test.dart`  | 228  | `_FakeDataSource` 注入 + 起真实 HTTP server 裸发 JSON-RPC，验证 5 工具 schema/annotations、update 语义、不存在 id 返回 null、UTC ISO 时间 | **高**：工具行为断言清单可整体搬为能力层测试用例 |
| `test/desktop_pet_page_test.dart` | 80   | 宠物单击/双击时序、气泡空态                                                                                                               | 无（功能移除，R4）                               |
| `test/lang_test.dart`             | 10   | 状态枚举往返                                                                                                                              | 低（顺带）                                       |
| `test/widget_test.dart`           | 14   | 无断言                                                                                                                                    | 无                                               |

DAO/分页/数据库层**无测试覆盖**。目标模块按 card-note 模式补：`database.test.mjs`（:memory:）、`runtime.test.mjs`（真实 ModuleHost + registerPageService 全链路）、`capabilities.test.mjs`（对齐源 MCP 测试断言清单）。注册到根 `package.json` test 脚本（§10.4）。

## 9. 设计文档与实现的偏差（迁移以代码为准）

| #   | 文档说法                                                                                               | 代码实际                                                                      | 处置                                     |
| --- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | `_doc/design.md`：多级树形分类、分类逐层下钻浏览                                                       | `parentCategoryId` 从未在 UI/查询使用                                         | R5 不迁移                                |
| 2   | `_doc/design.md`：三表 id 计划为 String                                                                | 实现均为 INTEGER 自增                                                         | 以代码为准（新库 DDL 亦为 INTEGER 自增） |
| 3   | `_doc/desktop_pet_flutter_implementation.md`：宠物动画状态机（idle/hover/dragging/notifying/sleeping） | 未实现，静态图片                                                              | 随 R4 不适用                             |
| 4   | `_doc/desktop_pet_flutter_implementation.md`：无截止时间的任务不进"今日未完成"气泡                     | `findTodayUnfinished` 含 `deadlineTime.isNull()` 分支，无截止时间**会进**气泡 | 事实存档；功能随 R4 移除                 |
| 5   | README：MCP 地址可复制                                                                                 | 仅托盘入口，端口占用时对话框显示错误                                          | 迁移后随 R3/R4 消失                      |

## 10. 宿主模块系统对接分析

### 10.1 宿主现状结论

- 模块接入的最小改动集已由 card-note/knowledge 验证：**两个组合根各加一行**（`apps/desktop/src/composition/modules.ts` 的 `modules` 清单 + `composition/runtime.ts` 的 `RUNTIME_MODULES`）+ 包本身 + 根 `package.json` test glob。
- 页面服务通道 `reisa/module/page`（受限 IPC，`host.runTracked` 跟踪、停用即取消）、`reisa/module/pickPath` / `pickSavePath`、`reisa/module/config/*`、模块状态推送 `reisa/module/state`、设置弹窗内嵌——全部就绪，todo 模块直接复用。
- 动作契约模式沿用 card-note 的**更新版本**：`contracts.ts` 集中 `PAGE_ACTIONS`（snake_case）与全部 DTO（`type` 而非 `interface`，可直接赋给 `JsonValue`），页面服务载荷逐字段显式转换，返回值以 DTO 类型收口。
- 存储：`app-data/modules/todo/`（`ModuleContext.storage.dataDir`），数据库 `todo.sqlite`，配置 `settings.json`（经 `ModuleConfigScope`）。模块**不得** import `@reisa/foundation`（边界白名单只有 `@reisa/module-sdk` 与 `@reisa/ui`）。
- 页面挂载：宿主工作区常驻挂载 + `hidden` 切换；SPA 无路由库，页面内部自管视图状态。

### 10.2 宿主缺口结论：无

R4 收缩范围后，todo 模块**不需要任何宿主扩展**：

- 无独立窗口/托盘需求 → 不需要 v0.1 设计的"模块独立窗口机制"（module-sdk `overlayWindows` + AppShell module-window 分支）与 `TodoDesktopHost` 桥接；模块 runtime 不 import `electron`，纯 Node 可测天然成立（card-note 同款约束，无额外成本）。
- 无原生依赖 → 不触碰 `electron-builder.yml` / `build-electron.mjs` / `pnpm-workspace allowBuilds`（v0.1 的托盘图标打包风险随之消失）。
- 数据库/配置/文件选择/通知全部走既有 `ModuleContext` 与受限 IPC 通道。

### 10.3 迁移映射表（源 → 目标）

| 源                                          | 目标（modules/todo/）                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 表定义 + DAO + DTO + mapper + query_builder | `runtime/database.ts`（node:sqlite + transaction）+ `runtime/repository.ts` + `domain/`（校验、状态枚举、过滤→SQL 规则）    |
| `TodoMcpDataSource` 5 方法                  | `runtime/service.ts`（页面服务与能力共用的服务层）                                                                          |
| `todo_mcp_server.dart` 工具定义             | `runtime/capabilities.ts`（`defineCapability` × 5，TypeBox schema，附录 B）                                                 |
| `contracts.ts`（新建）                      | MODULE_ID='todo'、PAGE_ACTIONS、DTO                                                                                         |
| `manifest.ts`（新建）                       | ModuleContribution：navigation + capabilities                                                                               |
| todo_thing / category / progress Widget     | `ui/TodoPage.tsx`、`ui/TasksView.tsx`、`ui/CategoriesView.tsx`、`ui/TodoDetailDialog.tsx`、`ui/CategorySelectDialog.tsx` 等 |
| `ui/client.ts`（新建）                      | `callPage<T>` 类型化封装，从 contracts 再导出 DTO                                                                           |
| DateTimeUtils                               | `domain/format.ts`                                                                                                          |
| provider notifiers / prefetch controller    | React 状态 + refetch + 分页 hook（§6.8，不逐文件对应）                                                                      |
| desktop_pet / platform / main.dart 窗口编排 | **不迁移**（R4）                                                                                                            |

### 10.4 宿主必改清单

实施后的实际改动（v0.4 核对）：

1. `apps/desktop/src/composition/modules.ts`：追加 `todoManifest`。✅
2. `apps/desktop/src/composition/runtime.ts`：`RUNTIME_MODULES` 追加 todo 条目（工厂选项仅 `registerPageService`，与 card-note 完全一致）。✅
3. 根 `package.json`：test 脚本追加 `modules/todo/test/*.test.mjs`。✅
4. `apps/desktop/package.json`：devDependencies 追加 `@reisa/module-todo: workspace:*`（§10.1 遗漏项——宿主以包依赖方式引用模块，与 card-note/knowledge 同样登记）。✅
5. `apps/desktop/test/e2e-chain.test.mjs`：端到端测试的期望能力清单追加 5 个 `todo/*` 能力。✅

除上述五处登记外，宿主零改动（v0.1 清单中的 module-sdk/AppShell/electron-builder 改动随 R4 取消）。

## 11. 迁移策略建议

1. **TS 重写而非嵌入**（R1 已论证）。源项目"Widget 直调 DAO"的结构反而降低迁移风险：需要保真的是 §5 的业务规则与 §4 的 schema 语义，而不是代码结构。
2. **服务层先行**：以 `TodoMcpDataSource` 的 5 方法为种子建 `runtime/service.ts`，页面服务与 Agent 能力都从它派生，保证"MCP 里能做的，页面上也能做；页面上能做的，Agent 也能做"（源 MCP 全部工具中仅 `update_todo_status` 为写操作，能力层 v1 同样只开放这 5 个动作，管理面动作只走页面服务——安全分层同 card-note 决策）。
3. **保真原则**：UI/文案/交互以源代码为准；R6 列出的缺陷修复是唯一有意的行为差异，每处都必须记录在本档或 PR 描述。
4. **纯 Node 可测**：`createTodoRuntime` 无任何 electron 依赖（R4 收缩后自然成立），测试完全在纯 Node 下装配（card-note 同款模式）。
5. **旧库不做导入**（Q3 已决）：源应用数据保留在 `getApplicationDocumentsDirectory()/zst_todo_tools/` 原处，不受迁移影响；孤儿数据问题在新库中由外键约束从源头避免（R6②）。

## 12. 分阶段迁移路线

| 阶段             | 内容                                                                                                                                                                                       | 验收                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| M0 骨架 + 数据层 | 包骨架（package.json/contracts/manifest/index/runtime/ui 占位）；`database.ts` DDL（附录 A）+ repository + domain（校验/枚举/查询规则）；组合根两处注册 + test glob；`TodoPage` 渲染空状态 | `pnpm test` / `typecheck` / `check:boundaries` 全绿；页面在宿主侧边栏出现且可打开；database/runtime 测试通过 |
| M1 任务域 CRUD   | 页面服务动作（save/get/delete/status/progress/category 全套）；TasksView 列表 + 详情 Dialog + 进度区块 + 分类 Tab + 分类选择弹窗；中文校验消息对齐 §5.1                                    | 手动走查源应用全部交互路径；runtime 全链路测试（激活/停用/数据保留/级联删除）通过                            |
| M2 过滤与分页    | searchKey/status/categoryId 过滤、可搜索分类下拉、分页 hook（含 hasMore 修复）、空态/加载态                                                                                                | 过滤组合行为与源一致；分页边界（空页/尾页）测试                                                              |
| M3 Agent 能力    | 5 个 `defineCapability`（TypeBox schema、分页约定、错误码）；会话内验证                                                                                                                    | 宿主会话中 Agent 可列出/查询/改状态待办；能力测试对齐源 MCP 测试断言清单                                     |
| M4 收尾          | 行为差异清单核对（R6）；全量回归；文档更新定稿                                                                                                                                             | 全量 `pnpm test` / `test:desktop` / `dist` 通过；实现行为与本文档记录一致                                    |

**实施状态（v0.4，2026-10-06）：M0–M4 全部完成。** 验收结果：模块测试 18/18 通过；全仓 `pnpm test` 247/247；`pnpm typecheck` / `pnpm check:boundaries` 通过；`pnpm --filter @reisa/desktop build` 成功；`pnpm test:desktop` 冒烟通过（真实主进程三模块全部 active，能力清单含全部 5 个 `todo/*`）。

全程不触碰 module-sdk 与宿主 renderer 代码；宿主侧改动仅为 §10.4 的五处登记（v0.4 核对），M0 一次完成。

## 13. 待决策问题清单

| #   | 问题                       | 选项与建议                                                                                   | 状态               |
| --- | -------------------------- | -------------------------------------------------------------------------------------------- | ------------------ |
| Q1  | 模块 id 与命名             | 采纳建议：`todo`（包 `@reisa/module-todo`，目录 `modules/todo`），数据库 `todo.sqlite`       | 已定（2026-10-06） |
| Q2  | ~~托盘是否保留~~           | 随 R4（2026-10-06）取消：托盘不迁移                                                          | 已决               |
| Q3  | 旧库一次性导入             | 不做导入，旧应用数据保留在原处不受迁移影响                                                   | 已决（2026-10-06） |
| Q4  | EXPIRED 状态               | 保持源行为：无自动超时、无展示层超时计算，仅手工设置                                         | 已定（2026-10-06） |
| Q5  | 日期时间选择器             | 方案 b：引入第三方库——`react-datepicker@^8`（M1 已落地，含时间选择与清除）                   | 已定（2026-10-06） |
| Q6  | 外部 MCP 客户端接入        | 不做任何 MCP 协议服务；Agent 访问待办一律经宿主能力注册中心（`todo/*` 能力）                 | 已决（2026-10-06） |
| Q7  | ~~主窗口最小化收起为宠物~~ | 随 R4（2026-10-06）取消                                                                      | 已决               |
| Q8  | 单实例锁                   | 宿主级事项（Electron `requestSingleInstanceLock`），不属模块范围；如宿主尚未启用建议另行提出 | 待确认（宿主侧）   |

---

## 14. 实施记录（v0.4）

### 14.1 交付物

```text
modules/todo/
  package.json / index.ts / contracts.ts / manifest.ts
  domain/    todo-state.ts（状态枚举）、validation.ts（校验与中文消息）、query.ts（过滤→SQL 规则）
  runtime/   database.ts（node:sqlite + 附录 A DDL + transaction）、service.ts（服务层）、
             tools.ts（5 个 ToolRegistration 构造）、index.ts（TodoRuntime + 页面服务分发）
  ui/        TodoPage.tsx（Tabs：任务/分类 + 详情弹窗状态机）、TasksView.tsx（搜索/过滤/分页/状态切换）、
             CategoriesView.tsx、TodoDetailDialog.tsx（react-datepicker + 进度区块）、
             CategorySelectDialog.tsx、ProgressSection.tsx、PromptDialog.tsx、client.ts、format.ts、TodoPage.css
  test/      database.test.mjs（9）、runtime.test.mjs（5）、capabilities.test.mjs（4）
```

实施期确认的选型：日期时间选择器用 `react-datepicker@^8`（Q5 落定）；TypeBox 能力 Schema 放 `contracts.ts`（renderer 安全，knowledge 同款），runtime 仅构造 ToolRegistration。

### 14.2 实现期行为差异（相对源项目，全部有意为之）

| #   | 差异                                                               | 说明                                                                                  |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 1   | 新建待办 title 去空白后非空                                        | 源仅校验非 null，空串标题可入库；迁移按"标题不得为空"的字面语义收紧（§5.1）           |
| 2   | 更新不存在的待办/分类抛"不存在或已被删除"                          | 源静默无操作；card-note 同款错误语义，便于 UI 提示                                    |
| 3   | add_progress 先校验待办存在                                        | 源无外键会产生孤儿进度（§5.8）；新库显式校验给出可读错误                              |
| 4   | categoryName 改用 SQL LEFT JOIN                                    | 源为内存 map join，输出语义完全一致（分类缺失 → null）                                |
| 5   | 分页 hasMore 以查询 pageSize+1 判定                                | R6① 修复项                                                                            |
| 6   | 排序追加 id tiebreak（todo: id DESC / category、progress: id ASC） | 源同值排序不确定，仅作稳定化，可观察行为不变                                          |
| 7   | 列表状态徽标为"状态文字"按钮（非源图标）                           | 交互语义一致（点击切换，§5.5）；视觉映射到 @reisa/ui 体系                             |
| 8   | Agent 改状态不实时推送已打开的页面                                 | 页面无轮询；切换 Tab / 下次刷新可见（v1 已知限制，如需可复用 card-note 5 秒轮询决策） |
| 9   | 删除进度/删除待办无二次确认差异                                    | 待办删除有 window.confirm（进度在源中亦无确认，保持一致不确认）                       |

### 14.3 遗留事项

- 旧库（`zst_todo_tools/*/app_database.sqlite`）不导入（Q3 已决），原地保留。
- Q8（宿主单实例锁）仍为宿主级待办，不阻塞本模块。
- 如后续需要"任务气泡"式的 Agent 主动提醒，可基于 §5.5 的 findTodayUnfinished 语义（v0.1 存档）扩展为宿主通知，不在模块 v1 范围。

全程不触碰 module-sdk 与宿主 renderer 代码；宿主侧改动仅有 §10.4 的三处登记，M0 一次完成。

---

## 附录 A：迁移目标库 DDL 草案（node:sqlite）

表名从 `todo_thing`/`todo_thing_progress` 简化为 `todo`/`todo_progress`（新库无历史包袱）；时间统一 **UTC 毫秒**；补外键/级联/索引（R6）。`PRAGMA foreign_keys = ON`，事务用 card-note 同款 `transaction<T>`（BEGIN IMMEDIATE）。

```sql
CREATE TABLE category (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  create_time INTEGER NOT NULL,             -- UTC ms
  update_time INTEGER NOT NULL              -- UTC ms
);

CREATE TABLE todo (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT    NOT NULL,
  detail       TEXT,
  status       INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0, 1, 2, 3)),
  category_id  INTEGER REFERENCES category(id) ON DELETE SET NULL,
  create_time  INTEGER NOT NULL,
  deadline_time INTEGER,
  update_time  INTEGER NOT NULL
);
CREATE INDEX idx_todo_status   ON todo(status);
CREATE INDEX idx_todo_category ON todo(category_id);
CREATE INDEX idx_todo_deadline ON todo(deadline_time);

CREATE TABLE todo_progress (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id     INTEGER NOT NULL REFERENCES todo(id) ON DELETE CASCADE,
  content     TEXT    NOT NULL,
  create_time INTEGER NOT NULL,
  is_finished INTEGER NOT NULL DEFAULT 0,
  update_time INTEGER NOT NULL
);
CREATE INDEX idx_progress_todo ON todo_progress(todo_id);
```

状态码 0–3 与源库一致（NOT_START/EXECUTING/FINISHED/EXPIRED），旧库导入无需映射；`parent_category_id` 不迁移（R5）。

## 附录 B：MCP 工具 → 模块能力映射

能力 id = `todo/<action>`，提交给模型的工具名 = `todo__<action>`（module-sdk `defineCapability` 自动生成）。schema 用 TypeBox `Type.Object`（knowledge 先例，宿主做完整校验）。分页约定与源 MCP 完全一致：`page ≥ 1` 默认 1、`pageSize 1–100` 默认 20、结果 `{items, page, pageSize, hasMore}`、时间 UTC ISO 8601 字符串。

| 源 MCP tool          | 目标能力                  | 输入要点                                                          | 语义                                      |
| -------------------- | ------------------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| `list_todos`         | `todo/list_todos`         | `page?`、`pageSize?`、`searchKey?`、`status?`(0–3)、`categoryId?` | 分页查待办（含 categoryName、statusText） |
| `get_todo`           | `todo/get_todo`           | `id` 必填                                                         | 单条；不存在返回 `{todo: null}`           |
| `update_todo_status` | `todo/update_todo_status` | `id`、`status`(0–3)                                               | 更新后回读返回（源标注 idempotent）       |
| `list_categories`    | `todo/list_categories`    | `page?`、`pageSize?`、`searchKey?`                                | 分页查分类                                |
| `list_progress`      | `todo/list_progress`      | `todoId` 必填、`page?`、`pageSize?`                               | 按 todoId 分页查进度                      |

源 annotations（readOnly 等）在 module-sdk `CapabilityDefinition` 中无对应字段，v1 不承载；输出 schema（`outputSchema`）可选，建议为 5 个能力补齐以利会话内渲染。

---

> 维护约定：实施过程中对本文档的修正以小版本号递增（v0.x），行为差异一律记入 R6 或 §9，不留未记录的偏差。
