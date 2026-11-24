/**
 * 「工作区」分区 —— 第二个内核腿分区（`origin: 'kernel'`）。
 *
 * 这一页做两件事，而且它们本来就是一件事:
 *   ① 梦现在能在**哪个目录**里动文件
 *   ② 那个目录**允许什么**（三档权限）
 * 目录是范围, 权限是这个范围内外的宽严 —— 所以它们在同一页、同一个 scope
 * （`sandbox.root` / `sandbox.mode`）。分成两页的话, 用户改完目录得再找一遍"权限在哪"。
 *
 * ── 四个刻意的取舍 ──
 *
 * ① **路径显示原样的值, 不猜绝对路径。**
 *    后端下发的 `value` 可能是 `.`(默认)。前端不知道服务进程启动在哪个目录,
 *    所以这里显示 `.` 并紧跟一行「= 进程启动时所在的目录」——如实说明"它就是
 *    一个相对量", 而不是拼一个看起来确定的假绝对路径。
 *    （后端现在也会下发 `resolved`, 但那是**另一件事**: 它是"现在解析成什么",
 *    不改变"配置里存的是什么"。两个都画会让人以为改的是那个绝对路径。）
 *
 * ② **改完立刻生效, 不再说"要重启"。**
 *    这一页曾经写死"重启之后才生效"—— 那是按实现顺手推的（七个消费方在
 *    `apply()` 里抓常量）。2026-11-16 后端把七处全改成现读, `restartRequired`
 *    也撤了。留着那句话现在就是**假话**, 而且它会让人改完去重启、然后以为
 *    重启才是生效的原因。
 *
 * ③ **权限用分段而不是下拉。** 三档、互斥、而且"有哪三档"本身就是信息
 *    （用户看到有"请求批准/帮我批准/绝对权限", 才知道自己现在偏严还是偏松）。
 *    选项**从 `schema.enum` 读**, 后端加第四档这里自动多一项。
 *
 * ④ **没有目录浏览器。**
 *    浏览器的文件选择器拿不到真实路径, 而内核也没有列目录的 op。与其做一个
 *    「选择文件夹」按钮点开只能选个假路径, 不如老老实实一个输入框 —— 填错了
 *    至少看得出来填的是什么。
 */

import { useCallback, useEffect, useState } from 'react'

import type { SectionApi } from './api.ts'
import { Field, Group, Note, Segmented } from './controls.tsx'
import styles from './WorkspaceSection.module.css'
import {
  MODE_HINTS,
  MODE_KEY,
  MODE_LABELS,
  WORKSPACE_KEY as KEY,
  canSave,
  isAbsolutePath,
  modeAsks,
  modeOf,
  modeOptionsOf,
  pathOf,
  sourceLabel,
  type RootEntry,
} from './workspace.ts'

/** 后端说的话原样给用户看; 认不出的东西降级成字符串, 不要吞掉 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function WorkspaceSection({ invoke }: SectionApi) {
  const [entry, setEntry] = useState<RootEntry>()
  const [modeEntry, setModeEntry] = useState<RootEntry>()
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string>()

  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string }>()

  const [modeBusy, setModeBusy] = useState(false)
  const [modeMessage, setModeMessage] = useState<{ tone: 'ok' | 'error'; text: string }>()

  const load = useCallback(async () => {
    try {
      const entries = await invoke<RootEntry[]>('config.list')
      const list = Array.isArray(entries) ? entries : []
      const found = list.find((e) => e.key === KEY)
      setEntry(found)
      setModeEntry(list.find((e) => e.key === MODE_KEY))
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
      // **不写"重启之后"**: 七个消费方现在都现读, 下一个请求就用新根
      setMessage({ tone: 'ok', text: '已写入设置文件，下一次工具调用就用新目录。' })
    } catch (err) {
      setMessage({ tone: 'error', text: errText(err) })
    } finally {
      setBusy(false)
    }
  }

  /**
   * 改权限档。**点一下就写**，不给保存按钮 —— 它是一个决定, 不是一个草稿:
   * 让用户选完再点一次"保存", 中间那段时间界面上显示的档位是假的。
   */
  async function pickMode(next: string) {
    if (modeBusy || next === modeOf(modeEntry)) return
    setModeBusy(true)
    setModeMessage(undefined)
    try {
      const res = await invoke<{ entry?: RootEntry }>('config.set', { key: MODE_KEY, value: next })
      if (res?.entry) setModeEntry(res.entry)
      else setModeEntry({ ...modeEntry, key: MODE_KEY, value: next, source: 'settings' })
      setModeMessage({ tone: 'ok', text: `已切到「${MODE_LABELS[next] ?? next}」，下一次工具调用生效。` })
    } catch (err) {
      setModeMessage({ tone: 'error', text: errText(err) })
    } finally {
      setModeBusy(false)
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

  const mode = modeOf(modeEntry)
  const modeOptions = modeOptionsOf(modeEntry)

  /**
   * 这一段随档位变。
   *
   * 为什么不在下面写死"越界会被拒绝": 那句话在 `full` 档**是假的**,
   * 而在 `ask`/`auto` 档也不准 —— 现在的行为是"问你一次", 批准了真的能越界。
   * 权限说明里写错一句, 用户就会按错误的预期去批准。
   */
  const facts: ReadonlyArray<{ name: string; text: string }> = [
    {
      name: '读写文件',
      text: modeAsks(mode) ? '越出这个目录会先问你；批准之后这次调用能写出去' : '越出这个目录也不问 —— 这一档不设围栏',
    },
    {
      name: '搜索与列目录',
      text: modeAsks(mode) ? 'grep / glob 从这个目录开始找；找到外面会先问你' : 'grep / glob 不受限制',
    },
    {
      name: '执行命令',
      text: modeAsks(mode) ? 'bash 的工作目录就是它；跑命令会按上面的档位问或放行' : 'bash 的工作目录就是它，命令不再拦',
    },
  ]

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
        {/* 权限档在标题区也露一面: 它和目录是同一件事的两半, 只看路径看不出宽严 */}
        <div className={styles.heroMeta} data-mode-badge={mode}>
          <span className={styles.heroDot} data-mode={mode} aria-hidden="true" />
          <span>
            权限：{MODE_LABELS[mode] ?? mode}
          </span>
        </div>
        {hint !== undefined && <p className={styles.heroHint}>{hint}</p>}
      </section>

      <Group title="根目录">
        <Field
          id="workspace-root"
          label="绝对路径"
          desc={
            <>
              文件读写、搜索、命令执行都以它为基准。填 <code>.</code> 表示回到默认的「启动目录」。
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

      <Group title="权限">
        <div className={styles.modeRow} data-mode-row="">
          <Segmented
            label="权限模式"
            value={mode}
            options={modeOptions}
            onChange={(next) => void pickMode(next)}
            disabled={modeBusy}
          />
          <p className={styles.modeHint} data-mode-hint={mode}>
            {MODE_HINTS[mode] ?? '这一档的说明还没写。'}
          </p>
          {modeMessage && (
            <p className={styles.modeMsg} data-tone={modeMessage.tone} role="status">
              {modeMessage.text}
            </p>
          )}
        </div>
      </Group>

      <Group title="这个目录管什么">
        {facts.map((f) => (
          <div key={f.name} className={styles.fact} data-fact={f.name}>
            <span className={styles.factName}>{f.name}</span>
            <span className={styles.factText}>{f.text}</span>
          </div>
        ))}
      </Group>

      <Note>
        改完立刻生效，不用重启：这些插件现在每次调用都现读工作区与权限档。
        三档都仍然会拦"一次就不可逆"的灾难命令（<code>rm -rf /</code> 之类）—— 那不是权限，是止损。
      </Note>
    </div>
  )
}
