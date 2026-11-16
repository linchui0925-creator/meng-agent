/**
 * 「工作区」分区 —— 第二个内核腿分区（`origin: 'kernel'`）。
 *
 * 这一页只做一件事: 让用户看清**梦现在能在哪个目录里动文件**, 并且能改它。
 * 所以结构是「一条事实 → 一个入口 → 一段说明」, 不是一张设置项清单:
 * 目录只有一个, 画成多行开关表反而让人以为还有别的可调。
 *
 * ── 三个刻意的取舍 ──
 *
 * ① **路径显示原样的值, 不猜绝对路径。**
 *    后端下发的 `value` 可能是 `.`(默认)。前端不知道服务进程启动在哪个目录,
 *    所以这里显示 `.` 并紧跟一行「= 进程启动时所在的目录」——如实说明"它就是
 *    一个相对量", 而不是拼一个看起来确定的假绝对路径。
 *
 * ② **保存之后明说「重启才生效」。**
 *    `sandboxRoot(ctx)` 本身每次现读, 但消费它的插件(policy-fs / tool-bash /
 *    tool-search …)是在 `apply` 时把它抓成常量的。中途改配置的结果是**一半插件
 *    用新路径、一半用旧路径** —— 那比"要重启"难查得多。所以不假装立刻生效。
 *
 * ③ **没有目录浏览器。**
 *    浏览器的文件选择器拿不到真实路径, 而内核也没有列目录的 op。与其做一个
 *    「选择文件夹」按钮点开只能选个假路径, 不如老老实实一个输入框 —— 填错了
 *    至少看得出来填的是什么。
 */

import { useCallback, useEffect, useState } from 'react'

import type { SectionApi } from './api.ts'
import { Field, Group, Note } from './controls.tsx'
import styles from './WorkspaceSection.module.css'
import {
  WORKSPACE_KEY as KEY,
  canSave,
  isAbsolutePath,
  pathOf,
  sourceLabel,
  type RootEntry,
} from './workspace.ts'

/** 后端说的话原样给用户看; 认不出的东西降级成字符串, 不要吞掉 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 目录能管什么。只读事实, 不画成禁用控件 —— 灰着的开关比一段文字更让人想点 */
const FACTS: ReadonlyArray<{ name: string; text: string }> = [
  { name: '读写文件', text: '往上一级会被拒绝，包括 ../ 这种绕路写法' },
  { name: '搜索与列目录', text: 'grep / glob 都从这个目录开始找，找不到外面去' },
  { name: '执行命令', text: 'bash 的默认工作目录就是它，命令也跑在这棵树里' },
]

export function WorkspaceSection({ invoke }: SectionApi) {
  const [entry, setEntry] = useState<RootEntry>()
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string>()

  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string }>()

  const load = useCallback(async () => {
    try {
      const entries = await invoke<RootEntry[]>('config.list')
      const found = Array.isArray(entries) ? entries.find((e) => e.key === KEY) : undefined
      setEntry(found)
      setDraft(pathOf(found))
      setLoadError(undefined)
    } catch (err) {
      setLoadError(errText(err))
    } finally {
      setLoaded(true)
    }
  }, [invoke])

  useEffect(() => {
    void load()
  }, [load])

  const saved = pathOf(entry)
  const clean = draft.trim()
  const dirty = canSave(draft, saved)

  async function save() {
    setBusy(true)
    setMessage(undefined)
    try {
      // 写的是**用户输入的原样** (去掉首尾空白)。空串在前端就拦住, 因为它的
      // 语义是"回到默认", 容易被误当成"清空这个设置"
      const res = await invoke<{ entry?: RootEntry }>('config.set', { key: KEY, value: clean })
      if (res?.entry) setEntry(res.entry)
      else setEntry({ ...entry, key: KEY, value: clean, source: 'settings' })
      setDraft(clean)
      setMessage({ tone: 'ok', text: '已写入设置文件。重启之后，新目录才会真的开始用。' })
    } catch (err) {
      setMessage({ tone: 'error', text: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) return <div className={styles.loading}>正在读内核里的工作区配置…</div>

  if (loadError) {
    return (
      <div className={styles.problem} role="alert">
        <p className={styles.problemTitle}>读不到工作区配置</p>
        <p className={styles.problemText}>{loadError}</p>
        <p className={styles.problemText}>
          这不影响聊天：工作区默认就是服务进程启动时所在的目录。等内核恢复后再回来改。
        </p>
      </div>
    )
  }

  // 内核没声明这一项 —— 说明这个后端版本不支持改工作区。**不画输入框**:
  // 画一个存进去没人读的框, 比不画更糟
  if (!entry) {
    return (
      <div className={styles.problem}>
        <p className={styles.problemTitle}>这个内核没有开放工作区设置</p>
        <p className={styles.problemText}>
          工作区由启动参数决定，界面改不了。要换目录，请在启动梦之前设置环境变量，或者从那个目录启动。
        </p>
      </div>
    )
  }

  const isDefault = saved === '.'
  const relative = !isAbsolutePath(saved)

  /**
   * 大字那一行。**默认态不画 `.`** —— 一个孤零零的点在 18px 下既不像路径也不
   * 像信息, 用户只会以为页面没加载完。所以这里放人话(「启动梦时所在的目录」),
   * 而真实的配置值 `.` 退到下面那行的小代码块里 —— 该看得见的是**它的含义**,
   * 需要核对配置时再看字面值。
   */
  const headline = isDefault ? '启动梦时所在的目录' : saved

  /** 只在"这个路径会跟着启动位置变"时提醒。稳定的绝对路径不需要第三段话 */
  const hint = isDefault
    ? '换一个目录启动梦，工作区就跟着变。想固定下来，在下面填一个绝对路径。'
    : relative
      ? '这不是绝对路径，它仍然相对于启动位置 —— 想固定下来，请填以 / 开头的完整路径。'
      : undefined

  return (
    <div>
      <section className={styles.hero} data-workspace-hero="">
        <div className={styles.heroLabel}>当前工作区</div>
        <div className={styles.heroPath} data-default={isDefault ? '' : undefined}>
          {headline}
        </div>
        <div className={styles.heroMeta}>
          <span className={styles.heroDot} data-source={entry.source ?? 'default'} aria-hidden="true" />
          <span>{sourceLabel(entry.source)}</span>
          {isDefault && <code className={styles.heroCode}>.</code>}
        </div>
        {hint !== undefined && <p className={styles.heroHint}>{hint}</p>}
      </section>

      <Group title="根目录">
        <Field
          id="workspace-root"
          label="绝对路径"
          desc={
            <>
              文件读写、搜索、命令执行都不会越出这个目录。填 <code>.</code> 表示回到默认的「启动目录」。
              <br />
              环境变量 <code>MENG_WORKSPACE</code> 的优先级高于这里 —— 它一旦有值，这一页改了也不生效。
            </>
          }
          value={draft}
          onChange={(next) => {
            setDraft(next)
            setMessage(undefined)
          }}
          onSave={() => void save()}
          dirty={dirty}
          busy={busy}
          message={message}
          placeholder="/Users/you/projects"
          mono
        />
      </Group>

      <Group title="这个目录管什么">
        {FACTS.map((f) => (
          <div key={f.name} className={styles.fact}>
            <span className={styles.factName}>{f.name}</span>
            <span className={styles.factText}>{f.text}</span>
          </div>
        ))}
      </Group>

      <Note>
        改完要重启梦才真的生效。文件、搜索、命令这几个插件在启动时读一次路径，中途换掉会让一部分插件用新目录、一部分还用旧的
        —— 那种半新半旧的状态比明确要求重启更难查。
      </Note>
    </div>
  )
}
