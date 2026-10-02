import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 加密器接口：Electron 侧应注入 safeStorage 实现；测试可注入直通实现。 */
export interface Cipher {
  encrypt(plain: string): string;
  decrypt(payload: string): string;
}

export interface CredentialStore {
  /** 读取凭据；凭据只通过句柄使用，不进入工具定义或提示词（架构设计 §8.2）。 */
  get(ref: string): Promise<string | undefined>;
  set(ref: string, secret: string): Promise<void>;
  remove(ref: string): Promise<void>;
}

const passthroughCipher: Cipher = {
  encrypt: (plain) => plain,
  decrypt: (payload) => payload,
};

let warnedPlain = false;

/**
 * 文件凭据存储：引用名 → 加密后的密文，原子写入。
 * 默认直通存储仅用于开发与测试（会警告一次）；正式运行必须注入加密器。
 */
export function createFileCredentialStore(
  filePath: string,
  cipher: Cipher = passthroughCipher,
): CredentialStore {
  if (cipher === passthroughCipher && !warnedPlain) {
    warnedPlain = true;
    console.warn('[foundation] 凭据未加密存储：正式运行请注入 safeStorage 等加密器');
  }
  const cache = new Map<string, string>();
  let loaded = false;

  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, string>;
      for (const [ref, payload] of Object.entries(raw)) cache.set(ref, payload);
    } catch {
      // 首次运行：无凭据文件
    }
    loaded = true;
  };

  const persist = async (): Promise<void> => {
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = join(
      dirname(filePath),
      `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    await writeFile(tmp, JSON.stringify(Object.fromEntries(cache), null, 2), 'utf8');
    await rename(tmp, filePath);
  };

  return {
    async get(ref: string): Promise<string | undefined> {
      await ensureLoaded();
      const payload = cache.get(ref);
      return payload === undefined ? undefined : cipher.decrypt(payload);
    },
    async set(ref: string, secret: string): Promise<void> {
      await ensureLoaded();
      cache.set(ref, cipher.encrypt(secret));
      await persist();
    },
    async remove(ref: string): Promise<void> {
      await ensureLoaded();
      cache.delete(ref);
      await persist();
    },
  };
}
