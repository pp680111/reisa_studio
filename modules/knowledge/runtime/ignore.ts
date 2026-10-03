import ignore from 'ignore';

/**
 * 来源相对 gitignore 排除规则（迁移自 skb ignore.py，pathspec → `ignore` npm）。
 * 语义基准见迁移设计文档 §4.5：后写规则优先；祖先剪枝中隐藏目录与
 * node_modules/__pycache__ 是不可覆盖的默认排除（负向规则无法恢复）。
 */

export const DEFAULT_IGNORED_DIRECTORIES = new Set<string>(['node_modules', '__pycache__']);
export const MAX_IGNORE_RULES_CHARS = 64_000;

export class IgnoreRules {
  readonly #spec: ReturnType<typeof ignore>;

  constructor(rules = '') {
    if (rules.length > MAX_IGNORE_RULES_CHARS) {
      throw new Error('排除规则不能超过 64000 个字符');
    }
    const spec = ignore();
    const lines = rules.split(/\r\n|\r|\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (line.includes('\0')) {
        throw new Error(`排除规则第 ${index + 1} 行包含无效字符`);
      }
      try {
        spec.add(line);
      } catch {
        // pathspec 会对个别非法语法抛错；`ignore` 包更宽容，能编译的行全部接受
        throw new Error(`排除规则第 ${index + 1} 行无效`);
      }
    }
    this.#spec = spec;
  }

  /**
   * 判断相对路径是否被排除。skb 语义：
   * 1. 祖先剪枝——任一前缀目录为隐藏目录 / 默认排除目录 / 被规则排除 → 整枝排除；
   * 2. 最后对路径本身做匹配（目录带尾部斜杠，目录模式只作用于目录）。
   */
  excludes(relPath: string, options: { isDirectory?: boolean } = {}): boolean {
    const isDirectory = options.isDirectory ?? false;
    const parts = relPath.split('/').filter((part) => part.length > 0 && part !== '.');
    const lastAncestor = parts.length - (isDirectory ? 0 : 1);
    for (let length = 1; length <= lastAncestor; length += 1) {
      const name = parts[length - 1] ?? '';
      if (name.startsWith('.') || DEFAULT_IGNORED_DIRECTORIES.has(name)) return true;
      if (this.#spec.ignores(`${parts.slice(0, length).join('/')}/`)) return true;
    }
    return this.#spec.ignores(relPath + (isDirectory ? '/' : ''));
  }
}
