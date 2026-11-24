# @meng/plugin-studio

一个插件内完成插件设计、外部功能适配、格式校验、构建、打包和隔离装载验证。

装载 `meng.patch.yml` 后，在当前对话直接描述需求，例如：

> 把本地 `./my-feature` 适配成全栈插件，输出到 `./plugins/my-feature`。

工坊提供 `studio_create`、`studio_adapt`、`studio_validate`、`studio_build`、`studio_pack`、`studio_verify` 和 `studio_spec`。写入、构建和执行生成代码前需要明确确认；不会发布包或调用真实模型。

规范见 `PLUGIN_SPEC.md`，三类标准模板位于 `templates/`。
