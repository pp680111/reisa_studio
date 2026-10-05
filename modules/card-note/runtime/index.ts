import type { JsonValue, ModuleActivation, ModuleContext, RuntimeModule } from '@reisa/module-sdk';
import { basename, join } from 'node:path';
import {
  MODULE_ID,
  MODULE_VERSION,
  PAGE_ACTIONS,
  type AttachmentJson,
  type BookJson,
  type CloneSyncResultJson,
  type DeletedResultJson,
  type ExportPreviewJson,
  type ExportWrittenJson,
  type ImportResultJson,
  type InitializedResultJson,
  type NoteJson,
  type ProbeImageResultJson,
  type ReadAttachmentResultJson,
  type SavedResultJson,
  type SaveNoteResultJson,
  type StatsJson,
  type SyncRunResultJson,
  type SyncStatusJson,
  type TagJson,
} from '../contracts.ts';
import {
  CardNoteDatabase,
  DomainError,
  type Attachment,
  type Book,
  type Note,
  type Tag,
} from './database.ts';
import { AttachmentStore, probeImage } from './attachments.ts';
import { buildExport, importFromPath, writeExport } from './export.ts';
import { validateQuote } from '../domain/validation.ts';
import { GitClient } from './sync/git-client.ts';
import { SyncCoordinator, SyncScheduler, type SyncCoordinatorLogger } from './sync/coordinator.ts';
import {
  isConfigured,
  loadSyncSettings,
  saveSyncAuto,
  saveSyncConnection,
} from './sync/settings.ts';

/**
 * 卡片笔记模块运行入口（迁移设计文档 M0/M2/M5）。
 * 只能被组合根导入（边界检查约定）；不加载任何 UI 代码。
 * 数据库文件位于模块私有数据目录（app-data/modules/card-note/card-note.sqlite），
 * 附件二进制在 dataDir/media/（SHA-256 内容寻址）；同步设置在 settings.json；
 * 停用不删数据、停用即停止调度器（宿主生命周期语义）。
 */

export interface CreateCardNoteRuntimeOptions {
  /** 组合根注入：注册本模块的页面服务（受限 IPC `reisa/module/page` 使用）。 */
  readonly registerPageService?: (invoke: PageServiceInvoke) => void;
  /** 测试注入：替代默认的系统 Git 封装（生产不传，走系统 git）。 */
  readonly createGitClient?: () => GitClient;
}

/** 页面服务调用上下文：信号与模块停用关联，宿主停用即取消（架构设计 §10.2）。 */
export interface PageServiceContext {
  readonly signal?: AbortSignal;
}

export type PageServiceInvoke = (
  action: string,
  input: JsonValue,
  context?: PageServiceContext,
) => Promise<JsonValue>;

interface CardNoteRuntimeServices {
  readonly database: CardNoteDatabase;
  readonly attachments: AttachmentStore;
  readonly config: ModuleContext['config'];
  readonly coordinator: SyncCoordinator;
  readonly scheduler: SyncScheduler;
}

export class CardNoteRuntime implements RuntimeModule {
  readonly id = MODULE_ID;
  readonly version = MODULE_VERSION;
  readonly protocolVersion = '1' as const;

  #context: ModuleContext | undefined;
  #services: CardNoteRuntimeServices | undefined;
  /** 同步取消源：停用时先于资源释放向在途同步传递取消（架构设计 §10.2）。 */
  #syncCancellation: AbortController | undefined;
  readonly #createGitClient: (() => GitClient) | undefined;

  constructor(createGitClient?: () => GitClient) {
    this.#createGitClient = createGitClient;
  }

  async activate(context: ModuleContext): Promise<ModuleActivation> {
    this.#context = context;
    const database = new CardNoteDatabase(join(context.storage.dataDir, 'card-note.sqlite'));
    const attachments = new AttachmentStore(database, context.storage.dataDir);
    const logger: SyncCoordinatorLogger = {
      info: (message) => context.logger.info(message),
      error: (message) => context.logger.error(message),
    };
    const syncCancellation = new AbortController();
    this.#syncCancellation = syncCancellation;
    const coordinator = new SyncCoordinator({
      database,
      attachments,
      config: context.config,
      git: this.#createGitClient?.() ?? new GitClient({ logger }),
      logger,
    });
    const scheduler = new SyncScheduler({
      database,
      config: context.config,
      synchronize: async () => {
        await coordinator.synchronize(syncCancellation.signal);
      },
      logger,
    });
    this.#services = { database, attachments, config: context.config, coordinator, scheduler };
    void scheduler.start();
    return {
      tools: [],
      deactivate: () => this.#deactivate(),
    };
  }

  async #deactivate(): Promise<void> {
    const services = this.#services;
    this.#services = undefined;
    this.#context = undefined;
    if (services) {
      // 停用顺序（架构设计 §10.2）：停定时器 → 取消在途同步 → 等待真正结束 → 才关闭数据库。
      services.scheduler.dispose();
      this.#syncCancellation?.abort();
      this.#syncCancellation = undefined;
      await services.scheduler.waitForIdle();
      services.database.close();
    }
  }

  #require(): CardNoteRuntimeServices {
    const services = this.#services;
    if (services === undefined) {
      throw new DomainError('模块未激活');
    }
    return services;
  }

  /**
   * 页面服务（受限通道动作分发；动作白名单见 contracts.ts PAGE_ACTIONS）。
   * 载荷为不可信输入：字段逐一显式转换，不透传任意结构。
   */
  pageService(): PageServiceInvoke {
    return async (action, input, context) => {
      const signal = context?.signal;
      const { database, attachments, config, coordinator, scheduler } = this.#require();
      const payload = (input ?? {}) as Record<string, unknown>;
      const string = (key: string): string => String(payload[key] ?? '');
      const optionalString = (key: string): string | null => {
        const value = payload[key];
        return value === undefined || value === null ? null : String(value);
      };
      const optionalInt = (key: string): number | null => {
        const value = payload[key];
        if (value === undefined || value === null || value === '') return null;
        const parsed = Number(value);
        if (!Number.isInteger(parsed)) {
          throw new DomainError(`字段 ${key} 必须是整数`);
        }
        return parsed;
      };
      const stringList = (key: string): string[] => {
        const value = payload[key];
        return Array.isArray(value) ? value.map((item) => String(item)) : [];
      };

      switch (action) {
        case PAGE_ACTIONS.getStats: {
          // 返回值以契约 DTO 类型收口：字段漂移在编译期暴露（R7 单一真源）
          const stats: StatsJson = database.stats();
          return stats;
        }
        case PAGE_ACTIONS.listBooks:
          return database.listBooks().map(toBookJson);
        case PAGE_ACTIONS.getBook: {
          const book = database.getBook(string('bookId'));
          return book === null ? null : toBookJson(book);
        }
        case PAGE_ACTIONS.createBook:
          return toBookJson(database.createBook(string('title')));
        case PAGE_ACTIONS.renameBook:
          return toBookJson(database.renameBook(string('bookId'), string('title')));
        case PAGE_ACTIONS.deleteBook: {
          database.deleteBook(string('bookId'));
          const receipt: DeletedResultJson = { deleted: true };
          return receipt;
        }
        case PAGE_ACTIONS.listNotes:
          return database
            .listNotes(string('bookId'), optionalString('query') ?? '')
            .map(toNoteJson);
        case PAGE_ACTIONS.getNote: {
          const note = database.getNote(string('noteId'));
          return note === null ? null : toNoteJson(note);
        }
        case PAGE_ACTIONS.saveNote: {
          const saved = database.saveNote({
            noteId: optionalString('noteId'),
            bookId: string('bookId'),
            quote: validateQuote(string('quote')),
            comment: optionalString('comment'),
            pageStart: optionalInt('pageStart'),
            pageEnd: optionalInt('pageEnd'),
            tagIds: stringList('tagIds'),
          });
          // 附件草稿落库（源 _save 语义）：仅在调用方携带 attachments 字段时执行——
          // 按草稿顺序写入新附件、移除缺失项、重排序号。
          if (payload['attachments'] !== undefined) {
            const drafts = Array.isArray(payload['attachments'])
              ? (payload['attachments'] as Array<Record<string, unknown>>)
              : [];
            const activeIds: string[] = [];
            for (let index = 0; index < drafts.length; index++) {
              const draft = drafts[index] ?? {};
              const id = String(draft['id'] ?? '');
              if (id === '') continue;
              const sourcePath = draft['sourcePath'];
              if (typeof sourcePath === 'string' && sourcePath !== '') {
                attachments.addFromPath({
                  id,
                  noteId: saved.id,
                  sourcePath,
                  originalFileName:
                    typeof draft['originalFileName'] === 'string' &&
                    draft['originalFileName'] !== ''
                      ? draft['originalFileName']
                      : basename(sourcePath),
                  sortOrder: index,
                });
              }
              activeIds.push(id);
            }
            const stored = database.getAttachmentsForNote(saved.id);
            for (const attachment of stored) {
              if (!activeIds.includes(attachment.id)) {
                attachments.remove(attachment.id);
              }
            }
            attachments.reorder(activeIds);
          }
          const receipt: SaveNoteResultJson = {
            id: saved.id,
            contentRevision: saved.contentRevision,
          };
          return receipt;
        }
        case PAGE_ACTIONS.deleteNote: {
          database.deleteNote(string('noteId'));
          const receipt: DeletedResultJson = { deleted: true };
          return receipt;
        }
        case PAGE_ACTIONS.exportBook: {
          const format = string('format') === 'json' ? 'json' : 'markdown';
          const targetPath = optionalString('targetPath');
          if (targetPath !== null) {
            const written: ExportWrittenJson = writeExport(
              database,
              string('bookId'),
              format,
              targetPath,
            );
            return written;
          }
          const preview: ExportPreviewJson = buildExport(database, string('bookId'), format);
          return preview;
        }
        case PAGE_ACTIONS.importBook: {
          const imported: ImportResultJson = importFromPath(database, string('sourcePath'));
          return imported;
        }
        case PAGE_ACTIONS.getSyncStatus: {
          const snapshot = await coordinator.status();
          const status: SyncStatusJson = {
            workspacePath: snapshot.settings.workspacePath,
            remoteUrl: snapshot.settings.remoteUrl,
            deviceId: snapshot.settings.deviceId,
            lastSyncedHead: snapshot.settings.lastSyncedHead,
            autoSync: snapshot.settings.autoSync,
            intervalMinutes: snapshot.settings.intervalMinutes,
            configured: isConfigured(snapshot.settings),
            gitAvailable: snapshot.gitAvailable,
            gitError: snapshot.gitError,
            workspaceIsRepository: snapshot.workspaceIsRepository,
            pendingChanges: snapshot.pendingChanges,
          };
          return status;
        }
        case PAGE_ACTIONS.initializeSyncWorkspace: {
          await coordinator.initializeNewWorkspace(
            {
              workspacePath: string('workspacePath'),
              remoteUrl: string('remoteUrl'),
            },
            signal,
          );
          await scheduler.restart();
          const receipt: InitializedResultJson = { initialized: true };
          return receipt;
        }
        case PAGE_ACTIONS.cloneSyncRepository: {
          const imported = await coordinator.cloneAndImport(
            {
              workspacePath: string('workspacePath'),
              remoteUrl: string('remoteUrl'),
            },
            signal,
          );
          await scheduler.restart();
          const receipt: CloneSyncResultJson = { importedDocuments: imported };
          return receipt;
        }
        case PAGE_ACTIONS.syncNow: {
          const result: SyncRunResultJson = await coordinator.synchronize(signal);
          return result;
        }
        case PAGE_ACTIONS.saveSyncConnection: {
          await saveSyncConnection(config, {
            workspacePath: string('workspacePath'),
            remoteUrl: string('remoteUrl'),
          });
          await scheduler.restart();
          const receipt: SavedResultJson = { saved: true };
          return receipt;
        }
        case PAGE_ACTIONS.saveSyncAuto: {
          const interval = optionalInt('intervalMinutes');
          await saveSyncAuto(config, {
            autoSync: payload['autoSync'] === true,
            intervalMinutes: interval ?? 10,
          });
          await scheduler.restart();
          const receipt: SavedResultJson = { saved: true };
          return receipt;
        }
        case PAGE_ACTIONS.listAttachments:
          return database.getAttachmentsForNote(string('noteId')).map(toAttachmentJson);
        case PAGE_ACTIONS.probeAttachment: {
          const probe: ProbeImageResultJson = probeImage(string('path'));
          return probe;
        }
        case PAGE_ACTIONS.readAttachment: {
          const attachment = database.getAttachment(string('attachmentId'));
          if (attachment === null) return null;
          const payload: ReadAttachmentResultJson = {
            dataUrl: attachments.readAsDataUrl(attachment),
          };
          return payload;
        }
        case PAGE_ACTIONS.listTags:
          return database.listTags().map(toTagJson);
        case PAGE_ACTIONS.getNoteTags:
          return database.getTagsForNote(string('noteId')).map(toTagJson);
        case PAGE_ACTIONS.ensureTag:
          return toTagJson(database.ensureTag(string('name')));
        case PAGE_ACTIONS.renameTag:
          return toTagJson(database.renameTag(string('tagId'), string('name')));
        case PAGE_ACTIONS.deleteTag: {
          database.deleteTag(string('tagId'));
          const receipt: DeletedResultJson = { deleted: true };
          return receipt;
        }
        default:
          throw new DomainError(`未知的页面服务操作：${action}`);
      }
    };
  }
}

// 领域实体 → 页面服务 DTO 的序列化收口：返回类型绑定 contracts.ts 契约，
// DTO 字段增删改在此处（以及 ui 侧调用签名）编译失败，替代原先的 as unknown as JsonValue 盲转。
function toBookJson(book: Book): BookJson {
  return {
    id: book.id,
    title: book.title,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
  };
}

function toNoteJson(note: Note): NoteJson {
  return {
    id: note.id,
    bookId: note.bookId,
    quote: note.quote,
    comment: note.comment,
    pageStart: note.pageStart,
    pageEnd: note.pageEnd,
    contentRevision: note.contentRevision,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

function toTagJson(tag: Tag): TagJson {
  return {
    id: tag.id,
    name: tag.name,
    normalizedName: tag.normalizedName,
    createdAt: tag.createdAt,
    updatedAt: tag.updatedAt,
  };
}

function toAttachmentJson(attachment: Attachment): AttachmentJson {
  return {
    id: attachment.id,
    noteId: attachment.noteId,
    storedFileName: attachment.storedFileName,
    originalFileName: attachment.originalFileName,
    mimeType: attachment.mimeType,
    byteSize: attachment.byteSize,
    sortOrder: attachment.sortOrder,
    contentHash: attachment.contentHash,
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt,
  };
}

/** 组合根入口：创建卡片笔记运行时模块。 */
export function createCardNoteRuntime(options: CreateCardNoteRuntimeOptions = {}): RuntimeModule {
  const runtime = new CardNoteRuntime(options.createGitClient);
  if (options.registerPageService) {
    options.registerPageService(runtime.pageService());
  }
  return runtime;
}
