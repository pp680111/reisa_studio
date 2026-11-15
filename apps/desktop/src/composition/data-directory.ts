import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appDataLayout } from '@reisa/foundation';

/**
 * 数据目录自定义（架构设计 §7.2 的存储根可配置化）：
 * 指针文件存放在默认 Electron userData（永不迁移）下，记录自定义数据根；
 * 启动装配时经 resolveAppDataRoot 解析，无指针或指针失效则回落默认位置。
 * 迁移 = 关闭运行层 → 全量复制 → 校验 → 写指针 → 重启；旧目录永远保留为备份。
 */

const POINTER_FILENAME = 'data-root.json';

interface DataRootPointer {
  readonly version: 1;
  readonly appDataRoot: string;
}

/** 默认数据根：与历史行为一致（userData 下的 app-data）。 */
export function defaultAppDataRoot(userDataPath: string): string {
  return resolve(join(userDataPath, 'app-data'));
}

/**
 * 读取指针记录的自定义数据根；文件缺失（首次运行/未自定义）返回 undefined。
 * 解析失败或指向目录不存在时告警并回落默认——数据本身仍在原处，不因指针损坏而丢失。
 */
export async function readDataRootPointer(userDataPath: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(userDataPath, POINTER_FILENAME), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as DataRootPointer;
    if (
      parsed.version !== 1 ||
      typeof parsed.appDataRoot !== 'string' ||
      parsed.appDataRoot.trim() === ''
    ) {
      throw new Error('指针文件字段不完整');
    }
    const root = resolve(parsed.appDataRoot);
    const info = await stat(root).catch(() => undefined);
    if (info?.isDirectory() !== true) {
      console.warn(`[data-directory] 指针指向的目录不存在，回退默认数据目录：${root}`);
      return undefined;
    }
    return root;
  } catch (error) {
    console.warn(
      `[data-directory] 数据目录指针无效，回退默认数据目录：${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/** 启动装配入口：指针优先，回落默认位置。 */
export async function resolveAppDataRoot(userDataPath: string): Promise<string> {
  return (await readDataRootPointer(userDataPath)) ?? defaultAppDataRoot(userDataPath);
}

/** 原子写入指针（.tmp → rename，同 foundation 配置服务的持久化模式）。 */
export async function writeDataRootPointer(userDataPath: string, root: string): Promise<void> {
  const filePath = join(userDataPath, POINTER_FILENAME);
  const payload = JSON.stringify(
    { version: 1, appDataRoot: resolve(root) } satisfies DataRootPointer,
    null,
    2,
  );
  const tmp = join(userDataPath, `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(tmp, payload, 'utf8');
  await rename(tmp, filePath);
}

/** 清除指针（恢复默认位置时使用）；文件不存在视为已清除。 */
export async function clearDataRootPointer(userDataPath: string): Promise<void> {
  await rm(join(userDataPath, POINTER_FILENAME), { force: true });
}

/** 目标目录是否位于 parent 目录内部（不含相等）。 */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 迁移目标校验：必须在启动迁移（关闭运行层）之前完成，失败不影响运行中的应用。
 * 目标要求为已存在的空目录，避免覆盖用户数据。
 */
export async function validateMigrationTarget(
  sourceRoot: string,
  targetRoot: string,
  options: { readonly defaultRoot?: string } = {},
): Promise<void> {
  const source = resolve(sourceRoot);
  const target = resolve(targetRoot);
  if (source === target) {
    throw new Error('新数据目录与当前数据目录相同');
  }
  if (isInside(source, target)) {
    throw new Error('新数据目录不能位于当前数据目录内部');
  }
  if (isInside(target, source)) {
    throw new Error('新数据目录不能包含当前数据目录');
  }
  const info = await stat(target).catch(() => undefined);
  if (info?.isDirectory() !== true) {
    throw new Error('所选目录不存在或不是文件夹');
  }
  const entries = await readdir(target);
  if (entries.length > 0) {
    // 恢复默认位置撞上旧备份：写明完整路径便于定位，行为保持手动清空
    if (options.defaultRoot !== undefined && resolve(options.defaultRoot) === target) {
      throw new Error(
        `默认数据目录 ${target} 中保留了上次迁移前的数据备份；` +
          '请在文件管理器中删除该目录后重试，当前使用的数据不受影响',
      );
    }
    throw new Error(`所选目录 ${target} 不是空目录：迁移要求目标目录为空，避免覆盖已有数据`);
  }
}

interface TreeStats {
  readonly files: number;
  readonly bytes: number;
}

async function walkTree(root: string): Promise<TreeStats> {
  let files = 0;
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else {
        const info = await stat(child);
        files += 1;
        bytes += Number(info.size);
      }
    }
  };
  await walk(root);
  return { files, bytes };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function assertIntegrity(db: DatabaseSync, label: string): void {
  const rows = db.prepare('PRAGMA integrity_check').all() as Record<string, unknown>[];
  const verdict = rows[0]?.['integrity_check'];
  if (verdict !== 'ok') {
    throw new Error(`迁移校验失败：${label} 完整性检查返回 ${String(verdict)}`);
  }
}

/**
 * 在已复制的库副本中把内嵌的旧数据根绝对路径前缀改写为新根。
 * 运行层已关闭后才执行：delete 日志模式的库复制即一致；WAL 库（knowledge）关闭时已 checkpoint。
 */
async function rewritePathPrefixInDb(
  dbPath: string,
  updateSql: string,
  params: readonly [string, number, number, string],
): Promise<void> {
  if (!existsSync(dbPath)) return; // 全新安装可能尚未建库
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(updateSql).run(...params);
    assertIntegrity(db, basename(dbPath));
  } finally {
    db.close();
  }
}

const ATTACHMENTS_PATH_UPDATE =
  'UPDATE attachments SET path = ? || substr(path, ?) WHERE substr(path, 1, ?) = ?';
const KNOWLEDGE_SOURCE_PATH_UPDATE =
  'UPDATE sources SET path = ? || substr(path, ?) WHERE substr(path, 1, ?) = ?';

/** 会话附件表记录 <app-data>/main/attachments 下的绝对路径（store.ts saveAttachment）。 */
async function rewriteAttachmentsPaths(oldRoot: string, newRoot: string): Promise<void> {
  const oldLayout = appDataLayout(oldRoot);
  const newLayout = appDataLayout(newRoot);
  await rewritePathPrefixInDb(newLayout.conversationsDb, ATTACHMENTS_PATH_UPDATE, [
    newLayout.attachmentsDir,
    oldLayout.attachmentsDir.length + 1,
    oldLayout.attachmentsDir.length,
    oldLayout.attachmentsDir,
  ]);
}

/** knowledge 内置 uploads 来源以绝对路径入库（service.ts ensureUploadsSource）；不改写会导致激活时重复建源。 */
async function rewriteKnowledgeSourcePaths(oldRoot: string, newRoot: string): Promise<void> {
  const oldLayout = appDataLayout(oldRoot);
  const newLayout = appDataLayout(newRoot);
  await rewritePathPrefixInDb(
    join(newLayout.moduleDir('knowledge'), 'data.sqlite'),
    KNOWLEDGE_SOURCE_PATH_UPDATE,
    [
      newLayout.moduleDir('knowledge'),
      oldLayout.moduleDir('knowledge').length + 1,
      oldLayout.moduleDir('knowledge').length,
      oldLayout.moduleDir('knowledge'),
    ],
  );
}

/** 无内嵌路径的模块库只做只读完整性校验（card-note / todo）。 */
async function verifyStandaloneDatabases(newRoot: string): Promise<void> {
  const layout = appDataLayout(newRoot);
  const candidates = [
    join(layout.moduleDir('card-note'), 'card-note.sqlite'),
    join(layout.moduleDir('todo'), 'todo.sqlite'),
  ];
  for (const dbPath of candidates) {
    if (!existsSync(dbPath)) continue;
    const db = new DatabaseSync(dbPath);
    try {
      assertIntegrity(db, basename(dbPath));
    } finally {
      db.close();
    }
  }
}

export interface MigrationStats {
  readonly files: number;
  readonly bytes: number;
}

/**
 * 全量迁移 app-data：复制 → 改写内嵌路径 → 校验（库完整性 + 文件数/字节数对账）。
 * 失败时清空目标目录即完成回滚（调用方保证目标为空目录）；源目录与指针不受影响。
 * 前置条件：调用方先 validateMigrationTarget，且运行层已关闭（无打开的库句柄）。
 */
export async function migrateAppData(options: {
  readonly sourceRoot: string;
  readonly targetRoot: string;
}): Promise<MigrationStats> {
  const sourceRoot = resolve(options.sourceRoot);
  const targetRoot = resolve(options.targetRoot);
  const sourceStats = await walkTree(sourceRoot);
  await cp(sourceRoot, targetRoot, { recursive: true });
  try {
    await rewriteAttachmentsPaths(sourceRoot, targetRoot);
    await rewriteKnowledgeSourcePaths(sourceRoot, targetRoot);
    await verifyStandaloneDatabases(targetRoot);
    const targetStats = await walkTree(targetRoot);
    if (targetStats.files !== sourceStats.files || targetStats.bytes !== sourceStats.bytes) {
      throw new Error(
        `迁移校验失败：源目录 ${sourceStats.files} 个文件 / ${formatBytes(sourceStats.bytes)}，` +
          `目标目录 ${targetStats.files} 个文件 / ${formatBytes(targetStats.bytes)}`,
      );
    }
    return targetStats;
  } catch (error) {
    await rm(targetRoot, { recursive: true, force: true });
    await mkdir(targetRoot, { recursive: true });
    throw error;
  }
}
