/**
 * demo-ui 挂进 `sidebar.footer` 的那一块。
 *
 * 这个文件里的 `import` 全部会被构建成 external (见 vite.plugin.config.ts 的
 * `output.globals`), 产物里落在 `__MENG_REQUIRE__("react")` 这种调用上 ——
 * 于是插件**不会**自带第二份 React, 宿主与插件共用同一个实例。
 * 这也是 F5 最想证明的一件事: 插件是"外来的代码", 但 UI 状态跟宿主是一体的。
 */

import { useState } from 'react'

export function Panel() {
  // 有 state 才看得出插件是真的活着, 而不是一段静态 HTML
  const [clicks, setClicks] = useState(0)

  return (
    <div className="demo-ui-card" data-testid="demo-ui-card">
      <div className="demo-ui-card__title">
        <span>外部 bundle</span>
      </div>
      <div className="demo-ui-card__note">
        这块 UI 不在主应用产物里 —— 它由 <code>/plugins/demo-ui/client.js</code> 在运行时装载。
      </div>
      <button
        type="button"
        className="demo-ui-card__button"
        data-testid="demo-ui-button"
        onClick={() => setClicks((n) => n + 1)}
      >
        点了 {clicks} 次
      </button>
    </div>
  )
}
