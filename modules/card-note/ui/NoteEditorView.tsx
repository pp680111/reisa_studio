import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, Field, Icon, IconButton } from '@reisa/ui';
import { parsePageRange, validateQuote } from '../runtime/validation.ts';
import { tabularTextToMarkdown } from '../runtime/markdown.ts';
import {
  deleteNote,
  ensureTag,
  errorMessage,
  getBook,
  getNote,
  getNoteTags,
  listAttachments,
  listTags,
  pickPath,
  probeAttachment,
  readAttachment,
  saveNote,
  type TagJson,
} from './client.ts';
import { MarkdownPreview } from './MarkdownPreview.tsx';

/**
 * 笔记编辑器（源 NoteEditorPage，M2 完成度）：
 * Markdown 工具栏 + 编辑/预览切换（GFM 与 KaTeX 公式）、TSV 粘贴转表格、
 * 图片附件草稿区（≤10MB、PNG/JPEG/WebP；SHA-256 内容寻址随保存落库）。
 * 链接与 AI 建议区已随 R4/R1 移除。
 */

interface AttachmentDraft {
  readonly id: string;
  readonly name: string;
  readonly byteSize: number;
  readonly previewDataUrl: string | null;
  /** 既有附件（DB 已有行）仅保持顺序；新附件携带本地源路径随保存写入。 */
  readonly existing: boolean;
  readonly sourcePath?: string;
}

interface EditorSnapshot {
  quote: string;
  comment: string;
  pageText: string;
  tagIds: string[];
  attachmentIds: string[];
}

const MARKDOWN_TOOLBAR: ReadonlyArray<{
  icon: string;
  label: string;
  prefix: string;
  suffix: string;
  placeholder: string;
}> = [
  { icon: 'heading', label: '标题', prefix: '## ', suffix: '', placeholder: '标题' },
  { icon: 'bold', label: '粗体', prefix: '**', suffix: '**', placeholder: '粗体文字' },
  { icon: 'italic', label: '斜体', prefix: '*', suffix: '*', placeholder: '斜体文字' },
  { icon: 'quote', label: '引用', prefix: '> ', suffix: '', placeholder: '引用内容' },
  { icon: 'list', label: '无序列表', prefix: '- ', suffix: '', placeholder: '列表项' },
  { icon: 'link', label: '链接', prefix: '[', suffix: '](https://)', placeholder: '链接文字' },
  {
    icon: 'table',
    label: '表格',
    prefix: '',
    suffix: '',
    placeholder: '| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |',
  },
  { icon: 'code', label: '代码块', prefix: '```\n', suffix: '\n```', placeholder: '代码' },
];

export function NoteEditorView({
  bookId,
  noteId,
  notify,
  onBack,
  onFinished,
}: {
  bookId: string;
  noteId: string | null;
  notify: (message: string) => void;
  onBack: () => void;
  onFinished: () => void;
}) {
  const [bookTitle, setBookTitle] = useState<string | null>(null);
  const [quote, setQuote] = useState('');
  const [comment, setComment] = useState('');
  const [pageText, setPageText] = useState('');
  const [pageError, setPageError] = useState<string | null>(null);
  const [quoteMode, setQuoteMode] = useState('编辑');
  const [allTags, setAllTags] = useState<TagJson[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [newTagName, setNewTagName] = useState('');
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [snapshot, setSnapshot] = useState<EditorSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const quoteRef = useRef<HTMLTextAreaElement | null>(null);

  const refreshTags = useCallback(async () => {
    try {
      setAllTags(await listTags());
    } catch (error) {
      notify(errorMessage(error));
    }
  }, [notify]);

  useEffect(() => {
    void (async () => {
      try {
        const book = await getBook(bookId);
        if (book === null) {
          notify('书籍不存在或已被删除');
          onBack();
          return;
        }
        setBookTitle(book.title);
        if (noteId !== null) {
          const note = await getNote(noteId);
          if (note === null) {
            notify('笔记不存在或已被删除');
            onBack();
            return;
          }
          const [noteTags, storedAttachments] = await Promise.all([
            getNoteTags(note.id),
            listAttachments(note.id),
          ]);
          const previews = await Promise.all(
            storedAttachments.map((attachment) => readAttachment(attachment.id)),
          );
          const drafts: AttachmentDraft[] = storedAttachments.map((attachment, index) => ({
            id: attachment.id,
            name: attachment.originalFileName,
            byteSize: attachment.byteSize,
            previewDataUrl: previews[index]?.dataUrl ?? null,
            existing: true,
          }));
          setAttachments(drafts);
          const nextPage = {
            quote: note.quote,
            comment: note.comment ?? '',
            pageText:
              note.pageStart === null
                ? ''
                : note.pageStart === note.pageEnd
                  ? String(note.pageStart)
                  : `${note.pageStart}-${note.pageEnd}`,
            tagIds: [...noteTags.map((tag) => tag.id)].sort(),
            attachmentIds: drafts.map((draft) => draft.id),
          };
          setQuote(nextPage.quote);
          setComment(nextPage.comment);
          setPageText(nextPage.pageText);
          setSelectedTagIds(new Set(nextPage.tagIds));
          setSnapshot(nextPage);
        } else {
          setSnapshot({ quote: '', comment: '', pageText: '', tagIds: [], attachmentIds: [] });
        }
      } catch (error) {
        notify(errorMessage(error));
      }
      void refreshTags();
    })();
    // 仅在打开编辑器时加载一次；标签列表另经 refreshTags 刷新。
  }, [bookId, noteId]);

  const dirty = useDirty({
    quote,
    comment,
    pageText,
    selectedTagIds,
    attachments,
    snapshot,
  });

  const handleBack = () => {
    if (dirty && !window.confirm('有未保存的修改，放弃并返回？')) return;
    onBack();
  };

  const insertMarkdown = (prefix: string, suffix: string, placeholder: string) => {
    const element = quoteRef.current;
    const start = element?.selectionStart ?? quote.length;
    const end = element?.selectionEnd ?? quote.length;
    const selected = quote.slice(start, end);
    const content = selected === '' ? placeholder : selected;
    setQuote(quote.slice(0, start) + prefix + content + suffix + quote.slice(end));
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + prefix.length, start + prefix.length + content.length);
    });
  };

  const handleQuotePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const source = event.clipboardData.getData('text/plain');
    if (source === '') return;
    const converted = tabularTextToMarkdown(source);
    if (converted === null) return;
    event.preventDefault();
    const element = event.currentTarget;
    const start = element.selectionStart ?? quote.length;
    const end = element.selectionEnd ?? quote.length;
    setQuote(quote.slice(0, start) + converted + quote.slice(end));
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + converted.length, start + converted.length);
    });
  };

  const handleSave = async () => {
    if (busy || snapshot === null) return;
    try {
      const trimmedQuote = validateQuote(quote);
      let pageStart: number | null = null;
      let pageEnd: number | null = null;
      try {
        setPageError(null);
        const range = parsePageRange(pageText);
        pageStart = range?.start ?? null;
        pageEnd = range?.end ?? null;
      } catch (error) {
        setPageError(error instanceof Error ? error.message : String(error));
        return;
      }
      setBusy(true);
      const result = await saveNote({
        noteId,
        bookId,
        quote: trimmedQuote,
        comment: comment.trim() === '' ? null : comment,
        pageStart,
        pageEnd,
        tagIds: [...selectedTagIds],
        attachments: attachments.map((draft) =>
          draft.existing
            ? { id: draft.id }
            : { id: draft.id, sourcePath: draft.sourcePath, originalFileName: draft.name },
        ),
      });
      notify(`已保存（第 ${result.contentRevision} 版）`);
      onFinished();
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (noteId === null) return;
    if (!window.confirm('删除该笔记？其标签关联与附件将一并删除。')) return;
    try {
      setBusy(true);
      await deleteNote(noteId);
      notify('笔记已删除');
      onFinished();
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const toggleTag = (tagId: string) => {
    setSelectedTagIds((current) => {
      const next = new Set(current);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  };

  const handleCreateTag = async () => {
    const name = newTagName.trim();
    if (name === '') return;
    try {
      const tag = await ensureTag(name);
      setNewTagName('');
      await refreshTags();
      setSelectedTagIds((current) => new Set(current).add(tag.id));
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  const handlePickAttachments = async () => {
    const path = await pickPath('file', ['png', 'jpg', 'jpeg', 'webp']);
    if (path === null) return;
    try {
      const probe = await probeAttachment(path);
      if (!probe.ok) {
        notify(probe.error ?? '所选图片不可用');
        return;
      }
      setAttachments((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          name: probe.originalFileName,
          byteSize: probe.byteSize,
          previewDataUrl: probe.previewDataUrl,
          existing: false,
          sourcePath: path,
        },
      ]);
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  const handleRemoveAttachment = (id: string) => {
    setAttachments((current) => current.filter((draft) => draft.id !== id));
  };

  const handleMoveAttachment = (id: string, delta: number) => {
    setAttachments((current) => {
      const index = current.findIndex((draft) => draft.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (moved !== undefined) next.splice(target, 0, moved);
      return next;
    });
  };

  return (
    <div
      className="card-note-view card-note-editor-view"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          if (!event.nativeEvent.isComposing && quote.trim() !== '') void handleSave();
        }
      }}
    >
      <div className="card-note-toolbar">
        <Button variant="ghost" onClick={handleBack}>
          ← 返回{bookTitle === null ? '' : `「${bookTitle}」`}
        </Button>
        {noteId !== null && (
          <IconButton
            name="trash"
            label="删除笔记"
            disabled={busy}
            onClick={() => void handleDelete()}
          />
        )}
      </div>

      <div className="card-note-section-heading">
        <h1>{noteId === null ? '新建笔记' : '编辑笔记'}</h1>
        <p>摘录值得记住的文字，写下此刻的想法。</p>
      </div>

      <div className="card-note-editor">
        <div className="card-note-editor-main">
          <div className="card-note-editor-section-title">
            <strong>原文摘录</strong>
            <span>支持 Markdown 与公式</span>
          </div>
          <div className="card-note-quote-tools">
            <div className="card-note-markdown-toolbar" aria-label="Markdown 工具栏">
              {MARKDOWN_TOOLBAR.map((item) => (
                <IconButton
                  key={item.label}
                  name={item.icon}
                  label={item.label}
                  disabled={quoteMode !== '编辑'}
                  onClick={() => insertMarkdown(item.prefix, item.suffix, item.placeholder)}
                />
              ))}
            </div>
            <div className="card-note-quote-tabs" role="group" aria-label="原文视图">
              <button
                type="button"
                className={quoteMode === '编辑' ? 'active' : ''}
                aria-pressed={quoteMode === '编辑'}
                onClick={() => setQuoteMode('编辑')}
              >
                编辑
              </button>
              <button
                type="button"
                className={quoteMode === '预览' ? 'active' : ''}
                aria-pressed={quoteMode === '预览'}
                onClick={() => setQuoteMode('预览')}
              >
                预览
              </button>
            </div>
          </div>

          {quoteMode === '编辑' ? (
            <textarea
              ref={quoteRef}
              className="card-note-quote-input"
              aria-label="原文摘录（必填）"
              rows={9}
              value={quote}
              placeholder="粘贴或输入书籍原文（支持 Markdown 与 LaTeX 公式）…"
              onPaste={handleQuotePaste}
              onChange={(event) => setQuote(event.target.value)}
            />
          ) : (
            <div className="card-note-quote-preview">
              {quote.trim() === '' ? (
                <EmptyState
                  icon="document"
                  title="暂无内容"
                  description="原文为空，切回编辑模式填写。"
                />
              ) : (
                <MarkdownPreview source={quote} />
              )}
            </div>
          )}

          <div className="card-note-attachments">
            <div className="card-note-attachments-heading">
              <span>
                图片附件{attachments.length > 0 ? ` · ${attachments.length}` : '（可选）'}
              </span>
              <Button onClick={() => void handlePickAttachments()}>
                <Icon name="image" size={15} />
                添加图片
              </Button>
            </div>
            {attachments.length > 0 && (
              <ul className="card-note-attachment-list">
                {attachments.map((draft, index) => (
                  <li key={draft.id}>
                    {draft.previewDataUrl !== null ? (
                      <img
                        src={draft.previewDataUrl}
                        alt={draft.name}
                        className="card-note-attachment-thumb"
                      />
                    ) : (
                      <span className="card-note-attachment-thumb card-note-attachment-fallback">
                        <Icon name="image" size={18} />
                      </span>
                    )}
                    <div className="card-note-attachment-meta">
                      <span className="card-note-attachment-name">{draft.name}</span>
                      <small>
                        {humanBytes(draft.byteSize)}
                        {draft.existing ? ' · 已保存' : ' · 待保存'}
                      </small>
                    </div>
                    <div className="card-note-row-actions">
                      <IconButton
                        name="arrowUp"
                        label="上移"
                        disabled={index === 0}
                        onClick={() => handleMoveAttachment(draft.id, -1)}
                      />
                      <IconButton
                        name="arrowDown"
                        label="下移"
                        disabled={index === attachments.length - 1}
                        onClick={() => handleMoveAttachment(draft.id, 1)}
                      />
                      <IconButton
                        name="close"
                        label={`移除「${draft.name}」`}
                        onClick={() => handleRemoveAttachment(draft.id)}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Field label="备注（可选）">
            <textarea
              rows={3}
              value={comment}
              placeholder="你的想法、追问或延伸阅读线索…"
              onChange={(event) => setComment(event.target.value)}
            />
          </Field>
        </div>
        <aside className="card-note-editor-aside" aria-label="笔记信息">
          <div className="card-note-editor-section-title">
            <strong>笔记信息</strong>
          </div>
          <Field label="页码（可选）" hint="单页填 12，范围填 12-15。">
            <input
              className={pageError === null ? '' : 'card-note-input-invalid'}
              aria-invalid={pageError !== null}
              aria-describedby={pageError !== null ? 'card-note-page-error' : undefined}
              value={pageText}
              placeholder="例如：12 或 12-15"
              onChange={(event) => {
                setPageText(event.target.value);
                setPageError(null);
              }}
            />
          </Field>
          {pageError !== null && (
            <p id="card-note-page-error" role="alert" className="card-note-message danger">
              {pageError}
            </p>
          )}

          <div className="card-note-tags-block">
            <span className="card-note-tags-label">标签（可选）</span>
            {allTags.length > 0 && (
              <div className="card-note-tag-picker">
                {allTags.map((tag) => {
                  const selected = selectedTagIds.has(tag.id);
                  return (
                    <button
                      type="button"
                      key={tag.id}
                      className={selected ? 'card-note-chip active' : 'card-note-chip'}
                      aria-pressed={selected}
                      onClick={() => toggleTag(tag.id)}
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="card-note-tag-create">
              <input
                aria-label="新标签名称"
                value={newTagName}
                placeholder="输入新标签…"
                onChange={(event) => setNewTagName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing)
                    void handleCreateTag();
                }}
              />
              <Button disabled={newTagName.trim() === ''} onClick={() => void handleCreateTag()}>
                添加
              </Button>
            </div>
          </div>
          <p className="card-note-editor-hint">标签在所有书籍间共享。选中标签，为这条笔记分类。</p>
        </aside>

        <div className="card-note-editor-footer">
          <small role="status">
            {snapshot === null
              ? '正在加载…'
              : busy
                ? '正在保存…'
                : dirty
                  ? '有未保存的修改'
                  : noteId === null
                    ? '开始记录你的第一段摘录'
                    : '所有修改已保存'}
          </small>
          <div>
            <span className="card-note-shortcut">Ctrl / ⌘ S 保存</span>
            <Button variant="ghost" onClick={handleBack}>
              返回
            </Button>
            <Button
              variant="primary"
              disabled={busy || snapshot === null || quote.trim() === ''}
              onClick={() => void handleSave()}
            >
              {busy ? '保存中…' : '保存笔记'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 脏检查：文本字段 + 标签集合 + 附件草稿顺序（附件仅随保存落库，也纳入守卫）。 */
function useDirty(input: {
  quote: string;
  comment: string;
  pageText: string;
  selectedTagIds: Set<string>;
  attachments: AttachmentDraft[];
  snapshot: EditorSnapshot | null;
}): boolean {
  const { quote, comment, pageText, selectedTagIds, attachments, snapshot } = input;
  return useMemo(() => {
    if (snapshot === null) return false;
    if (quote !== snapshot.quote) return true;
    if (comment !== snapshot.comment) return true;
    if (pageText.trim() !== snapshot.pageText) return true;
    const currentTags = [...selectedTagIds].sort();
    if (currentTags.length !== snapshot.tagIds.length) return true;
    if (currentTags.some((id, index) => id !== snapshot.tagIds[index])) return true;
    const currentAttachments = attachments.map((draft) => draft.id);
    if (currentAttachments.length !== snapshot.attachmentIds.length) return true;
    return currentAttachments.some((id, index) => id !== snapshot.attachmentIds[index]);
  }, [quote, comment, pageText, selectedTagIds, attachments, snapshot]);
}

function humanBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
