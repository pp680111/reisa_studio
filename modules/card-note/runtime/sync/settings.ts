import { randomUUID } from 'node:crypto';
import type { ModuleConfigScope } from '@reisa/module-sdk';

/**
 * 同步设置（迁移自 card_note `lib/features/sync/{domain,data}/sync_settings*`）。
 * 迁移偏差（v0.6 决策）：源存 SQLite 的 app_settings 表；目标模块按宿主约定
 * 存模块私有 settings.json（ModuleConfigScope，与知识库同模式），不建 app_settings 表。
 */

export interface SyncSettings {
  readonly workspacePath: string;
  readonly remoteUrl: string;
  readonly deviceId: string;
  readonly lastSyncedHead: string;
  readonly autoSync: boolean;
  readonly intervalMinutes: number;
}

const KEY_WORKSPACE_PATH = 'sync.workspace_path';
const KEY_REMOTE_URL = 'sync.remote_url';
const KEY_DEVICE_ID = 'sync.device_id';
const KEY_LAST_SYNCED_HEAD = 'sync.last_synced_head';
const KEY_AUTO_SYNC = 'sync.auto_sync';
const KEY_INTERVAL_MINUTES = 'sync.interval_minutes';

export function isConfigured(settings: SyncSettings): boolean {
  return settings.workspacePath.trim() !== '';
}

function clampInterval(value: number | undefined): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : 10;
  return Math.min(1440, Math.max(1, Math.round(parsed)));
}

export async function loadSyncSettings(config: ModuleConfigScope): Promise<SyncSettings> {
  let deviceId = (await config.get<string>(KEY_DEVICE_ID)) ?? '';
  if (deviceId === '') {
    deviceId = randomUUID();
    await config.set(KEY_DEVICE_ID, deviceId);
  }
  return {
    workspacePath: (await config.get<string>(KEY_WORKSPACE_PATH)) ?? '',
    remoteUrl: (await config.get<string>(KEY_REMOTE_URL)) ?? '',
    deviceId,
    lastSyncedHead: (await config.get<string>(KEY_LAST_SYNCED_HEAD)) ?? '',
    autoSync: (await config.get<boolean>(KEY_AUTO_SYNC)) ?? false,
    intervalMinutes: clampInterval(await config.get<number>(KEY_INTERVAL_MINUTES)),
  };
}

export async function saveSyncConnection(
  config: ModuleConfigScope,
  input: { workspacePath: string; remoteUrl: string },
): Promise<void> {
  await config.set(KEY_WORKSPACE_PATH, input.workspacePath.trim());
  await config.set(KEY_REMOTE_URL, input.remoteUrl.trim());
}

export async function saveSyncLastSyncedHead(
  config: ModuleConfigScope,
  head: string,
): Promise<void> {
  await config.set(KEY_LAST_SYNCED_HEAD, head);
}

export async function saveSyncAuto(
  config: ModuleConfigScope,
  input: { autoSync: boolean; intervalMinutes: number },
): Promise<void> {
  if (
    !Number.isInteger(input.intervalMinutes) ||
    input.intervalMinutes < 1 ||
    input.intervalMinutes > 1440
  ) {
    throw new Error('自动同步间隔必须在 1 到 1440 分钟之间');
  }
  await config.set(KEY_AUTO_SYNC, input.autoSync);
  await config.set(KEY_INTERVAL_MINUTES, input.intervalMinutes);
}
