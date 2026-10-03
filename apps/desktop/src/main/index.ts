import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
import { testModelConnection } from '@reisa/agent-adapter';
import {
  createAppRuntime,
  getModuleConfigScope,
  getModulePageService,
  type AppRuntime,
} from '../composition/runtime.ts';
import { ConversationManager, type IncomingAttachment } from './conversation-manager.ts';
import { ConversationStore } from './conversations/store.ts';
import { runSmoke } from './smoke.ts';

interface WindowBounds {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
  readonly maximized?: boolean;
}

async function createWindow() {
  let bounds: WindowBounds = { width: 1440, height: 940 };
  try {
    const saved = (await (
      await getRuntime()
    ).runtime.config.get<WindowBounds>('window.bounds')) ?? {
      width: 1440,
      height: 940,
    };
    if (
      Number.isFinite(saved.width) &&
      Number.isFinite(saved.height) &&
      saved.width >= 480 &&
      saved.height >= 540
    ) {
      bounds = saved;
    }
  } catch {
    // 状态读取失败时用默认尺寸
  }
  const window = new BrowserWindow({
    ...(bounds.maximized ? { width: 1440, height: 940 } : bounds),
    minWidth: 480,
    minHeight: 540,
    title: 'Reisa Studio',
    backgroundColor: '#f8f8fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (bounds.maximized) window.maximize();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  // 关闭时记忆窗口状态（宿主配置）；失败不影响关闭
  window.on('close', () => {
    const current = window.getBounds();
    void (async () => {
      try {
        const { runtime } = await getRuntime();
        await runtime.config.set('window.bounds', {
          x: current.x,
          y: current.y,
          width: current.width,
          height: current.height,
          maximized: window.isMaximized(),
        } satisfies WindowBounds);
      } catch {
        /* optional preference */
      }
    })();
  });
  const devUrl = process.env.REISA_DEV_URL;
  if (!app.isPackaged && devUrl === 'http://127.0.0.1:5173') void window.loadURL(devUrl);
  else void window.loadFile(join(__dirname, '../dist/index.html'));
}

interface RuntimeAssembly {
  readonly runtime: AppRuntime;
  readonly store: ConversationStore;
  readonly manager: ConversationManager;
}

// 运行层按需初始化：首次业务 IPC 调用时装配，不影响窗口启动路径。
let runtimePromise: Promise<RuntimeAssembly> | undefined;
function getRuntime(): Promise<RuntimeAssembly> {
  runtimePromise ??= (async () => {
    const runtime = await createAppRuntime(app.getPath('userData'));
    const store = await ConversationStore.open(runtime.layout.conversationsDb);
    const manager = new ConversationManager({
      host: runtime.host,
      store,
      resolveModel: runtime.resolveModel,
      resolveSystemPrompt: async () => runtime.config.get<string>('agent.systemPrompt'),
      onEvent: (conversationId, event) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('reisa/conversation/event', { conversationId, event });
        }
      },
    });
    return { runtime, store, manager };
  })();
  return runtimePromise;
}

function registerIpc(): void {
  ipcMain.handle(
    'reisa/conversations/list',
    async (_event, options?: { limit?: number; offset?: number }) => {
      const { limit, offset } = options ?? {};
      return (await getRuntime()).store.listConversations(
        typeof limit === 'number' ? limit : undefined,
        typeof offset === 'number' ? offset : 0,
      );
    },
  );
  ipcMain.handle('reisa/conversations/create', async (_event, title?: string) =>
    (await getRuntime()).store.createConversation(title),
  );
  ipcMain.handle(
    'reisa/conversations/rename',
    async (_event, payload: { conversationId: string; title: string }) => {
      (await getRuntime()).store.renameConversation(payload.conversationId, payload.title);
      return true;
    },
  );
  ipcMain.handle('reisa/conversations/delete', async (_event, conversationId: string) => {
    (await getRuntime()).manager.cancel(conversationId);
    await (await getRuntime()).store.deleteConversation(conversationId);
    return true;
  });
  ipcMain.handle('reisa/conversations/messages', async (_event, conversationId: string) =>
    (await getRuntime()).store.getMessages(conversationId),
  );
  ipcMain.handle('reisa/conversations/toolRecords', async (_event, conversationId: string) =>
    (await getRuntime()).store.listToolRecords(conversationId),
  );
  ipcMain.handle(
    'reisa/conversation/send',
    async (
      _event,
      payload: {
        conversationId: string;
        text: string;
        attachments?: {
          name: string;
          mediaType?: string;
          dataBase64: string;
        }[];
      },
    ) => {
      const attachments = (payload.attachments ?? []) as IncomingAttachment[];
      return (await getRuntime()).manager.send(payload.conversationId, payload.text, attachments);
    },
  );
  ipcMain.handle('reisa/conversation/cancel', async (_event, conversationId: string) => {
    (await getRuntime()).manager.cancel(conversationId);
    return true;
  });
  ipcMain.handle('reisa/capabilities/list', async () =>
    (await getRuntime()).runtime.host.listEnabledCapabilities(),
  );
  ipcMain.handle('reisa/modules/list', async () => (await getRuntime()).runtime.host.listModules());
  // 模块启停：更新宿主配置中的启用清单，并驱动存在运行时的模块真实激活/停用（架构设计 §10）
  ipcMain.handle(
    'reisa/modules/setEnabled',
    async (_event, payload: { id: string; enabled: boolean }) => {
      const { runtime } = await getRuntime();
      const current = (await runtime.config.get<string[]>('enabledModules')) ?? [];
      const enabledModules = payload.enabled
        ? current.includes(payload.id)
          ? current
          : [...current, payload.id]
        : current.filter((id) => id !== payload.id);
      await runtime.config.set('enabledModules', enabledModules);
      // 未接入运行时的模块只保存启用状态；有运行时的模块走真实生命周期
      if (runtime.host.getStatus(payload.id) === undefined) {
        return { state: payload.enabled ? 'active' : 'disabled', error: undefined };
      }
      try {
        if (payload.enabled) await runtime.host.activate(payload.id);
        else await runtime.host.deactivate(payload.id);
        return { state: runtime.host.getState(payload.id), error: undefined };
      } catch (error) {
        return {
          state: runtime.host.getState(payload.id),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
  // 模型连接设置：key 只写入凭据存储，不回传 renderer（§8.2）
  ipcMain.handle('reisa/settings/getModelConnection', async () => {
    const { runtime } = await getRuntime();
    const connection = await runtime.config.get<{
      baseURL?: string;
      modelId?: string;
      apiKeyRef?: string;
    }>('modelConnection');
    if (!connection?.baseURL || !connection.modelId) return null;
    const apiKey = await runtime.credentials.get(connection.apiKeyRef ?? 'modelConnection.apiKey');
    return { baseURL: connection.baseURL, modelId: connection.modelId, hasApiKey: Boolean(apiKey) };
  });
  ipcMain.handle(
    'reisa/settings/setModelConnection',
    async (_event, payload: { baseURL: string; modelId: string; apiKey?: string }) => {
      const { runtime } = await getRuntime();
      const existing = await runtime.config.get<{ apiKeyRef?: string }>('modelConnection');
      const apiKeyRef = existing?.apiKeyRef ?? 'modelConnection.apiKey';
      if (payload.apiKey) await runtime.credentials.set(apiKeyRef, payload.apiKey);
      await runtime.config.set('modelConnection', {
        baseURL: payload.baseURL.trim(),
        modelId: payload.modelId.trim(),
        apiKeyRef,
      });
      return true;
    },
  );
  ipcMain.handle('reisa/settings/testConnection', async () => {
    const { runtime } = await getRuntime();
    try {
      return await testModelConnection(await runtime.resolveModel());
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(
    'reisa/settings/getPrompt',
    async () => (await getRuntime()).runtime.config.get<string>('agent.systemPrompt') ?? '',
  );
  ipcMain.handle('reisa/settings/setPrompt', async (_event, prompt: string) => {
    (await getRuntime()).runtime.config.set('agent.systemPrompt', prompt);
    return true;
  });

  // 模块页面服务（迁移设计文档 §8.1）：受限通道，仅允许调用已激活模块声明的页面操作；
  // 管理面操作只经此通道，不进入 Agent 能力集合（知识库 §5.3 安全分层）。
  ipcMain.handle(
    'reisa/module/page',
    async (_event, payload: { moduleId: string; action: string; input?: unknown }) => {
      const { runtime } = await getRuntime();
      if (runtime.host.getState(payload.moduleId) !== 'active') {
        return {
          ok: false as const,
          error: { code: 'CAPABILITY_UNAVAILABLE', message: '模块未激活' },
        };
      }
      const service = getModulePageService(payload.moduleId);
      if (service === undefined) {
        return {
          ok: false as const,
          error: { code: 'CAPABILITY_UNAVAILABLE', message: '模块未提供页面服务' },
        };
      }
      try {
        const value = await service(payload.action, (payload.input ?? {}) as never);
        return { ok: true as const, value };
      } catch (error) {
        return {
          ok: false as const,
          error: {
            code: 'EXECUTION_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  );

  // 模块私有配置读写（reisa/module/config）：句柄由组合根登记，仅限本模块 settings.json。
  ipcMain.handle(
    'reisa/module/config/get',
    async (_event, payload: { moduleId: string; key: string }) => {
      const scope = getModuleConfigScope(payload.moduleId);
      if (scope === undefined) return null;
      return (await scope.get(payload.key)) ?? null;
    },
  );
  ipcMain.handle(
    'reisa/module/config/set',
    async (_event, payload: { moduleId: string; key: string; value: unknown }) => {
      const scope = getModuleConfigScope(payload.moduleId);
      if (scope === undefined) return false;
      await scope.set(payload.key, payload.value as never);
      return true;
    },
  );

  // 宿主目录/文件选择对话框（模块页面经受限通道触发，添加本地来源用）。
  ipcMain.handle(
    'reisa/module/pickPath',
    async (_event, payload: { mode: 'directory' | 'file' }) => {
      const result = await dialog.showOpenDialog({
        properties: [payload.mode === 'directory' ? 'openDirectory' : 'openFile'],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    },
  );
}

void app.whenReady().then(() => {
  registerIpc();
  if (process.env.REISA_SMOKE === '1') {
    void runSmoke();
    return;
  }
  void createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
