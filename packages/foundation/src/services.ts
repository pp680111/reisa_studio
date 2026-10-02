import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModuleLogger, ModuleServices } from '@reisa/module-sdk';
import { createFileConfigService, type ConfigService } from './config.ts';

export function createConsoleLogger(scope: string): ModuleLogger {
  const prefix = `[${scope}]`;
  return {
    debug: (message, details) => console.debug(prefix, message, details ?? ''),
    info: (message, details) => console.info(prefix, message, details ?? ''),
    warn: (message, details) => console.warn(prefix, message, details ?? ''),
    error: (message, details) => console.error(prefix, message, details ?? ''),
  };
}

/**
 * Node/Electron 主进程的模块作用域服务（架构设计 §7.2 模块布局）：
 * `<modulesRoot>/<moduleId>/` 下为 `settings.json`（模块私有配置）与 `files/`（模块文件）。
 * 句柄只暴露所属模块作用域，不提供跨模块枚举；传给 module-host 的 servicesFactory。
 */
export async function createNodeModuleServices(
  modulesRoot: string,
  moduleId: string,
  logger?: ModuleLogger,
): Promise<ModuleServices> {
  const moduleDir = join(modulesRoot, moduleId);
  const filesDir = join(moduleDir, 'files');
  await mkdir(filesDir, { recursive: true });
  const config: ConfigService = await createFileConfigService(join(moduleDir, 'settings.json'));
  return {
    storage: { dataDir: moduleDir },
    config,
    logger: logger ?? createConsoleLogger(`module:${moduleId}`),
  };
}
