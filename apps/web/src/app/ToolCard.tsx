/**
 * 工具卡：一次工具调用在会话里占的那块地方。
 *
 * 从 BuiltinLayout 里抽出来是因为它同时要管三态 + 折叠, 内联在布局里会把那个
 * 文件撑爆; 更实际的原因是: 它是**唯一知道工具输出长什么样**的地方,
 * 这一层不许扩散出去。
 *
 * ── 三态的分工 ──
 *   running  还没结果, 所以给 spinner, 并把 args 摊开 —— 这时候用户唯一想知道
 *            的就是"它在跑什么", 把它藏起来等于让他干等
 *   blocked  被策略拦了。reason **常显**不折叠 —— "为什么不让我干"是这一段里
 *            最重要的信息, 藏在展开里等于没有
 *   done     默认折叠: 头上一行摘要, 输出收起来。理由见 conversation.toolSummary
 *            的注释 —— 工具输出的价值在"想看时能看", 不在"每次都摊开把正文顶走"
 *
 * ── 为什么摘要能代替"成功/失败" ──
 *   后端不会因为命令跑挂了就报失败: tool-bash 的 render() 把非零退出渲染成
 *   `[exit code: 1]`, 而 ToolResult.ok 依然是 true(它明写非零退出是结果)。
 *   所以这里**不画勾也不画叉**, 而是把退出码摘进摘要并染成警示色 ——
 *   画一个"✓ 完成"在 exit 1 旁边, 是最容易骗人的一种界面。
 */

import { useEffect, useState } from 'react'

import { Badge, Spinner } from '@meng/ui'

import { elapsedLabel, segmentOutput, toolCardExpanded, toolOutputText, toolSummary, toolTitle, type ToolCall } from './conversation.ts'
import type { ToolRecord } from './layout.ts'
import styles from './App.module.css'

export interface ToolCardProps {
  tool: ToolCall
  /**
   * 跑完之后默认折叠。来自设置里的「工具卡」开关。
   *
   * 为什么是 prop 而不是组件自己去读偏好: 读 localStorage 的组件没法在被测时
   * 换一个取值, 而折叠与否是**会改变断言结果**的行为。偏好从上面流下来,
   * 这里就只是一个布尔。
   */
  autoFold?: boolean
  /**
   * 取这条记录的全文（`tool.record`）。缺 = 宿主没给这个能力
   * （插件自己画的布局可能没接），那时**不画**那个入口 —— 画一个点了没反应的按钮
   * 比不画更糟。
   */
  readRecord?: (recordId: string) => Promise<ToolRecord>
}

export function ToolCard({ tool, autoFold = true, readRecord }: ToolCardProps) {
  /**
   * `null` = 没手动动过, 跟随偏好的默认值。
   *
   * 三态而不是一个布尔, 是因为「默认收起」和「默认展开」两种偏好下,
   * 「用户点了一下」的方向是相反的 —— 用一个 boolean 记它, 换偏好时会翻车。
   */
  const [toggled, setToggled] = useState<boolean | null>(null)
  const [now, setNow] = useState(() => Date.now())
  /**
   * 完整输出。三态而不是一个字符串:
   *   undefined = 还没点    {text} = 取到了    {error} = 取不到（404 = 已被清理）
   * 用 `'error' in full` 区分, 而不是靠 `text === ''` —— 空记录也是合法结果。
   */
  const [full, setFull] = useState<{ text: string } | { error: string }>()
  const [loadingFull, setLoadingFull] = useState(false)

  /**
   * 计时器**只在 running 时挂**。
   *
   * 一秒一跳就够: 跑着的工具上显示秒数, 是为了让人判断"要不要中止",
   * 不是用来读毫秒的。而且这张卡可能在"最近 60 条"窗口里被卸载,
   * 所以清理必须是 effect 的返回值, 不能靠组件自己记得停。
   */
  useEffect(() => {
    if (tool.status !== 'running') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [tool.status])

  const output = tool.status === 'done' ? toolOutputText(tool.output) : ''
  const summary = toolSummary(tool)
  /** 完成后统一可折叠；单行结果也可以通过展开查看本次调用参数。 */
  const foldable = tool.status === 'done'
  /** 执行中与拦截态保留现场；完成后默认收起，手动选择优先。 */
  const expanded = toolCardExpanded(tool.status, toggled, autoFold)

  /**
   * 能不能展开全文。四个条件缺一不可:
   *   ① 跑完了（running 时没有 recordId）
   *   ② 事件里那份**被截过**（没截过的话正文就是全文，没必要多一次请求）
   *   ③ 有 recordId（没有 = 这条调用没落记录）
   *   ④ 宿主给了取记录的能力
   */
  const canLoadFull = tool.status === 'done' && tool.truncated === true && tool.recordId !== undefined && readRecord !== undefined

  async function toggleFull(): Promise<void> {
    if (readRecord === undefined || tool.recordId === undefined) return
    // 已经展开 → 收起（不重新请求：同一条记录不会变）
    if (full !== undefined && !('error' in full)) {
      setFull(undefined)
      return
    }
    setLoadingFull(true)
    setFull(undefined)
    try {
      const rec = await readRecord(tool.recordId)
      setFull({ text: rec.text })
    } catch {
      /*
       * 404 = 记录已被清理（记录是**可丢的附属数据**，B-27 明写）。
       * 不当错误弹：用户点的是"看全文"，得到"已经没了"是合理结局。
       */
      setFull({ error: '这条记录已被清理，取不到全文了' })
    } finally {
      setLoadingFull(false)
    }
  }

  return (
    <div
      className={styles.tool}
      data-status={tool.status}
      /*
        时间线节点用**首字母**当身份 (read→R, bash→B), 不给每个工具配图标:
        插件是外置的, 界面替所有可能出现的工具画图标不现实, 首字母零成本且够认。
        warn 用属性而不是类: 跟 data-status 同一条规矩 —— 状态是数据。
      */
      data-warn={tool.status === 'done' && summary.warn ? '' : undefined}
    >
      <div className={styles.toolNode} aria-hidden="true">
        {tool.tool.charAt(0).toUpperCase()}
      </div>
      <div className={styles.toolBody}>
        <div className={styles.toolHead}>
          <span className={styles.toolName}>{toolTitle(tool)}</span>

          {tool.status === 'running' && (
            <>
              <Spinner label="工具执行中" />
              {/*
                跑着的工具最该显示的就是"跑了多久" —— 用户凭这个决定要不要中止。
                比"努力加载中"有用, 而且不用维护文案: 秒数是真的。
              */}
              {elapsedLabel(tool.startedAt, now) !== '' && (
                <span className={styles.toolElapsed}>{elapsedLabel(tool.startedAt, now)}</span>
              )}
            </>
          )}
          {tool.status === 'blocked' && <Badge tone="danger">已拦截</Badge>}

          {/*
            摘要**不是**"成功/失败"的结论, 是这次调用的一句话结果。
            warn 只染色不换字 —— 让人自己去判断, 而不是替他下结论。
          */}
          {tool.status === 'done' && summary.text !== '' && (
            <span className={summary.warn ? styles.toolSummaryWarn : styles.toolSummary}>
              {summary.text}
            </span>
          )}

          {foldable && (
            <button
              type="button"
              className={styles.toolToggle}
              aria-expanded={expanded}
              onClick={() => setToggled(!expanded)}
            >
              {expanded ? '收起' : '展开'}
            </button>
          )}
        </div>

        {/*
          args 是技术细节: 折叠态里标题已经把"干了什么"说完了, JSON 只在
          看得见细节的场合出现 —— running(它在跑什么) / blocked(它想干什么) /
          用户亲手点开的展开态。注意判的是 `toggled === true` 而不是 `expanded`:
          偏好设成"默认展开"时 expanded 对多行输出也是常 true, 若按它判,
          args 会跟着常驻 —— 标题已经说了 notes/x.md, 再摆一遍 JSON 是纯噪音
        */}
        {(tool.status !== 'done' || toggled === true) && tool.args !== undefined && (
          <pre className={styles.toolArgs}>{JSON.stringify(tool.args, null, 2)}</pre>
        )}

        {/*
          输出按语义切段渲染, 不是一整块灰底: stderr 段染警示色、[exit code] 这类
          标记行弱化成"工具在跟人说话"的注解。段数恒定, 所以 2000 行的 read 也不会
          变成 2000 个节点 —— 逐行渲染才能做的行号 gutter 是拿性能换好看, 不换。
        */}
        {/*
          全文已经在下面摊开时，**这段就不画了** —— 它是同一条输出的前 2000 字，
          两段叠着只会让人以为"下面那段是补充说明"。收起全文之后它自然回来。
        */}
        {output !== '' && expanded && !(full !== undefined && 'text' in full) && (
          <div className={styles.toolOutput}>
            {segmentOutput(output).map((seg, i) => (
              <pre key={i} className={styles.toolSeg} data-kind={seg.kind}>
                {seg.text}
              </pre>
            ))}
          </div>
        )}

        {/*
          完整输出入口。**只在被截断时出现** —— 没截断的话展开里那份就是全文,
          多一个按钮只会让人以为还有更多。
        */}
        {canLoadFull && (
          <div className={styles.toolMore}>
            {full !== undefined && 'error' in full ? (
              <span className={styles.toolMoreNote}>{full.error}</span>
            ) : (
              <button
                type="button"
                className={styles.toolMoreBtn}
                data-tool-full={tool.recordId}
                aria-expanded={full !== undefined}
                disabled={loadingFull}
                onClick={() => void toggleFull()}
              >
                {loadingFull
                  ? '读取中…'
                  : full !== undefined
                    ? '收起完整输出'
                    : `查看完整输出${tool.bytes === undefined ? '' : ` · ${formatBytes(tool.bytes)}`}`}
              </button>
            )}
          </div>
        )}

        {full !== undefined && 'text' in full && (
          <div className={styles.toolOutput} data-full="" data-tool-record={tool.recordId}>
            <pre className={styles.toolSeg}>{full.text}</pre>
          </div>
        )}

        {tool.reason !== undefined && tool.reason !== '' && (
          <div className={styles.toolReason}>{tool.reason}</div>
        )}
      </div>
    </div>
  )
}

/**
 * 字节数。**和事件里的 `bytes` 同口径**（截断前的原始字节）。
 *
 * 只留一位小数: 用户看这个数是判断"要不要点开"，不是要精确到个位。
 * 小于 1 KB 就不带小数 —— "0.4 KB" 比 "412 B" 更难懂。
 */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${Math.round(n)} B`
}
