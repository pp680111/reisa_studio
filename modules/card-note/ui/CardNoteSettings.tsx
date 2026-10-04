import { useCallback, useEffect, useState } from 'react';
import type { ModuleSettingsProps } from '@reisa/module-sdk';
import { Badge, Button, Field, Icon } from '@reisa/ui';
import './CardNoteSettings.css';
import {
  cloneSyncRepository,
  errorMessage,
  getSyncStatus,
  initializeSyncWorkspace,
  pickPath,
  saveSyncAuto,
  saveSyncConnection,
  syncNow,
  type SyncStatusJson,
} from './client.ts';

/**
 * 同步设置（源 SyncSettingsPage 的 M5 范围，随模块设置面板弹出）：
 * 工作区目录 + 远端地址 → 初始化新仓库 / 克隆已有仓库；立即同步；
 * 自动同步开关与间隔（重启调度器立即生效）。
 * 编辑项（连接 + 自动同步）经页脚"保存同步设置"统一落盘（与知识库设置面板同模式）。
 * 冲突中心未随 v1 迁移（源实现即缺失，偏差 D1）——Git 冲突/校验失败会以错误提示呈现。
 */
export function CardNoteSettings({ notify, close }: ModuleSettingsProps) {
  const [status, setStatus] = useState<SyncStatusJson | null>(null);
  const [workspacePath, setWorkspacePath] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [autoSync, setAutoSync] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState(10);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await getSyncStatus();
      setStatus(next);
      setWorkspacePath(next.workspacePath);
      setRemoteUrl(next.remoteUrl);
      setAutoSync(next.autoSync);
      setIntervalMinutes(next.intervalMinutes);
    } catch (error) {
      notify(errorMessage(error));
    }
  }, [notify]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (action: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    try {
      notify(await action());
      await refresh();
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const pickWorkspace = async () => {
    const path = await pickPath('directory');
    if (path !== null) setWorkspacePath(path);
  };

  const statusLabel = (() => {
    if (status === null) return '正在加载…';
    if (!status.gitAvailable) return `Git 不可用：${status.gitError ?? ''}`;
    if (!status.configured) return '未配置';
    if (!status.workspaceIsRepository) return '同步目录不是 Git 仓库';
    if (status.pendingChanges > 0) return `有 ${status.pendingChanges} 项本地变更待同步`;
    return '已同步';
  })();

  const canConnect = workspacePath.trim() !== '' && remoteUrl.trim() !== '';
  const canSync =
    status !== null && status.gitAvailable && status.configured && status.workspaceIsRepository;
  const validInterval =
    Number.isFinite(intervalMinutes) && intervalMinutes >= 1 && intervalMinutes <= 1440;

  /** 页脚统一保存：连接信息 + 自动同步；成功后关闭面板（与知识库设置面板一致）。 */
  const save = async (): Promise<void> => {
    if (busy || !validInterval) return;
    setBusy(true);
    try {
      await saveSyncConnection(workspacePath.trim(), remoteUrl.trim());
      await saveSyncAuto(autoSync, Math.round(intervalMinutes));
      notify('同步设置已保存');
      await refresh();
      close?.();
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card-note-sync-settings"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="card-note-sync-body">
        <section className="card-note-sync-section card-note-sync-overview" aria-label="同步状态">
          <div className="card-note-sync-status" role="status">
            <h3>
              <Icon name="swap" size={16} />
              同步状态
            </h3>
            <Badge tone={canSync && status.pendingChanges === 0 ? 'success' : ''}>
              {statusLabel}
            </Badge>
            {status !== null && status.lastSyncedHead !== '' ? (
              <p className="card-note-sync-description">
                最近同步版本{' '}
                <code title={status.lastSyncedHead}>{status.lastSyncedHead.slice(0, 12)}</code>
              </p>
            ) : (
              <p className="card-note-sync-description">
                通过 Git 仓库同步书籍、笔记、标签与附件。
              </p>
            )}
          </div>
          <Button
            variant="primary"
            disabled={busy || !canSync}
            onClick={() =>
              void run(async () => {
                const result = await syncNow();
                return `同步完成：导出 ${result.exportedDocuments} 项，提交${result.createdCommit ? '已创建' : '无变化'}，版本 ${result.head}`;
              })
            }
          >
            <Icon name="swap" size={15} />
            立即同步
          </Button>
        </section>

        <section className="card-note-sync-section" aria-label="仓库连接">
          <header className="card-note-sync-section-header">
            <h3>
              <Icon name="folder" size={16} />
              仓库连接
            </h3>
            <p className="card-note-sync-description">
              设置本地工作区与远端仓库，首次使用时选择初始化或克隆。
            </p>
          </header>
          <div className="card-note-sync-fields">
            <Field
              label="同步工作区目录"
              hint="必须是空目录（初始化）或已克隆的同步仓库；不能使用应用源码目录。"
              group
            >
              <div className="card-note-sync-path">
                <input
                  aria-label="同步工作区目录"
                  value={workspacePath}
                  placeholder="选择或输入本地目录路径"
                  onChange={(event) => setWorkspacePath(event.target.value)}
                />
                <Button disabled={busy} onClick={() => void pickWorkspace()}>
                  选择目录
                </Button>
              </div>
            </Field>

            <Field
              label="Git 远端地址"
              hint="建议使用私有仓库；HTTPS 认证交给 Git Credential Manager，SSH 交给系统 SSH 配置。"
            >
              <input
                value={remoteUrl}
                placeholder="例如：git@github.com:you/card-note-sync.git"
                onChange={(event) => setRemoteUrl(event.target.value)}
              />
            </Field>
          </div>

          <div className="card-note-sync-connect-actions">
            <Button
              disabled={busy || !canConnect}
              onClick={() =>
                void run(async () => {
                  await initializeSyncWorkspace(workspacePath.trim(), remoteUrl.trim());
                  return '同步仓库已初始化，并写入当前全部数据';
                })
              }
            >
              初始化新仓库
            </Button>
            <Button
              disabled={busy || !canConnect}
              onClick={() =>
                void run(async () => {
                  const result = await cloneSyncRepository(workspacePath.trim(), remoteUrl.trim());
                  return `克隆完成，导入 ${result.importedDocuments} 个文档`;
                })
              }
            >
              克隆已有仓库
            </Button>
          </div>
        </section>

        <section className="card-note-sync-section" aria-label="自动同步">
          <header className="card-note-sync-auto-header">
            <div className="card-note-sync-section-header">
              <h3>
                <Icon name="history" size={16} />
                自动同步
              </h3>
              <p className="card-note-sync-description">仅在应用运行且存在本地变更时执行。</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="启用自动同步"
              aria-checked={autoSync}
              className="switch"
              disabled={busy || status === null}
              onClick={() => setAutoSync(!autoSync)}
            >
              <span />
            </button>
          </header>
          <div className="card-note-sync-auto-controls">
            <Field label="同步间隔" hint="可设置为 1–1440 分钟。">
              <div className="card-note-sync-interval">
                <input
                  type="number"
                  min={1}
                  max={1440}
                  disabled={busy || !autoSync}
                  value={intervalMinutes}
                  onChange={(event) => setIntervalMinutes(Number(event.target.value))}
                />
                <span>分钟</span>
              </div>
            </Field>
          </div>
        </section>

        <details className="card-note-sync-safety">
          <summary>
            <Icon name="help" size={15} />
            数据与安全说明
            <Icon name="chevronDown" size={15} />
          </summary>
          <ul>
            <li>同步目标是业务数据（书籍、笔记、标签、附件），不含凭据与本地设置。</li>
            <li>每次导入远端数据前会自动备份数据库（card-note.sqlite.bak）。</li>
            <li>
              Git 服务商可以读取未加密的笔记内容，请使用私有仓库；凭据由系统 Git
              管理，不写入本应用。
            </li>
            <li>删除以墓碑记录同步：已删除实体的文件会保留在仓库中作为删除事实。</li>
          </ul>
        </details>
      </div>
      <footer className="card-note-sync-footer">
        <p>
          <Icon name="help" size={15} />
          保存立即生效；工作区与远端仅记录连接信息，初始化或克隆才会建立同步仓库。
        </p>
        <Button type="submit" variant="primary" disabled={busy || !validInterval}>
          {busy ? '保存中…' : '保存同步设置'}
        </Button>
      </footer>
    </form>
  );
}
