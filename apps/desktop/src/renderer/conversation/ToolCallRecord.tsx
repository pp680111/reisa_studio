import { Icon } from '@reisa/ui';

export type ToolStatus =
  'waiting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unavailable';
const states: Record<ToolStatus, { icon: string; label: string }> = {
  waiting: { icon: 'history', label: '等待执行' },
  running: { icon: 'loading', label: '执行中' },
  completed: { icon: 'check', label: '已完成' },
  failed: { icon: 'close', label: '失败' },
  cancelled: { icon: 'stop', label: '已取消' },
  unavailable: { icon: 'help', label: '模块不可用' },
};
export interface ToolCallRecordProps {
  action: string;
  name: string;
  status: ToolStatus;
  summary?: string;
  parameters?: Readonly<Record<string, unknown>>;
  error?: string;
  sample?: boolean;
}
export function ToolCallRecord({
  action,
  name,
  status,
  summary,
  parameters,
  error,
  sample = false,
}: ToolCallRecordProps) {
  const state = states[status];
  return (
    <details className={`tool-record tool-${status}`}>
      <summary>
        <span className="tool-icon">
          <Icon name={state.icon} size={15} />
        </span>
        <strong>{action}</strong>
        <span>
          {state.label}
          {sample ? ' · 示例' : ''}
        </span>
        <Icon name="chevronDown" size={14} />
      </summary>
      <div>
        <code>{name}</code>
        {summary && <p>{summary}</p>}
        {parameters && <pre>{JSON.stringify(parameters, null, 2)}</pre>}
        {error && <p className="tool-error">{error}</p>}
      </div>
    </details>
  );
}
