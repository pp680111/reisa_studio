import { Badge, Icon } from '@reisa/ui';
import type { ModuleContribution, PublicResult } from '@reisa/module-sdk';

/** The renderer receives the returned payload only. Rendering never fetches private resources. */
export function ResultContainer({
  result,
  modules,
  enabled,
}: {
  result: PublicResult;
  modules: readonly ModuleContribution[];
  enabled: readonly string[];
}) {
  const owner = modules.find((module) => module.id === result.ownerModuleId);
  const available = owner && enabled.includes(owner.id);
  const Renderer = available
    ? owner.resultRenderers?.find((renderer) => renderer.type === result.type)?.component
    : undefined;
  if (Renderer)
    return (
      <div className="module-result">
        <Renderer result={result} />
      </div>
    );
  return (
    <div className="reference-card">
      <Icon name="document" size={24} />
      <h4>{result.title}</h4>
      <Badge>{result.sample ? '示例资源引用' : '资源引用'}</Badge>
      <p>{result.summary}</p>
      <small>
        来源：{owner?.name ?? result.ownerModuleId}
        {result.sample ? ' · 演示数据' : ''}
      </small>
      <p className="muted">
        {available
          ? '仅展示引用与摘要，尚未提供公开读取内容。'
          : '来源模块不可用，保留本次返回的引用与摘要。'}
      </p>
    </div>
  );
}
