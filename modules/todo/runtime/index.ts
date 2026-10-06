import type { JsonValue, ModuleActivation, ModuleContext, RuntimeModule } from '@reisa/module-sdk';
import { join } from 'node:path';
import { MODULE_ID, MODULE_VERSION, PAGE_ACTIONS, type DeletedResultJson } from '../contracts.ts';
import { buildTodoTools } from './tools.ts';
import { TodoService } from './service.ts';
import { DomainError, TodoDatabase } from './database.ts';

/**
 * 待办模块运行入口（迁移设计文档 M0–M3）：只能被组合根导入（边界检查约定），不加载任何 UI 代码。
 * 数据库位于模块私有数据目录（app-data/modules/todo/todo.sqlite）；
 * 无任何 electron 依赖（R4 收缩后自然成立），纯 Node 可测（card-note 同款模式）。
 * 停用不删数据；宿主会先中止在途调用，deactivate 内关闭数据库（§5.9 顺序语义）。
 */

export interface CreateTodoRuntimeOptions {
  /** 组合根注入：注册本模块的页面服务（受限 IPC `reisa/module/page` 使用）。 */
  readonly registerPageService?: (invoke: PageServiceInvoke) => void;
}

/** 页面服务调用上下文：信号与模块停用关联，宿主停用即取消（架构设计 §10.2）。 */
export interface PageServiceContext {
  readonly signal?: AbortSignal;
}

export type PageServiceInvoke = (
  action: string,
  input: JsonValue,
  context?: PageServiceContext,
) => Promise<JsonValue>;

interface TodoRuntimeServices {
  readonly database: TodoDatabase;
  readonly service: TodoService;
}

export class TodoRuntime implements RuntimeModule {
  readonly id = MODULE_ID;
  readonly version = MODULE_VERSION;
  readonly protocolVersion = '1' as const;

  #services: TodoRuntimeServices | undefined;

  async activate(context: ModuleContext): Promise<ModuleActivation> {
    const database = new TodoDatabase(join(context.storage.dataDir, 'todo.sqlite'));
    const service = new TodoService(database);
    this.#services = { database, service };
    return {
      tools: buildTodoTools(service),
      deactivate: () => this.#deactivate(),
    };
  }

  async #deactivate(): Promise<void> {
    const services = this.#services;
    this.#services = undefined;
    services?.database.close();
  }

  #require(): TodoRuntimeServices {
    const services = this.#services;
    if (services === undefined) {
      throw new DomainError('模块未激活');
    }
    return services;
  }

  /**
   * 页面服务（受限通道动作分发；动作白名单见 contracts.ts PAGE_ACTIONS）。
   * 载荷为不可信输入：字段逐一显式转换，不透传任意结构。
   */
  pageService(): PageServiceInvoke {
    return async (action, input) => {
      const { service } = this.#require();
      const payload = (input ?? {}) as Record<string, unknown>;
      switch (action) {
        case PAGE_ACTIONS.listTodos:
          return service.listTodos(payload);
        case PAGE_ACTIONS.getTodo: {
          const todo = service.getTodo(payload['id']);
          return todo;
        }
        case PAGE_ACTIONS.saveTodo:
          return service.saveTodo({
            todoId: payload['todoId'],
            title: payload['title'],
            detail: payload['detail'],
            status: payload['status'],
            categoryId: payload['categoryId'],
            deadlineTime: payload['deadlineTime'],
          });
        case PAGE_ACTIONS.updateTodoStatus: {
          const updated = service.setTodoStatus(payload['id'], payload['status']);
          return updated;
        }
        case PAGE_ACTIONS.deleteTodo: {
          const receipt: DeletedResultJson = service.deleteTodo(payload['id']);
          return receipt;
        }
        case PAGE_ACTIONS.listCategories:
          return service.listCategories(payload);
        case PAGE_ACTIONS.saveCategory:
          return service.saveCategory({
            categoryId: payload['categoryId'],
            name: String(payload['name'] ?? ''),
          });
        case PAGE_ACTIONS.deleteCategory:
          return service.deleteCategory(payload['id']);
        case PAGE_ACTIONS.listProgress:
          return service.listProgress({ todoId: payload['todoId'] });
        case PAGE_ACTIONS.addProgress:
          return service.addProgress({
            todoId: payload['todoId'],
            content: String(payload['content'] ?? ''),
          });
        case PAGE_ACTIONS.updateProgressFinished:
          return service.setProgressFinished(payload['id'], payload['isFinished']);
        case PAGE_ACTIONS.deleteProgress:
          return service.deleteProgress(payload['id']);
        default:
          throw new DomainError(`未知的页面服务操作：${action}`);
      }
    };
  }
}

/** 组合根入口：创建待办运行时模块。 */
export function createTodoRuntime(options: CreateTodoRuntimeOptions = {}): RuntimeModule {
  const runtime = new TodoRuntime();
  if (options.registerPageService) {
    options.registerPageService(runtime.pageService());
  }
  return runtime;
}
