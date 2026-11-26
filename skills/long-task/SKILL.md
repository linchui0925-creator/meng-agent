---
name: long-task
description: 多步骤长任务的 Plan、Todo、Goal 和进展纠偏规则
allowed-tools:
  - skill
  - read
  - grep
  - glob
  - edit
  - write
  - bash
  - todo_write
  - enter_plan_mode
  - exit_plan_mode
  - get_goal
  - create_goal
  - update_goal
  - subagent
  - ralph
  - ask_user_question
---
# 长任务

## 选择工具
- 用户要先看方案：进入 Plan，调研后调用 `exit_plan_mode`，批准前不改文件。
- 方案已批准、需要 3 个以上可验证步骤：调用 `todo_write` 建立清单。
- 任务需要跨多轮持续完成：创建 Goal；普通单轮任务不要创建。
- 用户明确要求 Ralph 时才使用 `ralph`。

## 执行纪律
1. 开始一步前标记 `in_progress`，验证通过后立即标记 `completed`。
2. 每轮先看当前 Todo 和 Goal，不重新规划已完成项。
3. 连续多次只读、重复读取或没有状态变化时，停止扩大调研。
4. 缺信息时先查工作区；查不到再用 `ask_user_question`。
5. 完成前必须有实际测试或页面证据。遇到同一阻塞连续三轮才标记 blocked。

## 结束条件
- 所有 Todo 完成。
- 相关测试/构建通过。
- 页面功能已从用户视角验收。
- 汇报改动、验证、限制和未完成项。
