import { useState } from 'react';
import type { ModulePageProps } from '@reisa/module-sdk';
import { Badge, Button, EmptyState, Icon, PageHeading, Tabs, pending } from '@reisa/ui';

const documents = [
  {
    name: '品牌与产品概览.md',
    type: 'Markdown',
    date: '10 月 02 日',
    content: 'NOVA 品牌与产品概览',
    text: 'NOVA 是一个探索日常灵感的创作品牌。我们相信，好的设计来自对生活的观察，以及将想法付诸实践的勇气。',
    section: '品牌表达',
    body: '简洁、自然、有温度。让每个触点都传达一致的品牌体验，为创作者保留自由表达的空间。',
  },
  {
    name: '视觉规范.pdf',
    type: 'PDF',
    date: '10 月 01 日',
    content: '视觉规范',
    text: '通过留白、克制的色彩和清晰的文字层级，构建统一且易于阅读的视觉系统。',
    section: '设计原则',
    body: '优先考虑可读性与内容结构。所有示例内容仅用于呈现界面。',
  },
  {
    name: '发布计划.md',
    type: 'Markdown',
    date: '09 月 28 日',
    content: '发布计划',
    text: '从构想开始，逐步完成内容整理、视觉创作与成果归档。',
    section: '下一步',
    body: '完善项目素材，核对文案，整理发布清单。',
  },
];
export function KnowledgeWorkspace({ openSettings, notify }: ModulePageProps) {
  const [collection, setCollection] = useState('品牌资料');
  const [tab, setTab] = useState('文档');
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const doc = documents[selected]!;
  return (
    <div className="module-layout">
      <aside className="local-nav">
        <div className="local-nav-heading">
          我的知识库
          <Button
            variant="ghost"
            aria-label="新建知识库"
            onClick={() => pending(notify, '新建知识库')}
          >
            <Icon name="plus" size={16} />
          </Button>
        </div>
        {['品牌资料', '灵感收集', '未分类'].map((name, i) => (
          <button
            key={name}
            className={`local-item ${collection === name ? 'active' : ''}`}
            onClick={() => setCollection(name)}
          >
            <Icon name="folder" />
            <span>{name}</span>
            <small>{i === 0 ? 3 : 0}</small>
          </button>
        ))}
        <div className="local-note">
          <Icon name="book" />
          <p>
            你的资料，独立管理。
            <br />
            仅通过公开能力分享。
          </p>
        </div>
      </aside>
      <div className="module-main">
        <PageHeading
          eyebrow="KNOWLEDGE"
          title={collection}
          description="为想法积累素材，让知识有迹可循。"
        >
          <Button onClick={openSettings}>
            <Icon name="sliders" />
            模块设置
          </Button>
          <Button variant="primary" onClick={() => pending(notify, '导入文档')}>
            <Icon name="upload" />
            导入文档
          </Button>
        </PageHeading>
        <div className="section-toolbar">
          <Tabs items={['文档', '检索测试']} value={tab} onChange={setTab} />
          <Badge>示例资料</Badge>
        </div>
        {collection !== '品牌资料' ? (
          <EmptyState
            icon="book"
            title="这里还没有文档"
            description="导入第一份资料，开始建立你的知识库。"
          >
            <Button onClick={() => pending(notify, '导入文档')}>导入文档</Button>
          </EmptyState>
        ) : tab === '文档' ? (
          <div className="document-layout">
            <div className="document-list">
              <div className="search-field">
                <Icon name="search" />
                <input
                  aria-label="搜索文档"
                  placeholder="搜索文档…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
              <div className="list-label">
                文档 · {documents.filter((d) => d.name.includes(filter)).length}
              </div>
              {documents.map(
                (item, i) =>
                  item.name.includes(filter) && (
                    <button
                      key={item.name}
                      className={`document-item ${selected === i ? 'active' : ''}`}
                      onClick={() => setSelected(i)}
                    >
                      <span className="file-symbol">
                        <Icon name="document" />
                      </span>
                      <span>
                        <strong>{item.name}</strong>
                        <small>
                          {item.type} · {item.date}
                        </small>
                      </span>
                      <Icon name="chevronRight" size={15} />
                    </button>
                  ),
              )}
              <p className="muted compact-note">索引服务尚未连接</p>
              <Button onClick={() => pending(notify, '更新索引')}>
                <Icon name="layers" />
                更新索引
              </Button>
            </div>
            <article className="document-preview">
              <div className="preview-top">
                <Badge>{doc.type}</Badge>
                <span className="muted">只读示例</span>
              </div>
              <h2>{doc.content}</h2>
              <p>{doc.text}</p>
              <h3>{doc.section}</h3>
              <p>{doc.body}</p>
              <blockquote>让灵感有处安放，让创作自然发生。</blockquote>
              <div className="document-meta">
                <span>所属知识库</span>
                <strong>品牌资料</strong>
                <span>索引状态</span>
                <strong>待接入</strong>
              </div>
            </article>
          </div>
        ) : (
          <div className="retrieval-view">
            <h2>试着找到相关内容</h2>
            <p className="muted">独立检索知识库，核对片段与来源。</p>
            <div className="search-field">
              <Icon name="search" />
              <input
                placeholder="输入问题或关键词…"
                aria-label="检索问题"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Button
                variant="primary"
                disabled={!query.trim()}
                onClick={() => pending(notify, '检索')}
              >
                检索
              </Button>
            </div>
            <EmptyState
              icon="search"
              title="检索结果会显示在这里"
              description="连接检索服务后，可查看相关片段及其来源。"
            />
          </div>
        )}
      </div>
    </div>
  );
}
