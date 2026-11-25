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

import { useEffect, useMemo, useState } from 'react'

import { Badge, Button, IconButton, ScrollArea, Separator, Spinner, Tooltip } from '@meng/ui'

import { MoonIcon, PlusIcon, SunIcon, LayersIcon, GearIcon } from './icons.tsx'
import type { LayoutApi, MessageRowApi, ToolCardApi } from './layout.ts'
import { waitingState, windowMessages, type Message, type ModifiedFile, type WaitState } from './conversation.ts'
import { WHISPER_DELAY_BY_PREF, WHISPER_HOLD_MS } from './whisper.ts'
import { WaitBubble } from './WaitBubble.tsx'
import { ToolCard } from './ToolCard.tsx'
import { BuiltinComposer } from './BuiltinComposer.tsx'
import { CopyButton } from './CopyButton.tsx'
import { AutolinkText, Markdown } from './Markdown.tsx'
import { JobTray } from './JobTray.tsx'
import { QuestionCard } from './QuestionCard.tsx'
import { PluginPanel } from './PluginPanel.tsx'
import { RunTimeline } from './RunTimeline.tsx'
import { FileInspector } from './FileInspector.tsx'
import { SidebarNav } from './SidebarNav.tsx'
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
    view,
    onViewChange,
    taskCenter,
    jobActions,
    messages,
    jobs,
    sessionId,
    sessions,
    workspaces,
    onSelectSession,
    archivedSessionIds,
    onArchiveSession,
    onDeleteSession,
    onRenameSession,
    theme,
    prefs,
    fixture,
    toolCount,
    status,
    connection,
    onNewSession,
    onNewWorkspaceSession,
    onToggleTheme,
    onOpenSettings,
    onNewWorkspace,
    composer,
    question,
    pluginNavCount,
    questionNotice,
    dismissQuestionNotice,
    Slot,
    scrollRef,
    stickToBottom,
    plugins,
    readToolRecord,
    readAttachment,
  } = api

  // 窗口大小归会话所有: 换会话时翻过的页数没有意义, 回到 60
  const [windowSize, setWindowSize] = useState(MESSAGE_WINDOW)
  const [selectedFile, setSelectedFile] = useState<ModifiedFile>()
  useEffect(() => setWindowSize(MESSAGE_WINDOW), [sessionId])
  useEffect(() => { if (!plugins.open) setSelectedFile(undefined) }, [plugins.open])
  function openFile(file: ModifiedFile): void {
    setSelectedFile(file)
    if (!plugins.open) plugins.toggle()
  }
  const { visible, hidden } = windowMessages(messages, windowSize)

  /**
   * 现在在等什么 —— 从消息投影里读, 不另存一份状态。
   * 有工具在跑就知道在等工具, 助手还在 streaming 就知道在等模型。
   */
  const waiting = waitingState(messages)

  /**
   * 气泡挂在**最后一条助手消息的头像**上, 不挂输入框。
   *
   * 理由是语义: 说话的是小梦, 气泡就该长在小梦身边。挂在输入框上等于让旁白
   * 离开了说话的人 —— 那条竖轴上一半是用户自己的话, 气泡待在那儿会像在替用户说话。
   *
   * 已知代价: 那条消息很长、头像已经滚出视口时, 气泡也跟着看不见。
   * 我没有让它"找不到头像就飘到别处" —— 会跳位的东西比不显示更让人迷惑。
   * 真到那天要做的是"跟随可视区", 那是另一件事。
   */
  const whisperAnchorId = (() => {
    if (waiting === null) return null
    for (let i = visible.length - 1; i >= 0; i--) {
      const message = visible[i]
      if (message?.role === 'assistant') return message.id
    }
    return null
  })()

  /**
   * 气泡的关键时刻。
   *
   * 默认值来自设置页那三档 (5 / 8 / 12 秒), 但 `?whisper=600` 仍然优先 ——
   * 验收脚本要能在**任何**偏好下把阈值压到 600ms, 否则用户把气泡调成
   * "12 秒"之后, 整套气泡验收会集体超时, 而且看起来像功能坏了。
   * `?whisperHold=` 同理, 用来在几秒内验完"停留 → 淡出 → 消失"。
   */
  const { whisperDelay, whisperHold } = useMemo(() => {
    const num = (name: string, fallback: number): number => {
      try {
        const n = Number(new URLSearchParams(window.location.search).get(name))
        return Number.isFinite(n) && n > 0 ? n : fallback
      } catch {
        return fallback
      }
    }
    return {
      whisperDelay: num('whisper', WHISPER_DELAY_BY_PREF[prefs.whisperWhen]),
      whisperHold: num('whisperHold', WHISPER_HOLD_MS),
    }
  }, [prefs.whisperWhen])

  return (
    <div className={styles.shell}>
      {/* data-density=compact 只作用于这一列: 会话列表天生该紧, 而右边正文要呼吸感。
          密度是继承的 CSS 变量, 写在这里就等于「只让侧栏紧凑」, 不需要全局开关。 */}
      <aside className={styles.sidebar} data-density="compact">
        <div className={styles.sidebarHead}>
          <div className={styles.brandRow}>
            <div className={styles.brandMark} aria-hidden="true">梦</div>
            <div className={styles.brandCopy}>
              <div className={styles.brand}>MENG</div>
              <div className={styles.brandSub}>PERSONAL AGENT</div>
            </div>
          </div>
          {fixture && (
            <div className={styles.badgeRow}>
              <Badge tone="warning">fixture · {fixture}</Badge>
            </div>
          )}
          {/* 插件动作独占自己的一行，主按钮不再和插件入口争抢宽度。 */}
          <div className={styles.headerActions}>
            <Slot name="sidebar.header" props={{ sessionId, onNewSession }} />
          </div>
          {/* 和下面导航共用同一套行高、图标块与毛玻璃表面。 */}
          <Button
            className={styles.newSession}
            variant="ghost"
            size="md"
            onClick={onNewSession}
            data-new-session=""
          >
            <span className={styles.newSessionIcon} aria-hidden="true">
              <PlusIcon />
            </span>
            <span>新会话</span>
          </Button>
        </div>

        <Separator />

        <SidebarNav
          pluginCount={pluginNavCount}
          plugins={plugins}
          Slot={Slot}
          activeView={view}
          onViewChange={onViewChange}
        />

        <ScrollArea className={styles.sessions}>
          <SidebarSessions
            sessions={sessions}
            workspaces={workspaces}
            activeId={view === 'chat' ? sessionId : undefined}
            now={Date.now()}
            onSelect={onSelectSession}
            archivedIds={archivedSessionIds}
            onArchive={onArchiveSession}
            onDelete={onDeleteSession}
            onRename={onRenameSession}
            onNewWorkspace={onNewWorkspace}
            onNewWorkspaceSession={onNewWorkspaceSession}
            Slot={Slot}
          />
        </ScrollArea>

        {/*
          侧栏脚: 插件位 + **设置入口**。
          设置原来只在标题栏右上角那颗齿轮里 —— 那是"全局动作"的位置, 但用户找它
          时会先看左下角（这一屏唯一常驻的导航区）。两个入口指向同一个整窗层,
          不会出现两套设置。
          插件位留在上面: 它还在契约里（docs/08）, 只是 demo-ui 不再往这儿挂东西了。
        */}
        <div className={styles.sidebarFoot}>
          <Slot name="sidebar.footer" props={{ messageCount: messages.length, toolCount, plugins, onOpenSettings }} />
          <button
            type="button"
            className={styles.footSettings}
            onClick={onOpenSettings}
            data-sidebar-settings=""
            title="模型 / 工作区 / 接口密钥 / 外观"
          >
            <span className={styles.footIcon} aria-hidden="true">
              <GearIcon />
            </span>
            设置
          </button>
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.topbar}>
          {/* 内层单独居中: 标题与正文第一条消息左边缘对齐 (App.module.css .topbarInner) */}
          <div className={styles.topbarInner}>
            <div className={styles.topbarTitle}>
              <span className={styles.title}>{view === 'tasks' ? '定时任务' : '会话'}</span>
              {view === 'chat' && sessionId && <span className={styles.sessionId}>{sessionId}</span>}
            </div>
            <div className={styles.topbarRight}>
            {/* 标题栏动作位: 分享 / 导出 / 设置这类全局动作。
                放在状态点**之前** —— 状态是宿主的, 动作是插件的, 插件不该被挤到最右边 */}
            <Slot name="topbar.actions" props={{ sessionId, theme }} />
            <Tooltip label="设置">
              <IconButton aria-label="打开设置" size="sm" onClick={onOpenSettings} data-settings-open="">
                <GearIcon />
              </IconButton>
            </Tooltip>
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
          </div>
        </header>

        {view === 'tasks' ? (
          <div className={styles.taskCenterHost} data-task-view="">{taskCenter}</div>
        ) : (
          <>
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
                {/* 空屏也要有重心: 一句「开始一段对话」孤零零飘在大片空白里, 不像界面 */}
                <div className={styles.emptyMark} aria-hidden="true">梦</div>
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
                <Slot
                  name="home.actions"
                  props={{ sessionId, onOpenSettings, plugins }}
                />
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
              {visible.map((message) => {
                // 同一份公开 props 给插件与内置兜底，避免两边字段慢慢长歪。
                const row: MessageRowApi = {
                  message,
                  Slot,
                  whisper: prefs.whisper && message.id === whisperAnchorId ? waiting : null,
                  whisperDelay,
                  whisperHold,
                  autoFold: prefs.foldTools,
                  readRecord: readToolRecord,
                  readAttachment,
                  onOpenFile: openFile,
                }
                return (
                  <Slot
                    key={message.id}
                    name="conversation.message"
                    props={row}
                    fallback={<MessageRow {...row} />}
                  />
                )
              })}
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
        {/*
          输入区一整块包起来, 只为了给等待气泡一个**定位锚点** ——
          气泡 absolute 在它上方, 不占布局、不挡点击 (样式注释有取舍)。
        */}
        <div className={styles.composerArea}>
          {jobs.length > 0 && <JobTray jobs={jobs} readOutput={jobActions.read} stop={jobActions.stop} />}

          {questionNotice !== undefined && (
            <div className={styles.questionNotice} role="status">
              <span>{questionNotice}</span>
              <button type="button" aria-label="关闭提示" onClick={dismissQuestionNotice}>
                ×
              </button>
            </div>
          )}

          {/*
            提问卡片: 位置在输入框**正上方** —— 它挡着输入框, 注意力本来就在那儿。
            状态归宿主 (事件流), 卡片只管画。**不要按 questionId 重挂**: 卡片自己
            按 questionId 保存每道题的草稿, 在右侧队列里切题时输入不能丢。
          */}
          {question ? <QuestionCard {...question} /> : null}

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
            等太久才说一句。它**不是**主状态: 主状态是工具卡上的真实进度 (read … 3s)。
            气泡挂在助手头像上 (见 MessageRow); 只有消息流里还没有助手消息时才落这里 ——
            刚发出去、模型还没开口, 没有头像可锚, 总比不说一句强。
          */}
          {/*
            关掉的是"冒不冒", 不是"等不等" —— 这个开关不该影响任何真实进度显示。
            挂载层就断开, 而不是挂上去再靠 CSS 藏起来: 藏起来的组件仍然在跑
            250ms 的心跳定时器, 一个假开关顺带烧一份电, 不值得。
          */}
          {prefs.whisper && waiting !== null && whisperAnchorId === null && (
            <WaitBubble state={waiting} anchor="composer" delayMs={whisperDelay} holdMs={whisperHold} />
          )}
        </div>

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
          </>
        )}
      </main>

      {/*
        第三栏: 插件状态面板。
        宽屏 (container >= 1080) 常驻在右侧, 窄屏变成覆盖在正文上的抽屉 ——
        **同一份 DOM, 只切定位方式**, 不是两套组件 (docs/07 F7「布局用 container query, 不做三套」)。
        这跟 composer chain 的处理是同一个原则: 布局变化不该让组件卸载重挂。
      */}
      <div className={styles.panelSlot} data-open={view === 'chat' && plugins.open ? 'true' : 'false'}>
        {view === 'chat' && plugins.open && (
          <div className={styles.rightPanelStack}>
            {selectedFile ? (
              <FileInspector file={selectedFile} onClose={() => { setSelectedFile(undefined); plugins.close() }} />
            ) : (
              <>
                <Slot
                  name="right.panel"
                  props={{ sessionId, onOpenSettings, plugins }}
                />
                <PluginPanel graph={plugins.graph} onRefresh={plugins.refresh} onClose={plugins.close} />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 一条消息。
 *
 * 对话方向明确分层：用户靠右成气泡，梦靠左以正文和结果为主。
 * 执行过程默认折叠成一行“执行过程 · N 步”，最终回复不再被工具日志淹没。
 */
function MessageRow({
  message,
  Slot,
  whisper = null,
  whisperDelay,
  whisperHold,
  autoFold,
  readRecord,
  readAttachment,
  onOpenFile,
}: MessageRowApi) {
  if (message.role === 'system' && message.modelSwitch !== undefined) {
    const change = message.modelSwitch
    return (
      <div className={styles.modelSwitchDivider} data-model-switch={message.id} role="separator">
        <span className={styles.modelSwitchLine} aria-hidden="true" />
        <div className={styles.modelSwitchCopy}>
          <div className={styles.modelSwitchTitle}>
            <span>模型已切换 · 新上下文</span>
            {change.estimatedInputTokens !== undefined && (
              <span className={styles.modelSwitchCost}>额外约 {formatTokens(change.estimatedInputTokens)} input tokens</span>
            )}
          </div>
          <div className={styles.modelSwitchModels}>
            <code>{change.from ?? '默认模型'}</code>
            <span aria-hidden="true">→</span>
            <code>{change.to}</code>
          </div>
          <p>切换前的对话将作为文字参考再次发送，不包含工具日志。</p>
        </div>
        <span className={styles.modelSwitchLine} aria-hidden="true" />
      </div>
    )
  }

  const isUser = message.role === 'user'
  const hasRun = !isUser && (message.steps?.length ?? 0) > 0

  return (
    <div className={`${styles.msg} ${isUser ? styles.msgUser : ''}`} data-message-role={message.role}>
      <div className={styles.role}>
        <span className={isUser ? styles.avatarUser : styles.avatar}>{isUser ? '你' : '梦'}</span>
        {/* 用户的名字不再重复一遍: 头像那个「你」就是名字, 再写一次就成了「你 你」 */}
        {!isUser && <span className={styles.roleName}>助手</span>}
        <span className={styles.meta}>{formatTime(message.at)}</span>
        {whisper && (
          <WaitBubble state={whisper} anchor="avatar" delayMs={whisperDelay} holdMs={whisperHold} />
        )}
      </div>

      {/*
        工具区接 compact 密度: 工具输出天生是"机器产物", 一行一条、越紧越好读;
        而正文需要呼吸感。密度是继承的 CSS 变量, 写在这一层只影响工具卡。
      */}
      {hasRun && onOpenFile ? (
        <RunTimeline
          message={message}
          autoFold={autoFold}
          readRecord={readRecord}
          Slot={Slot}
          onOpenFile={onOpenFile}
        />
      ) : message.tools.length > 0 && (
        <details className={styles.toolsDetails} data-density="compact" open={message.tools.some((tool) => tool.status === 'running')}>
          <summary className={styles.chainHead}>
            <span>执行过程</span>
            <span>· {message.tools.length} 步</span>
            <span className={styles.chainStatus}>
              {message.tools.some((tool) => tool.status === 'running') ? '进行中' : '已完成'}
            </span>
          </summary>
          <div className={styles.tools}>
            {message.tools.map((tool) => {
              const card: ToolCardApi = { tool, autoFold, readRecord }
              return (
                <Slot
                  key={tool.callId}
                  name="conversation.tool"
                  props={card}
                  fallback={<ToolCard {...card} />}
                />
              )
            })}
          </div>
        </details>
      )}

      {message.attachments !== undefined && message.attachments.length > 0 && (
        <div className={styles.messageAttachments} aria-label="消息附件">
          {message.attachments.map((attachment) => (
            <MessageAttachmentCard key={attachment.id} attachment={attachment} readAttachment={readAttachment} />
          ))}
        </div>
      )}

      {(!hasRun || message.status !== 'streaming') && (message.text || message.status === 'streaming') && (
        <div className={isUser ? styles.bodyUser : styles.body}>
          {/*
            助手的话过完整 Markdown, 用户的话只做裸链接识别 —— 不擅自解释用户输入里的 * / #。
            不是双标: 模型输出里 `**`、`-`、``` 是它表达结构的正常方式; 而用户
            手打的一句话里出现星号, 多半就是想打一个星号。
            光标由 Markdown 内部挂到最后一个块里 —— 挂在外面会掉到下一行。
          */}
          {isUser ? <AutolinkText text={message.text} /> : <Markdown text={message.text} caret={message.status === 'streaming'} />}
          {isUser && message.status === 'streaming' && <span className={styles.caret} aria-hidden="true" />}
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

function MessageAttachmentCard({
  attachment,
  readAttachment,
}: {
  attachment: NonNullable<Message['attachments']>[number]
  readAttachment?: (attachmentId: string) => Promise<{ id: string; mime: string; dataBase64: string }>
}) {
  const [loaded, setLoaded] = useState<{ mime: string; dataBase64: string } | undefined>(
    attachment.dataBase64 === undefined ? undefined : { mime: attachment.mime, dataBase64: attachment.dataBase64 },
  )

  useEffect(() => {
    if (loaded !== undefined || readAttachment === undefined) return
    let alive = true
    void readAttachment(attachment.id)
      .then((content) => {
        if (alive) setLoaded(() => ({ mime: content.mime, dataBase64: content.dataBase64 }))
      })
      .catch(() => {
        // 附件被清理 / 老后端没有 op：保留文件名卡，不把一条历史消息炸掉。
      })
    return () => {
      alive = false
    }
  }, [attachment.id, loaded, readAttachment])

  return (
    <div className={styles.messageAttachment} data-message-attachment={attachment.id}>
      {loaded !== undefined ? (
        <img src={`data:${loaded.mime};base64,${loaded.dataBase64}`} alt="" />
      ) : (
        <span aria-hidden="true">图</span>
      )}
      <b>{attachment.name}</b>
    </div>
  )
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
  return String(value)
}

function formatTime(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
