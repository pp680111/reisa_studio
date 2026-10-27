import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Icon, IconButton } from '@reisa/ui';
import { validateNoteContent } from '../domain/validation.ts';
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
import { MarkdownEditor } from './MarkdownEditor.tsx';

/**
 * 笔记编辑器（源 NoteEditorPage，M2 完成度 + v0.2 结构调整）：
 * 笔记正文与原文摘录均为 Markdown 编辑（工具栏 + 编辑/预览切换 + TSV 粘贴，共用 MarkdownEditor）；
 * 摘录改为可选并支持折叠（仅视图状态，不清除已填内容）——摘录与正文至少其一非空即可保存。
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
  tagIds: string[];
  attachmentIds: string[];
}

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
  const [quoteExpanded, setQuoteExpanded] = useState(false);
  // 页码编辑已移除：既有页码仅在加载时读入，保存时原样写回，避免旧笔记数据被清空。
  const [storedPages, setStoredPages] = useState<{ start: number | null; end: number | null }>({
    start: null,
    end: null,
  });
  const [allTags, setAllTags] = useState<TagJson[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [newTagName, setNewTagName] = useState('');
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [snapshot, setSnapshot] = useState<EditorSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

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
          notify('笔记本不存在或已被删除');
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
          setStoredPages({ start: note.pageStart, end: note.pageEnd });
          const nextPage = {
            quote: note.quote,
            comment: note.comment ?? '',
            tagIds: [...noteTags.map((tag) => tag.id)].sort(),
            attachmentIds: drafts.map((draft) => draft.id),
          };
          setQuote(nextPage.quote);
          setComment(nextPage.comment);
          setQuoteExpanded(nextPage.quote !== '');
          setSelectedTagIds(new Set(nextPage.tagIds));
          setSnapshot(nextPage);
        } else {
          setSnapshot({ quote: '', comment: '', tagIds: [], attachmentIds: [] });
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
    selectedTagIds,
    attachments,
    snapshot,
  });

  const handleBack = () => {
    if (dirty && !window.confirm('有未保存的修改，放弃并返回？')) return;
    onBack();
  };

  const handleSave = async () => {
    if (busy || snapshot === null) return;
    try {
      const trimmedQuote = validateNoteContent(quote, comment);
      setBusy(true);
      const result = await saveNote({
        noteId,
        bookId,
        quote: trimmedQuote,
        comment: comment.trim() === '' ? null : comment,
        pageStart: storedPages.start,
        pageEnd: storedPages.end,
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

  const hasContent = quote.trim() !== '' || comment.trim() !== '';

  return (
    <div
      className="card-note-view card-note-editor-view"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          if (!event.nativeEvent.isComposing && hasContent) void handleSave();
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
        <p>写下此刻的想法，也可以先摘录原文再作批注。</p>
      </div>

      <div className="card-note-editor">
        <div className="card-note-editor-main">
          <div className="card-note-quote-section">
            <button
              type="button"
              className="card-note-quote-toggle"
              aria-expanded={quoteExpanded}
              onClick={() => setQuoteExpanded((current) => !current)}
            >
              <strong>原文摘录</strong>
              <span className="card-note-quote-toggle-hint">
                {quoteExpanded
                  ? '支持 Markdown 与公式'
                  : quote.trim() === ''
                    ? '点击添加'
                    : '已填写 · 点击编辑'}
              </span>
              <Icon
                name={quoteExpanded ? 'arrowUp' : quote.trim() === '' ? 'plus' : 'arrowDown'}
                size={15}
              />
            </button>
            {quoteExpanded && (
              <MarkdownEditor
                value={quote}
                onChange={setQuote}
                ariaLabel="原文摘录（可选）"
                placeholder="粘贴或输入原文（支持 Markdown 与 LaTeX 公式）…"
              />
            )}
          </div>

          <div className="card-note-editor-section-title">
            <strong>笔记正文</strong>
            <span>支持 Markdown 与公式</span>
          </div>
          <MarkdownEditor
            value={comment}
            onChange={setComment}
            ariaLabel="笔记正文"
            rows={10}
            placeholder="写下你的想法、追问或延伸阅读线索…"
          />

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
        </div>
        <aside className="card-note-editor-aside" aria-label="笔记信息">
          <div className="card-note-editor-section-title">
            <strong>笔记信息</strong>
          </div>

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
          <p className="card-note-editor-hint">
            标签在所有笔记本间共享。选中标签，为这条笔记分类。
          </p>
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
                    ? ''
                    : '所有修改已保存'}
          </small>
          <div>
            <span className="card-note-shortcut">Ctrl / ⌘ S 保存</span>
            <Button variant="ghost" onClick={handleBack}>
              返回
            </Button>
            <Button
              variant="primary"
              disabled={busy || snapshot === null || !hasContent}
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
  selectedTagIds: Set<string>;
  attachments: AttachmentDraft[];
  snapshot: EditorSnapshot | null;
}): boolean {
  const { quote, comment, selectedTagIds, attachments, snapshot } = input;
  return useMemo(() => {
    if (snapshot === null) return false;
    if (quote !== snapshot.quote) return true;
    if (comment !== snapshot.comment) return true;
    const currentTags = [...selectedTagIds].sort();
    if (currentTags.length !== snapshot.tagIds.length) return true;
    if (currentTags.some((id, index) => id !== snapshot.tagIds[index])) return true;
    const currentAttachments = attachments.map((draft) => draft.id);
    if (currentAttachments.length !== snapshot.attachmentIds.length) return true;
    return currentAttachments.some((id, index) => id !== snapshot.attachmentIds[index]);
  }, [quote, comment, selectedTagIds, attachments, snapshot]);
}

function humanBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
