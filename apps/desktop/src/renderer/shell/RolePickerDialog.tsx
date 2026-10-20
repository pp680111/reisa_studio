import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Badge, Button, Dialog, Icon } from '@reisa/ui';
import type { ReisaRole } from '../bridge';

const DEFAULT_ROLE = '__default__';

/**
 * 新建会话的角色选择弹层：角色只在创建时选定，创建后不可切换。
 * 第一项“默认助手”是虚拟选项（不落库）：无角色，使用全局默认提示词。
 */
export function RolePickerDialog({
  open,
  onClose,
  roles,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  roles: readonly ReisaRole[];
  onConfirm: (roleId?: string) => Promise<void> | void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const creating = useRef(false);
  const [selected, setSelected] = useState(DEFAULT_ROLE);
  const [busy, setBusy] = useState(false);
  const options: { roleId?: string; name: string; description: string; builtin: boolean }[] = [
    {
      name: '默认助手',
      description: '使用全局默认提示词，适合日常对话与通用任务',
      builtin: false,
    },
    ...roles
      .filter((role) => role.disabled === false)
      .map((role) => ({
        roleId: role.id,
        name: role.name,
        description: role.description === '' ? '暂无描述' : role.description,
        builtin: role.builtin,
      })),
  ];
  // 每次打开回到默认助手，避免上次的选择在没有提示的情况下被沿用。
  useEffect(() => {
    if (open) {
      creating.current = false;
      setSelected(DEFAULT_ROLE);
      setBusy(false);
    }
  }, [open]);
  const confirm = async (value = selected) => {
    if (creating.current) return;
    creating.current = true;
    setBusy(true);
    try {
      await onConfirm(value === DEFAULT_ROLE ? undefined : value);
    } catch {
      // 失败原因由宿主提示；保持弹层打开，方便直接改选或重试。
    } finally {
      creating.current = false;
      setBusy(false);
    }
  };
  // 方向键在角色之间移动，符合 radiogroup 的键盘约定。
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.findIndex((item) => item.dataset.role === selected);
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const next = items[(current + direction + items.length) % items.length];
    if (!next) return;
    setSelected(next.dataset.role ?? DEFAULT_ROLE);
    next.focus();
  };
  return (
    <Dialog open={open} onClose={onClose} title="新建会话">
      <div className="role-picker">
        <div className="role-picker-heading">
          <span className="role-picker-eyebrow">
            <Icon name="sparkles" size={13} />
            选择角色
          </span>
          <p>角色决定本次会话使用的 system 提示词，创建后不可切换。</p>
        </div>
        <div
          className="role-picker-list"
          ref={list}
          role="radiogroup"
          aria-label="会话角色"
          onKeyDown={move}
        >
          {options.map((option) => {
            const value = option.roleId ?? DEFAULT_ROLE;
            const active = value === selected;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                data-role={value}
                tabIndex={active ? 0 : -1}
                className={`role-picker-item ${active ? 'selected' : ''}`}
                onClick={() => setSelected(value)}
                onDoubleClick={() => {
                  setSelected(value);
                  void confirm(value);
                }}
              >
                <span className="role-picker-mark">
                  <Icon name={option.roleId === undefined ? 'chat' : 'sparkles'} size={17} />
                </span>
                <span className="role-picker-body">
                  <span className="role-picker-title">
                    <strong>{option.name}</strong>
                    {option.builtin && <Badge>内置</Badge>}
                  </span>
                  <span className="role-picker-description">{option.description}</span>
                </span>
                <span className="role-picker-indicator" aria-hidden="true">
                  {active && <Icon name="check" size={13} />}
                </span>
              </button>
            );
          })}
        </div>
        {roles.filter((role) => role.disabled === false).length === 0 && (
          <p className="role-picker-note">
            当前没有可用的自定义角色；可在 设置 › 会话 中新建或启用角色。
          </p>
        )}
        <div className="role-picker-footer">
          <small>角色创建后固定绑定，可在 设置 › 会话 中管理。</small>
          <div>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void confirm()} disabled={busy}>
              {busy ? '创建中…' : '开始会话'}
              {!busy && <Icon name="arrowRight" size={14} />}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
