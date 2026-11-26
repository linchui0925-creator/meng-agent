# @meng/plugin-calculator

侧栏计算器插件。

- 前端入口：`src/client-entry.tsx`
- 挂载位置：`sidebar.utility`
- 产物：`client/client.js`
- 宿主导航只负责这个 slot，不直接依赖计算器实现。

## 测试

```bash
node --experimental-strip-types test/arithmetic.ts
node --experimental-strip-types test/contract.ts
PLAYWRIGHT_PATH=<playwright包路径> BASE_URL=http://127.0.0.1:4722/ node test/ui.mjs
```

- `arithmetic.ts`：算术内核、错误分类、浮点格式、禁止代码执行。
- `contract.ts`：插件清单、slot、宿主不直接 import、构建产物。
- `ui.mjs`：真实浏览器中的插件加载、按键和结果。
