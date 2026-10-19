import { Badge, Dialog, Icon } from '@reisa/ui';
import type { ReisaRole } from '../bridge';

/**
 * 新建会话的角色选择弹层：角色只在创建时选定，创建后不可切换。
 * 第一项"默认助手"是虚拟选项（不落库）：无角色，使用全局默认提示词。
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
  onConfirm: (roleId?: string) => void;
}) {
  const options: { roleId?: string; name: string; description: string; builtin: boolean }[] = [
    {
      name: '默认助手',
      description: '使用设置中的全局默认提示词，不带特定领域规则',
      builtin: true,
    },
    ...roles
      .filter((role) => role.disabled === false)
      .map((role) => ({
        roleId: role.id,
        name: role.name,
        description: role.description === '' ? '（无描述）' : role.description,
        builtin: role.builtin,
      })),
  ];
  return (
    <Dialog open={open} onClose={onClose} title="新建会话 · 选择角色" wide={false}>
      <p className="muted role-picker-hint">
        角色决定本轮会话的 system 提示词；创建后不可切换。可在设置中管理角色。
      </p>
      <div className="role-picker-list">
        {options.map((option) => (
          <button
            key={option.roleId ?? '__default__'}
            className="role-picker-item"
            onClick={() => onConfirm(option.roleId)}
          >
            <div className="role-picker-item-main">
              <strong>
                <Icon name={option.roleId === undefined ? 'chat' : 'sparkles'} size={15} />
                {option.name}
                {option.builtin && <Badge>内置</Badge>}
              </strong>
              <span>{option.description}</span>
            </div>
            <Icon name="chevronRight" size={14} />
          </button>
        ))}
      </div>
    </Dialog>
  );
}
