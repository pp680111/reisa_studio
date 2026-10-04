# Uzawa Reisa Studio — Agent 约定

## 界面代码

- **`PageHeading` 不使用 description**：页面标题区（`@reisa/ui` 的 `PageHeading`）不放装饰性描述文案（如"收藏书中的片段……"这类宣传语）。该组件已移除 `description` 支持，勿再加回；新页面标题区只放眉题（eyebrow）、标题和操作按钮。功能性说明文字应放在字段 hint、空状态（EmptyState）或帮助入口里，而不是页面标题下方。
