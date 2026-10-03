import { contextBridge, ipcRenderer } from 'electron';

/**
 * 有类型的受限 IPC 桥接（架构设计 §11）：只暴露白名单业务通道；
 * 不暴露通用 IPC、文件系统、凭据或模块私有数据。
 */
const api = {
  platform: process.platform,
  conversation: {
    listConversations: (options?: { limit?: number; offset?: number }) =>
      ipcRenderer.invoke('reisa/conversations/list', options),
    createConversation: (title?: string) => ipcRenderer.invoke('reisa/conversations/create', title),
    renameConversation: (conversationId: string, title: string) =>
      ipcRenderer.invoke('reisa/conversations/rename', { conversationId, title }),
    deleteConversation: (conversationId: string) =>
      ipcRenderer.invoke('reisa/conversations/delete', conversationId),
    getMessages: (conversationId: string) =>
      ipcRenderer.invoke('reisa/conversations/messages', conversationId),
    getToolRecords: (conversationId: string) =>
      ipcRenderer.invoke('reisa/conversations/toolRecords', conversationId),
    send: (
      conversationId: string,
      text: string,
      attachments?: { name: string; mediaType?: string; dataBase64: string }[],
    ) => ipcRenderer.invoke('reisa/conversation/send', { conversationId, text, attachments }),
    cancel: (conversationId: string) =>
      ipcRenderer.invoke('reisa/conversation/cancel', conversationId),
    listCapabilities: () => ipcRenderer.invoke('reisa/capabilities/list'),
    listModules: () => ipcRenderer.invoke('reisa/modules/list'),
    setModuleEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('reisa/modules/setEnabled', { id, enabled }),
    onEvent: (listener: (payload: { conversationId: string; event: unknown }) => void) => {
      const handler = (_event: unknown, payload: { conversationId: string; event: unknown }) =>
        listener(payload);
      ipcRenderer.on('reisa/conversation/event', handler as never);
      return () => ipcRenderer.removeListener('reisa/conversation/event', handler as never);
    },
  },
  settings: {
    getModelConnection: () => ipcRenderer.invoke('reisa/settings/getModelConnection'),
    setModelConnection: (payload: { baseURL: string; modelId: string; apiKey?: string }) =>
      ipcRenderer.invoke('reisa/settings/setModelConnection', payload),
    testConnection: () => ipcRenderer.invoke('reisa/settings/testConnection'),
    getPrompt: () => ipcRenderer.invoke('reisa/settings/getPrompt'),
    setPrompt: (prompt: string) => ipcRenderer.invoke('reisa/settings/setPrompt', prompt),
  },
  // 模块页面服务与私有配置（迁移设计文档 §8.1）：受限通道，action 白名单在主进程校验
  modulePage: {
    invoke: (moduleId: string, action: string, input?: unknown) =>
      ipcRenderer.invoke('reisa/module/page', { moduleId, action, input }),
    pickPath: (mode: 'directory' | 'file') => ipcRenderer.invoke('reisa/module/pickPath', { mode }),
  },
  moduleConfig: {
    get: (moduleId: string, key: string) =>
      ipcRenderer.invoke('reisa/module/config/get', { moduleId, key }),
    set: (moduleId: string, key: string, value: unknown) =>
      ipcRenderer.invoke('reisa/module/config/set', { moduleId, key, value }),
  },
};

contextBridge.exposeInMainWorld('reisa', Object.freeze(api));
