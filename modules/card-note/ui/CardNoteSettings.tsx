import { useCallback, useEffect, useState } from 'react';
import type { ModuleSettingsProps } from '@reisa/module-sdk';
import { Badge, Button, Field } from '@reisa/ui';
import {
  cloneSyncRepository,
  errorMessage,
  getSyncStatus,
  initializeSyncWorkspace,
  pickPath,
  saveSyncAuto,
  syncNow,
  type SyncStatusJson,
} from './client.ts';

/**
 * 同步设置（源 SyncSettingsPage 的 M5 范围，随模块设置面板弹出）：
 * 工作区目录 + 远端地址 → 初始化新仓库 / 克隆已有仓库；立即同步；
 * 自动同步开关与间隔（重启调度器立即生效）。
 * 冲突中心未随 v1 迁移（源实现即缺失，偏差 D1）——Git 冲突/校验失败会以错误提示呈现。
 */
export function CardNoteSettings({ notify }: ModuleSettingsProps) {
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

  return (
    <div className="card-note-sync-settings">
      <div className="card-note-sync-status">
        <Badge
          tone={
            status !== null && status.configured && status.workspaceIsRepository ? 'success' : ''
          }
        >
          {statusLabel}
        </Badge>
        {status !== null && status.lastSyncedHead !== '' && (
          <small>最近同步：{status.lastSyncedHead}</small>
        )}
      </div>

      <Field
        label="同步工作区目录"
        hint="必须是空目录（初始化）或已克隆的同步仓库；不能使用应用源码目录。"
      >
        <div className="card-note-sync-row">
          <input
            value={workspacePath}
            placeholder="选择或输入本地目录路径"
            onChange={(event) => setWorkspacePath(event.target.value)}
          />
          <Button onClick={() => void pickWorkspace()}>选择目录</Button>
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

      <div className="card-note-sync-actions">
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
        <Button
          variant="primary"
          disabled={busy || status === null || !status.configured || !status.workspaceIsRepository}
          onClick={() =>
            void run(async () => {
              const result = await syncNow();
              return `同步完成：导出 ${result.exportedDocuments} 项，提交${result.createdCommit ? '已创建' : '无变化'}，版本 ${result.head}`;
            })
          }
        >
          立即同步
        </Button>
      </div>

      <Field label="自动同步" hint="仅在应用运行且存在本地变更时执行；间隔 1–1440 分钟。">
        <div className="card-note-sync-row">
          <label className="card-note-sync-check">
            <input
              type="checkbox"
              checked={autoSync}
              onChange={(event) => setAutoSync(event.target.checked)}
            />
            启用自动同步
          </label>
          <input
            type="number"
            min={1}
            max={1440}
            value={intervalMinutes}
            onChange={(event) => setIntervalMinutes(Number(event.target.value))}
          />
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await saveSyncAuto(autoSync, Math.round(intervalMinutes));
                return '自动同步设置已保存';
              })
            }
          >
            保存
          </Button>
        </div>
      </Field>

      <div className="card-note-sync-safety">
        <small>同步目标是业务数据（书籍、笔记、标签、附件），不含凭据与本地设置。</small>
        <small>每次导入远端数据前会自动备份数据库（card-note.sqlite.bak）。</small>
        <small>
          Git 服务商可以读取未加密的笔记内容，请使用私有仓库；凭据由系统 Git 管理，不写入本应用。
        </small>
        <small>删除以墓碑记录同步：已删除实体的文件会保留在仓库中作为删除事实。</small>
      </div>
    </div>
  );
}
