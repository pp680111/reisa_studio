import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PublicResult } from '@reisa/module-sdk';
import { Badge, Button, EmptyState, Icon, IconButton } from '@reisa/ui';
import { ToolCallRecord, type ToolStatus } from './ToolCallRecord';
import type { ReisaAttachmentInput, ReisaBridge, ReisaEvent, ReisaMessage } from '../bridge';

export interface Conversation {
  id: string;
  title: string;
  draft: string;
  messages: { id: string; text: string; role: 'user' | 'notice' }[];
  attachments: { id: string; name: string; file?: File }[];
  sample?: boolean;
}
export function createConversation(): Conversation {
  return { id: crypto.randomUUID(), title: '新建会话', draft: '', messages: [], attachments: [] };
}

/** 用户消息中附件块的起始分隔符（由主进程合成，见 conversation-manager）。 */
const ATTACHMENT_DELIMITER = '--- 附件：';

/** 用户消息展示：截去附件内联内容，只显示正文与附件摘要。 */
export function displayUserText(text: string): string {
  const cut = text.indexOf(`\n\n${ATTACHMENT_DELIMITER}`);
  const head = cut === -1 ? text : text.slice(0, cut);
  const names =
    cut === -1 ? [] : [...text.slice(cut).matchAll(/--- 附件：(.+?) ---/g)].map((m) => m[1]);
  if (names.length === 0) return head;
  return `${head}\n附件：${names.join('、')}`;
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < buffer.length; offset += chunk) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** 会话条目：持久化消息与实时事件合成的展示单元。 */
type Entry =
  | { kind: 'text'; role: 'user' | 'assistant'; text: string }
  | {
      kind: 'tool';
      toolCallId: string;
      toolName: string;
      status: ToolStatus;
      input?: unknown;
      output?: unknown;
      error?: string;
    };

function unwrapOutput(output: unknown): unknown {
  if (
    output &&
    typeof output === 'object' &&
    (output as { type?: unknown }).type === 'json' &&
    'value' in output
  ) {
    return (output as { value: unknown }).value;
  }
  return output;
}

function messagesToEntries(messages: ReisaMessage[]): Entry[] {
  const entries: Entry[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : '';
      if (text) entries.push({ kind: 'text', role: 'user', text: displayUserText(text) });
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    if (message.role === 'assistant') {
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('');
      if (text) entries.push({ kind: 'text', role: 'assistant', text });
      for (const part of message.content) {
        if (part.type === 'tool-call' && part.toolCallId) {
          entries.push({
            kind: 'tool',
            toolCallId: String(part.toolCallId),
            toolName: String(part.toolName ?? ''),
            status: 'completed',
            input: part.input,
          });
        }
      }
    }
    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type === 'tool-result' && part.toolCallId) {
          const entry = [...entries]
            .reverse()
            .find((item) => item.kind === 'tool' && item.toolCallId === part.toolCallId);
          if (entry && entry.kind === 'tool') entry.output = unwrapOutput(part.output);
        }
      }
    }
  }
  return entries;
}

function applyEvent(entries: Entry[], event: ReisaEvent): Entry[] {
  switch (event.type) {
    case 'text-delta': {
      const last = entries[entries.length - 1];
      if (last && last.kind === 'text' && last.role === 'assistant') {
        return [...entries.slice(0, -1), { ...last, text: last.text + event.text }];
      }
      return [...entries, { kind: 'text', role: 'assistant', text: event.text }];
    }
    case 'tool-call':
      return [
        ...entries,
        {
          kind: 'tool',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: 'running',
          input: event.input,
        },
      ];
    case 'tool-result':
      return entries.map((entry) =>
        entry.kind === 'tool' && entry.toolCallId === event.toolCallId
          ? { ...entry, status: 'completed', output: event.output }
          : entry,
      );
    case 'tool-error':
      return entries.map((entry) =>
        entry.kind === 'tool' && entry.toolCallId === event.toolCallId
          ? { ...entry, status: 'failed', error: `${event.error.code}: ${event.error.message}` }
          : entry,
      );
    case 'finish':
      return event.reason === 'abort'
        ? entries.map((entry) =>
            entry.kind === 'tool' && entry.status === 'running'
              ? { ...entry, status: 'cancelled' }
              : entry,
          )
        : entries;
    default:
      return entries;
  }
}

function summarizeOutput(output: unknown): string {
  try {
    const json = JSON.stringify(output);
    if (json === undefined) return '';
    return json.length > 300 ? `${json.slice(0, 300)}…` : json;
  } catch {
    return '';
  }
}

export function ConversationView({
  conversation,
  update,
  capabilityCount,
  openCapabilities,
  notify,
  renderResult,
  bridge,
  toolAction,
}: {
  conversation: Conversation;
  update: (next: Conversation) => void;
  capabilityCount: number;
  openCapabilities: () => void;
  notify: (message: string) => void;
  renderResult: (result: PublicResult) => ReactNode;
  /** 桌面运行时桥；浏览器预览下为 undefined，走本地演示模式。 */
  bridge?: ReisaBridge;
  toolAction?: (toolName: string) => string;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [running, setRunning] = useState(false);
  const [lastUsage, setLastUsage] = useState<{
    inputTokens?: number;
    outputTokens?: number;
  } | null>(null);
  const runningRef = useRef(false);

  const load = useCallback(async () => {
    if (!bridge) return;
    const messages = await bridge.conversation.getMessages(conversation.id);
    setEntries(messagesToEntries(messages));
  }, [bridge, conversation.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.conversation.onEvent(({ conversationId, event }) => {
      if (conversationId !== conversation.id) return;
      setEntries((previous) => applyEvent(previous, event));
    });
  }, [bridge, conversation.id]);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ block: 'end' });
  }, [conversation.messages.length, entries.length]);

  const submit = () => {
    const text = conversation.draft.trim();
    if (!text && !conversation.attachments.length) return;
    if (!bridge) {
      update({
        ...conversation,
        title:
          conversation.messages.length === 0 ? text.slice(0, 20) || '附件会话' : conversation.title,
        draft: '',
        attachments: [],
        messages: [
          ...conversation.messages,
          {
            id: crypto.randomUUID(),
            role: 'user',
            text:
              text +
              (conversation.attachments.length
                ? `\n附件：${conversation.attachments.map((file) => file.name).join('、')}`
                : ''),
          },
          {
            id: crypto.randomUUID(),
            role: 'notice',
            text: '消息已保留在当前界面。Agent 与模型服务尚未连接，未执行任何工具或生成回答。',
          },
        ],
      });
      return;
    }
    void submitReal(text);
  };

  const submitReal = async (text: string) => {
    if (!bridge || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setLastUsage(null);
    const isFirst = entries.length === 0;
    const outgoing = conversation.attachments;
    update({
      ...conversation,
      title: isFirst ? text.slice(0, 20) || '新会话' : conversation.title,
      draft: '',
      attachments: [],
    });
    setEntries((previous) => [
      ...previous,
      {
        kind: 'text',
        role: 'user',
        text:
          text + (outgoing.length ? `\n附件：${outgoing.map((file) => file.name).join('、')}` : ''),
      },
    ]);
    try {
      const attachments: ReisaAttachmentInput[] = [];
      for (const file of outgoing) {
        if (!file.file) continue;
        attachments.push({
          name: file.name,
          ...(file.file.type ? { mediaType: file.file.type } : {}),
          dataBase64: await fileToBase64(file.file),
        });
      }
      const result = await bridge.conversation.send(conversation.id, text, attachments);
      if (result.usage) setLastUsage(result.usage);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    } finally {
      runningRef.current = false;
      setRunning(false);
      await load();
    }
  };

  const stop = () => {
    void bridge?.conversation.cancel(conversation.id);
  };

  const showWelcome = bridge
    ? entries.length === 0 && !running
    : !conversation.messages.length && !conversation.sample;

  const toolOutputs = bridge
    ? entries.filter(
        (entry): entry is Extract<Entry, { kind: 'tool' }> =>
          entry.kind === 'tool' && entry.output !== undefined,
      )
    : [];

  return (
    <div className={`conversation-layout ${results ? 'with-results' : ''}`}>
      <div className="conversation-column">
        <div className="conversation-scroll">
          {showWelcome ? null : (
            <div className="message-list">
              {conversation.sample && (
                <>
                  <div className="sample-label">
                    <Badge>示例会话</Badge>
                    <span>以下内容与调用记录仅用于展示界面</span>
                  </div>
                  <div className="user-message">整理 NOVA 的品牌方向，帮我构思一份发布计划。</div>
                  <div className="assistant-message">
                    <div className="assistant-heading">
                      <span className="assistant-avatar">R</span>
                      <strong>Reisa</strong>
                      <span>界面示例</span>
                    </div>
                    <div className="assistant-body">
                      <p>可以从品牌表达、视觉方向和发布节奏三个方面开始整理。</p>
                      <ToolCallRecord
                        action="检索品牌资料"
                        name="knowledge__search"
                        status="completed"
                        sample
                        parameters={{ query: 'NOVA 品牌方向', source: '界面示例，未执行真实调用' }}
                        summary="返回 2 个相关片段（示例）"
                      />
                      <h3>为灵感建立一个清晰的起点</h3>
                      <p>
                        用简洁、自然、有温度的表达连接创作者。视觉上保持留白，把内容与真实的生活细节放在前面。
                      </p>
                      <ul>
                        <li>
                          <strong>品牌表达：</strong>围绕「让灵感自然发生」构建文案。
                        </li>
                        <li>
                          <strong>视觉方向：</strong>柔和的中性色、简洁的构图。
                        </li>
                        <li>
                          <strong>发布准备：</strong>整理素材、核对文案，再完善发布清单。
                        </li>
                      </ul>
                      <button className="source-reference" onClick={() => setResults(true)}>
                        <Icon name="document" size={14} />
                        品牌概览 · 示例来源
                        <Icon name="arrowRight" size={13} />
                      </button>
                      <div className="assistant-actions">
                        <IconButton
                          name="copy"
                          label="复制示例回答"
                          onClick={() => {
                            void navigator.clipboard
                              .writeText('NOVA 品牌方向：简洁、自然、有温度。')
                              .then(() => notify('已复制示例回答'))
                              .catch(() => notify('无法访问剪贴板'));
                          }}
                        />
                        <Button variant="ghost" onClick={() => setResults(!results)}>
                          <Icon name="result" size={16} />
                          本次结果
                        </Button>
                      </div>
                    </div>
                  </div>
                </>
              )}
              {!bridge &&
                conversation.messages.map((message) =>
                  message.role === 'user' ? (
                    <div className="user-message" key={message.id}>
                      {message.text}
                    </div>
                  ) : (
                    <div className="connection-notice" key={message.id}>
                      <Icon name="help" />
                      <p>{message.text}</p>
                    </div>
                  ),
                )}
              {bridge &&
                entries.map((entry, index) =>
                  entry.kind === 'text' ? (
                    entry.role === 'user' ? (
                      <div className="user-message" key={`${entry.role}-${index}`}>
                        {entry.text}
                      </div>
                    ) : (
                      <div className="assistant-message" key={`assistant-${index}`}>
                        <div className="assistant-heading">
                          <span className="assistant-avatar">R</span>
                          <strong>Reisa</strong>
                        </div>
                        <div className="assistant-body markdown">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown>
                        </div>
                      </div>
                    )
                  ) : (
                    <ToolCallRecord
                      key={entry.toolCallId}
                      action={toolAction?.(entry.toolName) ?? entry.toolName}
                      name={entry.toolName}
                      status={entry.status}
                      parameters={entry.input as Record<string, unknown> | undefined}
                      summary={
                        entry.output !== undefined ? summarizeOutput(entry.output) : undefined
                      }
                      error={entry.error}
                    />
                  ),
                )}
              {lastUsage && !running && (
                <div className="usage-line" title="服务商上报的本次运行整体用量，仅用于展示">
                  本轮用量 · 输入 {lastUsage.inputTokens ?? '—'} tokens · 输出{' '}
                  {lastUsage.outputTokens ?? '—'} tokens
                </div>
              )}
              <div ref={messagesEnd} />
            </div>
          )}
        </div>
        <div className="composer-area">
          <div className="composer">
            {conversation.attachments.length > 0 && (
              <div className="attachment-list">
                {conversation.attachments.map((file) => (
                  <span key={file.id}>
                    <Icon name="file" size={14} />
                    {file.name}
                    <IconButton
                      name="close"
                      label={`移除附件${file.name}`}
                      onClick={() =>
                        update({
                          ...conversation,
                          attachments: conversation.attachments.filter((f) => f.id !== file.id),
                        })
                      }
                    />
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={input}
              rows={3}
              aria-label="会话消息"
              placeholder="写下你的想法，让我们从这里开始…"
              value={conversation.draft}
              onChange={(e) => update({ ...conversation, draft: e.target.value })}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  e.keyCode !== 229
                ) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <div className="composer-controls">
              <div>
                <IconButton
                  name="attach"
                  label={
                    bridge
                      ? '添加附件（文本内容随消息发送，其余保存副本）'
                      : '添加附件（只展示文件名）'
                  }
                  onClick={() => fileInput.current?.click()}
                />
                <button className="capability-trigger" onClick={openCapabilities}>
                  <Icon name="layers" size={15} />
                  {capabilityCount} 项能力
                  <Icon name="chevronDown" size={13} />
                </button>
              </div>
              {running ? (
                <button className="send-button" aria-label="停止生成" title="停止" onClick={stop}>
                  <Icon name="stop" size={17} />
                </button>
              ) : (
                <button
                  className="send-button"
                  aria-label="发送消息"
                  title="发送消息"
                  disabled={!conversation.draft.trim() && !conversation.attachments.length}
                  onClick={submit}
                >
                  <Icon name="arrowUp" size={19} />
                </button>
              )}
            </div>
            <input
              type="file"
              multiple
              hidden
              ref={fileInput}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []).map((file) => ({
                  id: crypto.randomUUID(),
                  name: file.name,
                  file,
                }));
                update({ ...conversation, attachments: [...conversation.attachments, ...files] });
                e.target.value = '';
              }}
            />
          </div>
          <div className="composer-footnote">
            <span>
              {bridge
                ? '已连接桌面运行时 · 工具调用会真实执行'
                : '界面预览 · 模型与工具服务尚未接入'}
            </span>
            <span>Enter 发送 · Shift + Enter 换行</span>
          </div>
        </div>
      </div>
      {results && (
        <aside className="result-panel">
          <div className="result-header">
            <h3>本次返回的内容</h3>
            <IconButton name="close" label="关闭结果面板" onClick={() => setResults(false)} />
          </div>
          {conversation.sample ? (
            renderResult({
              id: 'sample-brand-reference',
              ownerModuleId: 'knowledge',
              type: 'resource-reference',
              title: '品牌概览',
              summary: '简洁、自然、有温度的品牌表达。',
              resourceId: 'sample-brand',
              sample: true,
            })
          ) : bridge ? (
            toolOutputs.length > 0 ? (
              toolOutputs.map((entry) => (
                <div className="capability-row" key={entry.toolCallId}>
                  <code>{entry.toolName}</code>
                  <pre>{summarizeOutput(entry.output)}</pre>
                </div>
              ))
            ) : (
              <EmptyState
                icon="result"
                title="还没有返回结果"
                description="这里只展示本次能力调用明确返回的内容。"
              />
            )
          ) : (
            <EmptyState
              icon="result"
              title="还没有返回结果"
              description="这里只展示本次能力调用明确返回的内容。"
            />
          )}
        </aside>
      )}
    </div>
  );
}
