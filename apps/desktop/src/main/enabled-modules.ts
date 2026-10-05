/**
 * 启用清单合并逻辑（架构设计 §8.1）：
 * 配置缺失（未写入或损坏）视为「全部启用」，与组合根的缺省语义一致——
 * 首次停用单个模块时以完整清单为基线做删减，避免把空清单持久化成有效配置，
 * 导致重启后用户从未动过的模块也被停用。
 */
export function nextEnabledModules(
  stored: readonly string[] | null | undefined,
  allModuleIds: readonly string[],
  moduleId: string,
  enabled: boolean,
): string[] {
  const current = Array.isArray(stored) ? [...stored] : [...allModuleIds];
  if (enabled) {
    return current.includes(moduleId) ? current : [...current, moduleId];
  }
  return current.filter((id) => id !== moduleId);
}
