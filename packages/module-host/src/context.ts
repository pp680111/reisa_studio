import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonValue, ModuleLogger, ModuleServices } from '@reisa/module-sdk';

export type { ModuleServices } from '@reisa/module-sdk';

export function createConsoleLogger(moduleId: string): ModuleLogger {
  const prefix = `[module:${moduleId}]`;
  return {
    debug: (message, details) => console.debug(prefix, message, details ?? ''),
    info: (message, details) => console.info(prefix, message, details ?? ''),
    warn: (message, details) => console.warn(prefix, message, details ?? ''),
    error: (message, details) => console.error(prefix, message, details ?? ''),
  };
}

/**
 * 默认基础服务：目录创建 + 内存配置。
 * 仅提供机制，不构成跨模块读取旁路（架构设计 §7.2）；foundation 落地后替换为真实持久化实现。
 */
export async function createDefaultServices(
  storageRoot: string,
  moduleId: string,
  logger?: ModuleLogger,
): Promise<ModuleServices> {
  const dataDir = join(storageRoot, moduleId);
  await mkdir(dataDir, { recursive: true });
  const values = new Map<string, JsonValue>();
  return {
    storage: { dataDir },
    config: {
      async get<T extends JsonValue>(key: string): Promise<T | undefined> {
        return values.get(key) as T | undefined;
      },
      async set(key: string, value: JsonValue): Promise<void> {
        values.set(key, value);
      },
    },
    logger: logger ?? createConsoleLogger(moduleId),
  };
}
