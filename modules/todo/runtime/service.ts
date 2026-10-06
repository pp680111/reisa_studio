import {
  type AddedProgressJson,
  type CategoryJson,
  type CategoryListJson,
  type DeletedResultJson,
  type ProgressJson,
  type ProgressListJson,
  type SavedCategoryJson,
  type SavedTodoJson,
  type TodoJson,
  type TodoListJson,
  type TodoStatus,
  type UpdatedProgressJson,
  type UpdatedStatusJson,
} from '../contracts.ts';
import type { TodoFilter } from '../domain/query.ts';
import { todoStateFromKey, todoStateText } from '../domain/todo-state.ts';
import {
  validateCategoryName,
  validateDeadlineTime,
  validateProgressContent,
  validateTodoTitle,
} from '../domain/validation.ts';
import {
  DomainError,
  TodoDatabase,
  type CategoryRow,
  type ProgressRow,
  type TodoRowWithCategory,
} from './database.ts';

/**
 * 待办服务层（迁移自 todo_manage `TodoMcpDataSource` 接口及其 DAO 直调面）：
 * 页面服务与 Agent 能力共用的业务入口，输入一律视为不可信并在此校验
 * （迁移设计文档 §11.2：MCP 里能做的，页面上也能做；页面上能做的，Agent 也能做）。
 */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export function clampPage(page: unknown): number {
  const parsed = Number(page);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

export function clampPageSize(pageSize: unknown): number {
  const parsed = Number(pageSize);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

function normalizeStatus(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  return todoStateFromKey(Number(raw)).key;
}

function normalizeCategoryId(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DomainError('分类参数值类型错误');
  }
  return parsed;
}

export interface SaveTodoInput {
  /** 不可信载荷：null/undefined/'' 视为新建，其余经 requireTodoId 收敛。 */
  readonly todoId: unknown;
  readonly title: unknown;
  readonly detail: unknown;
  /** 仅编辑态提交；新建固定 NOT_START（源 _initDefValForFormMap 覆盖语义）。 */
  readonly status?: unknown;
  readonly categoryId: unknown;
  readonly deadlineTime: unknown;
}

export class TodoService {
  readonly #database: TodoDatabase;

  constructor(database: TodoDatabase) {
    this.#database = database;
  }

  // ---- 待办 ----

  listTodos(input: {
    page?: unknown;
    pageSize?: unknown;
    searchKey?: unknown;
    status?: unknown;
    categoryId?: unknown;
  }): TodoListJson {
    const filter: TodoFilter = {
      searchKey:
        typeof input.searchKey === 'string' && input.searchKey.trim() !== ''
          ? input.searchKey.trim()
          : null,
      status: normalizeStatus(input.status),
      categoryId: normalizeCategoryId(input.categoryId),
    };
    const page = clampPage(input.page);
    const pageSize = clampPageSize(input.pageSize);
    const { items, hasMore } = this.#database.pageTodos(page, pageSize, filter);
    return { items: items.map((row) => toTodoJson(row)), page, pageSize, hasMore };
  }

  getTodo(id: unknown): TodoJson | null {
    const row = this.#database.getTodoById(requireTodoId(id));
    return row === null ? null : toTodoJson(row);
  }

  saveTodo(input: SaveTodoInput): SavedTodoJson {
    const title = validateTodoTitle(String(input.title ?? ''));
    const detail =
      input.detail === undefined || input.detail === null ? null : String(input.detail);
    const categoryId = normalizeCategoryId(input.categoryId);
    const deadlineTime = validateDeadlineTime(input.deadlineTime);
    if (input.todoId === undefined || input.todoId === null || input.todoId === '') {
      const created = this.#database.insertTodo({ title, detail, categoryId, deadlineTime });
      return { id: created.id };
    }
    const todoId = requireTodoId(input.todoId);
    // 编辑态状态下拉仅编辑态出现；未提交时保留原状态。
    const status = normalizeStatus(input.status);
    this.#database.updateTodo({
      id: todoId,
      title,
      detail,
      status,
      categoryId,
      deadlineTime,
    });
    return { id: todoId };
  }

  /** 切换状态（源 updateState 语义：不刷 updateTime）；待办不存在返回 null。 */
  setTodoStatus(id: unknown, status: unknown): UpdatedStatusJson | null {
    const statusKey = todoStateFromKey(Number(status)).key;
    const todoId = requireTodoId(id);
    if (!this.#database.updateTodoStatus(todoId, statusKey)) {
      return null;
    }
    return { id: todoId, status: statusKey, statusText: todoStateText(statusKey) };
  }

  deleteTodo(id: unknown): DeletedResultJson {
    if (!this.#database.deleteTodoById(requireTodoId(id))) {
      throw new DomainError('待办不存在或已被删除');
    }
    return { deleted: true };
  }

  // ---- 分类 ----

  listCategories(input: {
    page?: unknown;
    pageSize?: unknown;
    searchKey?: unknown;
  }): CategoryListJson {
    const page = clampPage(input.page);
    const pageSize = clampPageSize(input.pageSize);
    const searchKey =
      typeof input.searchKey === 'string' && input.searchKey.trim() !== ''
        ? input.searchKey.trim()
        : null;
    const { items, hasMore } = this.#database.pageCategories(page, pageSize, searchKey);
    return { items: items.map(toCategoryJson), page, pageSize, hasMore };
  }

  saveCategory(input: { categoryId: unknown; name: unknown }): SavedCategoryJson {
    const name = validateCategoryName(String(input.name ?? ''));
    const categoryId = input.categoryId;
    if (categoryId === undefined || categoryId === null || categoryId === '') {
      const created = this.#database.insertCategory(name);
      return { id: created.id };
    }
    const updated = this.#database.updateCategory(requireId(categoryId, '分类'), name);
    return { id: updated.id };
  }

  deleteCategory(id: unknown): DeletedResultJson {
    if (!this.#database.deleteCategoryById(requireId(id, '分类'))) {
      throw new DomainError('分类不存在或已被删除');
    }
    return { deleted: true };
  }

  // ---- 进度 ----

  /** 详情页进度区块：全量列表（源 getProgress，未完成在前）。 */
  listProgress(input: { todoId: unknown }): ProgressListJson {
    const todoId = requireTodoId(input.todoId);
    return { items: this.#database.getProgressByTodo(todoId).map(toProgressJson) };
  }

  /** 能力层专用：分页版进度查询（源 MCP list_progress / pageForTodo）。 */
  pageProgress(input: { todoId: unknown; page?: unknown; pageSize?: unknown }): {
    items: ProgressJson[];
    page: number;
    pageSize: number;
    hasMore: boolean;
  } {
    const todoId = requireTodoId(input.todoId);
    const page = clampPage(input.page);
    const pageSize = clampPageSize(input.pageSize);
    const { items, hasMore } = this.#database.pageProgressByTodo(todoId, page, pageSize);
    return { items: items.map(toProgressJson), page, pageSize, hasMore };
  }

  addProgress(input: { todoId: unknown; content: unknown }): AddedProgressJson {
    const todoId = requireTodoId(input.todoId);
    const content = validateProgressContent(String(input.content ?? ''));
    // 源无外键校验会产生孤儿进度；新库先显式确认待办存在，给出可读错误（R6②）。
    if (this.#database.getTodoById(todoId) === null) {
      throw new DomainError('待办不存在或已被删除');
    }
    const created = this.#database.insertProgress(todoId, content);
    return { id: created.id };
  }

  setProgressFinished(id: unknown, isFinished: unknown): UpdatedProgressJson {
    const progressId = requireId(id, '进度');
    if (typeof isFinished !== 'boolean') {
      throw new DomainError('完成标记类型错误');
    }
    return { updated: this.#database.updateProgressFinished(progressId, isFinished) };
  }

  deleteProgress(id: unknown): DeletedResultJson {
    if (!this.#database.deleteProgressById(requireId(id, '进度'))) {
      throw new DomainError('进度不存在或已被删除');
    }
    return { deleted: true };
  }
}

// ---- 行 → 页面服务 DTO 序列化收口（返回类型绑定 contracts.ts，字段漂移编译期暴露） ----

export function toTodoJson(row: TodoRowWithCategory): TodoJson {
  const state = todoStateFromKey(row.status);
  return {
    id: row.id,
    title: row.title,
    detail: row.detail,
    status: state.key,
    statusText: state.text,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    deadlineTime: row.deadlineTime,
    createTime: row.createTime,
    updateTime: row.updateTime,
  };
}

export function toCategoryJson(row: CategoryRow): CategoryJson {
  return {
    id: row.id,
    name: row.name,
    createTime: row.createTime,
    updateTime: row.updateTime,
  };
}

export function toProgressJson(row: ProgressRow): ProgressJson {
  return {
    id: row.id,
    todoId: row.todoId,
    content: row.content,
    isFinished: row.isFinished,
    createTime: row.createTime,
    updateTime: row.updateTime,
  };
}

export function toTodoStatus(value: number): TodoStatus {
  return todoStateFromKey(value).key;
}

function requireTodoId(value: unknown): number {
  return requireId(value, '待办');
}

function requireId(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DomainError(`${label} ID 无效`);
  }
  return parsed;
}
