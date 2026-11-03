/**
 * 内置布局。**同样是 fallback, 不是内核** —— `layout.root` 空着的时候由它兜底。
 *
 * 这条设计解决了两个问题一起:
 *   1. 「插件要换整体布局」有正规入口 (register 'layout.root' + priority), 不用改宿主;
 *   2. 「插件全挂也要能画出界面」—— fallback 不经注册表, 注册表炸了它照样渲染。
 *
 * 注意它把 `Slot` 继续往下传: 换布局的插件如果不画内部的洞,
 * 就等于把别人的插件全埋了, 所以渲染子 slot 是布局契约的一部分。
 */

import { useEffect, useState } from 'react'

import { Badge, Button, IconButton, ScrollArea, Separator, Spinner, Tooltip } from '@meng/ui'

import { MoonIcon, PlusIcon, SunIcon, LayersIcon } from './icons.tsx'
import type { LayoutApi } from './layout.ts'
import { windowMessages, type Message } from './conversation.ts'
import { ToolCard } from './ToolCard.tsx'
import { BuiltinComposer } from './BuiltinComposer.tsx'
import { CopyButton } from './CopyButton.tsx'
import { JobBar } from './JobBar.tsx'
import { PluginPanel } from './PluginPanel.tsx'
import { SidebarSessions } from './SidebarSessions.tsx'
import styles from './App.module.css'

const SUGGESTIONS = ['给我讲讲这个平台', '帮我看看当前的工具列表', '设计一个插件加载流程']

/**
 * 一次渲染多少条消息。为什么是 60 而不是"全部":
 * 长会话的 DOM 节点数必须封顶 (docs/05 移动端性能预算), 窗口化的取舍写在
 * conversation.windowMessages 的注释里 —— 那里也解释了为什么**不是**虚拟化。
 */
const MESSAGE_WINDOW = 60

export function BuiltinLayout(api: LayoutApi) {
  const {
    messages,
    jobs,
    sessionId,
    sessions,
    onSelectSession,
    theme,
    fixture,
    toolCount,
    status,
    connection,
    onNewSession,
    onToggleTheme,
    composer,
    Slot,
    scrollRef,
    stickToBottom,
    plugins,
  } = api

  // 窗口大小归会话所有: 换会话时翻过的页数没有意义, 回到 60
  const [windowSize, setWindowSize] = useState(MESSAGE_WINDOW)
  useEffect(() => setWindowSize(MESSAGE_WINDOW), [sessionId])
  const { visible, hidden } = windowMessages(messages, windowSize)

  return (
    <div className={styles.shell}>
      {/* data-density=compact 只作用于这一列: 会话列表天生该紧, 而右边正文要呼吸感。
          密度是继承的 CSS 变量, 写在这里就等于「只让侧栏紧凑」, 不需要全局开关。 */}
      <aside className={styles.sidebar} data-density="compact">
        <div className={styles.sidebarHead}>
          <div className={styles.brand}>梦</div>
          <div className={styles.badgeRow}>
            <Badge tone="accent">M3 界面骨架</Badge>
            {fixture && <Badge tone="warning">fixture · {fixture}</Badge>}
          </div>
          {/* 侧栏头部的增强位: 插件可以加「搜索」「收藏」这类入口。
              与「新会话」同排 —— column 布局里独占一行太空, 而它们语义上都是"动作"。
              宿主自己的「新会话」按钮不进 slot —— 它是布局契约的一部分, 换掉就没有入口了 */}
          <div className={styles.headerActions}>
            <Slot name="sidebar.header" props={{ sessionId, onNewSession }} />
            <Button variant="secondary" size="sm" onClick={onNewSession}>
              <PlusIcon />
              新会话
            </Button>
          </div>
        </div>

        <Separator />

        <ScrollArea className={styles.sessions}>
          <SidebarSessions
            sessions={sessions}
            activeId={sessionId}
            now={Date.now()}
            onSelect={onSelectSession}
            Slot={Slot}
          />
        </ScrollArea>

        <div className={styles.sidebarFoot}>
          <Slot name="sidebar.footer" props={{ messageCount: messages.length, toolCount }} />
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.topbar}>
          <div className={styles.topbarTitle}>
            <span className={styles.title}>会话</span>
            {sessionId && <span className={styles.sessionId}>{sessionId}</span>}
          </div>
          <div className={styles.topbarRight}>
            {/* 标题栏动作位: 分享 / 导出 / 设置这类全局动作。
                放在状态点**之前** —— 状态是宿主的, 动作是插件的, 插件不该被挤到最右边 */}
            <Slot name="topbar.actions" props={{ sessionId, theme }} />
            <Tooltip label={plugins.open ? '收起插件面板' : '插件状态'}>
              <IconButton
                aria-label="插件状态面板"
                size="sm"
                aria-pressed={plugins.open}
                onClick={plugins.toggle}
              >
                <LayersIcon />
              </IconButton>
            </Tooltip>
            <span className={styles.status}>
              <i className={`${styles.dot} ${styles[connection]}`} aria-hidden="true" />
              {status}
            </span>
            <Tooltip label={theme === 'dark' ? '切到浅色' : '切到深色'}>
              <IconButton aria-label="切换主题" size="sm" onClick={onToggleTheme}>
                {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
              </IconButton>
            </Tooltip>
          </div>
        </header>

        <ScrollArea
          className={styles.messages}
          ref={scrollRef}
          onScroll={(event) => {
            const el = event.currentTarget
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
          }}
        >
          {messages.length === 0 ? (
            composer.busy ? (
              /*
                加载态与空态**必须分开**: 空态在教用户做什么(给建议), 加载态是
               已经发出去了在等 —— 这时候还挂着三条"试试这些"的引导按钮, 用户会以为
                自己没点成功, 于是再点一次。
              */
              <div className={styles.empty}>
                <Spinner label="正在等待回复" />
                <div className={styles.emptyHint}>正在思考…</div>
              </div>
            ) : (
              <div className={styles.empty}>
                <div className={styles.emptyTitle}>开始一段对话</div>
                <div className={styles.emptyHint}>
                  {fixture ? '当前是 fixture 内核, 回复是脚本化的' : '输入一句话, 或者试试下面这些'}
                </div>
                <div className={styles.chips}>
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={styles.chip}
                      onClick={() => composer.setValue(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )
          ) : (
            <div className={styles.thread}>
              {/*
                更早的消息**不渲染但也不丢**: 数量写进按钮文案, 用户知道有多少被折起来。
                放在 thread 顶部 (而不是 sticky) —— sticky 会跟着滚动条晃, 反而显眼。
              */}
              {hidden > 0 && (
                <button
                  type="button"
                  className={styles.loadEarlier}
                  onClick={() => setWindowSize((s) => s + MESSAGE_WINDOW)}
                >
                  显示更早的消息 (还有 {hidden} 条)
                </button>
              )}
              {visible.map((message) => (
                <MessageRow key={message.id} message={message} Slot={Slot} />
              ))}
            </div>
          )}
        </ScrollArea>

        {/* 演示入口: 真内核下审批来自后端的 approval/request 事件, 这里手动模拟 */}
        {composer.simulateApproval && !composer.approval && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', padding: '0 24px 6px' }}>
            <button type="button" className={styles.chip} onClick={composer.simulateApproval}>
              模拟：agent 请求审批
            </button>
          </div>
        )}

        {/*
          后台任务条。位置在输入框**上方** —— 它回答的是"我还能不能让 agent 干活",
          而输入框就是干活的入口。放到状态条那边会变成遥测, 用户不会去看。
          job/completed 一到就把它从「运行中」翻成终态, 5 秒后整条消失 (JobBar 注释有取舍)。
        */}
        {jobs.length > 0 && <JobBar jobs={jobs} />}

        {/*
          输入框是 **chain**, 不是 single。
          它要能被「临时接管」: 审批条上来时内置输入框让位 —— overlay 让它只是被藏起来
          而没有卸载, 所以草稿和光标都还活着, 审批完原样回来。
          priority 大的先被问, 但真正决定谁上场的是候选自己的 select。
        */}
        <Slot.Chain
          name="composer"
          owner={composer}
          fallback={<BuiltinComposer {...composer} />}
          overlay
        />

        {/*
          状态条: 常驻但不显眼。它的价值全在「插件能往里面塞东西」——
          token 用量、模型名、索引进度、内存占用都能挂这里, 而不用各自浮一层。
          宿主这边只放**诊断信息** (会话 id / 运行模式), 不放消息计数 ——
          那个 sidebar.footer 已经有了, 同一屏出现两次一样的数字是设计事故。
          data-density 让它是全界面最紧的一条。
        */}
        <footer className={styles.statusbar} data-density="compact">
          {sessionId ? <span>会话 {sessionId.slice(0, 8)}</span> : <span>未连接</span>}
          {fixture && (
            <>
              <span className={styles.statusbarDim}>·</span>
              <span>fixture · {fixture}</span>
            </>
          )}
          <Slot
            name="statusbar.item"
            props={{ messageCount: messages.length, toolCount, sessionId }}
          />
        </footer>
      </main>

      {/*
        第三栏: 插件状态面板。
        宽屏 (container >= 1080) 常驻在右侧, 窄屏变成覆盖在正文上的抽屉 ——
        **同一份 DOM, 只切定位方式**, 不是两套组件 (docs/07 F7「布局用 container query, 不做三套」)。
        这跟 composer chain 的处理是同一个原则: 布局变化不该让组件卸载重挂。
      */}
      <div className={styles.panelSlot} data-open={plugins.open ? 'true' : 'false'}>
        {plugins.open && (
          <PluginPanel graph={plugins.graph} onRefresh={plugins.refresh} onClose={plugins.close} />
        )}
      </div>
    </div>
  )
}

/**
 * 一条消息。
 *
 * **没有气泡**。角色行 + 通栏正文, 用户与助手走同一套骨架, 只在两处不同:
 *   1. 角色标记 (你 / 助手 + 不同底色)
 *   2. 用户正文左侧有一条 2px 竖线 —— 那是「引用原文」的排版惯例, 不是容器边界
 *
 * 为什么砍气泡 (F2b 定稿, docs/07 §6):
 *   - `max-width: 78%` 在长文本和代码下把可读宽度白白吃掉两成, 而工具卡是通栏的,
 *     两者并排会出现「半宽正文 + 全宽工具」的断裂感;
 *   - 气泡一旦有 border/radius/背景, 它就会想要 padding, 想要 padding 就会想在
 *     里面放工具卡、放操作条 —— 于是每个新块都得为「气泡内边距」做一次适配;
 *   - 移动端两侧留白纯属浪费, 而通栏在窄屏是唯一正确解。
 * 区分角色不需要画框: 一段文字 + 一个名字, 读者扫一眼就知道谁说的。
 */
function MessageRow({ message, Slot }: { message: Message; Slot: LayoutApi['Slot'] }) {
  const isUser = message.role === 'user'

  return (
    <div className={styles.msg}>
      <div className={styles.role}>
        <span className={isUser ? styles.avatarUser : styles.avatar}>{isUser ? '你' : '梦'}</span>
        <span className={styles.roleName}>{isUser ? '你' : '助手'}</span>
        <span className={styles.meta}>{formatTime(message.at)}</span>
      </div>

      {(message.text || message.status === 'streaming') && (
        <div className={isUser ? styles.bodyUser : styles.body}>
          {message.text}
          {message.status === 'streaming' && <span className={styles.caret} aria-hidden="true" />}
        </div>
      )}

      {/*
        工具区接 compact 密度: 工具输出天生是"机器产物", 一行一条、越紧越好读;
        而正文需要呼吸感。密度是继承的 CSS 变量, 写在这一层只影响工具卡。
      */}
      {message.tools.length > 0 && (
        <div className={styles.tools} data-density="compact">
          {message.tools.map((tool) => (
            <ToolCard key={tool.callId} tool={tool} />
          ))}
        </div>
      )}

      {message.status === 'error' && (
        <div className={styles.errorBox}>
          <span className={styles.errorCode}>{message.errorCode ?? 'error'}</span>
          {/*
            错误文案带值: 用户复制去搜、去贴给后端, 是这条链路上最短的排查路径。
            只放一个 "失败了" 等于让用户自己复述现场。
          */}
          <span className={styles.errorText}>{message.error}</span>
          <span className={styles.errorActions}>
            <CopyButton label="复制错误信息" text={[message.errorCode, message.error].filter(Boolean).join(': ')} />
          </span>
        </div>
      )}

      {message.status !== 'streaming' && message.text && (
        <div className={styles.actions}>
          <Slot name="conversation.actions" props={{ text: message.text }} />
        </div>
      )}
    </div>
  )
}

function formatTime(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
