/**
 * 工作区分区的纯逻辑。**和组件分开放**不是为了好看 —— `WorkspaceSection.tsx`
 * 会 import CSS Module, 而 node 里跑测试没有 CSS 加载器。把能测的东西挪出来,
 * 「来源文案别写错」「值是 undefined 时别显示 [object Object]」这两条才能被钉住。
 *
 * 这里刻意不 import `model.ts` 的 `ConfigEntry`: 分区之间不互相依赖, 删了模型
 * 分区工作区也不该编译不过。只声明这一页读的字段。
 */

export interface RootEntry {
  key: string
  value?: unknown
  /** 声明里的默认值。只用来"没配过时该显示什么", 不参与判断来源 */
  default?: unknown
  /** 值从哪一层来。env 表示环境变量盖过了设置文件 */
  source?: 'settings' | 'env' | 'manifest' | 'default'
  desc?: string
}

/** 后端配置项的全名。写在插件 `CONFIG` 里, 前端只当字符串用 */
export const WORKSPACE_KEY = 'sandbox.root'

/**
 * 当前该显示的那串字。
 *
 * **绝不 `String(value)`**: 值的类型是 `unknown`, 真写错一次就会在界面上
 * 看到 `[object Object]`（模型分区为此专门加过一条回归断言）。不是字符串
 * 就退回声明里的默认值, 再不行就退回 `'.'` —— 后者是内核声明的默认,
 * 显示它不会撒谎。
 */
export function pathOf(entry: RootEntry | undefined): string {
  if (!entry) return ''
  if (typeof entry.value === 'string') return entry.value
  if (typeof entry.default === 'string') return entry.default
  return '.'
}

/**
 * 来源说明。三种来源对用户的含义完全不同, 所以各写一句人话:
 *   · settings —— 就是这一页填的, 改它有意义
 *   · env      —— 环境变量优先, **在这一页改了也不生效**, 最容易被当成 bug
 *   · default  —— 没人配过, 用的是「进程启动目录」
 *
 * `manifest` 目前没有真实来源, 但配置缝的 `ConfigSource` 里有这一档 ——
 * 认不出来时降级成"没改过"会撒一个不该撒的谎, 所以给它一句自己的话。
 */
export function sourceLabel(source: RootEntry['source']): string {
  if (source === 'settings') return '来自这一页的设置'
  if (source === 'env') return '由环境变量指定，优先级高于这一页'
  if (source === 'manifest') return '由插件清单指定'
  return '还没改过，用的是默认值'
}

/**
 * 能不能存。空串和只有空白的东西一律拦住:
 * 空串在 schema 里不是"合法路径", 而内核拿到空串会 resolve 成 cwd ——
 * 界面上说"保存成功"、行为上悄悄换了个目录, 是最难查的一种。
 */
export function canSave(draft: string, saved: string): boolean {
  const clean = draft.trim()
  return clean !== '' && clean !== saved
}

/**
 * 是不是绝对路径。**两个平台都要认**: `/…` 与 `C:\…`。
 *
 * 只用来决定要不要提醒"这还是相对的" —— 不做校验 (真实存在性只有内核知道),
 * 所以宁可宽一点: 认错成绝对路径最多是少一句提示, 认错成相对会给一句多余的话。
 * 但**不能只判 `/`**: Windows 上 `C:\…` 会被判成相对, 于是正常路径也弹提示。
 */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
}
