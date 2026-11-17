/** Operates exclusively on public navigation declarations, never private module content. */
export function navigationModules(modules, enabled, pinned = [], recent = [], query = '') {
  const term = query.trim().toLocaleLowerCase();
  const priority = [...new Set([...pinned, ...recent])];
  return modules
    .filter(
      (module) =>
        enabled.includes(module.id) &&
        module.navigation &&
        (!term ||
          [module.name, ...module.navigation.aliases, ...module.navigation.keywords].some((text) =>
            text.toLocaleLowerCase().includes(term),
          )),
    )
    .sort((a, b) => {
      const ai = priority.indexOf(a.id);
      const bi = priority.indexOf(b.id);
      return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
    });
}

/**
 * 快捷切换器（Ctrl+K）模块检索：
 * 包含所有已启用的工作空间模块，以及拥有独立设置面板的模块（如代码仓库 repo-explorer）。
 */
export function quickSwitcherModules(modules, enabled, pinned = [], recent = [], query = '') {
  const term = query.trim().toLocaleLowerCase();
  const priority = [...new Set([...pinned, ...recent])];
  return modules
    .filter(
      (module) =>
        enabled.includes(module.id) &&
        (module.navigation || module.settings) &&
        (!term ||
          [
            module.name,
            module.description ?? '',
            ...(module.navigation?.aliases ?? []),
            ...(module.navigation?.keywords ?? []),
          ].some((text) => text.toLocaleLowerCase().includes(term))),
    )
    .sort((a, b) => {
      const ai = priority.indexOf(a.id);
      const bi = priority.indexOf(b.id);
      return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
    });
}
