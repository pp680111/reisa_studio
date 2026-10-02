import { useState } from 'react';
import type { ModulePageProps } from '@reisa/module-sdk';
import { Badge, Button, EmptyState, Field, Icon, PageHeading, pending } from '@reisa/ui';
export function ImageWorkspace({ openSettings, notify, availableModuleIds }: ModulePageProps) {
  const [prompt, setPrompt] = useState('');
  const [ratio, setRatio] = useState('1:1');
  const [format, setFormat] = useState('PNG');
  return (
    <div className="workspace-page image-workspace">
      <PageHeading
        eyebrow="IMAGE STUDIO"
        title="让灵感，成为画面"
        description="从一句描述开始，探索新的视觉可能。"
      >
        <Button onClick={openSettings}>
          <Icon name="sliders" />
          模块设置
        </Button>
      </PageHeading>
      <div className="image-layout">
        <aside className="generation-panel">
          <div className="panel-title">
            <Icon name="sliders" />
            生成参数
          </div>
          <Field label="画面描述">
            <textarea
              rows={7}
              placeholder="描述你想看到的画面、风格、光线和细节…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </Field>
          <Field label="绘图模型" hint="绘图模型独立于主会话">
            <select>
              <option>选择模型 · 尚未配置</option>
            </select>
          </Field>
          <Field label="画面比例" group>
            <div className="ratio-options">
              {['1:1', '4:3', '16:9', '9:16'].map((r) => (
                <button
                  key={r}
                  aria-pressed={ratio === r}
                  className={ratio === r ? 'active' : ''}
                  onClick={() => setRatio(r)}
                >
                  <span style={{ aspectRatio: r.replace(':', '/') }} />
                  {r}
                </button>
              ))}
            </div>
          </Field>
          <Field label="输出格式">
            <select value={format} onChange={(e) => setFormat(e.target.value)}>
              <option>PNG</option>
              <option>WebP</option>
            </select>
          </Field>
          <Button
            variant="primary"
            className="full-width"
            disabled={!prompt.trim()}
            onClick={() => pending(notify, '图片生成')}
          >
            <Icon name="sparkles" />
            生成图片
          </Button>
          <p className="muted compact-note">尚未连接绘图服务</p>
        </aside>
        <div className="canvas-section">
          <div className="canvas-toolbar">
            <span>
              <Icon name="image" />
              创作画布
            </span>
            <Badge>等待创作</Badge>
          </div>
          <div className="canvas checkerboard">
            <EmptyState
              icon="image"
              title="下一幅作品，从这里开始"
              description="在左侧写下画面描述，连接服务后即可生成图片。"
            />
          </div>
          <div className="canvas-footer">
            <span className="muted">
              {ratio} · {format}
            </span>
            <div>
              <Button disabled>
                <Icon name="arrowDown" />
                下载
              </Button>
              <Button
                disabled
                title={
                  availableModuleIds.includes('project')
                    ? '生成并读取图片后可加入项目'
                    : '项目模块未启用'
                }
              >
                <Icon name="folder" />
                加入项目
              </Button>
            </div>
          </div>
          <div className="history-heading">
            <h3>
              <Icon name="history" />
              生成历史
            </h3>
            <span className="muted">0 张作品</span>
          </div>
          <div className="history-empty">你的生成记录会保留在绘图工作空间中</div>
        </div>
      </div>
    </div>
  );
}
