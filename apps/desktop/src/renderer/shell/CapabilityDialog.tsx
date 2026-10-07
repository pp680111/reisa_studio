import { Badge, Dialog, Icon } from '@reisa/ui';
import type { ModuleContribution } from '@reisa/module-sdk';
import type { ReisaCapability } from '../bridge';

/**
 * 公开能力弹窗：以模块静态声明为基底渲染单一列表，运行时实际注册的能力
 * 逐行标记「运行时」徽标；运行时多出声明集合的能力也归属所属模块补显，
 * 避免声明与注册两个来源各画一遍造成重复。
 */
export function CapabilityDialog({
  open,
  onClose,
  moduleId,
  modules,
  enabled,
  runtimeConnected,
  liveCapabilities,
  capabilityCount,
}: {
  open: boolean;
  onClose: () => void;
  /** 打开弹窗时定位的模块 id；null 表示展示全部已启用模块。 */
  moduleId: string | null;
  modules: readonly ModuleContribution[];
  enabled: readonly string[];
  runtimeConnected: boolean;
  liveCapabilities: readonly ReisaCapability[] | null;
  capabilityCount: number;
}) {
  const live = liveCapabilities ?? [];
  const liveById = new Map(live.map((capability) => [capability.id, capability]));
  const liveByName = new Map(live.map((capability) => [capability.name, capability]));
  const isLive = (capability: { id: string; name: string }) =>
    liveById.has(capability.id) || liveByName.has(capability.name);

  const shownModules = modules.filter((module) =>
    moduleId ? module.id === moduleId : enabled.includes(module.id),
  );
  /** 注册了但不在声明集合里的能力，按 owner 前缀归入所属模块段补显。 */
  const runtimeOnlyFor = (module: ModuleContribution) =>
    live.filter(
      (capability) =>
        capability.id.startsWith(`${module.id}/`) &&
        !module.capabilities.some(
          (declared) => declared.id === capability.id || declared.name === capability.name,
        ),
    );
  // owner 不在模块清单中的运行时能力（清单未收录的外部模块），仅在全局视图单独成段兜底；
  // 单模块视图严格限定在该模块，其他任何 owner 的能力都不混入
  const runtimeOnlyOwners = new Map<string, ReisaCapability[]>();
  for (const capability of live) {
    const owner = capability.id.slice(0, capability.id.indexOf('/'));
    if (moduleId !== null) break;
    if (modules.some((module) => module.id === owner)) continue;
    const list = runtimeOnlyOwners.get(owner) ?? [];
    list.push(capability);
    runtimeOnlyOwners.set(owner, list);
  }
  const renderedLiveCount =
    shownModules.reduce(
      (sum, module) =>
        sum + module.capabilities.filter((c) => isLive(c)).length + runtimeOnlyFor(module).length,
      0,
    ) + [...runtimeOnlyOwners.values()].reduce((sum, list) => sum + list.length, 0);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        moduleId
          ? `${modules.find((module) => module.id === moduleId)?.name ?? ''} · 公开能力`
          : '公开能力声明'
      }
      wide
    >
      {open && (
        <div className="capability-dialog">
          <p className="muted">
            {runtimeConnected
              ? '只读接口声明 · 标记「运行时」的能力已在运行层注册执行处理器'
              : '只读接口声明 · 运行层尚未注册执行处理器'}
          </p>
          {shownModules.map((module) => {
            const runtimeOnly = runtimeOnlyFor(module);
            const liveCount =
              module.capabilities.filter((c) => isLive(c)).length + runtimeOnly.length;
            return (
              <section key={module.id}>
                <h3>
                  <Icon name={module.navigation?.icon ?? 'layers'} />
                  {module.name}
                  <Badge>{module.capabilities.length} 项</Badge>
                  {runtimeConnected && liveCount > 0 && (
                    <Badge tone="success">{liveCount} 项运行时</Badge>
                  )}
                  {!enabled.includes(module.id) && <Badge>已停用</Badge>}
                </h3>
                {module.capabilities.map((capability) => (
                  <div
                    className={`capability-row ${isLive(capability) ? 'is-live' : ''}`}
                    key={capability.id}
                  >
                    <div className="capability-row-head">
                      <code>{capability.name}</code>
                      {isLive(capability) && <Badge tone="success">运行时</Badge>}
                    </div>
                    <p>{capability.description}</p>
                  </div>
                ))}
                {runtimeOnly.map((capability) => (
                  <div className="capability-row is-live" key={capability.id}>
                    <div className="capability-row-head">
                      <code>{capability.name}</code>
                      <Badge tone="success">运行时</Badge>
                    </div>
                    <p>{capability.description}</p>
                  </div>
                ))}
              </section>
            );
          })}
          {[...runtimeOnlyOwners.entries()].map(([owner, capabilities]) => {
            const ownerModule = modules.find((module) => module.id === owner);
            return (
              <section key={owner}>
                <h3>
                  <Icon name={ownerModule?.navigation?.icon ?? 'layers'} />
                  {ownerModule?.name ?? owner}
                  <Badge>运行时 · {capabilities.length} 项</Badge>
                </h3>
                {capabilities.map((capability) => (
                  <div className="capability-row is-live" key={capability.id}>
                    <div className="capability-row-head">
                      <code>{capability.name}</code>
                      <Badge tone="success">运行时</Badge>
                    </div>
                    <p>{capability.description}</p>
                  </div>
                ))}
              </section>
            );
          })}
          {runtimeConnected && liveCapabilities && renderedLiveCount === 0 && (
            <p className="muted">运行时尚未注册任何能力；普通文本会话仍可用。</p>
          )}
          {capabilityCount === 0 && !moduleId && <p>所有模块已停用，仍可使用普通文本会话界面。</p>}
          <div className="info-box">
            仅查看接口描述。不会读取模块文档、文件或私有设置，也不提供逐工具开关。
          </div>
        </div>
      )}
    </Dialog>
  );
}
