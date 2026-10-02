import type { ComponentType } from 'react';
import type { CapabilityDefinition } from './capability.ts';
import type { JsonValue } from './json.ts';

/** Renderer-safe declarations only. Runtime handlers and private state never cross this contract. */
export interface ModulePageProps {
  openSettings: () => void;
  notify: (message: string) => void;
  availableModuleIds: readonly string[];
}

export interface ModuleSettingsProps {
  notify: (message: string) => void;
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
