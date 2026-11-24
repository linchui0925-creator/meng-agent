# 梦插件包规范 v1

## 包结构

```text
plugin-id/
├── package.json
├── tsconfig.json
├── meng.patch.yml
├── adapter.manifest.yml    # 适配器插件必需
├── README.md
├── src/
│   ├── index.ts
│   └── client-entry.tsx   # 前端或全栈插件
├── dist/                  # 构建产物：JavaScript + .d.ts
└── client/client.js       # 前端或全栈插件
```

分发格式为 npm `.tgz`。只分发 `files` 白名单中的产物，不包含 `src/`、`test/`、临时目录和密钥。

## package.json

必须声明：

- `name`、`version`、`type: "module"`、`main`、`types`、`exports`。
- `files` 包含 `dist`；前端包还包含 `client`。
- `engines.node: ">=22"`。
- `peerDependencies["@meng/core"]`，核心契约由宿主提供。
- `meng.plugin.apiVersion: 1`、`id`、`patch: "./meng.patch.yml"`。
- 前端包声明 `meng.client.platforms`、`immediately`、`slots`。
- 适配器包声明 `meng.adapter`、`meng.compatibility`、`meng.permissions`；可选
  `meng.install`、`meng.activationEvents`、`meng.sharedPackages`。
- 不得使用 `private: true`。

`exports["."]` 同时提供 `types` 和 `default`，使包自引用和现有 loader 都能解析。

## 适配器清单

```yaml
source:
  kind: library | cli | http | sidecar | mcp | ui
  package: upstream-package
  version: 1.2.3
runtime:
  mode: in-process | child-process | remote
  dataRoot: .meng/plugin-id
capabilities:
  prompt: true
  tools: [tool_name]
  web: [plugin.status]
compatibility:
  reusable: [audit, store-core]
  mapped: [prompt, tools, web]
  unsupported: [electron-asar, host-patch]
```

规则：

- `source.kind` 必须与 `package.json` 的 `meng.adapter.kind` 一致。
- `runtime.mode` 必须显式写；不能靠猜。
- `unsupported` 必须诚实列出。
- 项目源码默认只读，适配层不得复制业务实现。

## Profile 清单

安装目录使用 profile 模型：

```text
.meng/profiles/<profile>/
├── package.json
├── meng.patch.yml
├── package-lock.json
└── node_modules/
```

profile 的 `package.json`：

```json
{
  "meng": {
    "profile": {
      "bundles": ["@meng/plugin-x"],
      "plugins": {
        "@meng/plugin-x": { "enabled": true }
      }
    }
  }
}
```

校验要求：

- `bundles` 必须是字符串数组；允许空数组，表示 profile 还没装插件。
- 每个 bundle 必须在 `dependencies` 中声明。
- `plugins` 的键必须属于 `bundles`。
- profile 数据目录、日志、缓存与程序包分离。

工坊提供 profile 工具：

- `studio_profile_list`
- `studio_profile_add`
- `studio_profile_set`
- `studio_profile_remove`

这些工具只维护清单，不在后台偷偷联网安装依赖。

## 清单

```yaml
- insert:
    - id: example
      name: '@meng/plugin-example'
```

`id` 使用小写 kebab-case；`name` 与包名一致。加载顺序只由 `inject` 能力依赖决定。

## 后端入口

入口导出：

- `name`：插件标识。
- `inject`：所需能力面，例如 `["tools"]`。
- `apply(ctx, config)`：注册工具、提示、事件或服务。
- `invariant`：至少一条真实健康检查。

使用 `ctx.get(name)` 获取其他模块能力，不导入其他插件内部文件。所有注册使用 `ctx.effect`，确保失败回滚和卸载清理。工具写操作设置 `mutates: true`，长任务设置 `timeoutMs` 并处理 `call.signal`。

## 前端入口

浏览器产物只调用 `__MENG_LOADER__.load({ id, factory })`，顶层不得操作 DOM。实际注册在 `factory.apply` 内完成。

- 只注册宿主已声明的 slot。
- React、React DOM 和 `@meng/*` 共享模块必须 external，通过 `__MENG_REQUIRE__` 获取。
- 样式使用 `<style data-plugin="插件 id">`，卸载时移除。
- slot、事件、样式和其他副作用都必须可卸载。
- 后端 `meng.client.slots` 只声明使用位置，不等于实际注册。

## 外部功能适配

外部源码默认只读，适配结果写入不存在的新目录。保留原功能的输入、输出和错误边界，将入口改为梦的生命周期与能力注入，不复制密钥，不执行来源不明的安装脚本。

## 签名与市场

- 插件发行包使用 detached Ed25519 签名：`<plugin>.tgz.sig.json`。
- 信任公钥存独立 trust store；未信任 keyId 一律拒绝。
- 安装可要求 `requireSignature=true`，同时校验 SHA-256。
- 市场使用静态 catalog JSON：插件、发布者、版本、下载地址、镜像、通道、SHA-256、签名和兼容信息。
- catalog 自身也使用 detached Ed25519 签名。
- 更新检查按 stable / beta 通道比较已安装版本与 catalog 最新版本。
- 撤销列表可按插件、版本、SHA-256、发布者 keyId 拒绝安装。
- 下载支持 mirrors 顺序回退。
- 市场安装先下载到临时目录，再走同一安装事务。
- 插件工坊设置页提供基础市场面板：搜索、检查更新、安装。
- 发布者库记录公钥、keyId、状态和角色；暂停发布者后市场安装拒绝。
- rollout 0-100 使用稳定哈希分桶；同一用户同一版本结果稳定。
- 官方市场源可配置优先级、签名和 trust store。
- 本地遥测只写 `.meng` 数据目录：安装、更新、卸载、Worker 崩溃、评分和兼容反馈。
- 遥测不上传网络，不记录对话、密钥或文件内容。

## 安装事务

`studio_install` 只接受**自包含** tgz：

- 包已包含全部运行产物；
- `dependencies` 必须为空；
- 安装前先做隔离装载校验；
- 新旧包通过原子 rename 切换；
- 失败恢复原 `node_modules` 和 profile 文件；
- 卸载默认保留 `.meng` 用户数据。

带运行依赖的包使用 `studio_install_package`。它会调用 npm，联网依赖必须显式设置
`allowNetwork=true`；安装失败同样恢复事务备份。所有安装/卸载/回滚共用 profile 锁，
同一 profile 同时只允许一个事务。

## 验收

1. 源码结构校验通过。
2. TypeScript 构建产生 JavaScript 和 `.d.ts`。
3. 前端构建产生单文件 `client.js`，不重复打包宿主模块。
4. `pnpm pack` 生成真实 `.tgz`，归档不包含源码、测试和临时文件。
5. 隔离解包后由现有 loader 激活，不变量通过，卸载后注册项清空。
6. 测试使用 Mock，不调用真实付费模型。

隔离验证用于兼容性和生命周期检查，不是不可信代码安全沙箱。
