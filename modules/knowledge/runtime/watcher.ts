import chokidar, { type FSWatcher } from 'chokidar';
import { resolve } from 'node:path';

/**
 * 文件监听（迁移自 skb watcher.py）：监听已注册来源根目录，
 * 把文件事件合并为同步唤醒。事件只触发对账，周期全量扫描是丢事件时的兜底。
 * 监听不可用仅告警，绝不向上抛（skb watcher_unavailable 语义）。
 */

export type WatchCallback = () => void;

const FILE_EVENTS = new Set(['add', 'change', 'unlink', 'unlinkAll']);

export class ChangeWatcher {
  readonly #onChange: WatchCallback;
  #watcher: FSWatcher | undefined;
  readonly #watched = new Map<string, string>();
  #unavailable = false;

  constructor(onChange: WatchCallback) {
    this.#onChange = onChange;
  }

  /** 已监听则跳过；路径不存在则忽略；失败只告警（skb watch_existing 语义）。 */
  watchExisting(sourceId: string, path: string): void {
    if (this.#watched.has(sourceId)) return;
    void this.watch(sourceId, path);
  }

  watch(sourceId: string, path: string): boolean {
    if (this.#unavailable) return false;
    if (this.#watched.has(sourceId)) return true;
    try {
      this.#watcher ??= this.#createWatcher();
      const root = resolve(path);
      this.#watcher.add(root);
      this.#watched.set(sourceId, root);
      return true;
    } catch {
      this.#unavailable = true;
      console.warn(`[knowledge] watcher_unavailable source=${sourceId}`);
      return false;
    }
  }

  unwatch(sourceId: string): void {
    const root = this.#watched.get(sourceId);
    if (root === undefined) return;
    this.#watched.delete(sourceId);
    try {
      this.#watcher?.unwatch(root);
    } catch {
      /* 监听清理失败不影响业务 */
    }
  }

  async stop(): Promise<void> {
    this.#watched.clear();
    const watcher = this.#watcher;
    this.#watcher = undefined;
    await watcher?.close().catch(() => {});
  }

  #createWatcher(): FSWatcher {
    const watcher = chokidar.watch([], {
      ignoreInitial: true,
      ignorePermissionErrors: true,
      // chokidar 默认递归；skb 对单文件来源只监听父目录，事件过滤按根路径判断
    });
    watcher.on('all', (eventName, eventPath) => {
      if (!FILE_EVENTS.has(eventName)) return;
      const absolute = resolve(eventPath);
      for (const root of this.#watched.values()) {
        if (isWithin(root, absolute)) {
          try {
            this.#onChange();
          } catch (error) {
            console.error('[knowledge] watcher_callback_failed', error);
          }
          return;
        }
      }
    });
    watcher.on('error', (error) => {
      console.warn('[knowledge] watcher_error', error);
    });
    return watcher;
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = root === target ? '' : target.slice(root.length);
  if (relative === '') return true;
  return relative.startsWith('/') || relative.startsWith('\\');
}
