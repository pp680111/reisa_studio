import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PublicResult } from '@reisa/module-sdk';
import { Badge, Button, EmptyState, Icon, IconButton } from '@reisa/ui';
import { ToolCallRecord } from './ToolCallRecord';

export interface Conversation {
  id: string;
  title: string;
  draft: string;
  messages: { id: string; text: string; role: 'user' | 'notice' }[];
  attachments: { id: string; name: string }[];
  sample?: boolean;
}
export function createConversation(): Conversation {
  return { id: crypto.randomUUID(), title: '新建会话', draft: '', messages: [], attachments: [] };
}
const suggestions = [
  {
    id: 'knowledge',
    icon: 'book',
    title: '整理我的资料',
    description: '从零散信息到清晰的知识',
    prompt: '帮我整理资料，提炼重点并保留来源。',
  },
  {
    id: 'image',
    icon: 'image',
    title: '探索视觉灵感',
    description: '用一句描述开始新的创作',
    prompt: '我想创作一张极简风格的品牌宣传图，请先帮我完善画面描述。',
  },
  {
    id: 'project',
    icon: 'folder',
    title: '推进一个项目',
    description: '连接素材、想法与下一步',
    prompt: '帮我查看项目，整理现有素材与下一步计划。',
  },
];

export function ConversationView({
  conversation,
  update,
  capabilityCount,
  openCapabilities,
  enabledIds,
  notify,
  renderResult,
}: {
  conversation: Conversation;
  update: (next: Conversation) => void;
  capabilityCount: number;
  openCapabilities: () => void;
  enabledIds: readonly string[];
  notify: (message: string) => void;
  renderResult: (result: PublicResult) => ReactNode;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState(false);
  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ block: 'end' });
  }, [conversation.messages.length]);
  const submit = () => {
    const text = conversation.draft.trim();
    if (!text && !conversation.attachments.length) return;
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
  };
  return (
    <div className={`conversation-layout ${results ? 'with-results' : ''}`}>
      <div className="conversation-column">
        <div className="conversation-scroll">
          {!conversation.messages.length && !conversation.sample ? (
            <div className="welcome">
              <div className="welcome-orbit">
                <div className="welcome-mark">
                  <Icon name="sparkles" size={34} />
                </div>
                <span className="orbit-dot" />
              </div>
              <span className="eyebrow">A LITTLE SPACE FOR BIG IDEAS</span>
              <h1>
                想法在这里，
                <br />
                <span>慢慢成为现实。</span>
              </h1>
              <p>
                聊聊你的灵感，整理手边的资料，
                <br className="mobile-break" />
                或开始一段新的创作。
              </p>
              <div className="suggestion-grid">
                {suggestions
                  .filter((item) => enabledIds.includes(item.id))
                  .map((item) => (
                    <button
                      key={item.id}
                      className="suggestion-card"
                      onClick={() => {
                        update({ ...conversation, draft: item.prompt });
                        input.current?.focus();
                      }}
                    >
                      <span className="suggestion-icon">
                        <Icon name={item.icon} size={21} />
                      </span>
                      <strong>{item.title}</strong>
                      <small>{item.description}</small>
                      <Icon name="arrowRight" size={16} />
                    </button>
                  ))}
              </div>
              <div className="welcome-footnote">
                <span className="status-dot" />
                一个会话，连接你的工作空间
              </div>
            </div>
          ) : (
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
              {conversation.messages.map((message) =>
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
                  label="添加附件（只展示文件名）"
                  onClick={() => fileInput.current?.click()}
                />
                <button className="capability-trigger" onClick={openCapabilities}>
                  <Icon name="layers" size={15} />
                  {capabilityCount} 项能力声明
                  <Icon name="chevronDown" size={13} />
                </button>
              </div>
              <button
                className="send-button"
                aria-label="发送消息"
                title="发送消息"
                disabled={!conversation.draft.trim() && !conversation.attachments.length}
                onClick={submit}
              >
                <Icon name="arrowUp" size={19} />
              </button>
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
                }));
                update({ ...conversation, attachments: [...conversation.attachments, ...files] });
                e.target.value = '';
              }}
            />
          </div>
          <div className="composer-footnote">
            <span>界面预览 · 模型与工具服务尚未接入</span>
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
