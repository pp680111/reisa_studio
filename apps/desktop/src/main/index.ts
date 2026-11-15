import { app, BrowserWindow, dialog, ipcMain, nativeImage } from 'electron';
import { join, resolve } from 'node:path';
import { testModelConnection } from '@reisa/agent-adapter';
import {
  clearDataRootPointer,
  defaultAppDataRoot,
  migrateAppData,
  resolveAppDataRoot,
  validateMigrationTarget,
  writeDataRootPointer,
} from '../composition/data-directory.ts';
import { createAppRuntime, getModulePageService, type AppRuntime } from '../composition/runtime.ts';
import { nextEnabledModules } from './enabled-modules.ts';
import { ConversationManager, type IncomingAttachment } from './conversation-manager.ts';
import {
  ConversationStore,
  type CreateRoleInput,
  type UpdateRoleInput,
} from './conversations/store.ts';
import { DEFAULT_ROLE_SEEDS } from './roles/seed.ts';
import { resolveConversationSystemPrompt } from './roles/resolution.ts';
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
  // 窗口/任务栏图标：开发与打包后路径一致，均取 main.cjs 同级的 icon.png
  // （由 scripts/build-electron.mjs 从 apps/desktop/assets/icon.png 拷贝而来）
  const icon = nativeImage.createFromPath(join(__dirname, 'icon.png'));
  const window = new BrowserWindow({
    ...(bounds.maximized ? { width: 1440, height: 940 } : bounds),
    minWidth: 480,
    minHeight: 540,
    title: 'Reisa Studio',
    backgroundColor: '#f8f8fb',
    autoHideMenuBar: true,
    ...(icon.isEmpty() ? {} : { icon }),
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
// 数据迁移前须整体停摆（停用模块 + 关闭会话库）；停摆期间与迁移完成后拒绝新业务
// IPC 复用已关闭的库，错误文案区分"迁移进行中"与"已迁移待重启"两种状态。
let runtimeShutdown: 'open' | 'migrating' | 'migrated' = 'open';
let runtimePromise: Promise<RuntimeAssembly> | undefined;
function getRuntime(): Promise<RuntimeAssembly> {
  if (runtimeShutdown !== 'open') {
    return Promise.reject(
      new Error(
        runtimeShutdown === 'migrating'
          ? '数据迁移进行中，请稍候'
          : '数据目录已迁移，请重启应用后继续使用',
      ),
    );
  }
  runtimePromise ??= (async () => {
    const runtime = await createAppRuntime(app.getPath('userData'));
    const store = await ConversationStore.open(runtime.layout.conversationsDb);
    // 默认角色播种：整个生命周期仅一次（meta 标记）；历史内置只读角色降级为可编辑的普通角色
    store.seedDefaultRoles(DEFAULT_ROLE_SEEDS);
    const manager = new ConversationManager({
      host: runtime.host,
      store,
      resolveModel: runtime.resolveModel,
      // 角色注入：会话绑定角色时用角色 prompt（可叠加默认提示词），
      // 无角色或角色缺失时回退全局默认提示词（每轮 send 调用）
      resolveSystemPrompt: (conversationId) =>
        resolveConversationSystemPrompt({
          store,
          getBasePrompt: () => runtime.config.get<string>('agent.systemPrompt'),
          conversationId,
          warn: (message) => console.warn(`[roles] ${message}`),
        }),
      onEvent: (conversationId, event) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('reisa/conversation/event', { conversationId, event });
        }
      },
    });
    // 宿主生命周期状态变化实时推送给 renderer（架构设计 §10）：
    // 过渡态（activating/deactivating）与 failed 的失败原因立即可见。
    runtime.host.onStateChange((status) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('reisa/module/state', status);
      }
    });
    // 模块数据变更事件（如卡片笔记同步完成）推送给 renderer：页面据此即时刷新，
    // 不再依赖轮询兜底发现页面外变更（架构设计 §10 推送）。
    runtime.host.onModuleEvent((event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('reisa/module/event', event);
      }
    });
    return { runtime, store, manager };
  })();
  return runtimePromise;
}

/**
 * 数据迁移前的整体停摆：逐个停用模块（各模块 deactivate 自行关闭其 SQLite/LanceDB
 * 连接，knowledge 的 WAL 在此 checkpoint）→ 关闭主会话库。之后才允许复制目录。
 */
async function shutdownRuntime(): Promise<void> {
  if (runtimeShutdown !== 'open' || runtimePromise === undefined) return; // 运行层尚未装配：无库可关
  runtimeShutdown = 'migrating';
  const { runtime, store } = await runtimePromise;
  for (const module of runtime.host.listModules()) {
    const state = runtime.host.getState(module.id);
    if (state !== 'active' && state !== 'failed') continue;
    try {
      await runtime.host.deactivate(module.id);
    } catch (error) {
      // 单个模块停用失败不阻断迁移（其库文件可能仍被占用，复制校验阶段兜底发现）
      console.error(
        `[data-directory] 模块 ${module.id} 停用失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  store.close();
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
  ipcMain.handle('reisa/conversations/create', async (_event, title?: string, roleId?: string) =>
    (await getRuntime()).store.createConversation(title, roleId),
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
  // 角色管理（会话归属主应用，角色随会话库存储）：创建时选定，之后不可切换；
  // 内置角色只读，被引用角色拒绝删除（提示停用）。错误信息对 renderer 可直接展示。
  ipcMain.handle('reisa/roles/list', async () => (await getRuntime()).store.listRoles());
  ipcMain.handle('reisa/roles/create', async (_event, input: CreateRoleInput) =>
    (await getRuntime()).store.createRole(input),
  );
  ipcMain.handle('reisa/roles/update', async (_event, payload: { id: string } & UpdateRoleInput) =>
    (await getRuntime()).store.updateRole(payload.id, payload),
  );
  ipcMain.handle('reisa/roles/delete', async (_event, roleId: string) => {
    (await getRuntime()).store.deleteRole(roleId);
    return true;
  });
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
      // 缺失配置播种为完整启用清单（缺失 = 全启用，与组合根缺省语义一致）：
      // 首次停用单个模块不会把空清单持久化成有效配置。
      const enabledModules = nextEnabledModules(
        await runtime.config.get<string[]>('enabledModules'),
        runtime.host.listModules().map((module) => module.id),
        payload.id,
        payload.enabled,
      );
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

  // 数据目录（架构设计 §7.2 存储根可配置）：展示当前根、选择目录、迁移。
  ipcMain.handle('reisa/settings/getDataDirectory', async () => {
    const { runtime } = await getRuntime();
    const defaultRoot = defaultAppDataRoot(app.getPath('userData'));
    const root = runtime.layout.root;
    return { root, defaultRoot, isCustom: resolve(root) !== resolve(defaultRoot) };
  });
  ipcMain.handle('reisa/settings/pickDataDirectory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });
  ipcMain.handle('reisa/settings/migrateDataDirectory', async (_event, target: string) => {
    const userDataPath = app.getPath('userData');
    const defaultRoot = defaultAppDataRoot(userDataPath);
    const sourceRoot = await resolveAppDataRoot(userDataPath);
    const targetRoot = resolve(target);
    // 先校验再动运行层：校验失败时应用不受任何影响
    await validateMigrationTarget(sourceRoot, targetRoot, { defaultRoot });
    const restoreDefault = targetRoot === resolve(defaultRoot);
    await shutdownRuntime();
    try {
      const stats = await migrateAppData({ sourceRoot, targetRoot });
      // 指针在数据就位后才写入：任一步失败都保持旧目录生效
      if (restoreDefault) await clearDataRootPointer(userDataPath);
      else await writeDataRootPointer(userDataPath, targetRoot);
      // 迁移成功后运行层不再复用：重启后从新目录重新装配
      runtimeShutdown = 'migrated';
      return stats;
    } catch (error) {
      // 迁移失败：指针未写、源目录未动；重置装配状态，下次 IPC 请求按原目录重建
      runtimeShutdown = 'open';
      runtimePromise = undefined;
      throw error;
    }
  });
  // 应用重启（迁移完成后由 renderer 触发）：relaunch 按原参数拉起新实例，本进程立即退出
  ipcMain.handle('reisa/app/restart', () => {
    app.relaunch();
    app.exit(0);
  });

  // 模块页面服务（迁移设计文档 §8.1）：受限通道，仅允许调用已激活模块声明的页面操作；
  // 管理面操作只经此通道，不进入 Agent 能力集合（知识库 §5.3 安全分层）。
  // 页面调用经宿主 runTracked 在途登记：停用等待页面调用结束并传递停用取消信号（架构设计 §10.2）。
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
        const value = await runtime.host.runTracked(payload.moduleId, (signal) =>
          service(payload.action, (payload.input ?? {}) as never, { signal }),
        );
        return { ok: true as const, value };
      } catch (error) {
        const state = runtime.host.getState(payload.moduleId);
        if (state !== 'active') {
          // 停用引发的取消/拒绝统一为能力不可用，不伪装成执行失败。
          return {
            ok: false as const,
            error: {
              code: 'CAPABILITY_UNAVAILABLE',
              message: state === 'deactivating' ? '模块正在停用' : '模块未激活',
            },
          };
        }
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

  // 宿主目录/文件选择对话框（模块页面经受限通道触发，添加本地来源/附件用）。
  // extensions 为可选的文件类型白名单（如 ['png','jpg']），透传给系统对话框过滤。
  ipcMain.handle(
    'reisa/module/pickPath',
    async (_event, payload: { mode: 'directory' | 'file'; extensions?: string[] }) => {
      const result = await dialog.showOpenDialog({
        properties: [payload.mode === 'directory' ? 'openDirectory' : 'openFile'],
        filters:
          payload.extensions !== undefined && payload.extensions.length > 0
            ? [{ name: '文件', extensions: payload.extensions }]
            : undefined,
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    },
  );

  // 宿主保存文件对话框（模块页面经受限通道触发，导出落盘用）。
  // 返回用户确认的目标路径；模块 runtime 只允许写入该路径。
  ipcMain.handle(
    'reisa/module/pickSavePath',
    async (_event, payload: { suggestedName?: string; extensions?: string[] }) => {
      const result = await dialog.showSaveDialog({
        defaultPath: payload.suggestedName,
        filters:
          payload.extensions !== undefined && payload.extensions.length > 0
            ? [{ name: '文件', extensions: payload.extensions }]
            : undefined,
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (result.canceled || result.filePath === undefined) return null;
      return result.filePath;
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
