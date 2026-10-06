import { Type } from '@sinclair/typebox';
import { defineCapability } from '@reisa/module-sdk';

/**
 * 待办模块契约（迁移设计文档 §10.1）：动作常量、页面服务 DTO 与 Agent 能力 Schema 的单一真源。
 * 页面动作经宿主受限通道 `reisa/module/page` 访问 runtime 页面服务；
 * Agent 能力只开放源 MCP 的 5 个只读/改状态工具（R3），管理面动作绝不注册为能力
 * （知识库迁移设计文档 §5.3 安全分层）。
 *
 * DTO 一律用 type 而非 interface：类型别名的隐式索引签名使其可直接赋给 JsonValue，
 * 序列化边界不需要断言。
 */

export const MODULE_ID = 'todo';
export const MODULE_VERSION = '0.1.0';

/** 页面服务动作名（受限通道白名单的模块侧定义；对应源 DAO 方法面，§4.4）。 */
export const PAGE_ACTIONS = {
  listTodos: 'list_todos',
  getTodo: 'get_todo',
  saveTodo: 'save_todo',
  updateTodoStatus: 'update_todo_status',
  deleteTodo: 'delete_todo',
  listCategories: 'list_categories',
  saveCategory: 'save_category',
  deleteCategory: 'delete_category',
  listProgress: 'list_progress',
  addProgress: 'add_progress',
  updateProgressFinished: 'update_progress_finished',
  deleteProgress: 'delete_progress',
} as const;

export type PageAction = (typeof PAGE_ACTIONS)[keyof typeof PAGE_ACTIONS];

/** 待办状态 key（与源库 0–3 一致；语义见 domain/todo-state.ts）。 */
export type TodoStatus = 0 | 1 | 2 | 3;

// ---- 页面服务 DTO（ui 与 runtime 共享的真源；时间为 UTC 毫秒） ----

/** 受限通道返回封装（宿主 preload 注入的调用结果）。 */
export type ModulePageResult<T> = {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string };
};

export type TodoJson = {
  id: number;
  title: string;
  detail: string | null;
  status: TodoStatus;
  statusText: string;
  categoryId: number | null;
  categoryName: string | null;
  deadlineTime: number | null;
  createTime: number;
  updateTime: number;
};

export type CategoryJson = {
  id: number;
  name: string;
  createTime: number;
  updateTime: number;
};

export type ProgressJson = {
  id: number;
  todoId: number;
  content: string;
  isFinished: boolean;
  createTime: number;
  updateTime: number;
};

/** 分页封装：页码从 1，hasMore 以"查询 pageSize+1 条"判定（R6①：修复源"不足一页不置 false"缺陷）。 */
export type TodoListJson = {
  items: TodoJson[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};

export type CategoryListJson = {
  items: CategoryJson[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};

/** 详情页进度区块取全量（源 getProgress，未完成在前）；分页版仅能力层使用。 */
export type ProgressListJson = {
  items: ProgressJson[];
};

// 轻量动作回执也走契约：避免 ui 调用签名与 runtime 返回值各自内联字面量而静默漂移
export type SavedTodoJson = {
  id: number;
};

export type SavedCategoryJson = {
  id: number;
};

export type AddedProgressJson = {
  id: number;
};

export type UpdatedStatusJson = {
  id: number;
  status: TodoStatus;
  statusText: string;
};

export type UpdatedProgressJson = {
  updated: boolean;
};

export type DeletedResultJson = {
  deleted: true;
};

// ---- Agent 能力契约（附录 B；TypeBox Schema，宿主做完整校验） ----

/** 能力输出的待办时间字段为 UTC ISO 8601 字符串（§5.7，源 MCP 序列化语义）。 */
export const TodoItemSchema = Type.Object({
  id: Type.Integer(),
  title: Type.String(),
  detail: Type.Union([Type.String(), Type.Null()]),
  status: Type.Integer(),
  statusText: Type.String(),
  categoryId: Type.Union([Type.Integer(), Type.Null()]),
  categoryName: Type.Union([Type.String(), Type.Null()]),
  deadlineTime: Type.Union([Type.String(), Type.Null()]),
  createTime: Type.String(),
  updateTime: Type.String(),
});

export const CategoryItemSchema = Type.Object({
  id: Type.Integer(),
  name: Type.String(),
  createTime: Type.String(),
  updateTime: Type.String(),
});

export const ProgressItemSchema = Type.Object({
  id: Type.Integer(),
  todoId: Type.Integer(),
  content: Type.String(),
  isFinished: Type.Boolean(),
  createTime: Type.String(),
  updateTime: Type.String(),
});

function pagedSchema(item: ReturnType<typeof Type.Object>) {
  return Type.Object({
    items: Type.Array(item),
    page: Type.Integer(),
    pageSize: Type.Integer(),
    hasMore: Type.Boolean(),
  });
}

const ListTodosInput = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1, description: '页码，从 1 起' })),
  pageSize: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 100, default: 20, description: '每页条数，上限 100' }),
  ),
  searchKey: Type.Optional(Type.String({ description: '标题关键词过滤' })),
  status: Type.Optional(
    Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)], {
      description: '状态：0 未开始 / 1 执行中 / 2 已完成 / 3 已超时',
    }),
  ),
  categoryId: Type.Optional(Type.Integer({ minimum: 1, description: '按分类过滤' })),
});

const IdInput = Type.Object({
  id: Type.Integer({ minimum: 1, description: '待办 ID' }),
});

const UpdateStatusInput = Type.Object({
  id: Type.Integer({ minimum: 1, description: '待办 ID' }),
  status: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)], {
    description: '目标状态：0 未开始 / 1 执行中 / 2 已完成 / 3 已超时',
  }),
});

const ListCategoriesInput = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  searchKey: Type.Optional(Type.String({ description: '分类名关键词过滤' })),
});

const ListProgressInput = Type.Object({
  todoId: Type.Integer({ minimum: 1, description: '所属待办 ID' }),
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
});

export const todoListTodos = defineCapability(
  MODULE_ID,
  'list_todos',
  '分页查询待办事项，可按标题关键词、状态与分类过滤；结果含分类名与状态文案',
  { inputSchema: ListTodosInput, outputSchema: pagedSchema(TodoItemSchema) },
);

export const todoGetTodo = defineCapability(MODULE_ID, 'get_todo', '按 ID 查询单条待办详情', {
  inputSchema: IdInput,
  outputSchema: Type.Object({ todo: Type.Union([TodoItemSchema, Type.Null()]) }),
});

export const todoUpdateTodoStatus = defineCapability(
  MODULE_ID,
  'update_todo_status',
  '更新待办状态（未开始/执行中/已完成/已超时）并返回更新后的待办；待办不存在时 todo 为 null',
  {
    inputSchema: UpdateStatusInput,
    outputSchema: Type.Object({ todo: Type.Union([TodoItemSchema, Type.Null()]) }),
  },
);

export const todoListCategories = defineCapability(
  MODULE_ID,
  'list_categories',
  '分页查询待办分类，可按名称关键词过滤',
  { inputSchema: ListCategoriesInput, outputSchema: pagedSchema(CategoryItemSchema) },
);

export const todoListProgress = defineCapability(
  MODULE_ID,
  'list_progress',
  '分页查询指定待办的进度记录（未完成的在前）',
  { inputSchema: ListProgressInput, outputSchema: pagedSchema(ProgressItemSchema) },
);

export const TODO_CAPABILITIES = [
  todoListTodos,
  todoGetTodo,
  todoUpdateTodoStatus,
  todoListCategories,
  todoListProgress,
] as const;
