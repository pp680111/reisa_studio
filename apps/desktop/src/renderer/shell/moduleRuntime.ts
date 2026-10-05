/**
 * 宿主模块运行状态在 renderer 的唯一投影（架构设计 §10）：
 * 启用集合、页面挂载与启停按钮状态都从这份状态派生，
 * renderer 不再维护 localStorage 启用列表副本。
 */

/** 模块生命周期状态（ModuleHost ModuleStatus 的投影；保留激活失败原因）。 */
export interface ModuleRuntimeStatus {
  state: string;
  error?: string;
}

/** 单条状态投影：error 缺省时不产出空字段。 */
export function toRuntimeStatus(status: { state: string; error?: string }): ModuleRuntimeStatus {
  return status.error !== undefined
    ? { state: status.state, error: status.error }
    : { state: status.state };
}

/** ModuleStatus[] → 状态映射：保留 error 字段，failed 模块的失败原因可见。 */
export function toRuntimeStates(
  statuses: readonly { id: string; state: string; error?: string }[],
): Record<string, ModuleRuntimeStatus> {
  return Object.fromEntries(statuses.map((status) => [status.id, toRuntimeStatus(status)]));
}

/**
 * 启用集合派生：宿主状态非 disabled 即视为启用（含过渡态与 failed——用户意图未撤销）；
 * 宿主未登记的模块（界面原型/浏览器预览）保持可用。
 */
export function deriveEnabledModules(
  moduleIds: readonly string[],
  states: Readonly<Record<string, ModuleRuntimeStatus | undefined>>,
): string[] {
  return moduleIds.filter((id) => states[id]?.state !== 'disabled');
}

/** 过渡态（activating/deactivating）期间禁用启停操作，避免处理中重复触发。 */
export function isTransitioning(state: string | undefined): boolean {
  return state === 'activating' || state === 'deactivating';
}
