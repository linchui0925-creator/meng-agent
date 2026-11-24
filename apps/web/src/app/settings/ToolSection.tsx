/**
 * 「工具」分区 —— 第三块内核腿（`origin: 'kernel'`），B-27 的第二半。
 *
 * 这一页只做一件事: **让用户决定模型看得见哪几组工具**。
 *
 * 三组（core / jobs / web）由后端给，前端不认识"有哪些组" —— 加第四组时这里
 * 自动多一行。每一行必须回答两个问题，否则用户不知道该不该关:
 *   ① 关掉它我会失去什么（`GROUP_HINTS` + 组里那串工具名）
 *   ② 我到底用过它没有（`tool.stats` 合出来的次数与最近一次）
 * 没有 ② 的话，这一页就是三个开关加三句恐吓。
 *
 * ── 为什么不是"每行一个工具" ──
 * 十二个开关会让这一页变成一张检查表，而用户的心智单位是"我要不要联网"，
 * 不是"我要不要 web_fetch"。分组是后端的判断（`ToolDef.group`），前端照搬。
 *
 * ── 为什么点一下立刻写 ──
 * 和权限三档同一个理由: 它是个决定，不是草稿。写失败就把开关**回滚** ——
 * 界面停在"关着"而配置里开着，是这类设置页最坏的一种谎。
 */

import { useCallback, useEffect, useState } from 'react'

import type { SectionApi } from './api.ts'
import { Group, Note, Row, Switch } from './controls.tsx'
import styles from './ToolSection.module.css'
import {
  DISABLED_KEY,
  GROUP_HINTS,
  GROUP_LABELS,
  coreOff,
  disabledOf,
  groupUsage,
  normalizeGroups,
  normalizeStats,
  toggleGroup,
  usageText,
  type ToolGroup,
  type ToolStat,
} from './tools.ts'

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function ToolSection({ invoke }: SectionApi) {
  const [groups, setGroups] = useState<ToolGroup[]>()
  const [stats, setStats] = useState<ToolStat[]>([])
  const [loadError, setLoadError] = useState<string>()
  /** 正在写的那一组。写的时候**整排都禁用** —— 连着点两下会让两次写入互相覆盖 */
  const [busy, setBusy] = useState<string>()
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string }>()

  const load = useCallback(async () => {
    try {
      /*
       * 两个 op 并行，但**失败面不同**:
       *   `tools.groups` 挂了 → 整页没法用（不知道有哪几组）
       *   `tool.stats` 挂了   → 只少一行"用过几次"，页面照常能开关
       * 所以后者单独 catch 成空数组，不把前者拖下水。
       */
      const [rawGroups, rawStats] = await Promise.all([
        invoke<unknown>('tools.groups'),
        invoke<unknown>('tool.stats').catch(() => []),
      ])
      setGroups(normalizeGroups(rawGroups))
      setStats(normalizeStats(rawStats))
    } catch (err) {
      setLoadError(errText(err))
    }
  }, [invoke])

  useEffect(() => {
    void load()
  }, [load])

  async function toggle(id: string) {
    if (groups === undefined || busy !== undefined) return
    const before = groups
    const next = toggleGroup(groups, id)
    const on = next.find((g) => g.id === id)?.enabled === true
    const label = GROUP_LABELS[id] ?? id

    // 先动界面: 开关是"点一下就生效"的东西，等 round-trip 才动会有一次明显迟滞
    setGroups(next)
    setBusy(id)
    setMessage(undefined)
    try {
      await invoke('config.set', { key: DISABLED_KEY, value: disabledOf(next) })
      setMessage({ tone: 'ok', text: `${label}已${on ? '打开' : '关闭'}，下一轮对话生效。` })
    } catch (err) {
      // 写失败 → 回滚。界面停在"关着"而配置里开着，是这类页面最坏的一种谎
      setGroups(before)
      setMessage({ tone: 'error', text: `没写进内核配置：${errText(err)}` })
    } finally {
      setBusy(undefined)
    }
  }

  if (groups === undefined && loadError === undefined) {
    return <div className={styles.loading}>正在读内核里的工具分组…</div>
  }

  if (loadError !== undefined) {
    return (
      <div className={styles.problem} role="alert">
        <p className={styles.problemTitle}>读不到工具分组</p>
        <p className={styles.problemText}>{loadError}</p>
        <p className={styles.problemText}>
          这不影响聊天：所有工具照常开着。等内核恢复后再回来改。
        </p>
      </div>
    )
  }

  // 老内核没有 `tools.groups` —— 不画一排"关不掉的开关"，直接说清楚
  if (groups === undefined || groups.length === 0) {
    return (
      <div className={styles.problem}>
        <p className={styles.problemTitle}>这个内核没有工具分组</p>
        <p className={styles.problemText}>
          它把所有工具一次性交给模型，没有"按组开关"这一层。要减少工具，只能改内核配置。
        </p>
      </div>
    )
  }

  const now = Date.now()
  const warn = coreOff(groups)

  return (
    <div>
      <Group title="工具组">
        {groups.map((g) => {
          const usage = groupUsage(g, stats)
          const label = GROUP_LABELS[g.id] ?? g.id
          return (
            <Row
              key={g.id}
              title={label}
              desc={
                <>
                  {GROUP_HINTS[g.id] ?? ''}
                  <span className={styles.toolList}>
                    {g.tools.map((t) => (
                      <code key={t} className={styles.tool} data-off={g.enabled ? undefined : ''}>
                        {t}
                      </code>
                    ))}
                  </span>
                  <span className={styles.usage} data-idle={usage.count === 0 ? '' : undefined}>
                    {usageText(usage.count, usage.lastAt, now)}
                  </span>
                </>
              }
            >
              <Switch
                checked={g.enabled}
                onChange={() => void toggle(g.id)}
                label={`${label}这一组工具`}
                disabled={busy !== undefined}
              />
            </Row>
          )
        })}
      </Group>

      {/*
        core 关掉之后要说一句重话。
        它不是一个"高级选项"，它是把助手的手脚卸了 —— 页面必须说出来，
        而不是等用户发现"它怎么什么都不会了"。
      */}
      {warn && (
        <p className={styles.warn} role="status" data-tool-warn="">
          核心组关着：模型现在看不见 read / write / bash 这些工具，基本没法干活。
        </p>
      )}

      {message !== undefined && (
        <p className={styles.msg} data-tone={message.tone} role="status">
          {message.text}
        </p>
      )}

      <Note>
        改的是内核配置 <code>{DISABLED_KEY}</code>，下一轮对话生效。它管的是
        <strong>模型看得见哪些工具</strong>，不是禁用 —— 已经排好的任务照常跑完。
      </Note>
    </div>
  )
}
