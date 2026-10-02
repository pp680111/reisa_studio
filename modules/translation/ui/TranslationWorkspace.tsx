import { useState } from 'react';
import type { ModulePageProps } from '@reisa/module-sdk';
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Icon,
  IconButton,
  PageHeading,
  pending,
} from '@reisa/ui';
export function TranslationWorkspace({ openSettings, notify }: ModulePageProps) {
  const [source, setSource] = useState('');
  const [result, setResult] = useState('');
  const [sourceLanguage, setSourceLanguage] = useState('自动识别');
  const [targetLanguage, setTargetLanguage] = useState('英语');
  const [style, setStyle] = useState('自然流畅');
  const [glossary, setGlossary] = useState(false);
  const [term, setTerm] = useState('');
  const languages = ['简体中文', '英语', '日语', '韩语', '法语'];
  return (
    <div className="module-layout">
      <aside className="local-nav">
        <Button
          onClick={() => {
            setSource('');
            setResult('');
          }}
        >
          <Icon name="plus" />
          新建翻译
        </Button>
        <div className="local-nav-heading history-label">翻译历史</div>
        <div className="history-sidebar-empty">
          <Icon name="history" />
          <p>还没有保存的翻译</p>
          <small>每一次表达，都值得留下</small>
        </div>
        <div className="local-note">
          <Icon name="translation" />
          <p>
            历史与术语表
            <br />
            仅属于翻译模块。
          </p>
        </div>
      </aside>
      <div className="module-main">
        <PageHeading
          eyebrow="TRANSLATION"
          title="好的表达，不止一种语言"
          description="保留意思，也保留语气与细节。"
        >
          <Button onClick={() => setGlossary(true)}>
            <Icon name="book" />
            术语表
          </Button>
          <Button onClick={openSettings}>
            <Icon name="sliders" />
            模块设置
          </Button>
        </PageHeading>
        <div className="translation-model">
          <Icon name="sparkles" />
          <span>翻译模型</span>
          <select aria-label="翻译模型">
            <option>尚未配置服务</option>
          </select>
        </div>
        <div className="translation-editors">
          <section className="translation-pane">
            <div className="editor-heading">
              <select
                aria-label="源语言"
                value={sourceLanguage}
                onChange={(e) => setSourceLanguage(e.target.value)}
              >
                {['自动识别', ...languages].map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
              <span className="muted">原文</span>
            </div>
            <textarea
              aria-label="翻译原文"
              placeholder="输入想要翻译的文本…"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onKeyDown={(e) => {
                if (
                  (e.ctrlKey || e.metaKey) &&
                  e.key === 'Enter' &&
                  !e.nativeEvent.isComposing &&
                  source.trim()
                ) {
                  e.preventDefault();
                  pending(notify, '翻译');
                }
              }}
            />
            <div className="editor-footer">
              <span>{Array.from(source).length} 字符</span>
              <IconButton name="trash" label="清空原文" onClick={() => setSource('')} />
            </div>
          </section>
          <button
            className="language-swap icon-button"
            aria-label="交换语言与文本"
            title="交换语言与文本"
            onClick={() => {
              if (sourceLanguage === '自动识别') {
                notify('源语言尚未识别，请先选择明确的源语言。');
                return;
              }
              setSourceLanguage(targetLanguage);
              setTargetLanguage(sourceLanguage);
              setSource(result);
              setResult(source);
            }}
          >
            <Icon name="swap" />
          </button>
          <section className="translation-pane result-pane">
            <div className="editor-heading">
              <select
                aria-label="目标语言"
                value={targetLanguage}
                onChange={(e) => {
                  setTargetLanguage(e.target.value);
                  if (result) notify('目标语言已改变，当前译文尚未重新生成。');
                }}
              >
                {languages.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
              <span className="muted">译文</span>
            </div>
            {result ? (
              <textarea aria-label="译文" readOnly value={result} />
            ) : (
              <EmptyState
                icon="translation"
                title="让文字抵达另一种语言"
                description="翻译结果将显示在这里"
              />
            )}
            <div className="editor-footer">
              <span>尚未连接翻译服务</span>
              <IconButton
                name="copy"
                label="复制译文"
                disabled={!result}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(result)
                    .then(() => notify('已复制译文'))
                    .catch(() => notify('无法访问剪贴板'));
                }}
              />
            </div>
          </section>
        </div>
        <div className="translation-controls">
          <Field label="表达风格">
            <select value={style} onChange={(e) => setStyle(e.target.value)}>
              {['自然流畅', '正式专业', '简洁直接', '文学表达'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <div>
            <Button disabled={!result} onClick={() => pending(notify, '保存翻译历史')}>
              <Icon name="history" />
              保存到历史
            </Button>
            <Button
              variant="primary"
              disabled={!source.trim()}
              onClick={() => pending(notify, '翻译')}
            >
              <Icon name="translation" />
              开始翻译
            </Button>
          </div>
        </div>
        <p className="muted compact-note">Ctrl / ⌘ + Enter 翻译 · 直接使用翻译模块，不经过主会话</p>
      </div>
      <Dialog open={glossary} onClose={() => setGlossary(false)} title="翻译术语表">
        <div className="settings-form">
          <p className="muted">为专有名词约定表达，保持翻译一致。</p>
          <Field label="原词与译法">
            <textarea
              rows={5}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="例如：灵感 → inspiration"
            />
          </Field>
          <Button variant="primary" onClick={() => pending(notify, '保存术语表')}>
            保存术语表
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
