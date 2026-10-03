import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isSupportedDocument } from './parsing.ts';
import { IgnoreRules } from './ignore.ts';

/**
 * 目录扫描（迁移自 skb scanner.py）：列出支持格式的文件快照，
 * 隐藏目录与被排除目录在遍历时整枝剪掉（不会进入其子树 stat）。
 */

export interface FileSnapshot {
  readonly relPath: string;
  readonly size: number;
  readonly mtimeNs: bigint;
}

export async function scanDirectory(root: string, ignore?: IgnoreRules): Promise<FileSnapshot[]> {
  const rules = ignore ?? new IgnoreRules();
  const snapshots: FileSnapshot[] = [];
  await walk(root, root, rules, snapshots);
  return snapshots;
}

async function walk(
  root: string,
  directory: string,
  rules: IgnoreRules,
  snapshots: FileSnapshot[],
): Promise<void> {
  // 读目录失败（权限等）向上抛，由对账层记录并跳过该来源（skb walk onerror=raise 语义）
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      const relDir = relativePosix(root, absolute);
      if (rules.excludes(relDir, { isDirectory: true })) continue;
      await walk(root, absolute, rules, snapshots);
      continue;
    }
    if (!entry.isFile() || !isSupportedDocument(entry.name)) continue;
    const relPath = relativePosix(root, absolute);
    if (rules.excludes(relPath)) continue;
    try {
      // bigint:true 保留纳秒级 mtime（skb st_mtime_ns 语义）；size 回落为 number
      const info = await stat(absolute, { bigint: true });
      snapshots.push({ relPath, size: Number(info.size), mtimeNs: info.mtimeNs });
    } catch {
      // stat 失败的文件本轮跳过（skb FileNotFoundError: continue）
    }
  }
}

function relativePosix(root: string, target: string): string {
  return relative(root, target).replaceAll('\\', '/');
}
