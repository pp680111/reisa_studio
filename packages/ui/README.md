# @reisa/ui

宿主与模块共享的 UI 基础包（界面设计 §10）。

## 计划内容

- 设计 Token：中性色板、紫色主强调、语义状态色、4/8/12/16/24/32 px 间距、圆角与字号；浅色与深色同时定义，默认跟随系统
- 基础组件：Button、Input、Select、Dialog、表单与基础布局
- 宿主容器组件参考：AppShell、AppSidebar、ModulePageOutlet、SettingsShell、ResultContainer（组件所有者划分见界面设计 §10.1 与 module-ui-design §9）

## 边界

- `ModulePage`、`ModuleSettingsPanel`、`ToolResultRenderer` 属于各模块，不在本包实现。
- 不导入 Node、数据库驱动或任何模块运行层。
- 模块专业页面使用局部样式；本包只提供共享基础，不做全局 CSS 污染。

已提供 Icon、Button、IconButton、Badge、Field、Tabs、Dialog、PageHeading 和 EmptyState。输入控件沿用原生 HTML。`src/tokens.css` 定义浅色与深色主题，`src/styles.css` 提供统一组件及工作区布局。原生 dialog 管理模态焦点、Esc 和关闭后的焦点恢复。
