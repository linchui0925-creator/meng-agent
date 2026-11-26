---
name: testing
description: 梦项目的定向测试、类型检查和浏览器验收流程
allowed-tools:
  - skill
  - read
  - grep
  - glob
  - bash
  - ask_user_question
---
# 测试与验收

- 改 TypeScript：先跑相关 `tsc` 或构建，再跑对应测试。
- 改前端交互：用真实浏览器走用户路径，不只看单元测试。
- 已有服务占着端口时复用，不要再启动第二个。
- 只跑与改动相关的检查；失败先看第一条真实错误，不盲目全仓重跑。
- 报告必须区分：🟢 实际通过、🟡 部分验证、🔴 未验证。
- 工具结果很长时先用 `read` 的 offset/limit 分段读，不要假设模型看到了全文。
