import type { JsonValue, ToolRegistration, ToolResult } from '@reisa/module-sdk';
import {
  TODO_CAPABILITIES,
  todoGetTodo,
  todoListCategories,
  todoListTodos,
  todoListProgress,
  todoUpdateTodoStatus,
  type CategoryJson,
  type ProgressJson,
  type TodoJson,
} from '../contracts.ts';
import { TodoValidationError } from '../domain/validation.ts';
import type { TodoService } from './service.ts';

/**
 * Agent 能力的 ToolRegistration 构造（附录 B）：定义来自 contracts.ts（renderer 安全的真源），
 * 此处只负责把服务层结果映射为能力输出并收敛错误码。
 * 能力输出时间为 UTC ISO 8601 字符串（§5.7，源 MCP 序列化语义）。
 */

function toIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function toCapabilityTodo(todo: TodoJson): JsonValue {
  return {
    id: todo.id,
    title: todo.title,
    detail: todo.detail,
    status: todo.status,
    statusText: todo.statusText,
    categoryId: todo.categoryId,
    categoryName: todo.categoryName,
    deadlineTime: toIso(todo.deadlineTime),
    createTime: toIso(todo.createTime),
    updateTime: toIso(todo.updateTime),
  };
}

function toCapabilityCategory(category: CategoryJson): JsonValue {
  return {
    id: category.id,
    name: category.name,
    createTime: toIso(category.createTime),
    updateTime: toIso(category.updateTime),
  };
}

function toCapabilityProgress(progress: ProgressJson): JsonValue {
  return {
    id: progress.id,
    todoId: progress.todoId,
    content: progress.content,
    isFinished: progress.isFinished,
    createTime: toIso(progress.createTime),
    updateTime: toIso(progress.updateTime),
  };
}

/** 领域校验错误 → INVALID_INPUT（可读中文消息）；其余异常交给宿主统一收敛 EXECUTION_FAILED。 */
async function asToolResult(invocationId: string, run: () => JsonValue): Promise<ToolResult> {
  try {
    return { status: 'success', value: run() };
  } catch (error) {
    if (error instanceof TodoValidationError) {
      return {
        status: 'error',
        error: { code: 'INVALID_INPUT', message: error.message, invocationId, retryable: false },
      };
    }
    throw error;
  }
}

export function buildTodoTools(service: TodoService): ToolRegistration[] {
  const registrations: ToolRegistration[] = [
    {
      definition: todoListTodos,
      execute: (rawInput, context) =>
        asToolResult(context.invocationId, () => {
          const input = (rawInput ?? {}) as Record<string, unknown>;
          const result = service.listTodos(input);
          return {
            items: result.items.map(toCapabilityTodo),
            page: result.page,
            pageSize: result.pageSize,
            hasMore: result.hasMore,
          };
        }),
    },
    {
      definition: todoGetTodo,
      execute: (rawInput, context) =>
        asToolResult(context.invocationId, () => {
          const input = (rawInput ?? {}) as Record<string, unknown>;
          const todo = service.getTodo(input['id']);
          return { todo: todo === null ? null : toCapabilityTodo(todo) };
        }),
    },
    {
      definition: todoUpdateTodoStatus,
      execute: (rawInput, context) =>
        asToolResult(context.invocationId, () => {
          const input = (rawInput ?? {}) as Record<string, unknown>;
          // 源 MCP 语义：更新后回读返回；待办不存在时 todo 为 null。
          const updated = service.setTodoStatus(input['id'], input['status']);
          if (updated === null) {
            return { todo: null };
          }
          const todo = service.getTodo(updated.id);
          return { todo: todo === null ? null : toCapabilityTodo(todo) };
        }),
    },
    {
      definition: todoListCategories,
      execute: (rawInput, context) =>
        asToolResult(context.invocationId, () => {
          const input = (rawInput ?? {}) as Record<string, unknown>;
          const result = service.listCategories(input);
          return {
            items: result.items.map(toCapabilityCategory),
            page: result.page,
            pageSize: result.pageSize,
            hasMore: result.hasMore,
          };
        }),
    },
    {
      definition: todoListProgress,
      execute: (rawInput, context) =>
        asToolResult(context.invocationId, () => {
          const input = (rawInput ?? {}) as Record<string, unknown>;
          const result = service.pageProgress({
            todoId: input['todoId'],
            page: input['page'],
            pageSize: input['pageSize'],
          });
          return {
            items: result.items.map(toCapabilityProgress),
            page: result.page,
            pageSize: result.pageSize,
            hasMore: result.hasMore,
          };
        }),
    },
  ];
  // 定义集合与注册一一对应：新增/删减能力时在此处（及 manifest 消费处）编译期暴露遗漏。
  if (registrations.length !== TODO_CAPABILITIES.length) {
    throw new Error('能力定义与 ToolRegistration 数量不一致');
  }
  return registrations;
}
