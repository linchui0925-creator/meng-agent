# 梦 · meng

一个以插件为核心的本地 AI Agent 平台。模型供应商、工具、审批、记忆、界面和业务能力都通过插件装配，不需要修改内核。

## 功能

- **多模型供应商**：支持 OpenAI、Anthropic、Gemini、DeepSeek、MiniMax、Mistral、Azure、Bedrock、Vertex 等协议，可自动发现模型并手动维护模型清单。
- **插件化运行时**：后端插件、前端 UI 插件、工具、策略和 Provider 走同一套装卸流程。
- **流式对话**：HTTP 上行、WebSocket 下行，支持工具调用、中断、排队和追加指令。
- **会话持久化**：事件流落 SQLite，刷新或重启后可以恢复历史。
- **工具执行管线**：统一经过 `pre-execute → execute → post-execute`，支持审批、超时、输出溢出和失败记录。
- **上下文与记忆**：自动压缩超长上下文，保留最近工作集，并提供独立的 SQLite 全文检索。
- **工作区隔离**：每个会话可以绑定独立目录，文件、命令和搜索结果不跨会话泄漏。
- **桌面与移动目标**：Web 产物可复用于 Electron 和 Capacitor 外壳。

## 架构

```text
apps
  server      Node.js 内核进程、HTTP API、WebSocket
  web         React + Vite 前端
  desktop     Electron 外壳
  mobile      Capacitor 外壳

packages      能力契约与基础设施
  core        上下文、生命周期、事件、插件装载
  session     只追加事件流
  llm         模型路由与流式协议
  tools       工具注册和执行管线
  prompt      系统提示组装
  loop        Agent 循环契约
  web         HTTP / WebSocket 服务
  ...

plugins       可装卸功能
  provider-*  模型供应商
  tool-*      工具
  policy-*    审批、沙箱、超时等策略
  *-local     本地能力实现
  memory      记忆与检索
  plugin-studio 插件创建、适配、校验、构建和打包

bundles       插件组合清单
```

依赖方向保持单向：`apps → packages/shell → web-react → slots → core`。插件只依赖能力契约，不直接依赖具体实现。

## 环境要求

- Node.js 22 或更高版本
- pnpm 11 或更高版本
- macOS、Linux 或 Windows

## 快速开始

安装依赖：

```bash
pnpm install
```

启动后端：

```bash
pnpm dev
```

后端默认监听 `http://127.0.0.1:4721`。

另开一个终端启动前端：

```bash
cd apps/web
pnpm dev
```

打开 `http://127.0.0.1:4722`。

## 常用命令

```bash
pnpm typecheck          # 后端与共享包类型检查
pnpm typecheck:web      # 前端类型检查
pnpm graph              # 输出插件状态图和不变量结果
pnpm lint:tokens        # 检查 CSS 是否使用设计 token
```

一次性 CLI 对话：

```bash
node --experimental-strip-types apps/server/src/main.ts chat "你好"
```

## 配置

本机运行数据默认写入 `.meng/`，该目录不会进入 Git。

常用环境变量：

| 变量 | 说明 |
|---|---|
| `MENG_DATA_DIR` | 数据目录，默认 `.meng` |
| `MENG_WORKSPACE` | 默认工作区目录 |
| `MENG_QUIET` | 设置后减少启动日志 |
| `DISPLAY_CHARS` | 网页抓取演示时内联显示的字符数 |

模型 API Key 通过设置页或环境变量配置。仓库不会提交 `.env`、密钥或本机凭据。

## 插件开发

插件通常包含：

```text
plugins/my-plugin/
├── meng.patch.yml
├── package.json
└── src/
    └── index.ts
```

插件工坊提供创建、适配、校验、构建、打包和隔离装载验证能力。完整规范见：

- [插件规范](plugins/plugin-studio/PLUGIN_SPEC.md)
- [插件工坊说明](plugins/plugin-studio/README.md)
- [记忆插件](plugins/memory/README.md)
- [dsh-purge 适配器](plugins/dsh-purge/README.md)

## 安全

- `.env`、`.meng/` 和本机缓存默认不进入 Git。
- API Key 只保存在本机配置或环境变量中。
- 工作区外的文件访问需要显式配置或审批。
- 红队攻击技能等敏感素材不随公开仓库分发。
- 第三方组件遵循各自目录中的许可证和 NOTICE 文件。
- 测试代码、设计稿和内部文档不随公开仓库分发。

## 许可证

本仓库目前未声明统一的开源许可证。第三方代码和资源以各自附带的许可证为准。
