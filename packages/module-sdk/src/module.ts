import type { ToolExecutionContext, ToolRegistration, ToolResult } from './capability.ts';
import type { JsonValue } from './json.ts';

/** 模块私有数据的作用域句柄；宿主保证隔离，不提供跨模块枚举（架构设计 §7.2）。 */
export interface ModuleStorageScope {
  readonly dataDir: string;
}

/** 模块私有配置句柄；Schema、默认值与迁移由模块自身维护（架构设计 §8.1）。 */
export interface ModuleConfigScope {
  get<T extends JsonValue>(key: string): Promise<T | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
}

export interface ModuleLogger {
  debug(message: string, details?: JsonValue): void;
  info(message: string, details?: JsonValue): void;
  warn(message: string, details?: JsonValue): void;
  error(message: string, details?: JsonValue): void;
}

/** 宿主为模块提供的基础服务句柄集合；由 module-host 注入 ModuleContext，foundation 提供实现。 */
export interface ModuleServices {
  readonly storage: ModuleStorageScope;
  readonly config: ModuleConfigScope;
  readonly logger: ModuleLogger;
}

/**
 * 激活时注入的模块上下文：只包含所属模块的存储、配置、基础服务句柄及公开能力调用入口，
 * 不包含主应用会话库、其他模块配置或其他模块数据库（架构设计 §5）。
 * 凭据等其余基础服务句柄随 foundation 落地在此扩展。
 */
export interface ModuleContext {
  readonly moduleId: string;
  readonly protocolVersion: '1';
  readonly storage: ModuleStorageScope;
  readonly config: ModuleConfigScope;
  readonly logger: ModuleLogger;
  /** 跨模块协作只能通过公开能力调用入口，调用方依赖公共契约（架构设计 §6.4）。 */
  invoke(
    capabilityId: string,
    input: JsonValue,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}

export interface RuntimeModule {
  readonly id: string;
  readonly version: string;
  readonly protocolVersion: '1';
  activate(context: ModuleContext): Promise<ModuleActivation>;
}

export interface ModuleActivation {
  readonly tools: readonly ToolRegistration[];
  deactivate(): Promise<void>;
}
