import electronDefault from 'electron';
import { join } from 'node:path';
import {
  appDataLayout,
  createFileConfigService,
  createFileCredentialStore,
  createNodeModuleServices,
  type AppDataLayout,
  type Cipher,
  type ConfigService,
  type CredentialStore,
} from '@reisa/foundation';
import { ModuleHost } from '@reisa/module-host';
import { createOpenAICompatibleModel, type ProviderConnectionConfig } from '@reisa/agent-adapter';
import type { JsonValue, ModuleConfigScope } from '@reisa/module-sdk';
import type { LanguageModel } from 'ai';
import { createKnowledgeRuntime } from '@reisa/module-knowledge/runtime';
import { createCardNoteRuntime } from '@reisa/module-card-note/runtime';

// Electron 主进程内为 safeStorage API；纯 Node（测试）下 electron 包导出二进制路径，无此 API
const safeStorage = (
  electronDefault as unknown as {
    safeStorage?: {
      isEncryptionAvailable(): boolean;
      encryptString(plain: string): Buffer;
      decryptString(buffer: Buffer): string;
    };
  }
).safeStorage;

/**
 * safeStorage 加密器（Windows 使用 DPAPI）。密文带 `enc1:` 前缀；
 * 无前缀的历史明文按原样解出，兼容加密接入前保存的凭据。
 * safeStorage 不可用（纯 Node 测试）时退化为直通存储。
 */
const safeStorageCipher: Cipher = {
  encrypt: (plain) =>
    safeStorage && safeStorage.isEncryptionAvailable()
      ? `enc1:${safeStorage.encryptString(plain).toString('base64')}`
      : plain,
  decrypt: (payload) => {
    if (!payload.startsWith('enc1:')) return payload;
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      throw new Error('系统凭据加密不可用，无法解密已加密的密钥');
    }
    return safeStorage.decryptString(Buffer.from(payload.slice(5), 'base64'));
  },
};

export interface AppRuntime {
  readonly layout: AppDataLayout;
  readonly config: ConfigService;
  readonly credentials: CredentialStore;
  readonly host: ModuleHost;
  /** 按基础配置解析主会话模型；未配置时抛出可展示的真实状态提示（module-ui-design §7）。 */
  resolveModel(): Promise<LanguageModel>;
}

/**
 * 模块页面服务与配置句柄注册表（迁移设计文档 §8.1）：
 * 受限 IPC（reisa/module/page、reisa/module/config）经此访问模块提供的
 * 页面服务与私有配置；仅主进程可达，renderer 不能绕过。
 */
export type ModulePageServiceInvoke = (action: string, input: JsonValue) => Promise<JsonValue>;

const modulePageServices = new Map<string, ModulePageServiceInvoke>();
const moduleConfigScopes = new Map<string, ModuleConfigScope>();

export function getModulePageService(moduleId: string): ModulePageServiceInvoke | undefined {
  return modulePageServices.get(moduleId);
}

export function getModuleConfigScope(moduleId: string): ModuleConfigScope | undefined {
  return moduleConfigScopes.get(moduleId);
}

/**
 * 内置运行模块清单——组合根是宿主唯一导入模块运行入口的位置（架构设计 §11）。
 * 新模块接入：在此加入条目并把 UI 贡献加入 modules.ts，宿主其余代码零改动。
 */
const RUNTIME_MODULES: readonly {
  readonly id: string;
  readonly create: () => Parameters<ModuleHost['register']>[0];
}[] = [
  {
    id: 'knowledge',
    create: () =>
      createKnowledgeRuntime({
        registerPageService: (invoke) => {
          modulePageServices.set('knowledge', invoke);
        },
      }),
  },
  {
    id: 'card-note',
    create: () =>
      createCardNoteRuntime({
        registerPageService: (invoke) => {
          modulePageServices.set('card-note', invoke);
        },
      }),
  },
];

interface ModelConnectionSettings {
  readonly baseURL?: string;
  readonly modelId?: string;
  readonly apiKeyRef?: string;
}

export async function createAppRuntime(userDataPath: string): Promise<AppRuntime> {
  const layout = appDataLayout(join(userDataPath, 'app-data'));
  const config = await createFileConfigService(join(layout.foundationDir, 'settings.json'));
  const credentials = createFileCredentialStore(
    join(layout.foundationDir, 'credentials.json'),
    safeStorageCipher,
  );

  const host = new ModuleHost({
    storageRoot: layout.modulesDir,
    servicesFactory: async (moduleId) => {
      const services = await createNodeModuleServices(layout.modulesDir, moduleId);
      moduleConfigScopes.set(moduleId, services.config);
      return services;
    },
  });

  // 启用状态属于宿主自身配置（架构设计 §8.1）；未配置时默认启用内置运行模块。
  const enabled =
    (await config.get<string[]>('enabledModules')) ??
    RUNTIME_MODULES.map((entry) => entry.create().id);
  for (const entry of RUNTIME_MODULES) {
    const module = entry.create();
    host.register(module);
    if (enabled.includes(module.id)) {
      try {
        await host.activate(module.id);
      } catch (error) {
        // 激活失败保持 failed 并保留原因，不阻断其他模块（架构设计 §10.1）
        console.error(
          `[runtime] 模块 ${module.id} 激活失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return {
    layout,
    config,
    credentials,
    host,
    resolveModel: async (): Promise<LanguageModel> => {
      const connection = await config.get<ModelConnectionSettings>('modelConnection');
      if (!connection?.baseURL || !connection.modelId) {
        throw new Error('模型连接未配置：请先在设置中完成服务商连接');
      }
      const settings: ProviderConnectionConfig = {
        name: 'reisa',
        baseURL: connection.baseURL,
        modelId: connection.modelId,
        ...(connection.apiKeyRef
          ? { apiKey: (await credentials.get(connection.apiKeyRef)) ?? '' }
          : {}),
      };
      return createOpenAICompatibleModel(settings);
    },
  };
}
