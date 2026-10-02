import type { ComponentType } from 'react';

/** Renderer-safe declarations only. Runtime handlers and private state never cross this contract. */
export interface CapabilityDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  inputSchema: Readonly<Record<string, unknown>>;
}
export interface ModulePageProps {
  openSettings: () => void;
  notify: (message: string) => void;
  availableModuleIds: readonly string[];
}
export interface ModuleSettingsProps {
  notify: (message: string) => void;
}
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
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
export function defineCapability(
  moduleId: string,
  action: string,
  description: string,
): CapabilityDefinition {
  return {
    id: `${moduleId}/${action}`,
    name: `${moduleId}__${action}`,
    version: '0.1.0',
    description,
    inputSchema: { type: 'object', properties: {} },
  };
}
