import { useState } from 'react';
import type { ModulePageProps } from '@reisa/module-sdk';
import { Button, Icon, Tabs } from '@reisa/ui';
import { CategoriesView } from './CategoriesView.tsx';
import { TasksView } from './TasksView.tsx';
import { TodoDetailDialog } from './TodoDetailDialog.tsx';
import './TodoPage.css';

/**
 * 待办工作区（module-ui-design：模块页面自带视图状态机，无 URL 路由）：
 * 任务 / 分类两个 Tab + 待办详情弹窗（源 NavigationRail + 详情页的页面化对应物）。
 * 数据一律经页面服务通道获取；刷新采用"操作后主动刷新"（§6.8）。
 * 页面不重复宿主标题：视图切换与新增操作同处顶部，搜索与筛选放在下一层。
 */
export function TodoPage({ notify }: ModulePageProps) {
  const [tab, setTab] = useState('任务');
  // 详情弹窗：todoId 为 null 表示新建；编辑保存/删除后递增令牌触发列表刷新。
  const [editing, setEditing] = useState<{ todoId: number | null } | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [creatingCategory, setCreatingCategory] = useState(false);

  const bumpRefresh = () => setRefreshToken((token) => token + 1);

  return (
    <div className="todo-page">
      <div className="todo-page-header">
        <Tabs items={['任务', '分类']} value={tab} onChange={setTab} />
        <Button
          variant="primary"
          onClick={() =>
            tab === '任务' ? setEditing({ todoId: null }) : setCreatingCategory(true)
          }
        >
          <Icon name="plus" size={16} />
          {tab === '任务' ? '新建待办' : '新建分类'}
        </Button>
      </div>
      {tab === '任务' && (
        <TasksView
          notify={notify}
          refreshToken={refreshToken}
          onEdit={(todoId) => setEditing({ todoId })}
          onCreate={() => setEditing({ todoId: null })}
        />
      )}
      {tab === '分类' && (
        <CategoriesView
          notify={notify}
          refreshToken={refreshToken}
          creating={creatingCategory}
          onCreate={() => setCreatingCategory(true)}
          onCreateClose={() => setCreatingCategory(false)}
        />
      )}
      {editing !== null && (
        <TodoDetailDialog
          key={editing.todoId ?? 'new'}
          todoId={editing.todoId}
          notify={notify}
          onFinished={(changed) => {
            setEditing(null);
            if (changed) bumpRefresh();
          }}
        />
      )}
    </div>
  );
}
