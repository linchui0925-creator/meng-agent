/**
 * demo-ui 注册的那个**设置分区**（`settings.section`）。
 *
 * 2026-11-17 之前它挂在 `sidebar.footer` —— 侧栏底部一块"外部 bundle"卡片。
 * 那块地方现在归设置入口（左下角），而这张卡片本质上是个**诊断页**：
 * 它要证明的是"这段 UI 不在主应用产物里，却和宿主共用同一份 React"，
 * 放设置里比放在每天都看的侧栏里合适得多。
 *
 * 而且换到 `settings.section` 之后它证明的东西**更多**了：设置页左导航里
 * 那一项「外部 bundle」就是这个 bundle 自己注册的 —— 宿主没有为它写过一行代码。
 *
 * 这个文件里的 `import` 全部会被构建成 external (见 vite.plugin.config.ts 的
 * `output.globals`)，产物里落在 `__MENG_REQUIRE__("react")` 这种调用上 ——
 * 于是插件**不会**自带第二份 React，宿主与插件共用同一个实例。
 * 这也是 F5 最想证明的一件事: 插件是"外来的代码", 但 UI 状态跟宿主是一体的。
 */

import { useState } from 'react'

export function Panel() {
  // 有 state 才看得出插件是真的活着, 而不是一段静态 HTML
  const [clicks, setClicks] = useState(0)

  return (
    <div className="demo-ui-section">
      <p className="demo-ui-section__lead">
        这一页来自 <code>/plugins/demo-ui/client.js</code>：它不在主应用产物里，
        是运行时下载、执行、再挂进槽位的。左边导航里「外部 bundle」这一项也是它自己注册的
        —— 宿主没有为它写过一行代码。
      </p>

      <div className="demo-ui-card" data-testid="demo-ui-card">
        <div className="demo-ui-card__title">
          <span>外部 bundle</span>
        </div>
        <div className="demo-ui-card__note">
          React 用的是宿主那一份（构建期 external）。所以下面这个计数能加 ——
          hooks 活着，说明没有第二份 React。
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
    </div>
  )
}
