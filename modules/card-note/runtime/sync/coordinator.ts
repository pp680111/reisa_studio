import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ModuleConfigScope } from '@reisa/module-sdk';
import type { CardNoteDatabase } from '../database.ts';
import type { AttachmentStore } from '../attachments.ts';
import { GitClient } from './git-client.ts';
import {
  exportPendingChanges,
  exportSnapshot,
  importDocuments,
  readAndValidate,
} from './workspace.ts';
import {
  isConfigured,
  loadSyncSettings,
  saveSyncConnection,
  saveSyncLastSyncedHead,
  type SyncSettings,
} from './settings.ts';

/**
 * 同步协调器与调度器（迁移自 card_note `lib/features/sync/data/sync_coordinator.dart`
 * 与 sync_scheduler.dart）。
 * 协调器独占写序：导出 → 提交 → fetch/rebase → 校验 → **备份（D3，源实现缺失）** → 导入 → 推送 → 确认 outbox。
 * Git 失败保留 outbox，下一轮自动重试；单飞锁防止并发执行。
 */

export interface SyncRunResult {
  readonly exportedDocuments: number;
  /** 扫描并校验的工作区文档总数（不是新增的远端变更数）。 */
  readonly validatedDocuments: number;
  readonly head: string;
  readonly createdCommit: boolean;
}

export interface SyncCoordinatorLogger {
  info(message: string): void;
  error(message: string): void;
}

/** 导入前备份数据库文件（补源实现缺失的 D3；滚动覆盖单份 .bak）。
 *  node:sqlite 默认 delete 日志模式，复制点无在途事务，直接复制文件即一致；
 *  若未来切换 WAL，需在此先做 checkpoint。 */
export function backupDatabase(database: CardNoteDatabase): string {
  const destination = `${database.filePath}.bak`;
  if (existsSync(database.filePath)) {
    copyFileSync(database.filePath, destination);
  }
  return destination;
}

export class SyncCoordinator {
  readonly #database: CardNoteDatabase;
  readonly #attachments: AttachmentStore;
  readonly #config: ModuleConfigScope;
  readonly #git: GitClient;
  readonly #logger: SyncCoordinatorLogger;
  #running = false;

  constructor(input: {
    database: CardNoteDatabase;
    attachments: AttachmentStore;
    config: ModuleConfigScope;
    git: GitClient;
    logger: SyncCoordinatorLogger;
  }) {
    this.#database = input.database;
    this.#attachments = input.attachments;
    this.#config = input.config;
    this.#git = input.git;
    this.#logger = input.logger;
  }

  /** 初始化新仓库：空目录 init + 全量快照播种。 */
  async initializeNewWorkspace(input: { workspacePath: string; remoteUrl: string }): Promise<void> {
    this.#logger.info('开始初始化同步仓库');
    const settings = await loadSyncSettings(this.#config);
    await this.#git.verifyAvailable();
    await this.#git.initialize(input.workspacePath, settings.deviceId, input.remoteUrl);
    // 旧版本升级而来的空 outbox 无法靠增量补齐依赖（尤其 note-tag 引用的标签），播种全量。
    exportSnapshot(this.#database, input.workspacePath, settings.deviceId);
    await saveSyncConnection(this.#config, {
      workspacePath: input.workspacePath,
      remoteUrl: input.remoteUrl,
    });
    this.#logger.info('同步仓库初始化完成');
  }

  /** 克隆已有仓库并导入。仅当本地库为空或已有备份时安全（源 cloneAndImport 同样约定）。 */
  async cloneAndImport(input: { remoteUrl: string; workspacePath: string }): Promise<number> {
    this.#logger.info('开始克隆并导入同步仓库');
    const settings = await loadSyncSettings(this.#config);
    await this.#git.verifyAvailable();
    if (existsSync(input.workspacePath) && (await this.#git.isRepository(input.workspacePath))) {
      // 上次尝试可能克隆成功但导入失败：复用已克隆的干净工作区重试。
      await this.#git.setRemote(input.workspacePath, input.remoteUrl);
      await this.#git.fetchAndRebase(input.workspacePath);
    } else {
      await this.#git.clone(input.remoteUrl, input.workspacePath, settings.deviceId);
    }
    const documents = readAndValidate(input.workspacePath);
    backupDatabase(this.#database);
    importDocuments(this.#database, this.#attachments, documents, input.workspacePath);
    await saveSyncConnection(this.#config, {
      workspacePath: input.workspacePath,
      remoteUrl: input.remoteUrl,
    });
    await saveSyncLastSyncedHead(this.#config, await this.#git.head(input.workspacePath));
    this.#logger.info(`克隆并导入完成（文档数=${documents.length}）`);
    return documents.length;
  }

  /** 唯一支持的写序；Git 错误保留 outbox，下次成功运行可安全重试。 */
  async synchronize(): Promise<SyncRunResult> {
    if (this.#running) throw new Error('同步正在进行中');
    this.#running = true;
    try {
      this.#logger.info('开始同步');
      const settings = await loadSyncSettings(this.#config);
      if (!isConfigured(settings)) throw new Error('请先配置同步仓库目录');
      if (settings.remoteUrl.trim() === '') throw new Error('请先配置 Git 远端地址');
      const workspacePath = settings.workspacePath;
      if (!(await this.#git.isRepository(workspacePath))) {
        throw new Error('同步目录不是 Git 仓库，请先初始化或克隆仓库');
      }

      const remoteExists = await this.#git.remoteMainExists(workspacePath);
      const exportResult = exportPendingChanges(this.#database, workspacePath, settings.deviceId);
      const createdCommit = await this.#git.stageAndCommit(
        workspacePath,
        `Card Note sync: ${exportResult.documentCount} changes`,
      );

      if (remoteExists) {
        await this.#git.fetchAndRebase(workspacePath);
      }
      const documents = readAndValidate(workspacePath);
      backupDatabase(this.#database);
      const imported = importDocuments(this.#database, this.#attachments, documents, workspacePath);
      await this.#git.pushMain(workspacePath, !remoteExists);
      if (exportResult.changes !== undefined) {
        this.#database.acknowledgeSyncChanges(exportResult.changes);
      }
      const head = await this.#git.head(workspacePath);
      await saveSyncLastSyncedHead(this.#config, head);
      this.#logger.info(
        `同步完成（导出=${exportResult.documentCount}，导入=${imported.documentCount}，提交=${createdCommit}）`,
      );
      return {
        exportedDocuments: exportResult.documentCount,
        validatedDocuments: imported.documentCount,
        head,
        createdCommit,
      };
    } catch (error) {
      this.#logger.error(`同步失败：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      this.#running = false;
    }
  }

  /** UI 状态推导：未配置 / 工作区无效 / 本地变更 / 已同步。 */
  async status(): Promise<{
    settings: SyncSettings;
    gitAvailable: boolean;
    gitError: string | null;
    workspaceIsRepository: boolean;
    pendingChanges: number;
  }> {
    const settings = await loadSyncSettings(this.#config);
    let gitAvailable = true;
    let gitError: string | null = null;
    try {
      await this.#git.verifyAvailable();
    } catch (error) {
      gitAvailable = false;
      gitError = error instanceof Error ? error.message : String(error);
    }
    const workspaceIsRepository =
      isConfigured(settings) &&
      gitAvailable &&
      (await this.#git.isRepository(settings.workspacePath));
    return {
      settings,
      gitAvailable,
      gitError,
      workspaceIsRepository,
      pendingChanges: this.#database.getPendingSyncChanges().length,
    };
  }
}

/** 周期调度器：仅在应用运行期存在；outbox 为空时不发起任何 Git 操作。 */
export class SyncScheduler {
  readonly #database: CardNoteDatabase;
  readonly #config: ModuleConfigScope;
  readonly #synchronize: () => Promise<void>;
  readonly #logger: SyncCoordinatorLogger;
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(input: {
    database: CardNoteDatabase;
    config: ModuleConfigScope;
    synchronize: () => Promise<void>;
    logger: SyncCoordinatorLogger;
  }) {
    this.#database = input.database;
    this.#config = input.config;
    this.#synchronize = input.synchronize;
    this.#logger = input.logger;
  }

  async start(): Promise<void> {
    await this.restart();
  }

  async restart(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    const settings = await loadSyncSettings(this.#config);
    if (!settings.autoSync || !isConfigured(settings)) return;
    this.#timer = setInterval(
      () => {
        void this.runIfNeeded();
      },
      settings.intervalMinutes * 60 * 1000,
    );
    // 定时器不阻止模块停用/应用退出（unref）。
    this.#timer.unref?.();
  }

  async runIfNeeded(): Promise<void> {
    if (this.#running) return;
    const settings = await loadSyncSettings(this.#config);
    if (!settings.autoSync || !isConfigured(settings)) return;
    if (this.#database.getPendingSyncChanges().length === 0) return;
    this.#running = true;
    try {
      this.#logger.info('后台自动同步开始');
      await this.#synchronize();
      this.#logger.info('后台自动同步完成');
    } catch (error) {
      // outbox 原样保留，下个间隔重试；UI 发起的同步会把真实错误呈现给用户。
      this.#logger.error(
        `后台自动同步失败，将在下次间隔重试：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.#running = false;
    }
  }

  dispose(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
