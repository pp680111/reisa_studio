/**
 * 主进程受限桥的 renderer 侧类型与访问器（架构设计 §11）。
 * 桥仅存在于 Electron 环境；浏览器预览（pnpm dev）下为 undefined，页面退回本地演示模式。
 */
import type { useEffect, useState } from 'react';

export interface ReisaConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ReisaMessagePart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: { type?: string; value?: unknown };
  [key: string]: unknown;
}

export interface ReisaMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | ReisaMessagePart[];
}

export type ReisaEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown }
  | {
      type: 'tool-error';
      toolCallId: string;
      toolName: string;
      error: { code: string; message: string };
    }
  | { type: 'error'; message: string }
  | { type: 'finish'; reason: 'stop' | 'abort' | 'error' };

export interface ReisaCapability {
  id: string;
  name: string;
  version: string;
  description: string;
}

export interface ReisaModelConnection {
  baseURL: string;
  modelId: string;
  hasApiKey: boolean;
}

export interface ReisaConnectionTest {
  ok: boolean;
  reply?: string;
  error?: string;
}

export interface ReisaAttachmentInput {
  name: string;
  mediaType?: string;
  dataBase64: string;
}

export interface ReisaUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ReisaModulePageResult<T> {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string };
}

export interface ReisaBridge {
  platform: string;
  conversation: {
    listConversations(options?: {
      limit?: number;
      offset?: number;
    }): Promise<ReisaConversationSummary[]>;
    createConversation(title?: string): Promise<ReisaConversationSummary>;
    renameConversation(conversationId: string, title: string): Promise<boolean>;
    deleteConversation(conversationId: string): Promise<boolean>;
    getMessages(conversationId: string): Promise<ReisaMessage[]>;
    getToolRecords(
      conversationId: string,
    ): Promise<{ invocationId: string; toolName: string; status: string }[]>;
    send(
      conversationId: string,
      text: string,
      attachments?: ReisaAttachmentInput[],
    ): Promise<{ status: 'completed' | 'cancelled' | 'error'; usage?: ReisaUsage }>;
    cancel(conversationId: string): Promise<boolean>;
    listCapabilities(): Promise<ReisaCapability[]>;
    listModules(): Promise<{ id: string; state: string }[]>;
    setModuleEnabled(
      id: string,
      enabled: boolean,
    ): Promise<{ state: string | undefined; error: string | undefined }>;
    onEvent(listener: (payload: { conversationId: string; event: ReisaEvent }) => void): () => void;
  };
  settings: {
    getModelConnection(): Promise<ReisaModelConnection | null>;
    setModelConnection(payload: {
      baseURL: string;
      modelId: string;
      apiKey?: string;
    }): Promise<boolean>;
    testConnection(): Promise<ReisaConnectionTest>;
    getPrompt(): Promise<string>;
    setPrompt(prompt: string): Promise<boolean>;
  };
  /** 模块页面服务：仅能调用已激活模块声明的页面操作（管理面，不进 Agent 能力）。 */
  modulePage: {
    invoke<T = unknown>(
      moduleId: string,
      action: string,
      input?: unknown,
    ): Promise<ReisaModulePageResult<T>>;
    pickPath(mode: 'directory' | 'file', extensions?: string[]): Promise<string | null>;
    pickSavePath(suggestedName?: string, extensions?: string[]): Promise<string | null>;
  };
  /** 模块私有配置（模块自己的 settings.json，与 ModuleConfigScope 同一存储）。 */
  moduleConfig: {
    get<T = unknown>(moduleId: string, key: string): Promise<T | null>;
    set(moduleId: string, key: string, value: unknown): Promise<boolean>;
  };
}

export function getBridge(): ReisaBridge | undefined {
  const bridge = (window as unknown as { reisa?: ReisaBridge }).reisa;
  return bridge && bridge.conversation ? bridge : undefined;
}
