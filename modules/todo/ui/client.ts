/**
 * 待办页面服务客户端（renderer 侧）。
 * 结构化访问宿主受限通道 window.reisa.modulePage；
 * 不导入宿主代码（边界检查：模块 UI 只依赖 SDK 与共享 UI 包）。
 * DTO 类型单一来源于 ../contracts.ts（runtime 侧同源），此处只做类型化调用与再导出。
 */
import { MODULE_ID, PAGE_ACTIONS, type PageAction } from '../contracts.ts';
import type {
  AddedProgressJson,
  CategoryJson,
  CategoryListJson,
  DeletedResultJson,
  ModulePageResult,
  ProgressJson,
  ProgressListJson,
  SavedCategoryJson,
  SavedTodoJson,
  TodoJson,
  TodoListJson,
  UpdatedProgressJson,
  UpdatedStatusJson,
} from '../contracts.ts';

/** 页面服务 DTO 的公开再导出：ui 组件沿用从 client 取类型的既有导入路径。 */
export type {
  AddedProgressJson,
  CategoryJson,
  CategoryListJson,
  DeletedResultJson,
  ProgressJson,
  ProgressListJson,
  SavedCategoryJson,
  SavedTodoJson,
  TodoJson,
  TodoListJson,
  TodoStatus,
  UpdatedProgressJson,
  UpdatedStatusJson,
} from '../contracts.ts';

interface ModulePageBridge {
  invoke<T>(moduleId: string, action: string, input?: unknown): Promise<ModulePageResult<T>>;
}

function bridge(): ModulePageBridge | undefined {
  return (window as unknown as { reisa?: { modulePage?: ModulePageBridge } }).reisa?.modulePage;
}

export function pageBridgeAvailable(): boolean {
  return bridge() !== undefined;
}

async function callPage<T>(action: PageAction, input?: unknown): Promise<T> {
  const client = bridge();
  if (client === undefined) {
    throw new Error('页面服务仅在桌面应用内可用');
  }
  const result = await client.invoke<T>(MODULE_ID, action, input);
  if (!result.ok || result.error !== undefined) {
    throw new Error(result.error?.message ?? '页面服务调用失败');
  }
  return result.value as T;
}

/** 渲染侧错误提示统一出口。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- 类型化页面服务方法（DTO 见 ../contracts.ts） ----

export interface TodoListInput {
  page?: number;
  pageSize?: number;
  searchKey?: string | null;
  status?: number | null;
  categoryId?: number | null;
}

export const listTodos = (input: TodoListInput = {}) =>
  callPage<TodoListJson>(PAGE_ACTIONS.listTodos, input);
export const getTodo = (id: number) => callPage<TodoJson | null>(PAGE_ACTIONS.getTodo, { id });
export const saveTodo = (input: {
  todoId: number | null;
  title: string;
  detail: string | null;
  status?: number | null;
  categoryId: number | null;
  deadlineTime: number | null;
}) => callPage<SavedTodoJson>(PAGE_ACTIONS.saveTodo, input);
export const updateTodoStatus = (id: number, status: number) =>
  callPage<UpdatedStatusJson | null>(PAGE_ACTIONS.updateTodoStatus, { id, status });
export const deleteTodo = (id: number) =>
  callPage<DeletedResultJson>(PAGE_ACTIONS.deleteTodo, { id });

export const listCategories = (
  input: { page?: number; pageSize?: number; searchKey?: string | null } = {},
) => callPage<CategoryListJson>(PAGE_ACTIONS.listCategories, input);
export const saveCategory = (input: { categoryId: number | null; name: string }) =>
  callPage<SavedCategoryJson>(PAGE_ACTIONS.saveCategory, input);
export const deleteCategory = (id: number) =>
  callPage<DeletedResultJson>(PAGE_ACTIONS.deleteCategory, { id });

export const listProgress = (todoId: number) =>
  callPage<ProgressListJson>(PAGE_ACTIONS.listProgress, { todoId });
export const addProgress = (todoId: number, content: string) =>
  callPage<AddedProgressJson>(PAGE_ACTIONS.addProgress, { todoId, content });
export const updateProgressFinished = (id: number, isFinished: boolean) =>
  callPage<UpdatedProgressJson>(PAGE_ACTIONS.updateProgressFinished, { id, isFinished });
export const deleteProgress = (id: number) =>
  callPage<DeletedResultJson>(PAGE_ACTIONS.deleteProgress, { id });
