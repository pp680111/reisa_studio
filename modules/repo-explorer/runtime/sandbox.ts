import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { RepoRegistration } from './config.ts';

/**
 * 虚拟路径沙箱（对齐 ops_agent ScopedCompositeBackend 的拒绝语义）：
 * 只接受 `/repos/<name>/...` 形态的显式路径，拒绝根路径、省略路径、`..`/`~` 穿越
 * 与宿主机绝对路径；解析结果再做 realpath 复验防符号链接逃逸。
 */

export type SandboxErrorCode = 'invalid_path' | 'unregistered_repo';

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode, message: string) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
  }
}

/** 仓库名即虚拟路径段，只允许安全的 URL 风格标识。 */
export const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const VIRTUAL_ROOT = '/repos';

export function virtualRepoPath(name: string): string {
  return `${VIRTUAL_ROOT}/${name}/`;
}

export interface SandboxTarget {
  readonly repo: RepoRegistration;
  /** 解析出的宿主机绝对路径（尚未做 realpath 复验）。 */
  readonly absolutePath: string;
  /** 仓库内相对路径（POSIX 分隔）；仓库根为空串。 */
  readonly relativePart: string;
  /** 归一化后的虚拟路径（供输出与脱敏使用）。 */
  readonly virtualPath: string;
}

function invalid(message: string): SandboxError {
  return new SandboxError(
    'invalid_path',
    `${message}。请传入 /repos/<仓库名>/ 下的显式路径，禁止 . / .. / 家目录或宿主机绝对路径`,
  );
}

/**
 * 解析并校验一个虚拟路径。只做同步的形态与注册表检查；
 * 真实文件系统层面的符号链接逃逸防护由 {@link verifyWithinRepo} 异步复验。
 */
export function resolveVirtualPath(
  registry: readonly RepoRegistration[],
  rawPath: unknown,
): SandboxTarget {
  if (typeof rawPath !== 'string') throw invalid('路径必须是字符串');
  const path = rawPath.trim().replaceAll('\\', '/');
  if (path === '' || path === '.' || path === '/' || path === '/.') {
    throw invalid('禁止使用根路径或省略路径进行全局搜索');
  }
  if (path.startsWith('~')) throw invalid('禁止使用家目录路径');
  if (/^[a-z]:/i.test(path.startsWith('/') ? path.slice(1) : path)) {
    throw invalid('禁止使用宿主机绝对路径');
  }
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const segments = trimmed.split('/');
  if (segments.includes('..')) throw invalid('路径不允许 .. 穿越');
  if (segments.some((segment, index) => index > 0 && segment === '')) {
    throw invalid('路径包含空段');
  }
  if (segments[0] !== '' || segments[1] !== VIRTUAL_ROOT.slice(1)) {
    throw invalid(`路径必须以 ${VIRTUAL_ROOT}/ 开头`);
  }
  const name = segments[2];
  if (name === undefined || REPO_NAME_RE.test(name) === false) {
    throw invalid(`仓库名缺失或不合法：${name ?? '(空)'}`);
  }
  const repo = registry.find((entry) => entry.name === name && entry.enabled);
  if (repo === undefined) {
    throw new SandboxError('unregistered_repo', `仓库 ${name} 未注册或已停用，可先用 list_repos 查看可用仓库`);
  }
  const rest = segments.slice(3);
  if (rest.some((segment) => segment === '.' || segment === '~')) {
    throw invalid(`仓库内路径段不合法：${rest.join('/')}`);
  }
  const relativePart = rest.join('/');
  const root = resolve(repo.path);
  const absolutePath = relativePart === '' ? root : resolve(root, relativePart);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (absolutePath !== root && absolutePath.startsWith(rootWithSep) === false) {
    throw invalid('解析结果越出仓库根目录');
  }
  return {
    repo,
    absolutePath,
    relativePart,
    virtualPath: relativePart === '' ? virtualRepoPath(name) : `${virtualRepoPath(name)}${relativePart}`,
  };
}

/**
 * 对已存在的目标做 realpath 复验：真实路径必须仍在仓库根的真实路径内，
 * 防止仓库内的符号链接把读取引到仓库外。目标不存在时放行——
 * 后续文件操作会以 RESOURCE_NOT_FOUND 收场，不会泄露仓库外内容。
 */
export async function verifyWithinRepo(
  repo: RepoRegistration,
  absolutePath: string,
): Promise<void> {
  let realTarget: string;
  try {
    realTarget = await realpath(absolutePath);
  } catch {
    return;
  }
  const realRoot = await realpath(repo.path);
  const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (realTarget !== realRoot && realTarget.startsWith(rootWithSep) === false) {
    throw new SandboxError('invalid_path', '路径经符号链接指向仓库外，已拒绝访问');
  }
}

/**
 * 校验搜索参数：glob 模式带路径语义（相对搜索根，拒绝绝对路径与 `..`）；
 * 正则只要求非空且可编译（反斜杠等正则语义原样保留）。
 */
export function validateSearchPattern(raw: unknown, kind: 'glob' | 'regex'): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new SandboxError('invalid_path', `${kind === 'glob' ? 'glob 模式' : '正则表达式'}不能为空`);
  }
  const value = raw.trim();
  if (kind === 'regex') {
    try {
      // eslint-disable-next-line no-new -- 仅验证合法性
      new RegExp(value);
    } catch {
      throw new SandboxError('invalid_path', `正则表达式非法：${value}`);
    }
    return value;
  }
  const pattern = value.replaceAll('\\', '/');
  if (pattern.startsWith('/') || /^[a-z]:/i.test(pattern)) {
    throw invalid('glob 模式必须是相对搜索根的路径模式');
  }
  if (pattern.split('/').includes('..')) throw invalid('glob 模式不允许 .. 穿越');
  return pattern;
}
