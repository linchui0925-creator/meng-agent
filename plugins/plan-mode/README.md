# Plan 模式

先在当前工作区调研并提交方案，用户批准后才退出 Plan 模式并开始执行。

- `enter_plan_mode`：进入只规划状态。
- `exit_plan_mode`：提交完整方案，等待用户批准。
- 前端通过 `composer.actions` 提供 Plan 开关，通过 `conversation.plan` 展示方案状态。
