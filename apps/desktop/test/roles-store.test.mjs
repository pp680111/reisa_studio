/**
 * 角色化 prompt 管理测试：store 迁移（旧库补 role_id）、角色 CRUD 与删除守卫、
 * 默认角色种子（空表播种为普通角色、历史内置行降级）、会话绑定校验、注入解析优先级。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ConversationStore,
  RoleImmutableError,
  RoleInUseError,
} from '../src/main/conversations/store.ts';
import { DEFAULT_ROLE_SEEDS, OPS_SYSTEM_PROMPT } from '../src/main/roles/seed.ts';
import { resolveConversationSystemPrompt } from '../src/main/roles/resolution.ts';
import { REPO_EXPLORER_CAPABILITIES } from '@reisa/module-repo-explorer/contracts';
import { KNOWLEDGE_CAPABILITIES } from '@reisa/module-knowledge/contracts';

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'roles-store-'));
  const store = await ConversationStore.open(join(dir, 'conversations.db'));
  return {
    store,
    cleanup: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('种子：角色表为空时播种默认角色（普通角色）；非空时不插入、删除后不复活', async () => {
  const { store, cleanup } = await makeStore();
  try {
    store.seedDefaultRoles(DEFAULT_ROLE_SEEDS);
    const roles = store.listRoles();
    assert.equal(roles.length, DEFAULT_ROLE_SEEDS.length);
    assert.equal(roles[0].builtin, false, '默认角色是普通角色，不是内置只读');
    assert.equal(roles[0].id, DEFAULT_ROLE_SEEDS[0].key);
    assert.equal(roles[0].name, '运维排查专家');

    store.seedDefaultRoles(DEFAULT_ROLE_SEEDS); // 幂等：非空表不再插入
    assert.equal(store.listRoles().length, DEFAULT_ROLE_SEEDS.length);

    // 用户删除默认角色后不复活（表非空 = 用户已有自己的角色集合）
    store.deleteRole(DEFAULT_ROLE_SEEDS[0].key);
    store.seedDefaultRoles(DEFAULT_ROLE_SEEDS);
    assert.equal(store.listRoles().length, 0);
  } finally {
    await cleanup();
  }
});

test('旧库迁移：无 roles 表与 role_id 列的历史库打开后可正常使用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'roles-migrate-'));
  const dbPath = join(dir, 'conversations.db');
  {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, name TEXT NOT NULL,
        media_type TEXT, size INTEGER NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE tool_records (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
        tool_name TEXT NOT NULL, status TEXT NOT NULL, error_code TEXT, created_at INTEGER NOT NULL
      );
    `);
    legacy
      .prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('conv_legacy', '旧会话', 1, 2);
    legacy.close();
  }
  const store = await ConversationStore.open(dbPath);
  try {
    // 旧数据完好且能读到
    assert.equal(store.getConversation('conv_legacy').title, '旧会话');
    // 角色能力可用
    store.seedDefaultRoles(DEFAULT_ROLE_SEEDS);
    const role = store.listRoles()[0];
    const created = store.createConversation('新会话', role.id);
    assert.equal(created.roleId, role.id);
    assert.equal(store.getConversation(created.id).roleId, role.id);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('角色 CRUD：创建、编辑、停用、删除', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const role = store.createRole({ name: '代码审查', description: '审查代码', prompt: '你是代码审查员' });
    assert.equal(role.includeBasePrompt, false);
    assert.equal(role.disabled, false);

    const updated = store.updateRole(role.id, {
      name: '代码审查员',
      prompt: '你是资深代码审查员',
      includeBasePrompt: true,
      disabled: true,
    });
    assert.equal(updated.name, '代码审查员');
    assert.equal(updated.includeBasePrompt, true);
    assert.equal(updated.disabled, true);

    store.deleteRole(role.id);
    assert.equal(store.getRole(role.id), undefined);
  } finally {
    await cleanup();
  }
});

test('默认角色可编辑可删除；历史内置行播种时降级；被引用角色拒绝删除（提示停用）', async () => {
  const { store, cleanup } = await makeStore();
  try {
    // 历史版本以 builtin=1 播种的行（如旧库中的运维排查专家）：播种时降级为普通角色
    const legacy = store.createRole({ name: '历史内置', prompt: 'p', builtin: true });
    store.seedDefaultRoles(DEFAULT_ROLE_SEEDS);
    const demoted = store.getRole(legacy.id);
    assert.equal(demoted.builtin, false, 'builtin 只读语义已废弃，历史行应被降级');
    assert.equal(store.updateRole(demoted.id, { name: '历史内置（已降级）' }).name, '历史内置（已降级）');
    store.deleteRole(demoted.id);
    assert.equal(store.getRole(demoted.id), undefined);

    // 守卫仍然保留：若未来出现 builtin=1 的行，依旧拒绝改删
    const guarded = store.createRole({ name: '内置守卫', prompt: 'p', builtin: true });
    assert.throws(() => store.updateRole(guarded.id, { name: '改名' }), RoleImmutableError);
    assert.throws(() => store.deleteRole(guarded.id), RoleImmutableError);

    const role = store.createRole({ name: '引用角色', prompt: 'p' });
    store.createConversation('绑定会话', role.id);
    assert.throws(
      () => store.deleteRole(role.id),
      (error) => error instanceof RoleInUseError && error.referencedBy === 1,
    );
    // 停用后仍不可删（引用还在），但旧会话仍能读到角色
    store.updateRole(role.id, { disabled: true });
    assert.throws(() => store.deleteRole(role.id), RoleInUseError);
    const bound = store
      .listConversations()
      .find((conversation) => conversation.roleId === role.id);
    assert.ok(bound);
  } finally {
    await cleanup();
  }
});

test('会话绑定：停用/未知角色不能用于新会话；解绑（无角色）不受影响', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const role = store.createRole({ name: 'r', prompt: 'p' });
    store.updateRole(role.id, { disabled: true });
    assert.throws(() => store.createConversation('t', role.id), /已停用/);
    assert.throws(() => store.createConversation('t', 'role_missing'), /不存在/);
    const plain = store.createConversation('t');
    assert.equal(plain.roleId, undefined);
  } finally {
    await cleanup();
  }
});

test('注入解析：无角色→默认；角色→角色 prompt；叠加→拼接；角色缺失→回退并告警', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const getBase = async () => '全局默认提示词';
    const warnings = [];
    const resolve = (conversationId) =>
      resolveConversationSystemPrompt({
        store,
        getBasePrompt: getBase,
        conversationId,
        warn: (message) => warnings.push(message),
      });

    // 无角色
    const plain = store.createConversation('t');
    assert.equal(await resolve(plain.id), '全局默认提示词');

    // 角色（不叠加）
    const role = store.createRole({ name: 'r', prompt: '角色提示词' });
    const bound = store.createConversation('t', role.id);
    assert.equal(await resolve(bound.id), '角色提示词');

    // 叠加默认提示词：默认在前
    store.updateRole(role.id, { includeBasePrompt: true });
    assert.equal(await resolve(bound.id), '全局默认提示词\n\n角色提示词');
    assert.equal(warnings.length, 0);

    // 角色缺失（应用内被删除保护挡住，此处直接构造调用对象防脏数据）：回退默认 + 告警
    assert.equal(
      await resolveConversationSystemPrompt({
        store: {
          getConversation: () => ({
            id: 'conv_x',
            title: '',
            createdAt: 0,
            updatedAt: 0,
            roleId: 'role_gone',
          }),
          getRole: () => undefined,
        },
        getBasePrompt: getBase,
        conversationId: 'conv_x',
        warn: (message) => warnings.push(message),
      }),
      '全局默认提示词',
    );
    assert.equal(warnings.length, 1);
  } finally {
    await cleanup();
  }
});

test('防漂移：默认角色 prompt 引用的工具名与实际注册的能力名一致', () => {
  const registered = [...REPO_EXPLORER_CAPABILITIES, ...KNOWLEDGE_CAPABILITIES].map(
    (capability) => capability.name,
  );
  // prompt 中出现的 repo-explorer__* / knowledge__* 调用都必须是真实能力名
  const referenced = [...OPS_SYSTEM_PROMPT.matchAll(/(?:repo-explorer|knowledge)__[a-z_]+/g)].map(
    (match) => match[0],
  );
  assert.ok(referenced.length >= 5, `应引用检索工具：${referenced.join(', ')}`);
  for (const name of new Set(referenced)) {
    assert.ok(registered.includes(name), `prompt 引用了不存在的能力：${name}`);
  }
  // 不应残留 ops_agent 时代的旧工具名或 deepagents 虚拟路径
  for (const stale of ['knowledge_search(', 'git_inspect', '/workspace/', '/artifacts/']) {
    assert.ok(!OPS_SYSTEM_PROMPT.includes(stale), `不应残留旧表述：${stale}`);
  }
});
