---
name: plugin-authoring
description: 用梦的插件工坊创建、修改、构建、验证和安装前端或全栈插件
allowed-tools:
  - skill
  - read
  - grep
  - glob
  - todo_write
  - ask_user_question
  - studio_create
  - studio_adapt
  - studio_validate
  - studio_build
  - studio_pack
  - studio_verify
  - studio_install
---
# 插件开发

## 什么时候用
- 新增可独立开关、可分发、可替换的功能。
- 修改现有插件，而不是改宿主核心业务。
- 只有通用 slot、能力面或宿主契约缺失时，才修改核心壳。

## 最短路径
1. 先读 `plugins/plugin-studio/PLUGIN_SPEC.md` 和一个同类插件模板，不要扫描整个仓库。
2. 原生插件用 `studio_create` 创建骨架；适配外部项目用 `studio_adapt`。
3. 前端优先复用已声明 slot：`sidebar.utility`、`topbar.actions`、`composer.actions`、`composer.tools`、`home.actions`、`conversation.plan`、`right.panel`、`settings.section`。
4. 只改插件目录。样式放 `<style data-plugin="插件id">`，所有副作用返回 disposer。
5. 实现后依次运行 `studio_validate`、`studio_build`、`studio_pack`、`studio_verify`、`studio_install`。
6. 安装或 profile 变更后明确告诉用户需要重启梦。
7. 真实页面验收至少检查：入口出现、核心交互可用、刷新后状态正确、卸载无残留。

## 包约定
- `@meng/core` 等 workspace 依赖必须写 `workspace:*`，不要写 `0.0.0`。
- 前端 bundle 只调用 `__MENG_LOADER__.load`，React 等共享包必须 external。
- 不把测试、截图、临时文件打进分发 tgz。

## 禁止
- 不要为了一个业务功能直接改 `apps/web/src`。
- 不要新增 slot 只为一个插件服务。
- 不要只写源码就宣称完成；没有构建、安装和页面验证不算交付。
