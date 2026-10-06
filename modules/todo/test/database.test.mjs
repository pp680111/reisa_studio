/**
 * 数据库层测试（:memory:）：业务规则验收标准为迁移设计文档 §5——
 * 校验消息、insertOrUpdate 语义、排序、分页 hasMore（R6①）、外键级联（R6②）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TodoDatabase } from '../runtime/database.ts';
import { TodoValidationError } from '../domain/validation.ts';
import {
  validateTodoTitle,
  validateCategoryName,
  validateProgressContent,
} from '../domain/validation.ts';

function makeDb(now = () => 1_000_000) {
  return new TodoDatabase(':memory:', { now });
}

test('新建待办固定未开始，createTime=updateTime=now；更新保留 createTime 并刷 updateTime', () => {
  let tick = 1_000_000;
  const db = makeDb(() => (tick += 1_000));
  const created = db.insertTodo({
    title: '任务A',
    detail: null,
    categoryId: null,
    deadlineTime: null,
  });
  assert.equal(created.status, 0);
  assert.equal(created.createTime, 1_001_000);
  assert.equal(created.updateTime, 1_001_000);

  const updated = db.updateTodo({
    id: created.id,
    title: '任务A改',
    detail: '有详情',
    status: 2,
    categoryId: null,
    deadlineTime: null,
  });
  assert.equal(updated.title, '任务A改');
  assert.equal(updated.status, 2);
  assert.equal(updated.createTime, 1_001_000, 'createTime 不被更新触碰');
  assert.equal(updated.updateTime, 1_002_000);
  db.close();
});

test('更新不存在的待办抛错；updateStatus/deleteById 静默返回 false（源 updateState/delete 语义）', () => {
  const db = makeDb();
  assert.throws(
    () =>
      db.updateTodo({
        id: 99,
        title: 'x',
        detail: null,
        status: 0,
        categoryId: null,
        deadlineTime: null,
      }),
    /待办不存在或已被删除/,
  );
  assert.equal(db.updateTodoStatus(99, 2), false);
  assert.equal(db.deleteTodoById(99), false);
  db.close();
});

test('列表排序 status ASC, createTime DESC；过滤 searchKey/categoryId/status 生效', () => {
  const db = makeDb();
  const cat = db.insertCategory('工作');
  const a = db.insertTodo({
    title: '写周报',
    detail: null,
    categoryId: cat.id,
    deadlineTime: null,
  });
  db.insertTodo({ title: '买菜', detail: null, categoryId: null, deadlineTime: null });
  db.updateTodoStatus(a.id, 2);

  const all = db.pageTodos(1, 20).items;
  assert.deepEqual(
    all.map((t) => t.title),
    ['买菜', '写周报'],
    '未开始(0)在前，未开始按 createTime DESC',
  );

  const bySearch = db.pageTodos(1, 20, { searchKey: '周报' }).items;
  assert.equal(bySearch.length, 1);
  assert.equal(bySearch[0]?.title, '写周报');

  const byCategory = db.pageTodos(1, 20, { categoryId: cat.id }).items;
  assert.equal(byCategory.length, 1);
  assert.equal(byCategory[0]?.categoryName, '工作', 'LEFT JOIN 填充分类名');

  const byStatus = db.pageTodos(1, 20, { status: 2 }).items;
  assert.equal(byStatus.length, 1);
  assert.equal(byStatus[0]?.status, 2);
  db.close();
});

test('分页 hasMore：查 pageSize+1 条判定；返回不足一页时 hasMore=false（R6①）', () => {
  const db = makeDb();
  for (let i = 0; i < 5; i++) {
    db.insertTodo({ title: `任务${i}`, detail: null, categoryId: null, deadlineTime: null });
  }
  const page1 = db.pageTodos(1, 2);
  assert.equal(page1.items.length, 2);
  assert.equal(page1.hasMore, true);
  const page3 = db.pageTodos(3, 2);
  assert.equal(page3.items.length, 1);
  assert.equal(page3.hasMore, false, '尾页不足 pageSize+1，hasMore=false');
  db.close();
});

test('删除待办级联删除进度；删除分类置空待办关联（R6②）', () => {
  const db = makeDb();
  const cat = db.insertCategory('生活');
  const todo = db.insertTodo({
    title: '任务B',
    detail: null,
    categoryId: cat.id,
    deadlineTime: null,
  });
  db.insertProgress(todo.id, '第一步');
  db.insertProgress(todo.id, '第二步');

  assert.equal(db.deleteCategoryById(cat.id), true);
  assert.equal(db.getTodoById(todo.id)?.categoryId, null, '分类删除后待办保留且关联置空');

  assert.equal(db.getProgressByTodo(todo.id).length, 2);
  assert.equal(db.deleteTodoById(todo.id), true);
  assert.equal(db.getProgressByTodo(todo.id).length, 0, '待办删除后进度级联清空');
  db.close();
});

test('进度排序 isFinished ASC, id ASC；updateIsFinished 不刷 updateTime（源语义）', () => {
  const db = makeDb();
  const todo = db.insertTodo({
    title: '任务C',
    detail: null,
    categoryId: null,
    deadlineTime: null,
  });
  const p1 = db.insertProgress(todo.id, '第一条');
  const p2 = db.insertProgress(todo.id, '第二条');
  db.updateProgressFinished(p1.id, true);

  const list = db.getProgressByTodo(todo.id);
  assert.deepEqual(
    list.map((p) => p.id),
    [p2.id, p1.id],
    '未完成在前，同序按 id',
  );
  assert.equal(list[0]?.isFinished, false);
  assert.equal(list[1]?.isFinished, true);
  assert.equal(list[1]?.updateTime, p1.updateTime, '完成标记切换不改 updateTime');
  db.close();
});

test('分类与进度排序、分页与校验', () => {
  const db = makeDb();
  db.insertCategory('乙');
  db.insertCategory('甲');
  const cats = db.pageCategories(1, 20).items;
  assert.deepEqual(
    cats.map((c) => c.name),
    ['乙', '甲'],
    '分类按 createTime ASC',
  );

  const paged = db.pageCategories(1, 1);
  assert.equal(paged.items.length, 1);
  assert.equal(paged.hasMore, true);

  const searched = db.pageCategories(1, 20, '甲').items;
  assert.deepEqual(
    searched.map((c) => c.name),
    ['甲'],
  );

  assert.throws(() => validateTodoTitle('   '), TodoValidationError);
  assert.throws(() => validateTodoTitle('   '), /标题不得为空/);
  assert.throws(() => validateCategoryName(''), /名称不得为空/);
  assert.throws(() => validateProgressContent('  '), /内容不得为空/);
  db.close();
});

test('status 违反 CHECK 约束时拒绝写入（DDL CHECK status IN 0-3）', () => {
  const db = makeDb();
  const todo = db.insertTodo({
    title: '任务D',
    detail: null,
    categoryId: null,
    deadlineTime: null,
  });
  assert.throws(() => db.updateTodoStatus(todo.id, 9), /CHECK constraint failed/);
  db.close();
});
