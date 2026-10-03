import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Dialog, EmptyState, Field, Icon, IconButton, Tabs } from '@reisa/ui';
import type { ModulePageProps } from '@reisa/module-sdk';
import {
  callPage,
  pageBridgeAvailable,
  pickPath,
  type DocumentContentJson,
  type DocumentJson,
  type SearchHitJson,
  type SearchResultJson,
  type SourceJson,
  type SourceStatsJson,
  type StatsJson,
  type SyncStatusJson,
} from './client.ts';
import './KnowledgePage.css';

/**
 * 知识库工作区（module-ui-design §3，多来源模型）：
 * 左侧来源列表 + 主区"文档 / 检索测试"两个视图。
 * 数据一律经页面服务通道获取；管理操作绝不进入 Agent 能力集合。
 */

const STATUS_LABELS: Record<string, string> = {
  indexed: '已索引',
  error: '失败',
  manual_required: '待人工',
};

const MODE_LABELS: Record<string, string> = {
  hybrid: '混合',
  vector: '向量',
  full_text: '全文',
};

function humanBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function KnowledgePage({ openSettings, notify }: ModulePageProps) {
  const [sources, setSources] = useState<SourceJson[]>([]);
  const [documents, setDocuments] = useState<DocumentJson[]>([]);
  const [stats, setStats] = useState<StatsJson | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatusJson | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [selectedDocument, setSelectedDocument] = useState<DocumentContentJson | null>(null);
  const [view, setView] = useState('文档');
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('hybrid');
  const [searchResult, setSearchResult] = useState<SearchResultJson | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [addingSource, setAddingSource] = useState(false);
  const [newRules, setNewRules] = useState('');
  const [editingRules, setEditingRules] = useState<string | null>(null);
  const [rulesDraft, setRulesDraft] = useState('');
  const [errorText, setErrorText] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);
  const available = pageBridgeAvailable();

  const refresh = useCallback(async () => {
    if (!available) return;
    try {
      const [sourceList, sync, nextStats] = await Promise.all([
        callPage<SourceJson[]>('list_sources'),
        callPage<SyncStatusJson>('get_sync_status'),
        callPage<StatsJson>('get_stats'),
      ]);
      setSources(sourceList);
      setSyncStatus(sync);
      setStats(nextStats);
      const docs = await callPage<{ items: DocumentJson[] }>('list_documents', {
        limit: 200,
        ...(selectedSourceId !== null ? { sourceId: selectedSourceId } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
      });
      setDocuments(docs.items);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [available, selectedSourceId, statusFilter]);

  useEffect(() => {
    setLoading(true);
    void refresh().finally(() => setLoading(false));
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  /** 手动刷新：重新拉取页面数据；已打开的文档预览同步重取，文档已删除时关闭预览。 */
  const reload = useCallback(async () => {
    await refresh();
    const current = selectedDocument;
    if (current === null) return;
    try {
      setSelectedDocument(
        await callPage<DocumentContentJson>('get_document_content', {
          documentId: current.document.id,
        }),
      );
    } catch {
      setSelectedDocument(null);
    }
  }, [refresh, selectedDocument]);

  const sourceName = useMemo(() => {
    if (selectedSourceId === null) return '全部来源';
    return sources.find((source) => source.id === selectedSourceId)?.name ?? '全部来源';
  }, [selectedSourceId, sources]);

  const statsBySource = useMemo(() => {
    const map = new Map<string, SourceStatsJson>();
    for (const item of stats?.perSource ?? []) map.set(item.sourceId, item);
    return map;
  }, [stats]);

  // queued 等过渡态文档数 = 总数 − 三个终态之和；仅在大于 0 时展示。
  const processingCount = stats
    ? stats.documents -
      stats.indexedDocuments -
      stats.failedDocuments -
      stats.manualRequiredDocuments
    : 0;

  const run = async (action: () => Promise<void>, successMessage?: string) => {
    setBusy(true);
    setErrorText('');
    try {
      await action();
      if (successMessage) notify(successMessage);
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorText(message);
      notify(message);
    } finally {
      setBusy(false);
    }
  };

  const addSourceFromPicker = (picked: 'directory' | 'file') =>
    run(async () => {
      const path = await pickPath(picked);
      if (path === null) return;
      await callPage('add_source', { path, ignoreRules: newRules });
      setNewRules('');
      setAddingSource(false);
      notify('来源已添加，后台将自动扫描索引');
    });

  const removeSource = (source: SourceJson) =>
    run(async () => {
      if (!window.confirm(`删除来源「${source.name}」及其全部索引？源文件不受影响。`)) return;
      await callPage('remove_source', { sourceId: source.id });
      if (selectedSourceId === source.id) setSelectedSourceId(null);
    }, '来源已删除');

  const saveRules = (source: SourceJson) =>
    run(async () => {
      await callPage('update_rules', { sourceId: source.id, ignoreRules: rulesDraft });
      setEditingRules(null);
    }, '排除规则已保存，后台将重新扫描');

  const rescan = () => run(async () => void (await callPage('scan_now')), '已请求一次同步');

  const resubmit = (documentId: string) =>
    run(async () => void (await callPage('reindex_document', { documentId })), '已提交索引');

  const openDocument = (document: DocumentJson) =>
    run(async () => {
      const content = await callPage<DocumentContentJson>('get_document_content', {
        documentId: document.id,
      });
      setSelectedDocument(content);
    });

  const runSearch = () =>
    run(async () => {
      setSearching(true);
      try {
        const result = await callPage<SearchResultJson>('search', {
          query,
          mode,
          topK: 8,
        });
        setSearchResult(result);
      } finally {
        setSearching(false);
      }
    });

  const uploadFiles = async (files: FileList | null) => {
    if (files === null || files.length === 0) return;
    await run(async () => {
      for (const file of files) {
        const content = await file.text();
        await callPage('upload_file', { filename: file.name, content });
      }
      notify('文件已上传，后台将自动索引');
    });
  };

  const selectedSource = sources.find((source) => source.id === selectedSourceId);
  const editingSource = sources.find((source) => source.id === editingRules);

  const selectSource = (sourceId: string | null): void => {
    setSelectedSourceId(sourceId);
    setSelectedDocument(null);
  };

  if (!available) {
    return (
      <div className="knowledge-page">
        <EmptyState
          icon="book"
          title="知识库需要桌面运行时"
          description="请在桌面应用中打开本模块，管理文档来源并建立检索索引。"
        />
      </div>
    );
  }

  return (
    <div className="knowledge-page">
      <header className="knowledge-page-heading">
        {stats !== null && (
          <div className="knowledge-page-stats" role="status" aria-label="所有来源文档统计">
            <span className="knowledge-stats-label">所有来源</span>
            <span className="knowledge-stat">
              <strong>{stats.documents}</strong> 篇文档
            </span>
            <span className="knowledge-stat ok">
              <strong>{stats.indexedDocuments}</strong> 已索引
            </span>
            <span className="knowledge-stat bad">
              <strong>{stats.failedDocuments}</strong> 失败
            </span>
            {stats.manualRequiredDocuments > 0 && (
              <span className="knowledge-stat warn">
                <strong>{stats.manualRequiredDocuments}</strong> 待人工
              </span>
            )}
            {processingCount > 0 && (
              <span className="knowledge-stat">
                <strong>{processingCount}</strong> 处理中
              </span>
            )}
          </div>
        )}
        <div className="knowledge-page-actions">
          <Button onClick={rescan} disabled={busy}>
            <Icon name="history" size={15} />
            立即扫描
          </Button>
          <Button variant="ghost" onClick={() => void reload()} disabled={busy}>
            <Icon name="loading" size={15} />
            刷新
          </Button>
          <Button variant="ghost" onClick={openSettings}>
            <Icon name="settings" size={15} />
            模块设置
          </Button>
        </div>
      </header>

      <div className="knowledge-sync-bar" role="status">
        <span className="knowledge-sync-label">
          <span className={'knowledge-sync-dot' + (syncStatus?.running ? ' running' : '')} />
          {syncStatus?.running ? '正在同步' : syncStatus?.pending ? '等待同步' : '同步空闲'}
        </span>
        <span>
          {syncStatus?.lastRunAt ? '上次同步 ' + formatTime(syncStatus.lastRunAt) : '尚无同步记录'}
          {syncStatus?.lastRunSeconds !== null && syncStatus?.lastRunSeconds !== undefined
            ? ' · 耗时 ' + syncStatus.lastRunSeconds.toFixed(1) + ' 秒'
            : ''}
        </span>
      </div>

      {errorText && !editingSource && (
        <p role="alert" className="knowledge-message danger">
          <Icon name="help" size={16} />
          {errorText}
        </p>
      )}

      <div className="knowledge-workspace">
        <aside className="knowledge-sources-panel">
          <div className="knowledge-panel-heading">
            <h2>
              文档来源 <span>{sources.length}</span>
            </h2>
            <IconButton
              name={addingSource ? 'close' : 'plus'}
              label={addingSource ? '收起添加来源' : '添加来源'}
              onClick={() => setAddingSource((value) => !value)}
              disabled={busy}
            />
          </div>
          {addingSource && (
            <div className="knowledge-add-source">
              <p>选择本地目录或文件，自动扫描其中的文档。</p>
              <Field label="排除规则（可选）" hint="每行一条，相对于来源目录；留空使用默认规则。">
                <textarea
                  rows={3}
                  value={newRules}
                  onChange={(event) => setNewRules(event.target.value)}
                  placeholder={'*.draft.md\ntemp/'}
                />
              </Field>
              <div className="knowledge-source-picker">
                <Button onClick={() => addSourceFromPicker('directory')} disabled={busy}>
                  <Icon name="folder" size={15} />
                  选择目录
                </Button>
                <Button onClick={() => addSourceFromPicker('file')} disabled={busy}>
                  <Icon name="document" size={15} />
                  选择文件
                </Button>
              </div>
            </div>
          )}

          <nav aria-label="来源列表" className="knowledge-source-list">
            <button
              type="button"
              className={'knowledge-source-item all' + (selectedSourceId === null ? ' active' : '')}
              aria-pressed={selectedSourceId === null}
              onClick={() => selectSource(null)}
            >
              <Icon name="layers" size={17} />
              <span className="knowledge-source-copy">
                <strong>全部来源</strong>
                <small>浏览所有已导入文档</small>
              </span>
            </button>
            {sources.map((source) => {
              const selected = selectedSourceId === source.id;
              const sourceStats = statsBySource.get(source.id);
              return (
                <div
                  className={'knowledge-source-card' + (selected ? ' selected' : '')}
                  key={source.id}
                >
                  <button
                    type="button"
                    className={'knowledge-source-item' + (selected ? ' active' : '')}
                    aria-pressed={selected}
                    onClick={() => selectSource(source.id)}
                    title={source.path}
                  >
                    <Icon name={source.type === 'local_file' ? 'document' : 'folder'} size={17} />
                    <span className="knowledge-source-copy">
                      <strong>{source.name}</strong>
                      <small>{source.type === 'local_file' ? '本地文件' : '本地目录'}</small>
                    </span>
                    {sourceStats && (
                      <span className="knowledge-source-stats" title="来源文档统计">
                        <span>
                          <strong>{sourceStats.documents}</strong> 篇
                        </span>
                        <span className="ok">
                          <strong>{sourceStats.indexedDocuments}</strong> 已索引
                        </span>
                        <span className="bad">
                          <strong>{sourceStats.failedDocuments}</strong> 失败
                        </span>
                        {sourceStats.manualRequiredDocuments > 0 && (
                          <span className="warn">
                            <strong>{sourceStats.manualRequiredDocuments}</strong> 待人工
                          </span>
                        )}
                      </span>
                    )}
                    {selected && <Icon name="chevronRight" size={14} />}
                  </button>
                  {selected && (
                    <div className="knowledge-source-detail">
                      <p className="knowledge-source-path" title={source.path}>
                        {source.path}
                      </p>
                      <p className="knowledge-source-rule-summary">
                        {source.ignoreRules.trim()
                          ? '已设置 ' +
                            source.ignoreRules
                              .split(/\r?\n/)
                              .filter((rule) => rule.trim() && !rule.trim().startsWith('#'))
                              .length +
                            ' 条排除规则'
                          : '使用默认排除规则'}
                      </p>
                      <div className="knowledge-source-actions">
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            setErrorText('');
                            setEditingRules(source.id);
                            setRulesDraft(source.ignoreRules);
                          }}
                        >
                          <Icon name="sliders" size={14} />
                          编辑排除规则
                        </Button>
                        <IconButton
                          name="trash"
                          label={'删除来源「' + source.name + '」'}
                          disabled={busy}
                          onClick={() => removeSource(source)}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
          {sources.length === 0 && !loading && (
            <div className="knowledge-source-empty">
              <Icon name="folder" size={24} />
              <p>添加第一个文档来源</p>
              <small>支持本地目录、Markdown 和文本文件。</small>
              {!addingSource && (
                <Button onClick={() => setAddingSource(true)} disabled={busy}>
                  <Icon name="plus" size={14} />
                  添加来源
                </Button>
              )}
            </div>
          )}
          <div className="knowledge-source-note">
            <Icon name="help" size={15} />
            <span>来源文件变更后会自动同步。删除来源不会删除本地文件。</span>
          </div>
        </aside>

        <section className="knowledge-content-panel">
          <div className="knowledge-content-heading">
            <div className="knowledge-content-title">
              <h2>{view === '文档' ? sourceName : '全部来源检索'}</h2>
              <p title={selectedSource?.path}>
                {view === '文档'
                  ? (selectedSource?.path ?? '查看文档索引状态，或选择文档预览内容。')
                  : '输入问题或关键词，查看知识库返回的相关片段。'}
              </p>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".md,.txt"
              multiple
              hidden
              onChange={(event) => {
                void uploadFiles(event.target.files);
                event.target.value = '';
              }}
            />
            <Button onClick={() => fileInput.current?.click()} disabled={busy}>
              <Icon name="upload" size={15} />
              上传文档
            </Button>
          </div>

          <Tabs items={['文档', '检索测试']} value={view} onChange={setView} />

          {view === '文档' && (
            <>
              <div className="knowledge-document-toolbar">
                <span>{loading ? '正在加载文档…' : '已加载 ' + documents.length + ' 篇文档'}</span>
                <select
                  aria-label="按状态筛选"
                  value={statusFilter}
                  onChange={(event) => {
                    setStatusFilter(event.target.value);
                    setSelectedDocument(null);
                  }}
                >
                  <option value="">全部状态</option>
                  <option value="indexed">已索引</option>
                  <option value="error">失败</option>
                  <option value="manual_required">待人工</option>
                </select>
              </div>
              <div
                className={'knowledge-document-layout' + (selectedDocument ? ' with-preview' : '')}
              >
                <div className="knowledge-documents">
                  {loading ? (
                    <div className="knowledge-loading" role="status">
                      <Icon name="loading" size={22} />
                      正在加载文档…
                    </div>
                  ) : documents.length === 0 ? (
                    <EmptyState
                      icon={statusFilter ? 'search' : 'document'}
                      title={statusFilter ? '没有符合条件的文档' : '还没有文档'}
                      description={
                        statusFilter
                          ? '试试其他索引状态，或查看全部文档。'
                          : '添加本地来源或上传 Markdown / 文本文件，后台会自动建立索引。'
                      }
                    >
                      {statusFilter && (
                        <Button onClick={() => setStatusFilter('')}>查看全部状态</Button>
                      )}
                    </EmptyState>
                  ) : (
                    <ul className="knowledge-document-list">
                      {documents.map((document) => (
                        <li
                          key={document.id}
                          className={
                            'knowledge-document-row' +
                            (document.id === selectedDocument?.document.id ? ' selected' : '')
                          }
                        >
                          <div className="knowledge-document-row-main">
                            <button
                              type="button"
                              onClick={() => openDocument(document)}
                              className="knowledge-document-open"
                              aria-pressed={document.id === selectedDocument?.document.id}
                              disabled={busy}
                              title={document.relPath}
                            >
                              <span className="knowledge-file-symbol">
                                <Icon name="document" size={18} />
                              </span>
                              <span className="knowledge-document-copy">
                                <strong>{document.name}</strong>
                                <small>{document.relPath}</small>
                              </span>
                            </button>
                            <div className="knowledge-document-status">
                              <Badge
                                tone={
                                  document.status === 'indexed'
                                    ? 'success'
                                    : document.status === 'error'
                                      ? 'danger'
                                      : 'warn'
                                }
                              >
                                {STATUS_LABELS[document.status] ?? document.status}
                              </Badge>
                              <small>
                                {document.chunkCount} 片段 · {humanBytes(document.size)}
                              </small>
                            </div>
                          </div>
                          {document.status === 'manual_required' && (
                            <div className="knowledge-document-action">
                              <span>文档超过自动索引门槛</span>
                              <Button
                                variant="ghost"
                                onClick={() => resubmit(document.id)}
                                disabled={busy}
                              >
                                <Icon name="upload" size={13} />
                                手动提交分析
                              </Button>
                            </div>
                          )}
                          {document.status === 'error' && document.error && (
                            <p className="knowledge-document-error">
                              <Icon name="help" size={14} />
                              {document.error}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {!loading && documents.length >= 200 && (
                    <p className="knowledge-list-note">
                      当前最多显示 200 篇文档，可按来源或索引状态筛选。
                    </p>
                  )}
                </div>
                {selectedDocument && (
                  <aside aria-label="文档预览" className="knowledge-preview">
                    <div className="knowledge-preview-heading">
                      <div>
                        <span>文档预览</span>
                        <h3>{selectedDocument.document.name}</h3>
                      </div>
                      <IconButton
                        name="close"
                        label="关闭文档预览"
                        onClick={() => setSelectedDocument(null)}
                      />
                    </div>
                    <p className="knowledge-preview-note">
                      外部文档内容仅供参考。
                      {selectedDocument.truncated ? ' 当前仅显示部分内容。' : ''}
                    </p>
                    <pre className="knowledge-preview-content">{selectedDocument.content}</pre>
                  </aside>
                )}
              </div>
            </>
          )}

          {view === '检索测试' && (
            <div className="knowledge-search">
              <form
                className="knowledge-search-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!busy && !searching && query.trim()) void runSearch();
                }}
              >
                <Field label="查询内容">
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="输入问题或关键词，例如：项目如何部署？"
                  />
                </Field>
                <Field label="检索方式">
                  <select value={mode} onChange={(event) => setMode(event.target.value)}>
                    <option value="hybrid">混合检索</option>
                    <option value="vector">向量检索</option>
                    <option value="full_text">全文检索</option>
                  </select>
                </Field>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busy || searching || !query.trim()}
                >
                  <Icon name={searching ? 'loading' : 'search'} size={16} />
                  {searching ? '检索中…' : '开始检索'}
                </Button>
                <p>混合检索兼顾语义与关键词；向量检索适合相近含义，全文检索适合精确词句。</p>
              </form>
              {searchResult?.degraded && (
                <p role="status" className="knowledge-message warn">
                  <Icon name="help" size={16} />
                  Embedding 服务暂不可用，已使用全文检索返回结果。
                </p>
              )}
              {searchResult === null ? (
                <EmptyState
                  icon="search"
                  title="试着检索你的知识库"
                  description="输入一个问题，查看相关文档片段与匹配结果。"
                />
              ) : (
                <>
                  <div className="knowledge-search-summary">
                    <strong>{searchResult.results.length} 条匹配片段</strong>
                    <span>
                      “{searchResult.query}” · {MODE_LABELS[searchResult.mode] ?? searchResult.mode}
                      检索
                    </span>
                  </div>
                  <ul className="knowledge-search-results">
                    {searchResult.results.map((hit: SearchHitJson, index) => (
                      <li
                        key={hit.documentId + '-' + hit.lineStart + '-' + index}
                        className="knowledge-search-hit"
                      >
                        <div className="knowledge-search-hit-heading">
                          <span className="knowledge-hit-number">{index + 1}</span>
                          <strong>{hit.documentName}</strong>
                          <span className="knowledge-hit-score">得分 {hit.score.toFixed(4)}</span>
                        </div>
                        <div className="knowledge-search-hit-meta">
                          {hit.sectionPath && <Badge>{hit.sectionPath}</Badge>}
                          <span>
                            行 {hit.lineStart}–{hit.lineEnd}
                          </span>
                        </div>
                        <p>{hit.content}</p>
                      </li>
                    ))}
                  </ul>
                  {searchResult.results.length === 0 && (
                    <EmptyState
                      icon="search"
                      title="没有找到相关片段"
                      description="尝试更换关键词，或检查来源文档是否已完成索引。"
                    />
                  )}
                </>
              )}
            </div>
          )}
        </section>
      </div>

      <Dialog
        open={editingSource !== undefined}
        onClose={() => setEditingRules(null)}
        title="编辑排除规则"
        wide
      >
        {editingSource && (
          <div className="knowledge-rule-editor">
            <div className="knowledge-rule-source">
              <Icon name={editingSource.type === 'local_file' ? 'document' : 'folder'} size={18} />
              <div>
                <strong>{editingSource.name}</strong>
                <p>{editingSource.path}</p>
              </div>
            </div>
            <Field
              label="扫描时跳过的文件或目录"
              hint="每行一条，使用 .gitignore 格式；路径相对于当前来源目录。"
            >
              <textarea
                rows={6}
                value={rulesDraft}
                onChange={(event) => setRulesDraft(event.target.value)}
                placeholder={'*.draft.md\ntemp/\nprivate/'}
                spellCheck={false}
              />
            </Field>
            <div className="knowledge-rule-help">
              <strong>填写示例</strong>
              <dl>
                <div>
                  <dt>*.draft.md</dt>
                  <dd>跳过草稿 Markdown 文件</dd>
                </div>
                <div>
                  <dt>temp/</dt>
                  <dd>跳过 temp 目录及其中的文件</dd>
                </div>
                <div>
                  <dt>private/</dt>
                  <dd>跳过 private 目录及其中的文件</dd>
                </div>
              </dl>
              <p>留空表示不添加自定义规则。隐藏目录、node_modules 和 __pycache__ 始终默认跳过。</p>
            </div>
            {errorText && (
              <p role="alert" className="knowledge-message danger">
                {errorText}
              </p>
            )}
            <div className="knowledge-rule-footer">
              <small>保存后会自动重新扫描，源文件不受影响。</small>
              <div>
                <Button variant="ghost" onClick={() => setEditingRules(null)}>
                  取消
                </Button>
                <Button variant="primary" onClick={() => saveRules(editingSource)} disabled={busy}>
                  {busy ? '保存中…' : '保存排除规则'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
