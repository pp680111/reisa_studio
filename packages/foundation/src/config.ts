import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface ConfigService {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  all(): Promise<Readonly<Record<string, unknown>>>;
  reload(): Promise<void>;
}

async function persistAtomically(filePath: string, data: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = join(dirname(filePath), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, filePath);
}

/**
 * JSON 文件配置：内存缓存 + 原子写入。
 * 只承载约定共享的公共配置（主题、语言、服务商连接等，架构设计 §8.1）；
 * 模块私有配置由模块自己的 settings.json 承载，不经由此服务读取。
 */
export async function createFileConfigService(filePath: string): Promise<ConfigService> {
  const values = new Map<string, unknown>();
  let loaded = false;

  const load = async (): Promise<void> => {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) values.set(key, value);
    } catch {
      // 首次运行或文件缺失：从空配置开始（真实状态提示由调用方负责）
    }
    loaded = true;
  };

  const ensureLoaded = async (): Promise<void> => {
    if (!loaded) await load();
  };

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      await ensureLoaded();
      return values.get(key) as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      await ensureLoaded();
      values.set(key, value);
      await persistAtomically(filePath, JSON.stringify(Object.fromEntries(values), null, 2));
    },
    async remove(key: string): Promise<void> {
      await ensureLoaded();
      values.delete(key);
      await persistAtomically(filePath, JSON.stringify(Object.fromEntries(values), null, 2));
    },
    async all(): Promise<Readonly<Record<string, unknown>>> {
      await ensureLoaded();
      return Object.fromEntries(values);
    },
    async reload(): Promise<void> {
      values.clear();
      loaded = false;
      await load();
    },
  };
}
