import { app, BrowserWindow } from 'electron';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';

/**
 * Electron 冒烟测试入口：REISA_SMOKE=1 时由主进程启用。
 * 与 tests/electron-smoke.cjs 配合，验证真实主进程装配（窗口、受限桥、运行层 IPC）。
 * 使用一次性 userData，避免历史运行状态影响断言。
 */
export async function runSmoke(): Promise<void> {
  app.setPath('userData', await mkdtemp(join(tmpdir(), 'reisa-smoke-')));
  const errors: string[] = [];
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.on('console-message', (_event, level, message) => {
    if (level === 3) errors.push(message);
  });
  window.webContents.on('render-process-gone', (_event, detail) => errors.push(detail.reason));
  try {
    await window.loadFile(join(__dirname, '../dist/index.html'));

    // 等待会话引导完成（自动创建首个会话后渲染出输入区），消除首屏时序竞态
    const waitFor = async (expression: string, timeoutMs = 8000): Promise<true> => {
      const start = Date.now();
      for (;;) {
        const ready = (await window.webContents
          .executeJavaScript(expression)
          .catch(() => false)) as boolean;
        if (ready) return true;
        if (Date.now() - start > timeoutMs) throw new Error(`冒烟等待超时：${expression}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    await waitFor("!!document.querySelector('.composer textarea')");

    const state = await window.webContents.executeJavaScript(
      '({title:document.title,blankWelcome:document.querySelector(".conversation-scroll")?.childElementCount === 0,bridgeKeys:Object.keys(window.reisa||{}),conversationKeys:Object.keys(window.reisa?.conversation||{}),settingsKeys:Object.keys(window.reisa?.settings||{}),nodeAvailable:typeof window.require,overflow:document.documentElement.scrollWidth>innerWidth})',
    );
    assert.match(state.title, /Reisa Studio/);
    assert.equal(state.blankWelcome, true, '新会话输入框上方应保留空白');
    assert.ok(state.bridgeKeys.includes('platform'), '桥应暴露平台信息');
    assert.ok(state.bridgeKeys.includes('conversation'), '桥应暴露受限会话通道');
    assert.ok(state.bridgeKeys.includes('settings'), '桥应暴露受限设置通道');
    for (const key of [
      'listConversations',
      'createConversation',
      'send',
      'cancel',
      'listCapabilities',
      'onEvent',
    ]) {
      assert.ok(state.conversationKeys.includes(key), `会话通道缺少 ${key}`);
    }
    for (const key of [
      'getModelConnection',
      'setModelConnection',
      'testConnection',
      'getPrompt',
      'setPrompt',
    ]) {
      assert.ok(state.settingsKeys.includes(key), `设置通道缺少 ${key}`);
    }
    assert.equal(state.nodeAvailable, 'undefined');
    assert.equal(state.overflow, false);

    // 真实 IPC 往返：触发主进程运行层（node:sqlite、ModuleHost 装配）
    const conversations = await window.webContents.executeJavaScript(
      'window.reisa.conversation.listConversations()',
    );
    assert.ok(Array.isArray(conversations), '会话列表 IPC 应返回数组');
    // 内置知识库模块随运行时激活：能力集合应包含其四个公开能力
    const capabilityIds = (await window.webContents.executeJavaScript(
      'window.reisa.conversation.listCapabilities().then((list) => list.map((c) => c.id))',
    )) as string[];
    assert.ok(
      capabilityIds.includes('knowledge/search') &&
        capabilityIds.includes('knowledge/list_documents') &&
        capabilityIds.includes('knowledge/read_document') &&
        capabilityIds.includes('knowledge/upload_document'),
      `知识库能力应已注册，实际：${JSON.stringify(capabilityIds)}`,
    );
    // 模块页面服务通道：已激活模块可调用，未激活模块被拒
    const pageOk = (await window.webContents.executeJavaScript(
      "window.reisa.modulePage.invoke('knowledge', 'get_sync_status')",
    )) as { ok: boolean };
    assert.equal(pageOk.ok, true, '知识库页面服务应可用');
    const moduleStates = (await window.webContents.executeJavaScript(
      'window.reisa.conversation.listModules()',
    )) as { id: string; state: string }[];
    assert.ok(
      moduleStates.some((module) => module.id === 'knowledge' && module.state === 'active'),
      '知识库模块应处于激活状态',
    );

    assert.deepEqual(errors, []);
    console.log(
      'Electron smoke passed:',
      JSON.stringify({ ...state, conversations, capabilityIds }),
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}
