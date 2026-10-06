import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  buildTodoWhere,
  CATEGORY_ORDER_SQL,
  PROGRESS_ORDER_SQL,
  TODO_ORDER_SQL,
  type TodoFilter,
} from '../domain/query.ts';

/**
 * 待办数据库（迁移自 todo_manage `lib/model/`，业务规则真源为源 DAO，验收标准见迁移设计文档 §5）。
 *
 * schema v1 = 源三表语义 + 迁移修正（决策 R2/R6，DDL 见迁移设计文档附录 A）：
 * - 表名 todo_thing/todo_thing_progress → todo/todo_progress（新库无历史包袱）；
 * - 时间统一 UTC 毫秒（源为 drift 默认的 Unix 秒）；
 * - 补外键与级联：删除待办级联删进度、删除分类置空待办关联（源无外键，R6②）；
 * - 补索引；parent_category_id 不迁移（R5，源中未使用且类型错误）。
 *
 * 与 card-note 相同，node:sqlite 无内建事务 API，自实现 transaction（嵌套并入外层）。
 */

export class DomainError extends Error {}

export interface TodoRow {
  readonly id: number;
  readonly title: string;
  readonly detail: string | null;
  readonly status: number;
  readonly categoryId: number | null;
  readonly deadlineTime: number | null;
  readonly createTime: number;
  readonly updateTime: number;
}

export interface TodoRowWithCategory extends TodoRow {
  readonly categoryName: string | null;
}

export interface CategoryRow {
  readonly id: number;
  readonly name: string;
  readonly createTime: number;
  readonly updateTime: number;
}

export interface ProgressRow {
  readonly id: number;
  readonly todoId: number;
  readonly content: string;
  readonly isFinished: boolean;
  readonly createTime: number;
  readonly updateTime: number;
}

export interface PagedRows<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS category (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  create_time INTEGER NOT NULL,
  update_time INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS todo (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL,
  detail        TEXT,
  status        INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0, 1, 2, 3)),
  category_id   INTEGER REFERENCES category(id) ON DELETE SET NULL,
  create_time   INTEGER NOT NULL,
  deadline_time INTEGER,
  update_time   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todo_status   ON todo(status);
CREATE INDEX IF NOT EXISTS idx_todo_category ON todo(category_id);
CREATE INDEX IF NOT EXISTS idx_todo_deadline ON todo(deadline_time);
CREATE TABLE IF NOT EXISTS todo_progress (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id     INTEGER NOT NULL REFERENCES todo(id) ON DELETE CASCADE,
  content     TEXT    NOT NULL,
  is_finished INTEGER NOT NULL DEFAULT 0,
  create_time INTEGER NOT NULL,
  update_time INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_progress_todo ON todo_progress(todo_id);
`;

interface TodoRowSql {
  id: number;
  title: string;
  detail: string | null;
  status: number;
  category_id: number | null;
  deadline_time: number | null;
  create_time: number;
  update_time: number;
  category_name?: string | null;
}

interface CategoryRowSql {
  id: number;
  name: string;
  create_time: number;
  update_time: number;
}

interface ProgressRowSql {
  id: number;
  todo_id: number;
  content: string;
  is_finished: number;
  create_time: number;
  update_time: number;
}

function toTodo(row: TodoRowSql): TodoRowWithCategory {
  return {
    id: Number(row.id),
    title: row.title,
    detail: row.detail,
    status: Number(row.status),
    categoryId: row.category_id === null ? null : Number(row.category_id),
    deadlineTime: row.deadline_time === null ? null : Number(row.deadline_time),
    createTime: Number(row.create_time),
    updateTime: Number(row.update_time),
    categoryName: row.category_name ?? null,
  };
}

function toCategory(row: CategoryRowSql): CategoryRow {
  return {
    id: Number(row.id),
    name: row.name,
    createTime: Number(row.create_time),
    updateTime: Number(row.update_time),
  };
}

function toProgress(row: ProgressRowSql): ProgressRow {
  return {
    id: Number(row.id),
    todoId: Number(row.todo_id),
    content: row.content,
    isFinished: Number(row.is_finished) !== 0,
    createTime: Number(row.create_time),
    updateTime: Number(row.update_time),
  };
}

export class TodoDatabase {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  #inTransaction = false;

  constructor(filePath: string, options: { now?: () => number } = {}) {
    if (filePath !== ':memory:') {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    this.#db = new DatabaseSync(filePath);
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec(SCHEMA);
    this.#now = options.now ?? Date.now;
  }

  close(): void {
    this.#db.close();
  }

  /** node:sqlite 无内建事务 API；嵌套调用并入外层事务（与 drift transaction 语义一致）。 */
  transaction<T>(fn: () => T): T {
    if (this.#inTransaction) return fn();
    this.#db.exec('BEGIN IMMEDIATE');
    this.#inTransaction = true;
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      this.#inTransaction = false;
      return result;
    } catch (error) {
      this.#inTransaction = false;
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // 回滚失败时以外层异常为准。
      }
      throw error;
    }
  }

  // ---- 待办（源 TodoThingDao；排序 status ASC, create_time DESC） ----

  /**
   * 分页查询：查询 pageSize+1 条判定 hasMore（R6①：修复源"返回不足一页仍显示可加载"的缺陷）。
   * categoryName 以 LEFT JOIN 填充（分类不存在时为 null，待办正常展示，§5.6）。
   */
  pageTodos(
    pageIndex: number,
    pageSize: number,
    filter?: TodoFilter,
  ): PagedRows<TodoRowWithCategory> {
    const offset = (pageIndex - 1) * pageSize;
    const where = buildTodoWhere(filter);
    const rows = this.#db
      .prepare(
        `SELECT todo.*, category.name AS category_name
         FROM todo LEFT JOIN category ON category.id = todo.category_id
         WHERE 1 = 1${where.sql}
         ${TODO_ORDER_SQL}
         LIMIT ? OFFSET ?`,
      )
      .all(...where.params, pageSize + 1, offset) as unknown as TodoRowSql[];
    const hasMore = rows.length > pageSize;
    return { items: rows.slice(0, pageSize).map(toTodo), hasMore };
  }

  getTodoById(id: number): TodoRowWithCategory | null {
    const row = this.#db
      .prepare(
        `SELECT todo.*, category.name AS category_name
         FROM todo LEFT JOIN category ON category.id = todo.category_id
         WHERE todo.id = ?`,
      )
      .get(id) as TodoRowSql | undefined;
    return row === undefined ? null : toTodo(row);
  }

  /**
   * 新建待办（源 insertOrUpdateFromMap 无 id 分支）：createTime = updateTime = now，
   * status 固定 NOT_START（源 _initDefValForFormMap 覆盖语义）。
   */
  insertTodo(input: {
    title: string;
    detail: string | null;
    categoryId: number | null;
    deadlineTime: number | null;
  }): TodoRowWithCategory {
    const now = this.#now();
    const result = this.#db
      .prepare(
        `INSERT INTO todo (title, detail, status, category_id, create_time, deadline_time, update_time)
         VALUES (?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(input.title, input.detail, input.categoryId, now, input.deadlineTime, now);
    const id = Number(result.lastInsertRowid);
    const created = this.getTodoById(id);
    if (created === null) {
      throw new DomainError('待办创建失败');
    }
    return created;
  }

  /**
   * 更新待办（源 insertOrUpdateFromMap 有 id 分支）：不触碰 createTime，刷 updateTime；
   * status 为 null 时保留原值（类型化 API 下等价于源"表单未提交状态字段则不写"）。
   */
  updateTodo(input: {
    id: number;
    title: string;
    detail: string | null;
    status: number | null;
    categoryId: number | null;
    deadlineTime: number | null;
  }): TodoRowWithCategory {
    const now = this.#now();
    const result = this.#db
      .prepare(
        `UPDATE todo
         SET title = ?, detail = ?, status = COALESCE(?, status), category_id = ?,
             deadline_time = ?, update_time = ?
         WHERE id = ?`,
      )
      .run(
        input.title,
        input.detail,
        input.status,
        input.categoryId,
        input.deadlineTime,
        now,
        input.id,
      );
    if (result.changes === 0) {
      throw new DomainError('待办不存在或已被删除');
    }
    const updated = this.getTodoById(input.id);
    if (updated === null) {
      throw new DomainError('待办不存在或已被删除');
    }
    return updated;
  }

  /** 仅切换状态（源 updateState：不刷 updateTime）。返回 false 表示待办不存在。 */
  updateTodoStatus(id: number, status: number): boolean {
    const result = this.#db.prepare('UPDATE todo SET status = ? WHERE id = ?').run(status, id);
    return result.changes > 0;
  }

  deleteTodoById(id: number): boolean {
    // 外键级联删除 todo_progress（R6②）。
    return this.#db.prepare('DELETE FROM todo WHERE id = ?').run(id).changes > 0;
  }

  // ---- 分类（源 CategoryDao；排序 create_time ASC） ----

  pageCategories(
    pageIndex: number,
    pageSize: number,
    searchKey?: string | null,
  ): PagedRows<CategoryRow> {
    const offset = (pageIndex - 1) * pageSize;
    const normalized = typeof searchKey === 'string' ? searchKey.trim() : '';
    const rows = (normalized === ''
      ? this.#db
          .prepare(`SELECT * FROM category ${CATEGORY_ORDER_SQL} LIMIT ? OFFSET ?`)
          .all(pageSize + 1, offset)
      : this.#db
          .prepare(
            `SELECT * FROM category WHERE name LIKE ? ${CATEGORY_ORDER_SQL} LIMIT ? OFFSET ?`,
          )
          .all(`%${normalized}%`, pageSize + 1, offset)) as unknown as CategoryRowSql[];
    const hasMore = rows.length > pageSize;
    return { items: rows.slice(0, pageSize).map(toCategory), hasMore };
  }

  insertCategory(name: string): CategoryRow {
    const now = this.#now();
    const result = this.#db
      .prepare('INSERT INTO category (name, create_time, update_time) VALUES (?, ?, ?)')
      .run(name, now, now);
    const row = this.#db
      .prepare('SELECT * FROM category WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as CategoryRowSql | undefined;
    if (row === undefined) {
      throw new DomainError('分类创建失败');
    }
    return toCategory(row);
  }

  updateCategory(id: number, name: string): CategoryRow {
    const now = this.#now();
    const result = this.#db
      .prepare('UPDATE category SET name = ?, update_time = ? WHERE id = ?')
      .run(name, now, id);
    if (result.changes === 0) {
      throw new DomainError('分类不存在或已被删除');
    }
    const row = this.#db.prepare('SELECT * FROM category WHERE id = ?').get(id) as
      CategoryRowSql | undefined;
    if (row === undefined) {
      throw new DomainError('分类不存在或已被删除');
    }
    return toCategory(row);
  }

  /** 删除分类：待办的 category_id 由外键置空（R6②），不删除待办。 */
  deleteCategoryById(id: number): boolean {
    return this.#db.prepare('DELETE FROM category WHERE id = ?').run(id).changes > 0;
  }

  // ---- 进度（源 TodoThingProgressDao；排序 is_finished ASC, id ASC） ----

  getProgressByTodo(todoId: number): ProgressRow[] {
    const rows = this.#db
      .prepare(`SELECT * FROM todo_progress WHERE todo_id = ? ${PROGRESS_ORDER_SQL}`)
      .all(todoId) as unknown as ProgressRowSql[];
    return rows.map(toProgress);
  }

  pageProgressByTodo(todoId: number, pageIndex: number, pageSize: number): PagedRows<ProgressRow> {
    const offset = (pageIndex - 1) * pageSize;
    const rows = this.#db
      .prepare(
        `SELECT * FROM todo_progress WHERE todo_id = ? ${PROGRESS_ORDER_SQL} LIMIT ? OFFSET ?`,
      )
      .all(todoId, pageSize + 1, offset) as unknown as ProgressRowSql[];
    const hasMore = rows.length > pageSize;
    return { items: rows.slice(0, pageSize).map(toProgress), hasMore };
  }

  /** 新建进度（源 insert）：isFinished 默认 false，createTime = updateTime = now。 */
  insertProgress(todoId: number, content: string): ProgressRow {
    const now = this.#now();
    const result = this.#db
      .prepare(
        `INSERT INTO todo_progress (todo_id, content, is_finished, create_time, update_time)
         VALUES (?, ?, 0, ?, ?)`,
      )
      .run(todoId, content, now, now);
    const row = this.#db
      .prepare('SELECT * FROM todo_progress WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as ProgressRowSql | undefined;
    if (row === undefined) {
      throw new DomainError('进度创建失败');
    }
    return toProgress(row);
  }

  /** 切换进度完成标记（源 updateIsFinished：不刷 updateTime）。 */
  updateProgressFinished(id: number, isFinished: boolean): boolean {
    const result = this.#db
      .prepare('UPDATE todo_progress SET is_finished = ? WHERE id = ?')
      .run(isFinished ? 1 : 0, id);
    return result.changes > 0;
  }

  deleteProgressById(id: number): boolean {
    return this.#db.prepare('DELETE FROM todo_progress WHERE id = ?').run(id).changes > 0;
  }
}
