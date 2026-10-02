import { useState } from 'react';
import type { ModuleSettingsProps } from '@reisa/module-sdk';
import { Button, Field } from '@reisa/ui';
export function ImageSettings({ notify }: ModuleSettingsProps) {
  const [mode, setMode] = useState('inherit');
  const [dirty, setDirty] = useState(false);
  return (
    <div className="settings-form" onChange={() => setDirty(true)}>
      <Field label="服务连接">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="inherit">继承基础配置</option>
          <option value="independent">模块独立配置</option>
        </select>
      </Field>
      {mode === 'independent' && (
        <Field label="独立服务地址">
          <input placeholder="https://api.example.com" />
        </Field>
      )}
      <Field label="默认绘图模型">
        <input placeholder="连接服务后选择模型" />
      </Field>
      <Field label="默认尺寸">
        <select>
          <option>1024 × 1024</option>
          <option>1536 × 1024</option>
          <option>1024 × 1536</option>
        </select>
      </Field>
      <Field label="默认格式">
        <select>
          <option>PNG</option>
          <option>WebP</option>
        </select>
      </Field>
      <p className="muted">仅影响绘图模块。配置持久化待接入。</p>
      <div className="form-footer">
        <small>{dirty ? '有未保存的修改' : '当前为本地预览'}</small>
        <Button
          variant="primary"
          onClick={() => {
            setDirty(false);
            notify('绘图设置已应用到当前预览，尚未持久化。');
          }}
        >
          应用到预览
        </Button>
      </div>
    </div>
  );
}
