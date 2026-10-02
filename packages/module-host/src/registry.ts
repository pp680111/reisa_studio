import type { CapabilityDefinition, ToolRegistration } from '@reisa/module-sdk';

/** 按模块分组的注册表；模块能力整体注册/撤销，失败不产生部分注册（架构设计 §6.2）。 */
export class CapabilityRegistry {
  readonly #byModule = new Map<string, ToolRegistration[]>();
  readonly #byId = new Map<string, { moduleId: string; registration: ToolRegistration }>();

  set(moduleId: string, registrations: readonly ToolRegistration[]): void {
    this.remove(moduleId);
    this.#byModule.set(moduleId, [...registrations]);
    for (const registration of registrations) {
      this.#byId.set(registration.definition.id, { moduleId, registration });
    }
  }

  remove(moduleId: string): void {
    const existing = this.#byModule.get(moduleId);
    if (existing) {
      for (const registration of existing) this.#byId.delete(registration.definition.id);
    }
    this.#byModule.delete(moduleId);
  }

  get(capabilityId: string): { moduleId: string; registration: ToolRegistration } | undefined {
    return this.#byId.get(capabilityId);
  }

  has(moduleId: string): boolean {
    return this.#byModule.has(moduleId);
  }

  definitionsOf(moduleId: string): readonly CapabilityDefinition[] {
    return (this.#byModule.get(moduleId) ?? []).map((registration) => registration.definition);
  }

  /** 全量已注册能力描述；顺序按模块登记顺序稳定排列。 */
  allDefinitions(): readonly CapabilityDefinition[] {
    const definitions: CapabilityDefinition[] = [];
    for (const registrations of this.#byModule.values()) {
      for (const registration of registrations) definitions.push(registration.definition);
    }
    return definitions;
  }
}
