import { useState } from 'react';
import type { ModulePageProps } from '@reisa/module-sdk';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  PageHeading,
  Tabs,
  pending,
} from '@reisa/ui';
const assets = [
  {
    name: '品牌概览',
    kind: 'Markdown',
    icon: 'document',
    description: '品牌定位、产品介绍与表达原则。',
  },
  {
    name: '视觉灵感',
    kind: '链接引用',
    icon: 'book',
    description: '保留关于色彩、构图和日常生活的想法。',
  },
  {
    name: '发布清单',
    kind: '文本文档',
    icon: 'list',
    description: '从创意到发布，每一步都有迹可循。',
  },
];
export function ProjectWorkspace({ openSettings, notify }: ModulePageProps) {
  const [project, setProject] = useState('NOVA 品牌企划');
  const [tab, setTab] = useState('素材');
  const [layout, setLayout] = useState('grid');
  const [favorites, setFavorites] = useState<string[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [notes, setNotes] = useState(
    '## 项目目标\n\n建立统一的品牌表达，整理第一轮发布素材。\n\n## 灵感记录\n\n- 保留自然的留白\n- 让内容先于装饰\n- 从日常生活寻找灵感',
  );
  const [dirty, setDirty] = useState(false);
  return (
    <div className="module-layout">
      <aside className="local-nav">
        <div className="local-nav-heading">
          我的项目
          <Button variant="ghost" aria-label="新建项目" onClick={() => pending(notify, '新建项目')}>
            <Icon name="plus" size={16} />
          </Button>
        </div>
        {['NOVA 品牌企划', '个人创作', '未分类素材'].map((name) => (
          <button
            className={`local-item ${project === name ? 'active' : ''}`}
            key={name}
            onClick={() => setProject(name)}
          >
            <Icon name="folder" />
            <span>{name}</span>
          </button>
        ))}
        <div className="local-note">
          <Icon name="folder" />
          <p>
            把零散的灵感，
            <br />
            整理成完整的作品。
          </p>
        </div>
      </aside>
      <div className="module-main">
        <PageHeading
          eyebrow="PROJECTS"
          title={project}
          description="一处空间，连接素材、想法与创作成果。"
        >
          <Button onClick={openSettings}>
            <Icon name="sliders" />
            模块设置
          </Button>
          <Button variant="primary" onClick={() => pending(notify, '添加素材')}>
            <Icon name="plus" />
            添加素材
          </Button>
        </PageHeading>
        <div className="section-toolbar">
          <Tabs items={['素材', '笔记', '活动']} value={tab} onChange={setTab} />
          <div className="view-options">
            <Badge>示例项目</Badge>
            <IconButton
              name="grid"
              label="网格布局"
              aria-pressed={layout === 'grid'}
              onClick={() => setLayout('grid')}
            />
            <IconButton
              name="list"
              label="列表布局"
              aria-pressed={layout === 'list'}
              onClick={() => setLayout('list')}
            />
          </div>
        </div>
        {project !== 'NOVA 品牌企划' ? (
          <EmptyState
            icon="folder"
            title="准备好开始一个新项目"
            description="添加素材或记下想法，让创作慢慢成形。"
          />
        ) : tab === '素材' ? (
          <>
            <div className="list-label">全部素材 · 3</div>
            <div className={`asset-grid ${layout === 'list' ? 'asset-list' : ''}`}>
              {assets.map((asset, i) => (
                <div className="asset-card" key={asset.name}>
                  <button
                    className={`asset-cover cover-${i}`}
                    aria-label={`查看${asset.name}`}
                    onClick={() => setSelected(i)}
                  >
                    <Icon name={asset.icon} size={38} />
                    <span>{asset.kind}</span>
                  </button>
                  <div className="asset-info">
                    <button className="text-button" onClick={() => setSelected(i)}>
                      {asset.name}
                    </button>
                    <IconButton
                      name="star"
                      label={`${favorites.includes(asset.name) ? '取消收藏' : '收藏'}${asset.name}`}
                      aria-pressed={favorites.includes(asset.name)}
                      onClick={() =>
                        setFavorites((previous) =>
                          previous.includes(asset.name)
                            ? previous.filter((n) => n !== asset.name)
                            : [...previous, asset.name],
                        )
                      }
                    />
                    <small>{asset.kind} · 示例内容</small>
                  </div>
                </div>
              ))}
            </div>
            <p className="muted compact-note">
              仅展示项目拥有的素材；其他模块的内容需明确保存后加入。
            </p>
          </>
        ) : tab === '笔记' ? (
          <div className="notes-editor">
            <div className="section-toolbar">
              <h3>项目笔记</h3>
              <span className="muted">{dirty ? '未保存' : '本地示例'}</span>
            </div>
            <textarea
              aria-label="项目笔记"
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                setDirty(true);
              }}
              rows={15}
            />
            <div className="form-footer">
              <small>笔记仅保留在当前预览中</small>
              <Button
                variant="primary"
                onClick={() => {
                  setDirty(false);
                  notify('笔记已保留在当前预览中，保存服务尚未接入。');
                }}
              >
                应用到预览
              </Button>
            </div>
          </div>
        ) : (
          <EmptyState
            icon="history"
            title="项目的每一步，都有记录"
            description="接入项目服务后，这里会显示实际发生的素材和笔记变化。"
          />
        )}
      </div>
      <Dialog open={selected !== null} onClose={() => setSelected(null)} title="素材详情">
        {selected !== null && (
          <div className="settings-form">
            <Badge>示例素材</Badge>
            <h3>{assets[selected]!.name}</h3>
            <p>{assets[selected]!.description}</p>
            <div className="document-meta">
              <span>来源</span>
              <strong>项目示例</strong>
              <span>保存方式</span>
              <strong>本地展示数据</strong>
            </div>
            <Button onClick={() => pending(notify, '素材重命名')}>重命名</Button>
            <Button onClick={() => pending(notify, '发送到会话')}>发送到会话</Button>
          </div>
        )}
      </Dialog>
    </div>
  );
}
