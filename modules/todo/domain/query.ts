/**
 * 过滤参数 → SQL 规则（迁移自 todo_manage `todo_thing_query_builder.dart`，语义逐条对应）：
 * searchKey → title LIKE '%key%'；categoryId / status → 等值；
 * 排序固定 case 0：status ASC, createTime DESC（§5.3）。
 */

export interface TodoFilter {
  readonly searchKey?: string | null;
  readonly status?: number | null;
  readonly categoryId?: number | null;
}

export interface WhereClause {
  readonly sql: string;
  /** 参数值限定为 SQLite 可绑定类型（string/number/null），便于 node:sqlite 绑定。 */
  readonly params: readonly (string | number | null)[];
}

export function buildTodoWhere(filter: TodoFilter | undefined): WhereClause {
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];
  if (filter === undefined) {
    return { sql: '', params };
  }
  const searchKey = filter.searchKey;
  if (typeof searchKey === 'string' && searchKey !== '') {
    conditions.push('todo.title LIKE ?');
    params.push(`%${searchKey}%`);
  }
  if (typeof filter.categoryId === 'number' && Number.isInteger(filter.categoryId)) {
    conditions.push('todo.category_id = ?');
    params.push(filter.categoryId);
  }
  if (typeof filter.status === 'number' && Number.isInteger(filter.status)) {
    conditions.push('todo.status = ?');
    params.push(filter.status);
  }
  if (conditions.length === 0) {
    return { sql: '', params };
  }
  return { sql: ` AND ${conditions.join(' AND ')}`, params };
}

/** 待办排序：status ASC, createTime DESC（id DESC 仅作同值稳定 tiebreak）。 */
export const TODO_ORDER_SQL = 'ORDER BY todo.status ASC, todo.create_time DESC, todo.id DESC';

/** 分类排序：createTime ASC（源 CategoryDao.page）。 */
export const CATEGORY_ORDER_SQL = 'ORDER BY category.create_time ASC, category.id ASC';

/** 进度排序：isFinished ASC, id ASC（未完成在前，源 TodoThingProgressDao；单表查询无别名）。 */
export const PROGRESS_ORDER_SQL = 'ORDER BY is_finished ASC, id ASC';
