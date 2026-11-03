/**
 * 主题控制器: 层栈 + 写集账本。
 *
 * 解决的问题: 多个插件同时改 token 时, 谁撤谁的那一份。
 *
 * 错误做法 (我们之前就是这么干的, 见 demo-skin-plugin 的旧版): 每个插件
 * setProperty 之前存下旧值, 卸载时写回。单层能用, 两层必错 ——
 *   A 把 accent 改成赭, 记下旧值 蓝
 *   B 把 accent 改成青, 记下旧值 赭
 *   A 卸载 → 写回 蓝 → B 的青被抹掉, 而 B 还活着
 * 根因是「旧值」这个概念在多层覆盖下没有意义。
 *
 * 正确做法 (dsh 的 ThemePresenter 是这么做的, 我们只学了这一点):
 * **不记旧值, 记写集**。每次变化都: 撤掉上一轮写过的全部属性 → 按层序重新合成 → 重新写。
 * 账本只记「我写过哪些名字」, 不记「它们原来是什么」。
 * 于是撤销任一层都自动正确, 且永远不会把别人的值写回去。
 *
 * 为什么只许动 alias 层: specific 层是结构 (布局尺寸、层叠、间距), 一个皮肤改它
 * 就不是换皮而是改版 —— 那种改动必须走 slot 换组件, 不能走 token。
 */

import { auditContrast } from './contrast.ts'

/** 允许被覆盖的层前缀。specific 层是结构, 不在白名单 */
const ALLOWED_PREFIX = '--meng-alias-'
export interface ThemeLayer {
  /** 层标识, 通常用 pluginId。同 id 再次 apply = 替换那一层, 不新增 */
  id: string
  tokens: Readonly<Record<string, string>>
}

export interface ThemeController {
  /**
   * 提交/替换一层覆盖。
   * 顺序即优先级: 后提交的层覆盖先提交的层。
   */
  apply(id: string, tokens: Record<string, string>): void
  /** 撤掉一层。下层的值自动重新露出来 */
  remove(id: string): void
  /** 当前生效的层, 按提交顺序 */
  layers(): ThemeLayer[]
  /** 合成后的最终写集 —— 诊断用, 也是「页面上到底生效了什么」的唯一答案 */
  applied(): Record<string, string>
  /** 撤掉所有层, 恢复成 tokens.css 的默认值 */
  dispose(): void
}

export interface ThemeControllerOptions {
  /** 写哪个元素, 默认 documentElement。node 测试可注入假元素 */
  target?: HTMLElement
  /** 违约回调。默认 console.error; 一个坏 token 只丢它自己, 不整层作废 */
  onInvalid?: (key: string, reason: string) => void
  /**
   * 严格模式: 对比度不过审时**抛异常**而不是拒绝该 token。
   * dev 下 (?strict-theme) 用 —— 「看着不明显」的问题靠人眼永远发现不了, 让它当场炸。
   * 生产环境保持 false: 渲染期不能因为配色审计把界面卡住。
   */
  strict?: boolean
  /** 关掉运行时对比度审计。给 node 里的旧测试用; 浏览器里不建议关 */
  audit?: boolean
}

export function createThemeController(options: ThemeControllerOptions = {}): ThemeController {
  const target =
    options.target ?? (typeof document === 'undefined' ? undefined : document.documentElement)
  const onInvalid = options.onInvalid ?? ((key, reason) => console.error(`[theme] 拒绝 ${key}: ${reason}`))
  const strict = options.strict ?? false
  const audit = options.audit ?? true

  /** 层栈。Map 保持插入顺序, 同名 set 不会挪位置 —— 这是「替换而非叠一层」的关键 */
  const stack = new Map<string, ThemeLayer>()
  /** 写集账本: 上一轮实际写进 DOM 的属性名。只记名字, 不记旧值 */
  let written: string[] = []

  function validate(tokens: Record<string, string>): Record<string, string> {
    const clean: Record<string, string> = {}
    for (const [key, value] of Object.entries(tokens)) {
      if (!key.startsWith(ALLOWED_PREFIX)) {
        onInvalid(key, '只许覆盖 --meng-alias-* 层; specific 层是结构, 要改请走换组件')
        continue
      }
      if (typeof value !== 'string' || value.trim() === '') {
        onInvalid(key, '值必须是非空字符串')
        continue
      }
      clean[key] = value.trim()
    }
    return clean
  }

  function commit(): void {
    if (!target) return

    // 1. 撤上一轮。只撤自己写过的名字 —— 别人的 inline style 一行都不碰
    for (const name of written) target.style.removeProperty(name)
    written = []

    // 2. 按层序合成。后提交的赢
    const merged: Record<string, string> = {}
    for (const layer of stack.values()) Object.assign(merged, layer.tokens)

    /**
     * 审计用的「最终生效值」。**merged 必须优先** —— 这条踩过:
     * resolve 只查 target 时, 上一轮刚被撤、本轮还没写, 读到的永远是内置旧值,
     * 审计于是一直在给「改之前的颜色」打分, 什么违规都发现不了。
     * merged 查不到才回落 target: 那时 inline 为空, getPropertyValue 拿到的
     * 正是 tokens.css 的内置值。
     */
    const resolve = (name: string): string | undefined => {
      if (name in merged) return merged[name]
      if (!target?.style) return undefined
      // getPropertyValue 也要防: node 测试注入的假 style 只有 set/remove/get 三个方法
      if (typeof target.style.getPropertyValue !== 'function') return undefined
      const value = target.style.getPropertyValue(name)
      if (value) return value
      const view = target.ownerDocument?.defaultView
      if (typeof view?.getComputedStyle === 'function') {
        const computed = view.getComputedStyle(target).getPropertyValue(name)
        if (computed) return computed
      }
      return undefined
    }

    // 3. 对比度审计 —— 只审这一轮写过的 token 参与的组合, 不是全表。
    //    内置 token 构建期已经过 60 项脚本, 每帧重算全表纯属浪费。
    let effective = merged
    if (audit) {
      const violations = auditContrast(merged, resolve)
      if (violations.length > 0) {
        if (strict) {
          // length > 0 刚检查过, 非空断言免掉收窄税
          const first = violations[0]!
          throw new Error(
            `[theme] 对比度不过审: ${first.fg} / ${first.bg} = ${first.ratio.toFixed(2)} < ${first.min} (${first.label})`,
          )
        }

        // 拒绝策略与格式违约一致: **坏的那个自己退出, 不整层作废**。
        // 归属判断: fg 坏就退 fg; bg 是本次写坏、fg 没动过就退 bg (别让无辜的前景背锅);
        // 两个都是本次写的, 退 fg —— 想改颜色的多数改的是前景。
        const rejected = new Set<string>()
        for (const v of violations) {
          const fgWritten = v.fg in merged
          const bgWritten = v.bg in merged
          const blame = fgWritten || !bgWritten ? v.fg : v.bg
          if (!rejected.has(blame)) {
            rejected.add(blame)
            const short = blame.replace('--meng-alias-', '')
            onInvalid(
              short,
              `对比度 ${v.ratio.toFixed(2)} < ${v.min} (${v.label} / ${v.bg.replace('--meng-alias-', '')}), 已拒绝`,
            )
          }
        }
        effective = { ...merged }
        for (const name of rejected) delete effective[name]
      }
    }

    // 4. 重新写
    for (const [name, value] of Object.entries(effective)) {
      target.style.setProperty(name, value)
      written.push(name)
    }
  }

  return {
    apply(id, tokens) {
      stack.set(id, { id, tokens: validate(tokens) })
      commit()
    },

    remove(id) {
      if (stack.delete(id)) commit()
    },

    layers() {
      return [...stack.values()]
    },

    applied() {
      const merged: Record<string, string> = {}
      for (const layer of stack.values()) Object.assign(merged, layer.tokens)
      return merged
    },

    dispose() {
      stack.clear()
      commit()
    },
  }
}
