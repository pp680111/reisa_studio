import { useState } from 'react';
import type { ModuleSettingsProps } from '@reisa/module-sdk';
import { Button, Field } from '@reisa/ui';
export function ProjectSettings({ notify }: ModuleSettingsProps) {
  const [storage, setStorage] = useState('copy');
  const [dirty, setDirty] = useState(false);
  return (
    <div className="settings-form">
      <Field label="接收素材时的保存方式" hint="引用仍需要来源模块公开的读取能力">
        <select
          value={storage}
          onChange={(e) => {
            setStorage(e.target.value);
            setDirty(true);
          }}
        >
          <option value="copy">保存副本</option>
          <option value="reference">只保留引用</option>
        </select>
      </Field>
      <div className="info-box">
        <IconText />
        保存副本后，素材不再依赖来源文件。引用素材在来源不可用时也将不可用。
      </div>
      <p className="muted">项目存储与配置持久化尚未接入。</p>
      <div className="form-footer">
        <small>{dirty ? '有未保存的修改' : '当前为本地预览'}</small>
        <Button
          variant="primary"
          onClick={() => {
            setDirty(false);
            notify('项目设置已应用到当前预览，尚未持久化。');
          }}
        >
          应用到预览
        </Button>
      </div>
    </div>
  );
}
function IconText() {
  return <strong>素材归属 · </strong>;
}
