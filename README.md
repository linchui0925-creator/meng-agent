# 梦 · meng

万物即插件的 agent 平台。TypeScript 重写版。

> 状态: **M1–M4 完成 + M5 后端八项已通（审批通道 / LLM 词汇表对齐 / 工具输出硬闸 / 执行缝 / 后台任务 / 上网 / 长材料索引 / 循环插件化）** —— 内核、HTTP 上行 12 个 op、WS 下行、
> 会话持久化、工具拦截、**内置工具层（对齐 dsh: read/write/edit/glob/grep/bash/ask_user_question/web_fetch/outline）
> + fs/spill/exec/jobs/net **五条 seam** + loop 一条循环缝（实现是 plugins/loop-basic） + 三个策略插件
> + 审批通道（question/asked → 用户回答 → 继续或拦）
> + 块式词汇表（ContentBlock / 7 种 StreamChunk / 中立层 assemble / 稳定错误码）
> + 输出硬闸（超 50KB 落盘回 locator, 用 read 分段取回）
> + 后台任务（job_output/job_list/job_kill + job/started / job/completed, 会话围栏, 只通知"没人等"的那次）
> + 上网（web_fetch: 原文落盘 + 去噪开头 + 路径, **不做摘要** —— 摘要不可核对）
> + 长材料索引（outline: 建**位置地图**不是摘要; 有结构用代码切, 无结构才轮到小模型）**
> 全部跑通并有一键冒烟（74 项断言）+ `meng graph` 78 项不变量 + 装载顺序回归;
> `pnpm typecheck`（内核侧）与 `pnpm typecheck:web`（前端侧）**双绿**;
> 一个**真** provider（OpenAI 兼容）已就位但默认禁用（沙箱连不上, 用 mock 验证）。
>
> 架构真相看 `docs/05-architecture-final.md`; 后端分层看 `docs/07-backend.md`;
> 工具层设计（抄 dsh 的分层真相）看 `docs/08-tools-dsh.md`;
> LLM 层设计（抄 dsh 的 provider 结构）看 `docs/10-llm-dsh.md`;
> **前端对接看 `docs/06-api-contract.md`**（那份是前后端唯一契约）。
> 插件前端面（谁该被前端下载、url 怎么来、inject 两边不同义）看 `docs/11-client-face.md`。

## 目录

```
梦/
├── packages/           能力包（capability 层, 可被插件整体替换）
│   ├── core/           @meng/core     上下文 / 生命周期 / 事件 / 状态图 / 装载器（零依赖, 三端通用）
│   ├── llm/            @meng/llm      provider 注册表（一张 Map, 注册即生效）
│   ├── session/        @meng/session  只追加事件流（真相源）
│   ├── persistence/    @meng/persistence 会话落盘: append-only JSONL + 启动回放
│   ├── tools/          @meng/tools    工具注册 + 四段管线（waterfall, 唯一执行路径）
│   ├── fs/             @meng/fs       文件能力面 (seam): 读写 + write/edit-intent 单决策槽
│   ├── spill/          @meng/spill    溢出落盘 (seam): 临时产物, 不进 fs 的语义
│   ├── questions/      @meng/questions 问用户/审批 seam: ask/answer + question/* 事件
│   ├── exec/           @meng/exec      执行外部命令的 seam (零实现): resolve/run/start + ExecResult
│   ├── jobs/           @meng/jobs      后台任务的 seam (零实现): start/list/read/kill/wait + 会话围栏
│   ├── prompt/         @meng/prompt   系统提示分区
│   ├── agent/          @meng/agent    一轮对话的循环（< 120 行, 故意的）
│   ├── web/            @meng/web      HTTP 上行 + WS 下行（手写, 零第三方依赖）
│   │   ── 前端侧 ──
│   ├── slots/          @meng/slots    Slot 契约 + 注册表 + 快照 store（零 React）
│   ├── modules/        @meng/modules  模块系统: server 半扫描 / 浏览器半按需加载（零依赖）
│   ├── shell/          @meng/shell    启动内核: manifest → entries → sweep → settled（零 DOM）
│   ├── web-react/      @meng/web-react AppRoot 两态闸门 / Slot 渲染器 / uSES 桥
│   ├── ui/             @meng/ui       Radix + CVA + CSS 变量双层 token + 主题
│   ├── platform/       @meng/platform 平台能力面契约 + web / desktop / mobile 三份实现
│   └── transport/      @meng/transport 通信契约: ws / ipc / inproc
├── bundles/            组合层（只有清单, 没有代码）
│   ├── base/           @meng/bundle-base    6 行, 上限 12 行 —— 内核
│   ├── kit/            @meng/bundle-kit     10 行 —— 能干什么活（seam + 薄壳 + 策略）
│   └── server/         @meng/bundle-server  1 行 —— 怎么把内核接到世界上
├── apps/
│   ├── server/         @meng/server   Node 内核进程（bin: meng）
│   ├── web/            @meng/app-web  Vite 8 入口（Capacitor web target 同源）
│   ├── desktop/        @meng/app-desktop Electron 壳（主进程跑内核）
│   └── mobile/         @meng/app-mobile  Capacitor（iOS / Android）
├── plugins/            第三方插件（照 hello 抄）
│   ├── hello/          一个工具 + 一段提示 + 一条拦截
│   ├── tool-fs/        read / write / edit 薄壳, 只认 ctx.fs（上限抄 dsh: 2000 行/50KB）
│   ├── tool-search/    glob / grep 薄壳（glob 100 条, grep 250 命中）
│   ├── tool-bash/      bash 薄壳, 只认 ctx.exec: 申报校验 + render (零 spawn)
│   ├── tool-ask/       ask_user_question 薄壳: 模型中途提问, 回答回到工具结果
│   ├── policy-fs/      零能力面, 占 fs intent 槽: 先读后写 / 敏感路径 / 越界
│   ├── policy-bash/    零能力面, 挂 pre-execute: 声明式升权审批 + 灾难命令止血带
│   ├── bash-local/     @meng/exec 的实现: spawn / 进程组 / 超时 / 缓冲区 / 溢出落盘 / 环境净化
│   ├── policy-spill/   零能力面, 挂 post-execute: 超 50KB 落盘 + 回 locator (bash 除外, 见下)
│   ├── policy-timeout/ 零能力面, 挂 execute: 读工具自报的 timeoutMs, 到点改判 (只通知不掐断)
│   ├── jobs-local/     @meng/jobs 的实现: 编号 / 会话围栏 / 落定 / 通知 / 卸载收尾
│   ├── tool-jobs/      job_output / job_list / job_kill + 落定通知落进会话流 (job/completed)
│   ├── questions-web/  questions seam 的 HTTP 桥: question.answer / question.list
│   ├── provider-openai/ OpenAI 兼容 provider（edgefn / 智谱 / minimax…）
│   └── provider-mock/   离线验收 provider（按脚本产出真实形态的 chunk 流）
└── docs/
    ├── 00-why-ts.md           为什么重写（决策记录 + 退出条件）
    ├── 01-dsh-base-notes.md   读 dsh-base 的笔记（451 行清单 / 78 行）
    ├── 02-our-base.md         ★ 我们的 base 设计定稿
    ├── 03-migration-map.md    Python → 梦 的能力对照与顺序
    ├── 04-frontend-research-dsh.md  dsh 前端架构调研
    ├── 05-architecture-final.md     ★★ 完整架构定稿（三端）
    ├── 06-api-contract.md     ★★ 前后端契约（前端照此实现）
    ├── 07-backend.md          ★ 后端分层与数据流
    ├── 08-tools-dsh.md        工具层设计（抄 dsh 的分层真相）
    │   ── 前端线 ──
    ├── 07-frontend-plan.md    ★ 前端开发顺序 F-1b…F8 + 每阶段怎么验
    ├── 08-frontend-protocol.md  ★★ 前端标准协议（对 dsh 的 9 条偏离）
    └── 09-frontend-map.md     ★ 看图入口: 分层 / 启动时序 / 数据流 / 方块→路径
```

前端侧两条能跑的命令（不需要浏览器、不需要后端）:

```bash
pnpm typecheck:web    # 前端那一支 tsc 全绿 (含 packages/shell/test)
pnpm test:shell       # shell 外壳断言 20 条
```

依赖方向严格单向: `apps → shell → web-react → slots → core`。`slots` 不认识 React, `core` 不认识任何东西。

## 三条原则

1. **kernel 不做业务, base 不写代码**。`@meng/core` 只有机制; bundle 只有清单。
2. **控制权必须唯一**。想跑工具只有 `tools.call()` 一条路, 而它第一件事是 `waterfall` —— 插件真的能拦住（Python 版这条从来没生效过）。
3. **每个包都要能自检**。`invariant` 不许为空, 启动时全跑一遍, 失败即退出。

## 跑起来

```bash
node --experimental-strip-types apps/server/src/main.ts <命令>

  (无)     起 HTTP 4721 + WS 4721, 长驻
  smoke    端到端冒烟: 上行 HTTP + 下行 WS + 工具循环 + 流式文本 + 断线重放
  chat X   一次性对话, 打印到 stdout（不经网络, 验证内核）
  graph    状态图 JSON（给 CI / 调试面板）
  demo     拦截验收: 插件能不能真的拦住一次工具调用
```

**2026-11-02 实测（M1–M5f，工具层 + 审批通道 + LLM 词汇表对齐 + 执行缝 + 截止时间 + 后台任务）**：

```
$ meng smoke
  web              http://127.0.0.1:4721 · 12 个 op
  kernel.hello     12 op · 10 工具 · protocol=1
  tools.list       read, write, edit, glob, grep, bash, ask_user_question, job_output, job_list, job_kill, hello
  read             README.md (共 175 行)
  glob             packages/web/src/index.ts
  grep             packages/shell/test/boot.ts:13:import { createContext, type
  未读先写         已拦截 (FS_NOT_OBSERVED: 先读后写: package.json 还没有被 read 过)
  write            ok
  edit             ok
  越界读取         已拦截 (FS_OUT_OF_ROOT: 路径越界: /etc/passwd 不在工作区内)
  写敏感文件       已拦截 (FS_SENSITIVE: 敏感路径禁止写入: .env)
  缺 description   已拦截 (缺参数 description —— 先说清楚这条命令做什么)
  bash             meng
  灾难命令         已拦截 (命令被策略拒绝 (不可逆操作): rm -rf /)
  越权申报         已拦截 (danger-full-access 未获本部署授权)
  大输出           落盘 .meng/spill/20261102-bash-44e65ef7.txt (108894 字节) · 内联保留尾部
  溢出目录可搜     不可搜 ✓
  失败输出         4024 字节 · 未砍到 2K · 也没被当成工具错误 (非零退出是结果)
  locator 召回     .meng/spill/20261102-bash-ab12cd34.txt (…)
  溢出清理         清理前 1 个 · 删 1 个 · 剩 0 个
  后台启动         bash-3 · 3ms 返回 (命令本身 sleep 0.4s)
  后台读取         completed · 首读 32 字节 (增量)
  后台列表         bash-3 [bash] completed (exit code: 0) — echo 起点; sleep 0.4; echo 终点
  后台围栏         跨会话被拒 ✓
  后台通知         1 条 · bash-4 在内 (等过的不再通知)
  审批·允许        已执行
  审批·拒绝        已拦截 (用户未批准: 冒烟需要用户批准)
  重复回答         已拒绝 (409)
  模型提问         用户选择了: 演示方式

  P1 交错轮: 2 块 · 文本「我先看一眼, 然后调用工具」· 1 个工具调用 · 4 个 delta
  P1 空响应: 判错 (EMPTY_RESPONSE)

  ✓ 7 个工具主路径 + 策略拦截 16 项       ✓ 审批通道 7 项
  ✓ hello / chunk / turn / seq 单调 7 项   ✓ 词汇表契约 8 项
  ✓ 工具输出硬闸 7 项
  ✓ 断线重放 (含 question/* 事件)

✓ 冒烟通过: 上行 HTTP + 下行 WS + 工具循环 + 审批通道 + 流式文本 + 块组装 + 输出硬闸
```

```
$ meng graph | jq
19 节点: llm, session, persistence, tools, prompt, agent,
         fs, spill, questions, policy-fs, policy-bash, policy-spill,
         tool-fs, tool-search, tool-bash, tool-ask,
         web, questions-web, provider-mock  → 全 active
invariants: 25 / 25 通过
```

> 离线（不联网装依赖）时的临时做法, `pnpm install` 成功后应删掉这些链接:
>
> ```bash
> mkdir -p node_modules/@meng
> for p in core llm session persistence tools fs spill questions prompt agent web transport \
>          slots modules shell ui platform web-react; do
>   ln -sfn ../../packages/$p node_modules/@meng/$p
> done
> ln -sfn ../../bundles/base   node_modules/@meng/bundle-base
> ln -sfn ../../bundles/kit    node_modules/@meng/bundle-kit
> ln -sfn ../../bundles/server node_modules/@meng/bundle-server
> ln -sfn ../../plugins/hello        node_modules/@meng/plugin-hello
> ln -sfn ../../plugins/tool-fs      node_modules/@meng/plugin-tool-fs
> ln -sfn ../../plugins/tool-search  node_modules/@meng/plugin-tool-search
> ln -sfn ../../plugins/tool-bash    node_modules/@meng/plugin-tool-bash
> ln -sfn ../../plugins/tool-ask     node_modules/@meng/plugin-tool-ask
> ln -sfn ../../plugins/policy-fs    node_modules/@meng/plugin-policy-fs
> ln -sfn ../../plugins/policy-bash  node_modules/@meng/plugin-policy-bash
> ln -sfn ../../plugins/policy-spill node_modules/@meng/plugin-policy-spill
> ln -sfn ../../plugins/questions-web node_modules/@meng/plugin-questions-web
> ln -sfn ../../plugins/provider-openai node_modules/@meng/provider-openai
> ln -sfn ../../plugins/provider-mock   node_modules/@meng/provider-mock
> ln -sfn ~/.dsh/profiles/node_modules/yaml node_modules/yaml
> ```

**还没做**: `pnpm typecheck` 未跑（本地没有 typescript 依赖）; 真 provider 联网未验证（沙箱代理拦 api.openai.com, 实测 502）。

## 技术选型（2026-10-30 拍板）

| 议题 | 决策 |
|---|---|
| 构建 | **Vite 8**（Rolldown 唯一打包器, Oxc transform, Lightning CSS minify） |
| 样式 | **CSS Modules + CSS 变量双层 token + CVA**，不引 Tailwind（理由见 `docs/05` §2） |
| 组件 | **Radix Primitives + CVA** |
| 通信 | **HTTP 上行 / WebSocket 下行**双流，抽象成 transport 能力面 |
| 桌面端 | **Electron**（主进程 = Node = 插件宿主本体，零桥接） |
| 移动端 | **Capacitor**（复用 web 产物，原生能力即插件） |

## 下一步

| 阶段 | 内容 | 出口 |
|---|---|---|
| M0 | 骨架 + 架构定稿 | 拦截演示通过 ✓ |
| M1 | provider + 一句话来回 | `meng chat "hi"` 出字 ✓ |
| M2 | 持久化 | 重开进程历史还在 ✓ |
| M3 | HTTP 上行 + WS 下行 + BootManifest | `meng smoke` 全过 ✓ |
| **M4** | **内置工具层（对齐 dsh）+ fs seam + 策略插件**（后端） | 能读改文件/搜代码/跑命令; 越界/未读先写/灾难命令被拦 ✓ |
| **M5a** | **审批通道**: questions seam + ask_user_question + question.answer op（后端） | question/asked → 用户回答 → 批准则执行/拒绝则拦; 重放可恢复 ✓ |
| **M5b** | **LLM 词汇表对齐 dsh**: ContentBlock + 7 种 StreamChunk + 中立层 assemble + 稳定错误码（后端） | 一轮里文本块与工具块共存; 工具参数由 delta 累积; 空响应判错 ✓ |
| **M5c** | **工具输出硬闸**: spill seam + policy-spill（后端） | 109KB 输出落盘回 locator, read 能取回全量; 溢出目录搜不到; 失败输出不再被砍到 2K ✓ |
| **M5d** | **执行缝**: @meng/exec (零实现) + bash-local 执行器 + tool-bash 瘦成壳（后端） | 非零退出是结果不是失败; 截断留尾部; ESC 杀得掉子进程; 环境净化; 换执行器不改工具 ✓ |
| **M5e** | **截止时间**: policy-timeout (挂 tools/execute) + grep 声明 20s（后端） | 声明的工具 81ms 被判超时; 没声明的不受影响; 不听话的工具会被改判但不被扔掉; 中止 ≠ 超时 ✓ |
| **M5f** | **后台任务**: @meng/jobs (零实现) + jobs-local + tool-jobs + bash run_in_background（后端） | 起任务 3ms 返回 (命令本身 0.4s); 增量读; 跨会话读不到; 等过的不再通知、没等的发一条; 卸载杀得掉后台进程 ✓ |
| **M5** | **ui 原子层 + transport 客户端 + slots/modules/shell**（前端, 并行） | 浏览器运行时装载 UI 插件 |
| M6 | platform 三份实现 + Electron 桌面端 | 本地内核 + 本地 fs 可用 |
| M7 | Capacitor 移动端 | 同一插件在 iOS/Android 跑通 |
| M8 | 真 provider 联网验证 | `MENG_PROVIDER=openai meng chat` 出字 |

M4（后端）与 M5（前端）**无依赖, 可双线并行** —— 前端只需对着 `docs/06` 的契约实现,
不需要等后端任何东西。合流点在 M5 末尾的 BootManifest。

迁移顺序与"容易搬错的三件事"见 `docs/03-migration-map.md`。
