import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Dialog, Field, Icon } from '@reisa/ui';
import type { ReisaBridge, ReisaRole } from '../bridge';

/**
 * 角色管理（设置 · 会话区）：角色 = 一套会话 system prompt 方案。
 * 规则：角色只在新建会话时选定，创建后不可切换；被会话引用的角色拒绝删除
 * （宿主返回错误，提示改用停用）；默认角色（运维排查专家）与自建角色能力一致，均可编辑删除。
 */
export function RolesManager({
  bridge,
  notify,
  onChanged,
}: {
  bridge?: ReisaBridge;
  notify: (message: string) => void;
  /** 变更后通知宿主刷新（AppShell 的角色选择器与徽标数据源）。 */
  onChanged?: () => void;
}) {
  const [roles, setRoles] = useState<ReisaRole[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{
    id?: string;
    name: string;
    description: string;
    prompt: string;
    includeBasePrompt: boolean;
  } | null>(null);

  const reload = useCallback(() => {
    if (!bridge) return;
    void bridge.roles
      .list()
      .then(setRoles)
      .catch((error) => notify(error instanceof Error ? error.message : String(error)));
  }, [bridge, notify]);

  useEffect(() => {
    reload();
  }, [reload]);

  const afterChange = (message: string): void => {
    notify(message);
    reload();
    onChanged?.();
  };

  const save = async (): Promise<void> => {
    if (!bridge || draft === null) return;
    if (draft.name.trim() === '' || draft.prompt.trim() === '') {
      notify('请填写角色名称与提示词内容。');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        prompt: draft.prompt,
        includeBasePrompt: draft.includeBasePrompt,
      };
      if (draft.id === undefined) await bridge.roles.create(payload);
      else await bridge.roles.update({ id: draft.id, ...payload });
      setDraft(null);
      afterChange('角色已保存；修改将从使用该角色的会话下一轮开始生效。');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const toggleDisabled = async (role: ReisaRole): Promise<void> => {
    if (!bridge) return;
    setBusy(true);
    try {
      await bridge.roles.update({ id: role.id, disabled: role.disabled === false });
      afterChange(role.disabled === false ? `角色 ${role.name} 已停用。` : `角色 ${role.name} 已启用。`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (role: ReisaRole): Promise<void> => {
    if (!bridge) return;
    if (window.confirm(`删除角色「${role.name}」？仅当没有会话使用它时才能删除。`)) {
      setBusy(true);
      try {
        await bridge.roles.remove(role.id);
        afterChange(`角色 ${role.name} 已删除。`);
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    }
  };

  return (
    <div className="roles-manager">
      <div className="setting-row">
        <div>
          <h3>角色</h3>
          <p>
            一套提示词方案对应一个角色。角色在新建会话时选择，创建后不可切换；
            编辑角色提示词将影响所有使用它的会话（从下一轮生效）。
          </p>
        </div>
        <Button
          variant="primary"
          disabled={!bridge || busy}
          onClick={() =>
            setDraft({ name: '', description: '', prompt: '', includeBasePrompt: false })
          }
        >
          <Icon name="plus" size={14} />
          新建角色
        </Button>
      </div>
      {!bridge ? (
        <p className="muted">角色管理需要桌面运行时；浏览器预览下不可编辑。</p>
      ) : roles.length === 0 ? (
        <p className="muted">暂无角色。首次启动会自动添加默认角色「运维排查专家」，可编辑或删除。</p>
      ) : (
        <ul className="roles-list">
          {roles.map((role) => (
            <li key={role.id} className={role.disabled ? 'disabled' : ''}>
              <div className="roles-item-main">
                <strong>
                  {role.name}
                  {role.builtin && <Badge>内置</Badge>}
                  {role.disabled && <Badge tone="">已停用</Badge>}
                </strong>
                {role.description !== '' ? <p>{role.description}</p> : null}
                <small>
                  {role.includeBasePrompt ? '注入时叠加默认提示词 · ' : ''}
                  创建后固定绑定，不可切换
                </small>
              </div>
              <div className="roles-item-actions">
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    setDraft({
                      id: role.id,
                      name: role.name,
                      description: role.description,
                      prompt: role.prompt,
                      includeBasePrompt: role.includeBasePrompt,
                    })
                  }
                >
                  编辑
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => void toggleDisabled(role)}>
                  {role.disabled ? '启用' : '停用'}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => void remove(role)}>
                  删除
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id === undefined ? '新建角色' : '编辑角色'}
        wide
      >
        {draft && (
          <div className="role-editor">
            <div className="role-editor-heading">
              <span className="role-editor-eyebrow">
                <Icon name="sparkles" size={12} />
                会话角色
              </span>
              <p>角色决定使用它的会话以什么样的身份与规则工作，在新建会话时选定后不可切换。</p>
            </div>
            <div className="role-editor-grid">
              <Field label="角色名称">
                <input
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="例如 运维排查专家"
                />
              </Field>
              <Field label="描述" hint="显示在新建会话的角色选择列表里">
                <input
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  placeholder="一句话说明这个角色的用途"
                />
              </Field>
            </div>
            <div className="role-editor-prompt">
              <div className="role-editor-prompt-head">
                <span className="role-editor-prompt-title">
                  <Icon name="document" size={13} />
                  提示词内容
                </span>
                <small>{draft.prompt.length} 字符 · 作为会话的 system 消息每轮注入</small>
              </div>
              <textarea
                value={draft.prompt}
                onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                rows={12}
                placeholder="描述这个角色的行为规则、输出约定与可用工具的使用方式…"
              />
              <label className="role-editor-toggle">
                <input
                  type="checkbox"
                  checked={draft.includeBasePrompt}
                  onChange={(event) =>
                    setDraft({ ...draft, includeBasePrompt: event.target.checked })
                  }
                />
                <span className="role-editor-toggle-text">
                  <strong>叠加全局默认提示词</strong>
                  <small>开启后注入顺序：全局默认提示词在前，角色提示词在后</small>
                </span>
              </label>
            </div>
            <div className="role-editor-footer">
              <small>角色在新建会话时选定后不可切换；编辑只影响后续轮次。</small>
              <div>
                <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
                  取消
                </Button>
                <Button variant="primary" disabled={busy} onClick={() => void save()}>
                  {busy ? '保存中…' : '保存角色'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
