import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import picomatch from 'picomatch';
import ignoreFactory from 'ignore';

/**
 * 只读文件工具实现：ls / read_file / glob / grep。
 * 输入是沙箱解析后的绝对路径；本模块不做虚拟路径判断，只做读操作与上限控制。
 * 遍历不跟随符号链接（逃逸防护由 sandbox.verifyWithinRepo 与此处共同保证）。
 */

/** 单文件读取上限：超过只读前 512KB 并标记截断。 */
export const READ_BYTES_CAP = 512 * 1024;
/** grep 单文件大小上限：更大的文件跳过。 */
export const GREP_FILE_BYTES_CAP = 1024 * 1024;
/** 单次遍历的条目上限：防止巨型目录树拖垮调用。 */
export const WALK_MAX_ENTRIES = 50_000;
/** 命中行原文截断长度。 */
export const SNIPPET_MAX_CHARS = 500;

/** 遍历/搜索始终跳过的目录名（不读 ignore 文件也生效）。 */
const ALWAYS_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);

/** 高置信二进制扩展名：grep 直接跳过，read_file 仍允许（交给 NUL 嗅探）。 */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'pdf', 'zip', 'gz', 'tgz', 'bz2', '7z',
  'rar', 'jar', 'war', 'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'pyc', 'pyo',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac',
  'sqlite', 'db', 'wasm', 'node', 'lancedb',
]);

export class ToolFileError extends Error {
  readonly code: 'not_found' | 'binary_file' | 'is_directory';

  constructor(code: 'not_found' | 'binary_file' | 'is_directory', message: string) {
    super(message);
    this.name = 'ToolFileError';
    this.code = code;
  }
}

/** 仓库根 .gitignore 语义的忽略判断（始终叠加内建跳过目录）。 */
export interface IgnoreMatcher {
  /** 入参为仓库根相对的 POSIX 路径（目录传 `dir/` 形态亦可）。 */
  ignores(repoRelativePosix: string): boolean;
}

export async function loadIgnoreMatcher(repoRoot: string): Promise<IgnoreMatcher> {
  const ignore = ignoreFactory();
  try {
    const content = await readFile(join(repoRoot, '.gitignore'), 'utf8');
    ignore.add(content);
  } catch {
    // 无 .gitignore 或不可读：仅内建跳过规则
  }
  return {
    ignores(repoRelativePosix: string): boolean {
      const normalized = repoRelativePosix.replaceAll('\\', '/').replace(/^\/+/, '');
      if (normalized === '') return false;
      const segments = normalized.split('/');
      if (segments.some((segment) => ALWAYS_SKIP_DIRS.has(segment))) return true;
      try {
        return ignore.ignores(normalized);
      } catch {
        return false;
      }
    },
  };
}

export interface WalkEntry {
  readonly absolutePath: string;
  /** 相对遍历根的 POSIX 路径（glob/grep 匹配用）。 */
  readonly searchRelative: string;
  readonly isDirectory: boolean;
}

export interface WalkState {
  visited: number;
  truncated: boolean;
}

/**
 * 深度优先遍历：先产出目录自身（若 root 本身作为条目匹配），再递归子目录。
 * 跳过符号链接、内建目录与 ignore 规则；达到 maxEntries 后停止并置 truncated。
 */
export async function* walkTree(
  root: string,
  matcher: IgnoreMatcher,
  state: WalkState,
  rootRelative = '',
): AsyncGenerator<WalkEntry> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (entries === null) return;
  for (const entry of entries) {
    state.visited += 1;
    if (state.visited > WALK_MAX_ENTRIES) {
      state.truncated = true;
      return;
    }
    const childRelative = rootRelative === '' ? entry.name : `${rootRelative}/${entry.name}`;
    if (matcher.ignores(childRelative)) continue;
    const childAbsolute = join(root, entry.name);
    if (entry.isDirectory()) {
      yield { absolutePath: childAbsolute, searchRelative: childRelative, isDirectory: true };
      yield* walkTree(childAbsolute, matcher, state, childRelative);
    } else if (entry.isFile()) {
      yield { absolutePath: childAbsolute, searchRelative: childRelative, isDirectory: false };
    }
    // 符号链接与其他特殊文件一律跳过
  }
}

// ---- ls ----

export interface LsEntryJson {
  name: string;
  type: 'file' | 'directory';
  size: number | null;
}

export async function listDirectory(
  absolutePath: string,
  limit: number,
): Promise<{ entries: LsEntryJson[]; truncated: boolean }> {
  const dirents = await readdir(absolutePath, { withFileTypes: true });
  const sorted = [...dirents].sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  const truncated = sorted.length > limit;
  const page = sorted.slice(0, limit);
  const entries: LsEntryJson[] = [];
  for (const dirent of page) {
    if (dirent.isFile()) {
      const info = await stat(join(absolutePath, dirent.name)).catch(() => undefined);
      entries.push({ name: dirent.name, type: 'file', size: info?.size ?? null });
    } else if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, type: 'directory', size: null });
    }
    // 符号链接与其他特殊文件不列出：类型不确定且可能指向仓库外
  }
  return { entries, truncated };
}

// ---- read_file ----

export interface ReadFilePage {
  content: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
}

/** 按行窗口读取文本文件；超过 READ_BYTES_CAP 只读前段并标记截断。 */
export async function readFileLines(
  absolutePath: string,
  offset: number,
  limit: number,
): Promise<ReadFilePage> {
  const info = await stat(absolutePath).catch(() => undefined);
  if (info === undefined) throw new ToolFileError('not_found', '文件不存在');
  if (info.isDirectory()) throw new ToolFileError('is_directory', '目标是目录，请使用 ls');

  const bytesToRead = Math.min(info.size, READ_BYTES_CAP);
  const buffer = Buffer.alloc(bytesToRead);
  if (bytesToRead > 0) {
    const handle = await open(absolutePath, 'r');
    try {
      await handle.read(buffer, 0, bytesToRead, 0);
    } finally {
      await handle.close();
    }
  }
  assertNotBinary(buffer);

  const text = buffer.toString('utf8');
  const allLines = text.split('\n');
  // 文件以换行结尾时最后一个空串不是真实行
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();
  const lines = allLines.map((line) => line.replace(/\r$/, ''));

  const startIndex = Math.min(offset - 1, lines.length);
  const pageLines = lines.slice(startIndex, startIndex + limit);
  const reachedByteCap = info.size > READ_BYTES_CAP;
  const truncated = reachedByteCap || startIndex + limit < lines.length;
  return {
    content: pageLines.join('\n'),
    startLine: startIndex + 1,
    endLine: startIndex + pageLines.length,
    truncated,
  };
}

function assertNotBinary(buffer: Buffer): void {
  const probeEnd = Math.min(buffer.length, 8192);
  for (let index = 0; index < probeEnd; index += 1) {
    if (buffer[index] === 0) throw new ToolFileError('binary_file', '目标看起来是二进制文件，未返回内容');
  }
}

// ---- glob / grep 共用 ----

export function compileGlob(pattern: string): (candidate: string) => boolean {
  return picomatch(pattern, { dot: true });
}

export function toPosixPath(value: string): string {
  return value.split(sep).join('/');
}

/** grep 额外的文件过滤：命中文件相对路径或其基名匹配 glob 即保留。 */
export function makeGlobFilter(globPattern: string | undefined): (searchRelative: string) => boolean {
  if (globPattern === undefined) return () => true;
  const normalized = globPattern.replaceAll('\\', '/').replace(/^\/+/, '');
  const match = compileGlob(normalized);
  return (searchRelative: string) => {
    const base = searchRelative.includes('/') ? searchRelative.slice(searchRelative.lastIndexOf('/') + 1) : searchRelative;
    return match(searchRelative) || match(base);
  };
}

export function looksBinaryByExtension(searchRelative: string): boolean {
  const base = searchRelative.includes('/') ? searchRelative.slice(searchRelative.lastIndexOf('/') + 1) : searchRelative;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return BINARY_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

// ---- grep ----

export interface GrepMatchJson {
  path: string;
  line: number;
  snippet: string;
}

export interface GrepOutcome {
  matches: GrepMatchJson[];
  truncated: boolean;
  filesSearched: number;
}

/**
 * 在遍历根下逐文件逐行正则搜索。
 * virtualPrefix 用于把命中文件的相对路径拼回虚拟路径（如 /repos/demo/）。
 */
export async function grepTree(options: {
  root: string;
  virtualPrefix: string;
  regex: RegExp;
  fileFilter: (searchRelative: string) => boolean;
  maxCount: number;
  matcher: IgnoreMatcher;
}): Promise<GrepOutcome> {
  const { root, virtualPrefix, regex, fileFilter, maxCount, matcher } = options;
  const state: WalkState = { visited: 0, truncated: false };
  const matches: GrepMatchJson[] = [];
  let filesSearched = 0;
  let hitCap = false;

  for await (const entry of walkTree(root, matcher, state)) {
    if (hitCap) break;
    if (entry.isDirectory) continue;
    if (fileFilter(entry.searchRelative) === false) continue;
    if (looksBinaryByExtension(entry.searchRelative)) continue;
    const info = await stat(entry.absolutePath).catch(() => undefined);
    if (info?.isFile() !== true || info.size > GREP_FILE_BYTES_CAP) continue;

    const buffer = await readFile(entry.absolutePath).catch(() => null);
    if (buffer === null) continue;
    const probeEnd = Math.min(buffer.length, 8192);
    let binary = false;
    for (let index = 0; index < probeEnd; index += 1) {
      if (buffer[index] === 0) {
        binary = true;
        break;
      }
    }
    if (binary) continue;

    filesSearched += 1;
    const lines = buffer.toString('utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.replace(/\r$/, '');
      if (regex.test(line) === false) continue;
      matches.push({
        path: `${virtualPrefix}${toPosixPath(entry.searchRelative)}`,
        line: index + 1,
        snippet: line.length > SNIPPET_MAX_CHARS ? line.slice(0, SNIPPET_MAX_CHARS) : line,
      });
      if (matches.length >= maxCount) {
        hitCap = true;
        break;
      }
    }
  }
  return {
    matches,
    truncated: hitCap || state.truncated,
    filesSearched,
  };
}
