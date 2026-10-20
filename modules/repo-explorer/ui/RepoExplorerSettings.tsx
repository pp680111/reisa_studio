import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Field, Icon } from '@reisa/ui';
import type { ModuleSettingsProps } from '@reisa/module-sdk';
import { callPage, pageBridgeAvailable, pickDirectory, type RepoJson, type RepoTestJson } from './client.ts';
import './RepoExplorerSettings.css';

/**
 * 代码仓库设置页：管理注册表（增删改、启停、登记前目录测试）。
 * 路径经宿主 pickPath 对话框选择，避免手输绝对路径；
 * 仓库注册后模型通过 /repos/<name>/ 虚拟路径只读访问，真实路径不出现在会话中。
 */

const REPO_NAME_HINT = '字母或数字开头，可含 . _ -（作为虚拟路径段，需全局唯一）';

export function RepoExplorerSettings({ notify }: ModuleSettingsProps) {
  const [repos, setRepos] = useState<RepoJson[] | null>(null);
  const [name, setName] = useState('');
  const [tagsDraft, setTagsDraft] = useState('');
  const [description, setDescription] = useState('');
  const [pickedPath, setPickedPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<RepoTestJson | null>(null);
  const available = pageBridgeAvailable();

  const reload = useCallback(async (): Promise<void> => {
    try {
      setRepos(await callPage<RepoJson[]>('list_repos'));
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  }, [notify]);

  useEffect(() => {
    if (available) void reload();
  }, [available, reload]);

  if (!available) {
    return <p className="repo-settings-state">仓库管理需要桌面运行时；浏览器预览下不可编辑。</p>;
  }

  const parseTags = (): string[] =>
    tagsDraft
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '');

  const chooseDirectory = async (): Promise<void> => {
    const path = await pickDirectory();
    if (path === null) return;
    setPickedPath(path);
    setTestResult(null);
  };

  const testDirectory = async (): Promise<void> => {
    if (pickedPath.trim() === '') {
      setTestResult({ ok: false, error: '请先选择目录' });
      return;
    }
    setBusy(true);
    try {
      setTestResult(await callPage<RepoTestJson>('test_repo', { path: pickedPath }));
    } catch (error) {
      setTestResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const addRepo = async (): Promise<void> => {
    if (name.trim() === '' || pickedPath.trim() === '') {
      notify('请填写仓库名并选择目录。');
      return;
    }
    setBusy(true);
    try {
      await callPage<RepoJson>('add_repo', {
        name: name.trim(),
        path: pickedPath.trim(),
        tags: parseTags(),
        description: description.trim(),
      });
      setName('');
      setTagsDraft('');
      setDescription('');
      setPickedPath('');
      setTestResult(null);
      await reload();
      notify('仓库已注册，会话中即可通过 /repos/<名称>/ 检索。');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const toggleRepo = async (repo: RepoJson): Promise<void> => {
    setBusy(true);
    try {
      await callPage<RepoJson>('update_repo', { id: repo.id, enabled: !repo.enabled });
      await reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const removeRepo = async (repo: RepoJson): Promise<void> => {
    if (window.confirm(`移除仓库「${repo.name}」？会话中将不能再检索该仓库（不影响磁盘文件）。`)) {
      setBusy(true);
      try {
        await callPage('remove_repo', { id: repo.id });
        await reload();
        notify(`仓库 ${repo.name} 已移除。`);
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    }
  };

  return (
    <div className="repo-settings">
      <section className="repo-settings-section" aria-label="已注册仓库">
        <header className="repo-settings-section-header">
          <h3>
            <Icon name="layers" size={16} />
            已注册仓库
          </h3>
          <Badge>{repos === null ? '加载中' : `${repos.length} 个`}</Badge>
        </header>
        <p className="repo-settings-description">
          仓库以只读方式挂载到虚拟路径 /repos/&lt;名称&gt;/；模型只能检索，不能写入，宿主机真实路径不会暴露给模型。
        </p>
        {repos !== null && repos.length === 0 ? (
          <p className="repo-settings-empty">尚未注册仓库。添加后模型即可用 list_repos 查看并检索代码。</p>
        ) : null}
        <ul className="repo-settings-list">
          {(repos ?? []).map((repo) => (
            <li key={repo.id} className={repo.enabled ? '' : 'disabled'}>
              <div className="repo-settings-item-main">
                <strong>
                  {repo.name}
                  <Badge tone={repo.enabled ? 'success' : ''}>{repo.enabled ? '已启用' : '已停用'}</Badge>
                </strong>
                <span className="repo-settings-path" title={repo.path}>
                  /repos/{repo.name}/
                </span>
                {repo.description !== '' ? <p>{repo.description}</p> : null}
                {repo.tags.length > 0 ? (
                  <div className="repo-settings-tags">
                    {repo.tags.map((tag) => (
                      <Badge key={tag}>{tag}</Badge>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="repo-settings-item-actions">
                <Button variant="ghost" disabled={busy} onClick={() => void toggleRepo(repo)}>
                  {repo.enabled ? '停用' : '启用'}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => void removeRepo(repo)}>
                  移除
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="repo-settings-section" aria-label="添加仓库">
        <header className="repo-settings-section-header">
          <h3>
            <Icon name="plus" size={16} />
            添加仓库
          </h3>
        </header>
        <div className="repo-settings-grid">
          <Field label="仓库名" hint={REPO_NAME_HINT}>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如 media-service"
            />
          </Field>
          <Field label="标签" hint="逗号分隔；会话按名称或标签匹配仓库">
            <input
              value={tagsDraft}
              onChange={(event) => setTagsDraft(event.target.value)}
              placeholder="例如 全连接, ush"
            />
          </Field>
          <Field label="描述" hint="可选；会帮助模型判断仓库用途">
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="例如 用户媒体服务的后端仓库"
            />
          </Field>
        </div>
        <div className="repo-settings-pick">
          <input value={pickedPath} placeholder="通过「选择目录」登记仓库根目录" readOnly />
          <Button variant="ghost" disabled={busy} onClick={() => void chooseDirectory()}>
            选择目录…
          </Button>
          <Button variant="ghost" disabled={busy || pickedPath.trim() === ''} onClick={() => void testDirectory()}>
            测试
          </Button>
        </div>
        <small
          role="status"
          className={
            testResult === null ? '' : testResult.ok ? 'repo-settings-test-ok' : 'repo-settings-test-failed'
          }
        >
          {testResult === null
            ? '选择目录后建议先测试：确认目录可读，并提示是否为 Git 仓库。'
            : testResult.ok
              ? testResult.isGit === true
                ? '目录可用，且包含 .git（可追溯版本历史）。'
                : '目录可用（不是 Git 仓库，不影响文件检索）。'
              : `不可用：${testResult.error ?? '未知错误'}`}
        </small>
        <footer className="repo-settings-footer">
          <Button variant="primary" disabled={busy} onClick={() => void addRepo()}>
            {busy ? '处理中…' : '注册仓库'}
          </Button>
        </footer>
      </section>
    </div>
  );
}
