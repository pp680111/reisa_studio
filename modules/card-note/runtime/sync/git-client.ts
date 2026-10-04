import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';

/**
 * 系统 Git 封装（迁移自 card_note `lib/features/sync/data/git_client.dart`）。
 * Token 绝不作为命令行参数传递：HTTPS 认证交给 Git Credential Manager，
 * SSH 交给用户自己的 SSH 配置；错误信息脱敏可能内嵌凭据的远端 URL。
 * 异步执行（execFile），不阻塞主进程事件循环。
 */

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitCommandRunner {
  run(arguments_: string[], workingDirectory?: string): Promise<GitCommandResult>;
}

export class GitException extends Error {
  readonly details: string | null;
  constructor(message: string, details?: string | null) {
    super(
      details === null || details === undefined || details.trim() === ''
        ? message
        : `${message}：${details.trim()}`,
    );
    this.details = details ?? null;
  }
}

/** 避免回显可能内嵌旧版 HTTPS 凭据的远端 URL（源 _safeDetails）。 */
export function safeGitDetails(details: string): string {
  return details.replace(/https?:\/\/[^\s/@]+@/g, 'https://***@');
}

export class SystemGitCommandRunner implements GitCommandRunner {
  run(arguments_: string[], workingDirectory?: string): Promise<GitCommandResult> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        arguments_,
        { cwd: workingDirectory, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          const err = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
          if (err === null || err === undefined) {
            resolve({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
            return;
          }
          if (err.code === 'ENOENT') {
            reject(new GitException('无法启动 Git。请安装 Git 并重新打开应用。', err.message));
            return;
          }
          if (typeof err.code === 'number') {
            // git 非零退出码：交由调用方按语义处理（如 ls-remote 的 2、diff 的 0/1）。
            resolve({ exitCode: err.code, stdout: String(stdout), stderr: String(stderr) });
            return;
          }
          reject(new GitException('无法启动 Git。请安装 Git 并重新打开应用。', err.message));
        },
      );
    });
  }
}

export class GitClient {
  readonly #runner: GitCommandRunner;
  readonly #logger: { info: (message: string) => void; error: (message: string) => void };

  constructor(
    options: {
      runner?: GitCommandRunner;
      logger?: { info(message: string): void; error(message: string): void };
    } = {},
  ) {
    this.#runner = options.runner ?? new SystemGitCommandRunner();
    this.#logger = options.logger ?? { info: () => {}, error: () => {} };
  }

  async verifyAvailable(): Promise<void> {
    await this.#require(['--version'], { operation: '检查 Git' });
  }

  async isRepository(directory: string): Promise<boolean> {
    const result = await this.#runner.run(['rev-parse', '--is-inside-work-tree'], directory);
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  }

  async initialize(directory: string, deviceId: string, remoteUrl?: string): Promise<void> {
    if (existsSync(directory) && readdirSync(directory).length > 0) {
      throw new GitException('初始化同步仓库的目录必须为空');
    }
    mkdirSync(directory, { recursive: true });
    await this.#require(['init', '--initial-branch=main'], {
      workingDirectory: directory,
      operation: '初始化同步仓库',
    });
    await this.#configureIdentity(directory, deviceId);
    if (remoteUrl !== undefined && remoteUrl.trim() !== '') {
      await this.setRemote(directory, remoteUrl);
    }
  }

  async clone(remoteUrl: string, target: string, deviceId: string): Promise<void> {
    if (existsSync(target) && readdirSync(target).length > 0) {
      throw new GitException('克隆目录必须为空');
    }
    await this.#require(['clone', remoteUrl, target], { operation: '克隆同步仓库' });
    await this.#configureIdentity(target, deviceId);
  }

  async setRemote(directory: string, remoteUrl: string): Promise<void> {
    const existing = await this.#runner.run(['remote', 'get-url', 'origin'], directory);
    if (existing.exitCode === 0) {
      await this.#require(['remote', 'set-url', 'origin', remoteUrl], {
        workingDirectory: directory,
        operation: '更新同步远端',
      });
    } else {
      await this.#require(['remote', 'add', 'origin', remoteUrl], {
        workingDirectory: directory,
        operation: '设置同步远端',
      });
    }
  }

  /** 远端是否存在 main 分支（ls-remote 退出码 2 = 不存在）。 */
  async remoteMainExists(directory: string): Promise<boolean> {
    const result = await this.#runner.run(
      ['ls-remote', '--exit-code', '--heads', 'origin', 'main'],
      directory,
    );
    if (result.exitCode === 0) return true;
    if (result.exitCode === 2) return false;
    throw new GitException('检查远端分支失败', safeGitDetails(result.stderr));
  }

  /** 返回是否真的创建了提交；无文件变化是正常情况（源 stageAndCommit）。 */
  async stageAndCommit(directory: string, message: string): Promise<boolean> {
    await this.#require(['add', '--all'], {
      workingDirectory: directory,
      operation: '暂存同步数据',
    });
    const diff = await this.#runner.run(['diff', '--cached', '--quiet'], directory);
    if (diff.exitCode === 0) return false;
    if (diff.exitCode !== 1) {
      throw new GitException('检查同步变更失败', safeGitDetails(diff.stderr));
    }
    await this.#require(['commit', '--message', message], {
      workingDirectory: directory,
      operation: '提交同步数据',
    });
    return true;
  }

  async fetchAndRebase(directory: string): Promise<void> {
    await this.#require(['fetch', 'origin', 'main'], {
      workingDirectory: directory,
      operation: '获取远端同步数据',
    });
    await this.#require(['rebase', 'origin/main'], {
      workingDirectory: directory,
      operation: '合并远端同步数据',
    });
  }

  async pushMain(directory: string, setUpstream = false): Promise<void> {
    await this.#require(['push', ...(setUpstream ? ['--set-upstream'] : []), 'origin', 'main'], {
      workingDirectory: directory,
      operation: '推送同步数据',
    });
  }

  async head(directory: string): Promise<string> {
    const result = await this.#require(['rev-parse', '--short', 'HEAD'], {
      workingDirectory: directory,
      operation: '读取同步版本',
    });
    return result.stdout.trim();
  }

  async #configureIdentity(directory: string, deviceId: string): Promise<void> {
    await this.#require(['config', 'user.name', 'Card Note'], {
      workingDirectory: directory,
      operation: '配置同步作者',
    });
    await this.#require(['config', 'user.email', `${deviceId}@card-note.local`], {
      workingDirectory: directory,
      operation: '配置同步作者',
    });
  }

  async #require(
    arguments_: string[],
    options: { workingDirectory?: string; operation: string },
  ): Promise<GitCommandResult> {
    const result = await this.#runner.run(arguments_, options.workingDirectory);
    if (result.exitCode !== 0) {
      this.#logger.error(`${options.operation} 失败：${safeGitDetails(result.stderr)}`);
      throw new GitException(options.operation, safeGitDetails(result.stderr));
    }
    this.#logger.info(`${options.operation} 成功`);
    return result;
  }
}
