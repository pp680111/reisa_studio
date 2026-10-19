import { Type } from '@sinclair/typebox';
import { defineCapability } from '@reisa/module-sdk';

/**
 * 代码仓库检索能力契约（renderer 安全）。
 * 所有路径参数一律使用虚拟路径 `/repos/<仓库名>/...`（POSIX 风格）；
 * 输出与错误中不出现宿主机真实路径（沙箱脱敏由 runtime 保证）。
 */

export const MODULE_ID = 'repo-explorer';
export const MODULE_VERSION = '0.1.0';

/** 仓库数量与单次输出的防御性上限。 */
export const MAX_LS_ENTRIES = 1000;
export const MAX_GLOB_MATCHES = 500;
export const MAX_GREP_MATCHES = 200;
export const MAX_READ_LINES = 2000;
export const DEFAULT_READ_LINES = 500;

const VirtualPath = Type.String({
  minLength: 1,
  maxLength: 2000,
  description: '虚拟路径，必须以 /repos/<仓库名>/ 开头（如 /repos/demo/src/main.ts）；禁止 . / .. 或宿主机路径',
});

// ---- list_repos ----

export const RepoSummarySchema = Type.Object({
  name: Type.String({ description: '仓库名，用作虚拟路径的第二段' }),
  path: Type.String({ description: '虚拟根路径 /repos/<name>/' }),
  tags: Type.Array(Type.String(), { description: '业务标签，用于按服务匹配仓库' }),
  description: Type.Union([Type.String(), Type.Null()]),
});

export const ListReposOutput = Type.Object({
  repos: Type.Array(RepoSummarySchema),
});

// ---- ls ----

export const LsInput = Type.Object({
  path: VirtualPath,
});

export const LsEntrySchema = Type.Object({
  name: Type.String(),
  type: Type.Union([Type.Literal('file'), Type.Literal('directory')]),
  size: Type.Union([Type.Integer(), Type.Null()], { description: '文件字节数；目录为 null' }),
});

export const LsOutput = Type.Object({
  path: Type.String(),
  entries: Type.Array(LsEntrySchema, { maxItems: MAX_LS_ENTRIES }),
  truncated: Type.Boolean(),
});

// ---- read_file ----

export const ReadFileInput = Type.Object({
  path: VirtualPath,
  offset: Type.Optional(
    Type.Integer({ minimum: 1, default: 1, description: '起始行（1-based）' }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_READ_LINES, default: DEFAULT_READ_LINES }),
  ),
});

export const ReadFileOutput = Type.Object({
  path: Type.String(),
  content: Type.String(),
  startLine: Type.Integer({ description: '本页首行的 1-based 行号' }),
  endLine: Type.Integer({ description: '本页末行的 1-based 行号' }),
  truncated: Type.Boolean({ description: '是否还有后续行（或单次读取达到字节上限）' }),
});

// ---- glob ----

export const GlobInput = Type.Object({
  pattern: Type.String({
    minLength: 1,
    maxLength: 1000,
    description: '相对 path 的 glob 模式，如 **/*.ts；禁止以 / 开头或包含 ..',
  }),
  path: VirtualPath,
});

export const GlobOutput = Type.Object({
  matches: Type.Array(Type.String(), { description: '命中的虚拟路径列表', maxItems: MAX_GLOB_MATCHES }),
  truncated: Type.Boolean(),
});

// ---- grep ----

export const GrepInput = Type.Object({
  pattern: Type.String({
    minLength: 1,
    maxLength: 1000,
    description: 'JavaScript 正则表达式（区分大小写）',
  }),
  path: VirtualPath,
  glob: Type.Optional(
    Type.String({ description: '文件名过滤，如 *.ts 或 src/**；仅匹配 glob 命中的文件' }),
  ),
  maxCount: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_GREP_MATCHES, default: 50 }),
  ),
});

export const GrepMatchSchema = Type.Object({
  path: Type.String({ description: '命中文件的虚拟路径' }),
  line: Type.Integer({ description: '1-based 行号' }),
  snippet: Type.String({ description: '命中行原文（截断到 500 字符）' }),
});

export const GrepOutput = Type.Object({
  matches: Type.Array(GrepMatchSchema, { maxItems: MAX_GREP_MATCHES }),
  truncated: Type.Boolean({ description: '达到 maxCount 或遍历上限而提前停止' }),
  filesSearched: Type.Integer({ description: '本次实际扫描的文件数' }),
});

export const repoExplorerListRepos = defineCapability(
  MODULE_ID,
  'list_repos',
  '列出已注册的代码仓库（名称、虚拟路径与标签）。查看或检索项目源码前先调用此工具获取可用仓库。',
  { outputSchema: ListReposOutput },
);

export const repoExplorerLs = defineCapability(
  MODULE_ID,
  'ls',
  '列出虚拟路径下目录的子项（名称、类型与文件大小）。path 必须是 /repos/<name>/ 下的显式路径。',
  { inputSchema: LsInput, outputSchema: LsOutput },
);

export const repoExplorerReadFile = defineCapability(
  MODULE_ID,
  'read_file',
  '按行窗口读取虚拟路径下文本文件的内容；返回超限或还有后续行时用 offset 续读。',
  { inputSchema: ReadFileInput, outputSchema: ReadFileOutput },
);

export const repoExplorerGlob = defineCapability(
  MODULE_ID,
  'glob',
  '在虚拟路径目录下按 glob 模式查找文件路径。',
  { inputSchema: GlobInput, outputSchema: GlobOutput },
);

export const repoExplorerGrep = defineCapability(
  MODULE_ID,
  'grep',
  '在虚拟路径目录下按正则搜索文件内容，返回命中文件的路径、行号与命中行原文。',
  { inputSchema: GrepInput, outputSchema: GrepOutput },
);

export const REPO_EXPLORER_CAPABILITIES = [
  repoExplorerListRepos,
  repoExplorerLs,
  repoExplorerReadFile,
  repoExplorerGlob,
  repoExplorerGrep,
] as const;
