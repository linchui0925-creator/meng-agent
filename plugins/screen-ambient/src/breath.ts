/**
 * 呼吸的实现方式 —— **CSS 动画, 不是 JS 定时器**。
 *
 * 理由很直接: 呼吸是个 9 秒周期的慢起伏, 如果用 JS 做, 每秒就得唤醒
 * 主线程几十次去改三个 CSS 变量。页面看着不动, 电量在掉。
 * 交给 CSS 之后, 动画跑在合成器上, JS 完全不参与。
 *
 * 怎么让 CSS 动一个**数值**?
 * 靠 `@property` 把 `--sa-breath` 注册成 `<number>` —— 注册过的自定义属性
 * 才是**可插值的**, 于是 keyframes 能平滑地改它, 而不是整数式地跳。
 *
 * 两条独立的轴:
 *   · **颜色** (色相/饱和/亮度) 由 JS 写 —— 随屏幕实时变
 *   · **起伏** (明暗呼吸) 由 CSS 动画乘上去 —— 随时间变
 * token 的 alpha 写成 `calc(N% * (1 + (var(--sa-breath, 1) - 1) * 幅度))`:
 * 前者随屏幕走, 后者随时间走, 互不干扰。
 *
 * **`var()` 的 fallback 不是可省的**:
 * 自定义属性里写 `var(--sa-breath)` 而没有 fallback, 一旦这个属性不存在
 * (比如 @property 不被支持、或注入的 style 被摘了), 整条声明在计算值阶段
 * becomes invalid → 用它的 `radial-gradient` 整条作废 → 宿主的环境光层直接消失。
 * 写成 `var(--sa-breath, 1)` 就只是「不呼吸」, 而不是「把宿主样式弄坏」。
 */

/** 宿主是否支持 @property / CSS.registerProperty */
export const CAN_BREATHE =
  typeof CSS !== 'undefined' && typeof CSS.registerProperty === 'function'

/**
 * 呼吸动画的 CSS 片段。
 *
 * 只在 CAN_BREATHE 时注入 —— 否则自定义属性不可插值, 动画会变成生硬的
 * 50% 处跳变, 那还不如不呼吸。
 *
 * **动画挂在 `html` 上**, 因为 token 写在 `<html>` 的 inline style 上,
 * 自定义属性会继承下去。
 */
export const BREATH_CSS = `
@property --sa-breath {
  syntax: '<number>';
  inherits: true;
  initial-value: 1;
}

@keyframes screen-ambient-breathe {
  0%, 100% { --sa-breath: 0.72; }
  50% { --sa-breath: 1; }
}

html {
  animation: screen-ambient-breathe 9s ease-in-out infinite;
}

/*
 * 尊重系统的「减少动态效果」。
 *
 * 宿主 tokens.css 里有一条 animation-duration: 0.01ms !important 的全局规则,
 * 那会把动画变成「一瞬间跳到终点」—— 效果上是**常亮**, 不是不呼吸。
 * 所以这里用 animation: none 明确关掉: 呼吸值停在 initial-value (1),
 * 于是光是**静态**的, 而不是某个中间态。
 */
@media (prefers-reduced-motion: reduce) {
  html { animation: none; }
}
`
