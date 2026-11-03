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

import { elapsedLabel, segmentOutput, shouldFold, toolOutputText, toolSummary, toolTitle, type ToolCall } from './conversation.ts'
import styles from './App.module.css'

export interface ToolCardProps {
  tool: ToolCall
}

export function ToolCard({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

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
  /** 只有一行的输出没有折叠的必要 —— 摘要已经把它整个显示出来了 */
  const foldable = shouldFold(output)
  const expanded = open || !foldable

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
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? '收起' : '展开'}
            </button>
          )}
        </div>

        {/*
          args 是技术细节: 折叠态里标题已经把"干了什么"说完了, JSON 只在
          看得见细节的场合出现 —— running(它在跑什么) / blocked(它想干什么) /
          用户亲手点开的展开态。注意用 `open` 不用 `expanded`: 单行输出没有
          折叠这回事(永远 expanded), 若按 expanded 判, 它的 args 会常驻 ——
          标题已经说了 notes/x.md, 再摆一遍 JSON 是纯噪音
        */}
        {(tool.status !== 'done' || open) && tool.args !== undefined && (
          <pre className={styles.toolArgs}>{JSON.stringify(tool.args, null, 2)}</pre>
        )}

        {/*
          输出按语义切段渲染, 不是一整块灰底: stderr 段染警示色、[exit code] 这类
          标记行弱化成"工具在跟人说话"的注解。段数恒定, 所以 2000 行的 read 也不会
          变成 2000 个节点 —— 逐行渲染才能做的行号 gutter 是拿性能换好看, 不换。
        */}
        {output !== '' && expanded && (
          <div className={styles.toolOutput}>
            {segmentOutput(output).map((seg, i) => (
              <pre key={i} className={styles.toolSeg} data-kind={seg.kind}>
                {seg.text}
              </pre>
            ))}
          </div>
        )}

        {tool.reason !== undefined && tool.reason !== '' && (
          <div className={styles.toolReason}>{tool.reason}</div>
        )}
      </div>
    </div>
  )
}
