# @meng/plugin-theme-ui

主题 UI 插件。

- 侧栏主题导航：`sidebar.utility`
- 标题栏主题切换：`topbar.actions`
- 主题状态、偏好持久化和 `applyTheme` 仍由宿主提供；插件只负责入口和 visual chrome。
- 产物：`client/client.js`

测试：`node --experimental-strip-types test/theme-nav.ts`

## 测试

```bash
node --experimental-strip-types test/theme-nav.ts
node --experimental-strip-types test/contract.ts
```

- `theme-nav.ts`：主题选项表、顺序、脏值兜底。
- `contract.ts`：插件清单、两个 slot、宿主隔离、构建产物。
