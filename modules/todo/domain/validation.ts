/**
 * 表单校验（迁移自 todo_manage DAO 的 _validateFormMap / validateMapForm / _validateFromMap，
 * 迁移设计文档 §5.1）：错误消息与源逐一对应，UI 直接展示。
 * 源的类型错误分支（'xx参数值类型错误'）在类型化 API 下只剩截止时间一类需要保留。
 */

/** 领域规则错误（消息与源项目对应，UI 直接展示）。 */
export class TodoValidationError extends Error {}

/** 标题：去空白后非空（源消息 '标题不得为空'）。 */
export function validateTodoTitle(rawTitle: string): string {
  const title = rawTitle.trim();
  if (title === '') {
    throw new TodoValidationError('标题不得为空');
  }
  return title;
}

/** 截止时间：可空，非空必须是有限数值（UTC 毫秒；源消息 '截止时间参数值类型错误'）。 */
export function validateDeadlineTime(rawDeadline: unknown): number | null {
  if (rawDeadline === undefined || rawDeadline === null || rawDeadline === '') {
    return null;
  }
  const parsed = Number(rawDeadline);
  if (!Number.isFinite(parsed)) {
    throw new TodoValidationError('截止时间参数值类型错误');
  }
  return parsed;
}

/** 分类名：去空白后非空（源消息 '名称不得为空'）。 */
export function validateCategoryName(rawName: string): string {
  const name = rawName.trim();
  if (name === '') {
    throw new TodoValidationError('名称不得为空');
  }
  return name;
}

/** 进度内容：去空白后非空（源消息 '内容不得为空'）。 */
export function validateProgressContent(rawContent: string): string {
  const content = rawContent.trim();
  if (content === '') {
    throw new TodoValidationError('内容不得为空');
  }
  return content;
}
