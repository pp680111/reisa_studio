import { join } from 'node:path';
import {
  toolFailure,
  type CapabilityDefinition,
  type JsonValue,
  type ModuleActivation,
  type ModuleContext,
  type ModuleLogger,
  type RuntimeModule,
  type ToolExecutionContext,
  type ToolRegistration,
  type ToolResult,
} from '@reisa/module-sdk';
import { createDefaultServices, type ModuleServices } from './context.ts';
import { CapabilityRegistry } from './registry.ts';
import { issuesToJson, validateAgainstSchema } from './validate.ts';

export const HOST_PROTOCOL_VERSION = '1';

export type ModuleState = 'disabled' | 'activating' | 'active' | 'deactivating' | 'failed';

export interface ModuleHostOptions {
  /** 模块私有数据根目录；每个模块获得 `${root}/${moduleId}` 作用域目录（架构设计 §7.2）。 */
  readonly storageRoot: string;
  /** 宿主级日志；不采集模块私有数据、密钥或未公开配置（架构设计 §9）。 */
  readonly logger?: ModuleLogger;
  /** 注入模块作用域服务工厂（由 foundation 提供）；缺省使用内置占位实现（目录 + 内存配置）。 */
  readonly servicesFactory?: (moduleId: string) => Promise<ModuleServices>;
}

export interface ModuleStatus {
  readonly id: string;
  readonly version: string;
  readonly state: ModuleState;
  readonly error?: string;
}

type StateListener = (status: ModuleStatus) => void;

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error) ?? String(error);
}

/** 校验模块返回的能力集合：命名空间、工具名格式与处理器（架构设计 §6.2 第 4 步）。 */
function validateRegistrations(
  moduleId: string,
  registrations: readonly ToolRegistration[],
): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const { definition, execute } of registrations) {
    if (!definition.id.startsWith(`${moduleId}/`)) {
      issues.push(`${definition.id}: 能力 ID 必须使用 ${moduleId}/ 命名空间`);
    }
    if (!definition.name.startsWith(`${moduleId}__`) || !/^[a-zA-Z0-9_-]+$/.test(definition.name)) {
      issues.push(
        `${definition.id}: 工具名 ${definition.name} 必须形如 ${moduleId}__action 且仅含字母数字`,
      );
    }
    if (typeof execute !== 'function') {
      issues.push(`${definition.id}: 缺少 execute 处理器`);
    }
    if (!definition.inputSchema || typeof definition.inputSchema !== 'object') {
      issues.push(`${definition.id}: 缺少输入 Schema`);
    }
    if (seen.has(definition.id)) {
      issues.push(`${definition.id}: 能力 ID 重复`);
    }
    seen.add(definition.id);
  }
  return issues;
}

/**
 * 模块宿主：生命周期状态机 + 能力注册中心 + 能力调用入口（架构设计 §6、§10）。
 * 一次普通工具失败不会使模块进入 failed；只有激活/基础设施失败才撤销注册（§10.1）。
 */
export class ModuleHost {
  readonly #options: ModuleHostOptions;
  readonly #modules = new Map<string, RuntimeModule>();
  readonly #states = new Map<string, ModuleState>();
  readonly #errors = new Map<string, string>();
  readonly #registry = new CapabilityRegistry();
  readonly #services = new Map<string, ModuleServices>();
  readonly #activations = new Map<string, ModuleActivation>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #listeners = new Set<StateListener>();

  constructor(options: ModuleHostOptions) {
    this.#options = options;
  }

  onStateChange(listener: StateListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** 登记内置模块清单；组合根按启用状态调用 activate（架构设计 §6.2）。 */
  register(module: RuntimeModule): void {
    if (this.#modules.has(module.id)) {
      throw new Error(`模块 ${module.id} 已登记`);
    }
    this.#modules.set(module.id, module);
    this.#states.set(module.id, 'disabled');
    this.#notify(module.id);
  }

  getState(moduleId: string): ModuleState | undefined {
    return this.#states.get(moduleId);
  }

  getStatus(moduleId: string): ModuleStatus | undefined {
    const module = this.#modules.get(moduleId);
    const state = this.#states.get(moduleId);
    if (!module || !state) return undefined;
    const error = this.#errors.get(moduleId);
    return { id: moduleId, version: module.version, state, ...(error ? { error } : {}) };
  }

  listModules(): readonly ModuleStatus[] {
    return [...this.#modules.keys()].map((id) => this.getStatus(id) as ModuleStatus);
  }

  /** 全量已启用能力描述（可序列化）；停用/未激活模块不在集合中——生命周期处理，非相关性筛选（架构设计 §6.3）。 */
  listEnabledCapabilities(): readonly CapabilityDefinition[] {
    return this.#registry.allDefinitions();
  }

  /** 能力调用入口 `invoke`（架构设计 §6.4）：定位、校验、构造上下文、执行、统一错误。 */
  async invoke(
    capabilityId: string,
    input: unknown,
    invocationContext: ToolExecutionContext,
  ): Promise<ToolResult> {
    const invocationId = invocationContext?.invocationId ?? '';
    const found = this.#registry.get(capabilityId);
    const moduleId = found?.moduleId ?? capabilityId.slice(0, capabilityId.indexOf('/'));
    if (!found || this.#states.get(moduleId) !== 'active') {
      return toolFailure(
        'CAPABILITY_UNAVAILABLE',
        `能力 ${capabilityId} 不可用（未注册或模块未激活）`,
        invocationId,
      );
    }
    const { registration } = found;
    const inputIssues = validateAgainstSchema(registration.definition.inputSchema, input);
    if (inputIssues.length > 0) {
      return toolFailure('INVALID_INPUT', '输入不符合能力声明', invocationId, {
        details: issuesToJson(inputIssues),
      });
    }

    // 构造所属模块的调用上下文：合并本次调用信号与模块停用信号（架构设计 §6.4、§10.2）。
    const controller = this.#controllers.get(moduleId);
    const signals = [invocationContext.signal, controller?.signal].filter(
      (signal): signal is AbortSignal => signal instanceof AbortSignal,
    );
    const signal =
      signals.length > 1 ? AbortSignal.any(signals) : (signals[0] ?? new AbortController().signal);
    const moduleContext: ToolExecutionContext = { invocationId, signal };

    try {
      // 输入已通过声明校验，此处断言为契约声明的 JSON 值。
      const result = await registration.execute(input as JsonValue, moduleContext);
      // 取消优先于结果：信号已中止的调用不交付成功产物（架构设计 §10.3），即使处理器实际完成。
      if (signal.aborted) {
        return toolFailure('CANCELLED', '调用已取消', invocationId);
      }
      if (result.status === 'success' && registration.definition.outputSchema) {
        const outputIssues = validateAgainstSchema(
          registration.definition.outputSchema,
          result.value,
        );
        if (outputIssues.length > 0) {
          return toolFailure('EXECUTION_FAILED', '结果与声明的输出 Schema 不符', invocationId, {
            details: issuesToJson(outputIssues),
          });
        }
      }
      return result;
    } catch (error) {
      if (signal.aborted) {
        return toolFailure('CANCELLED', '调用已取消', invocationId);
      }
      return toolFailure('EXECUTION_FAILED', describeError(error), invocationId);
    }
  }

  /** 适配层 `CapabilityInvoker` 兼容入口；宿主把它交给 startConversation。 */
  createInvoker(): (
    capabilityId: string,
    input: unknown,
    context: ToolExecutionContext,
  ) => Promise<ToolResult> {
    return (capabilityId, input, context) => this.invoke(capabilityId, input, context);
  }

  async activate(moduleId: string): Promise<void> {
    const module = this.#modules.get(moduleId);
    if (!module) throw new Error(`模块 ${moduleId} 未登记`);
    const state = this.#states.get(moduleId);
    if (state === 'active') return;
    if (state !== 'disabled' && state !== 'failed') {
      throw new Error(`模块 ${moduleId} 当前状态 ${state}，无法激活`);
    }
    this.#setState(moduleId, 'activating');
    try {
      if (module.protocolVersion !== HOST_PROTOCOL_VERSION) {
        throw new Error(
          `模块协议版本 ${module.protocolVersion} 与宿主 ${HOST_PROTOCOL_VERSION} 不兼容`,
        );
      }
      const services = await (this.#options.servicesFactory
        ? this.#options.servicesFactory(moduleId)
        : createDefaultServices(this.#options.storageRoot, moduleId, this.#options.logger));
      this.#services.set(moduleId, services);
      const context: ModuleContext = {
        moduleId,
        protocolVersion: HOST_PROTOCOL_VERSION,
        storage: services.storage,
        config: services.config,
        logger: services.logger,
        invoke: (capabilityId, input, invocationContext) =>
          this.invoke(capabilityId, input, invocationContext),
      };
      const activation = await module.activate(context);
      const registrations = [...(activation.tools ?? [])];
      const issues = validateRegistrations(moduleId, registrations);
      if (issues.length > 0) {
        throw new Error(`能力注册无效：${issues.join('；')}`);
      }
      this.#registry.set(moduleId, registrations);
      this.#activations.set(moduleId, activation);
      this.#controllers.set(moduleId, new AbortController());
      this.#errors.delete(moduleId);
      this.#setState(moduleId, 'active');
    } catch (error) {
      this.#registry.remove(moduleId);
      this.#activations.delete(moduleId);
      this.#controllers.delete(moduleId);
      this.#services.delete(moduleId);
      this.#errors.set(moduleId, describeError(error));
      this.#setState(moduleId, 'failed');
      throw error;
    }
  }

  /**
   * 停用顺序（架构设计 §10.2）：拒绝新调用 → 撤销工具注册 → 传递取消信号 →
   * 等待处理器结束并释放资源 → 卸载。停用不删除业务数据。
   */
  async deactivate(moduleId: string): Promise<void> {
    const state = this.#states.get(moduleId);
    if (state === 'disabled') return;
    if (state !== 'active' && state !== 'failed') {
      throw new Error(`模块 ${moduleId} 当前状态 ${state}，无法停用`);
    }
    if (state === 'failed') {
      this.#services.delete(moduleId);
      this.#setState(moduleId, 'disabled');
      return;
    }
    this.#setState(moduleId, 'deactivating');
    this.#registry.remove(moduleId);
    this.#controllers.get(moduleId)?.abort();
    const activation = this.#activations.get(moduleId);
    try {
      await activation?.deactivate();
    } finally {
      this.#activations.delete(moduleId);
      this.#controllers.delete(moduleId);
      this.#services.delete(moduleId);
      this.#setState(moduleId, 'disabled');
    }
  }

  #setState(moduleId: string, state: ModuleState): void {
    this.#states.set(moduleId, state);
    this.#notify(moduleId);
  }

  #notify(moduleId: string): void {
    const status = this.getStatus(moduleId);
    if (!status) return;
    for (const listener of this.#listeners) {
      try {
        listener(status);
      } catch (error) {
        this.#options.logger?.warn(`状态监听器执行失败：${describeError(error)}`);
      }
    }
  }
}
