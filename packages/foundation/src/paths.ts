import { join } from 'node:path';

/**
 * 运行期数据布局（架构设计 §7.2）：每个所有者使用独立目录与数据库。
 * 属运行产物，不入库（根 .gitignore 已排除 app-data/）。
 */
export interface AppDataLayout {
  readonly root: string;
  /** 约定共享的基础配置与凭据。 */
  readonly foundationDir: string;
  /** 主应用会话库与附件副本。 */
  readonly mainDir: string;
  readonly conversationsDb: string;
  readonly attachmentsDir: string;
  /** 各模块私有存储根目录；模块目录内为 data.sqlite / settings.json / files/。 */
  readonly modulesDir: string;
  moduleDir(moduleId: string): string;
}

export function appDataLayout(root: string): AppDataLayout {
  return {
    root,
    foundationDir: join(root, 'foundation'),
    mainDir: join(root, 'main'),
    conversationsDb: join(root, 'main', 'conversations.sqlite'),
    attachmentsDir: join(root, 'main', 'attachments'),
    modulesDir: join(root, 'modules'),
    moduleDir: (moduleId: string) => join(root, 'modules', moduleId),
  };
}
