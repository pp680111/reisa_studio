import { useState } from 'react';
import type { ModuleSettingsProps } from '@reisa/module-sdk';
import { Button, Field } from '@reisa/ui';
export function KnowledgeSettings({ notify }: ModuleSettingsProps) {
  const [mode, setMode] = useState('inherit');
  const [method, setMethod] = useState('hybrid');
  const [address, setAddress] = useState('');
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
          <input
            placeholder="https://api.example.com"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </Field>
      )}
      <Field label="检索方式">
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="hybrid">混合检索</option>
          <option value="semantic">语义检索</option>
          <option value="keyword">关键词检索</option>
        </select>
      </Field>
      <p className="muted">仅影响知识库。配置持久化待接入。</p>
      <div className="form-footer">
        <small>{dirty ? '有未保存的修改' : '当前为本地预览'}</small>
        <Button
          variant="primary"
          onClick={() => {
            setDirty(false);
            notify('知识库设置已应用到当前预览，尚未持久化。');
          }}
        >
          应用到预览
        </Button>
      </div>
    </div>
  );
}
