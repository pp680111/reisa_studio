import type { ComponentType } from 'react';
import type { CapabilityDefinition } from './capability.ts';
import type { JsonValue } from './json.ts';
import type { ModuleEventEnvelope } from './module.ts';

/** Renderer-safe declarations only. Runtime handlers and private state never cross this contract. */
export interface ModulePageProps {
  openSettings: () => void;
  notify: (message: string) => void;
  availableModuleIds: readonly string[];
  /**
   * 订阅模块数据变更事件（runtime emit → 宿主推送，架构设计 §10）；
   * 浏览器预览等无桥环境不提供。返回退订函数。
   */
  subscribeModuleEvents?: (
    listener: (event: ModuleEventEnvelope) => void,
  ) => () => void;
}

export interface ModuleSettingsProps {
  notify: (message: string) => void;
  /** 请求宿主关闭设置界面。宿主以弹窗展示时会响应；内嵌展示时可能不提供。 */
  close?: () => void;
}

/** Only data explicitly returned by a capability; an ID does not grant access to private files. */
export interface PublicResult {
  id: string;
  ownerModuleId: string;
  type: string;
  title: string;
  summary: string;
  data?: JsonValue;
  resourceId?: string;
  sample?: boolean;
}

export interface ResultRendererProps {
  result: PublicResult;
}

/** 模块向宿主声明的 UI 贡献（架构设计 §9）。 */
export interface ModuleContribution {
  id: string;
  name: string;
  description: string;
  version: string;
  protocolVersion: '1';
  source: 'builtin' | 'external';
  capabilities: readonly CapabilityDefinition[];
  navigation?: {
    icon: string;
    aliases: readonly string[];
    keywords: readonly string[];
    page: ComponentType<ModulePageProps>;
  };
  settings?: ComponentType<ModuleSettingsProps>;
  resultRenderers?: readonly {
    id: string;
    type: string;
    component: ComponentType<ResultRendererProps>;
  }[];
}
