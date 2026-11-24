/**
 * 输入框下面那一条：工作区 / 权限 / git ‖ ＋ / 模型 ······ 上下文。
 *
 * 全部**受控**：状态在宿主（App），这里只画和转发。理由和 `ComposerApi` 里那条一样 ——
 * 输入框是可被插件替换的，组件自己藏状态的话，换掉它就等于把这些选择一起丢了。
 *
 * ── 为什么分两组（2026-11-17 重排）──
 * 上一版是「左边三个、右边三个」，六颗胶囊平均摊在一条线上：没有分界，眼睛
 * 扫过去是一片同重量的灰字，用户原话是"挤在一起有点丑"。这一版按**语义**分组：
 *
 *   环境  工作区 · 权限 · git         "这段会话在哪儿、能干什么"
 *   ‖
 *   设置  模型                        "这一次用哪个脑子"
 *   状态  ▬ 18K / 125K                "已经花了多少"  ← 靠右，它是读数不是开关
 *
 * 组间一条 1px 竖线，组内 2px、组间 8px —— 分组靠**间距和分隔线**表达，
 * 不靠再加一层容器背景（那会让这一条比输入框还重）。
 *
 * ＋ 不在这里：它挪到了输入框最左侧（`ComposerPlus.tsx`）。它属于"往这条消息
 * 里加东西"，不属于"这段会话在什么环境里跑"。
 *
 * ── 一条贯穿全文件的规矩：**没有数据就不画** ──
 * 工作区列表、git 状态、上下文用量分别来自不同接口，老内核可能只给一部分。
 * 拿不到时这一格**直接不渲染**，而不是画一个"未连接 / 未知"的灰条：
 * 灰条会让人以为功能坏了，而它其实只是还没有数据。
 *
 * ── 普通任务与工作区会话必须分开 ──
 * 顶栏“新会话”是普通任务，不出现目录选择。只有从某个工作区的 `＋` 进入时，
 * 才显示目录归属；第一句话发出去后它也会收起，会话固定挂到那个工作区下面。
 *
 * 弹层是自己写的（`Popover`），因为 `@meng/ui` 里没有 Menu/Popover —— 引一个
 * 带定位引擎的库为这六个小弹层不值当。这里只需要"贴着按钮上方、点外面关、Esc 关"。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'

import { ChevronIcon, FolderIcon, ShieldIcon, BranchIcon } from './icons.tsx'
import { ContextPanel } from './ContextPanel.tsx'
import { PermissionWarningDialog } from './PermissionWarningDialog.tsx'
import { workspaceLabelOf, type Workspace } from './workspaces.ts'
import styles from './ComposerBar.module.css'

import type { ComposerControls, ComposerModelGroup, ComposerModelInfo } from './layout.ts'

type Menu = 'workspace' | 'permission' | 'model' | 'effort' | 'context'

export function ComposerBar({ controls }: { controls: ComposerControls }) {
  const [open, setOpen] = useState<Menu>()
  const [fullPermissionWarning, setFullPermissionWarning] = useState(false)
  const [hoveredModel, setHoveredModel] = useState<{ group: ComposerModelGroup; model: ComposerModelInfo }>()
  const hoverArmed = useRef(false)
  const root = useRef<HTMLDivElement>(null)

  // 菜单刚展开时鼠标可能正好落在某一项上，不能把那次误当成“用户悬停”。
  useEffect(() => {
    if (open !== 'model') return
    const timer = window.setTimeout(() => { hoverArmed.current = true }, 80)
    return () => window.clearTimeout(timer)
  }, [open])

  // 点外面 / Esc 关。挂在 document 上而不是 onBlur: 弹层里的按钮点下去时
  // 输入框会先失焦，用 blur 关会在点击生效之前就把它卸掉
  useEffect(() => {
    if (open === undefined) return
    const onDown = (e: MouseEvent): void => {
      if (root.current !== null && !root.current.contains(e.target as Node)) setOpen(undefined)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(undefined)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = (menu: Menu): void => setOpen((cur) => (cur === menu ? undefined : menu))

  const workspaceLabel = workspaceLabelOf(controls.workspaceId, controls.workspaces)
  const permissionLabel =
    controls.permissionOptions.find((o) => o.value === controls.permission)?.label ?? controls.permission

  const showWorkspace = controls.canPickWorkspace
  const showPermission = controls.permissionOptions.length > 0
  const showModel = controls.models.length > 0
  // 兼容还没有 modelGroups 的老 composer 插件：把扁平列表当成一个兜底组。
  const modelGroups: ComposerModelGroup[] = controls.modelGroups ?? [{
    id: 'default',
    name: '可用模型',
    models: controls.models.map((id) => ({ id })),
  }]
  // 空组会留下一条悬空的分隔线，所以"有没有内容"要先算出来
  const showEnv = showWorkspace || showPermission || controls.git !== undefined
  const showTail = controls.contextStatus !== undefined || controls.context !== undefined || controls.contextPending === true || controls.contextLoading === true

  return (
    <div className={styles.bar} ref={root} data-composer-bar="">
      <div className={styles.group} data-group="env">
        {showWorkspace && (
          <span className={styles.anchor}>
            <Chip
              icon={<FolderIcon />}
              label={workspaceLabel}
              active={open === 'workspace'}
              onClick={() => toggle('workspace')}
              data-chip="workspace"
              title="这段会话在哪个目录里跑（开始对话后不能再改）"
            />
            {open === 'workspace' && (
              <Popover>
                <WorkspaceMenu
                  controls={controls}
                  onPick={(id) => (controls.setWorkspace(id), setOpen(undefined))}
                  onClose={() => setOpen(undefined)}
                />
              </Popover>
            )}
          </span>
        )}

        {showPermission && (
          <span className={styles.anchor}>
            <Chip
              icon={<ShieldIcon />}
              label={permissionLabel}
              active={open === 'permission'}
              onClick={() => toggle('permission')}
              data-chip="permission"
              title="危险操作要问、还是直接放行"
            />
            {open === 'permission' && (
              <Popover>
                <div className={styles.menu} role="menu" data-menu="permission">
                  {controls.permissionOptions.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={o.value === controls.permission}
                      className={styles.menuItem}
                      data-permission={o.value}
                      onClick={() => {
                        if (o.value === 'full') {
                          setOpen(undefined)
                          setFullPermissionWarning(true)
                          return
                        }
                        controls.setPermission(o.value)
                        setOpen(undefined)
                      }}
                    >
                      <span className={styles.check}>{o.value === controls.permission ? '✓' : ''}</span>
                      {o.label}
                    </button>
                  ))}
                  <p className={styles.menuNote}>改的是全局设置，下一次工具调用生效。</p>
                </div>
              </Popover>
            )}
          </span>
        )}

        {controls.git !== undefined && (
          <span className={styles.git} data-git={controls.git.dirty ? 'dirty' : 'clean'} title="工作区目录的 git 状态">
            <BranchIcon />
            <span className={styles.gitName}>{controls.git.branch ?? 'git'}</span>
            {controls.git.dirty === true && <span className={styles.gitDirty} title="有未提交的改动" />}
          </span>
        )}
      </div>


      {showTail && (
        <div className={styles.tail}>
          <span className={styles.anchor}>
            <ContextMeter
              status={controls.contextStatus}
              legacy={controls.context}
              pending={controls.contextPending === true}
              loading={controls.contextLoading === true}
              active={open === 'context'}
              onClick={() => toggle('context')}
            />
            {open === 'context' && controls.contextStatus !== undefined && (
              <Popover align="right" context>
                <ContextPanel
                  status={controls.contextStatus}
                  {...(controls.compactContext === undefined ? {} : { compact: controls.compactContext })}
                  onClose={() => setOpen(undefined)}
                />
              </Popover>
            )}
          </span>
        </div>
      )}

      {/* 模型组是最后一组，和发送键相邻；上下文读数在它左边。 */}
      {showEnv && showModel && <span className={styles.sep} aria-hidden="true" />}

      <div className={styles.group} data-group="model">
        {showModel && (
          <>
          <span className={styles.anchor}>
            <Chip
              label={controls.model ?? '默认模型'}
              active={open === 'model'}
              onClick={() => {
                // 先关掉悬停判定，等菜单稳定后再允许；否则菜单在鼠标下展开会
                // 直接冒出一张用户没主动看的信息卡。
                hoverArmed.current = false
                setHoveredModel(undefined)
                toggle('model')
              }}
              data-chip="model"
              title="这一轮用哪个模型"
              mono
            />
            {open === 'model' && (
              <Popover wide>
                <div className={`${styles.menu} ${styles.modelMenu}`} role="menu" data-menu="model">
                  <div className={styles.modelListPane}>
                    <div className={styles.menuScroll}>
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={controls.model === undefined}
                        className={styles.menuItem}
                        onClick={() => {
                          controls.setModel(undefined)
                          setOpen(undefined)
                        }}
                      >
                        <span className={styles.check}>{controls.model === undefined ? '✓' : ''}</span>
                        默认（由内核决定）
                      </button>
                      {modelGroups.map((group) => (
                        <section key={group.id} className={styles.modelGroup} data-model-group={group.id}>
                          <div className={styles.providerHead}>
                            <span className={styles.providerBadge} aria-hidden="true">{group.name.slice(0, 1)}</span>
                            <span className={styles.providerName}>{group.name}</span>
                          </div>
                          {group.models.map((m) => (
                            <button
                              key={`${group.id}:${m.id}`}
                              type="button"
                              role="menuitemradio"
                              aria-checked={m.id === controls.model}
                              className={styles.menuItem}
                              data-model-option={m.id}
                              data-model-provider={group.id}
                              onMouseEnter={() => {
                                if (hoverArmed.current) setHoveredModel({ group, model: m })
                              }}
                              onFocus={() => {
                                if (hoverArmed.current) setHoveredModel({ group, model: m })
                              }}
                              onMouseLeave={() => setHoveredModel(undefined)}
                              onClick={() => {
                                controls.setModel(m.id)
                                setOpen(undefined)
                              }}
                            >
                              <span className={styles.check}>{m.id === controls.model ? '✓' : ''}</span>
                              <code className={styles.modelId}>{m.id}</code>
                            </button>
                          ))}
                        </section>
                      ))}
                    </div>
                  </div>
                  <ModelInfoCard hovered={hoveredModel} />
                </div>
              </Popover>
            )}
          </span>

          <span className={styles.anchor}>
            <Chip
              label={controls.reasoningEffort ?? 'Thinking'}
              active={open === 'effort'}
              onClick={() => toggle('effort')}
              data-chip="effort"
              title="Applied to each message. Default inherits model settings."
            />
            {open === 'effort' && (
              <Popover>
                <div className={styles.menu} role="menu" data-menu="effort">
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={controls.reasoningEffort === undefined}
                    className={styles.menuItem}
                    data-effort-default=""
                    onClick={() => {
                      controls.setReasoningEffort(undefined)
                      setOpen(undefined)
                    }}
                  >
                    <span className={styles.check}>{controls.reasoningEffort === undefined ? '✓' : ''}</span>
                    Default{controls.defaultReasoningEffort ? ` (${controls.defaultReasoningEffort})` : ''}
                  </button>
                  {controls.reasoningEffortOptions.map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="menuitemradio"
                      aria-checked={option === controls.reasoningEffort}
                      className={styles.menuItem}
                      data-effort-option={option}
                      onClick={() => {
                        controls.setReasoningEffort(option)
                        setOpen(undefined)
                      }}
                    >
                      <span className={styles.check}>{option === controls.reasoningEffort ? '✓' : ''}</span>
                      <code className={styles.modelId}>{option}</code>
                    </button>
                  ))}
                  <p className={styles.menuNote}>
                    {controls.reasoningEffortOptions.length > 0
                      ? 'Applied to each message. Options come from the current model.'
                      : 'This model has not reported reasoning effort options. Default remains available.'}
                  </p>
                </div>
              </Popover>
            )}
          </span>
          </>
        )}
      </div>

      <PermissionWarningDialog
        open={fullPermissionWarning}
        onCancel={() => setFullPermissionWarning(false)}
        onConfirm={() => {
          controls.setPermission('full')
          setFullPermissionWarning(false)
        }}
      />
    </div>
  )
}

function Chip({
  icon,
  label,
  active,
  onClick,
  title,
  mono = false,
  ...rest
}: {
  icon?: ReactNode
  label: string
  active: boolean
  onClick: () => void
  title?: string
  mono?: boolean
  'data-chip'?: string
}) {
  return (
    <button
      type="button"
      className={styles.chip}
      data-active={active ? '' : undefined}
      onClick={onClick}
      title={title}
      {...rest}
    >
      {icon !== undefined && <span className={styles.chipIcon}>{icon}</span>}
      <span className={mono ? styles.chipMono : styles.chipLabel}>{label}</span>
      <span className={styles.chipChev} aria-hidden="true">
        <ChevronIcon />
      </span>
    </button>
  )
}

/**
 * 上下文用量。
 *
 * 只画**已知**的部分: 知道窗口多大才画进度条，只知道用了多少就只写数字。
 * 拿"默认 262144"去凑一个百分比是在编数据 —— 用户会拿它判断"还能不能再塞一段长代码"。
 */
function ContextMeter({
  status,
  legacy,
  pending,
  loading,
  active,
  onClick,
}: {
  status?: { usedTokens: number; contextWindow?: number; thresholdTokens?: number }
  legacy?: { used: number; total?: number }
  pending: boolean
  loading: boolean
  active: boolean
  onClick: () => void
}) {
  const used = status?.usedTokens ?? legacy?.used ?? 0
  const total = status?.contextWindow ?? legacy?.total
  const pct = total !== undefined && total > 0 ? Math.min(100, Math.round((used / total) * 100)) : undefined
  const high = status?.thresholdTokens === undefined ? (pct ?? 0) >= 85 : used >= status.thresholdTokens
  const unavailable = pending || loading
  return (
    <button
      type="button"
      className={styles.context}
      data-context={unavailable ? 'pending' : pct === undefined ? 'used' : high ? 'high' : 'ok'}
      data-context-button=""
      data-active={active ? '' : undefined}
      disabled={unavailable}
      aria-haspopup="dialog"
      aria-expanded={active}
      title={pending ? '发送第一条消息后可查看上下文' : loading ? '正在读取上下文状态' : `当前上下文约 ${used} / ${total} tokens；包含系统提示、工具说明和会话历史`}
      onClick={onClick}
    >
      <span className={styles.contextLabel}>上下文</span>
      {pct !== undefined && !unavailable && (
        <span className={styles.contextTrack} aria-hidden="true">
          <span className={styles.contextFill} style={{ width: `${pct}%` }} />
        </span>
      )}
      <span className={styles.contextText}>
        {pending ? '发送后可用' : loading ? '读取中' : `${formatTokens(used)}${total !== undefined ? ` / ${formatTokens(total)}` : ''}`}
      </span>
      {!unavailable && <span className={styles.contextChev} aria-hidden="true"><ChevronIcon /></span>}
    </button>
  )
}

/** `12345` → `12.1K`。和设置页那份同一个口径（1024 进制），但这里只用于"粗略看一眼" */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`
  if (n >= 1000) return `${Math.round(n / 1024)}K`
  return String(n)
}

/**
 * 弹层。**没有关闭按钮** —— 点外面和 Esc 都能关，而右上角那个 × 会和第一项
 * 右边的「待接」标签抢同一个角落（试过，两个东西叠在一起）。
 * 菜单类浮层的通行做法本来也不是给它一个 ×。
 *
 * 它是 `.anchor` 的子元素而不是 `.bar` 的：弹层要**长在触发它的那颗胶囊上方**，
 * 挂在这一条上就只能对齐到最左或最右 —— 模型那颗在中间时，菜单会飘到工作区底下。
 */
function Popover({ children, wide = false, align = 'left', context = false }: { children: ReactNode; wide?: boolean; align?: 'left' | 'right'; context?: boolean }) {
  return (
    <div className={`${styles.pop}${wide ? ` ${styles.popWide}` : ''}${align === 'right' ? ` ${styles.popRight}` : ''}${context ? ` ${styles.popContext}` : ''}`} role="presentation">
      {children}
    </div>
  )
}

/** 只有鼠标停在模型上时才出现；没有悬停就不渲染卡片。 */
function ModelInfoCard({ hovered }: { hovered?: { group: ComposerModelGroup; model: ComposerModelInfo } }) {
  if (hovered === undefined) return null
  const { group, model } = hovered
  return (
    <aside className={styles.modelInfo} data-model-info="" data-model-info-provider={group.id}>
      <div className={styles.modelInfoHead}>
        <span className={styles.modelInfoProvider}>{group.name}</span>
        <span className={styles.modelInfoName}>{model.name || model.id}</span>
        <code className={styles.modelInfoId}>{model.id}</code>
      </div>
      <dl className={styles.modelInfoFacts}>
        <div>
          <dt>上下文</dt>
          <dd>{tokenText(model.contextWindow)}</dd>
        </div>
        <div>
          <dt>最大输出</dt>
          <dd>{tokenText(model.maxTokens)}</dd>
        </div>
        <div>
          <dt>输入</dt>
          <dd>{modalityText(model.input)}</dd>
        </div>
        <div>
          <dt>推理</dt>
          <dd>{model.reasoning === true ? '支持' : model.reasoning === false ? '不支持' : '未声明'}</dd>
        </div>
        {model.reasoningEfforts && model.reasoningEfforts.length > 0 ? (
          <div>
            <dt>思考档</dt>
            <dd>{model.reasoningEfforts.join(' / ')}{model.defaultReasoningEffort ? ` · 默认 ${model.defaultReasoningEffort}` : ''}</dd>
          </div>
        ) : null}
        {group.modelSource ? (
          <div>
            <dt>来源</dt>
            <dd>{sourceText(group.modelSource)}</dd>
          </div>
        ) : null}
      </dl>
    </aside>
  )
}

function tokenText(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '未声明'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}K`
  return String(value)
}

function modalityText(value: Array<'text' | 'image'> | undefined): string {
  if (value === undefined || value.length === 0) return '未声明'
  return value.map((v) => (v === 'image' ? '图像' : '文本')).join(' / ')
}

function sourceText(value: string): string {
  return ({ catalog: '内置目录', endpoint: '厂商实时', manual: '手动配置', error: '拉取失败' } as Record<string, string>)[value] ?? value
}

function WorkspaceMenu({
  controls,
  onPick,
  onClose,
}: {
  controls: ComposerControls
  onPick: (id?: string) => void
  /** 工作区会话只能在工作区列表内切换，不能切成普通任务。 */
  onClose: () => void
}) {
  const [q, setQ] = useState('')

  const needle = q.trim().toLowerCase()
  const list = controls.workspaces.filter(
    (w) => needle === '' || w.name.toLowerCase().includes(needle) || w.path.toLowerCase().includes(needle),
  )

  return (
    <div className={styles.menu} data-menu="workspace">
      {controls.workspaces.length > 6 && (
        <input
          className={styles.search}
          value={q}
          placeholder="搜索工作区"
          autoFocus
          onChange={(e) => setQ(e.target.value)}
        />
      )}
      <div className={styles.menuScroll}>
        {list.map((w) => (
          <button
            key={w.id}
            type="button"
            role="menuitemradio"
            aria-checked={w.id === controls.workspaceId}
            className={styles.menuItem}
            data-workspace-option={w.id}
            title={w.path}
            onClick={() => onPick(w.id)}
          >
            <span className={styles.check}>{w.id === controls.workspaceId ? '✓' : ''}</span>
            <span className={styles.wsName}>{w.name}</span>
          </button>
        ))}
        {list.length === 0 && <p className={styles.menuNote}>没有匹配的工作区</p>}
      </div>
      <div className={styles.menuSep} />

      <button
        type="button"
        className={styles.menuItem}
        data-workspace-create=""
        onClick={() => {
          onClose()
          controls.openWorkspacePicker()
        }}
      >
        <span className={styles.check}>＋</span>
        新建工作区
      </button>

      {/*
        一句必须说清的话（B-28 的边界）：目录目前只是**归属标记**，
        工具仍然在 `sandbox.root` 里读写。不说的话，用户会以为"在项目 A 里开的会话
        只会动 A"，而它可能动的是别处 —— 这是会弄坏东西的误解。
      */}
      <p className={styles.menuNote}>目录目前只标归属：工具仍在设置页那个「工作区根目录」里跑。</p>
    </div>
  )
}
