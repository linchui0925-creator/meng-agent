import * as React from 'react'
import css from './collab.css?inline'

declare const __MENG_LOADER__: { load(spec: { id: string; factory: () => unknown }): void }

interface Transport {
  invoke<T = unknown>(op: string, payload?: unknown): Promise<T>
  subscribe(fn: (event: { type: string; sessionId?: string }) => void): () => void
}
interface Slots { register(pluginId: string, reg: { name: string; component: unknown; order?: number; meta?: unknown }): () => void }
interface ClientCtx { get(name: string): unknown }
type Tab = 'plan' | 'todo' | 'goal' | 'agents'
type TodoStatus = 'pending' | 'in_progress' | 'completed'
interface TodoItem { content: string; status: TodoStatus }
interface Goal {
  id: string
  revision: number
  objective: string
  phase: 'active' | 'paused' | 'completed' | 'blocked'
  roundsStarted: number
  maxGoalRounds: number
  blockedReason?: string
}
interface RunInfo { id: string; sessionId: string; startedAt: number; running: boolean }
interface CollabProps {
  sessionId?: string
  busy?: boolean
  ensureSession?: (title?: string) => Promise<string>
}

const ID = 'collab-ui'

__MENG_LOADER__.load({
  id: ID,
  factory: () => ({
    inject: ['slots', 'transport'],
    apply(ctx: ClientCtx): () => void {
      const slots = ctx.get('slots') as Slots | undefined
      const transport = ctx.get('transport') as Transport | undefined
      if (!slots) throw new Error('collab-ui 需要 slots')
      const style = document.createElement('style')
      style.dataset.plugin = ID
      style.textContent = css
      document.head.appendChild(style)
      const off = slots.register(ID, {
        name: 'composer.tools',
        component: (props: CollabProps) => (
          <CollabMenu transport={transport} sessionId={props.sessionId} busy={props.busy} ensureSession={props.ensureSession} />
        ),
        order: 10,
        meta: { label: '协作', group: '协作', origin: 'builtin' },
      })
      return () => { off(); style.remove() }
    },
  }),
})

function CollabMenu({ transport, sessionId, busy, ensureSession }: CollabProps & { transport?: Transport }) {
  const [open, setOpen] = React.useState(false)
  const [tab, setTab] = React.useState<Tab>('plan')
  const [planActive, setPlanActive] = React.useState(false)
  const [todos, setTodos] = React.useState<TodoItem[]>([])
  const [goal, setGoal] = React.useState<Goal>()
  const [runs, setRuns] = React.useState<RunInfo[]>([])
  const [working, setWorking] = React.useState(false)
  const root = React.useRef<HTMLDivElement>(null)
  const resolvedSession = React.useRef<string | undefined>(sessionId)

  React.useEffect(() => { resolvedSession.current = sessionId }, [sessionId])

  const load = React.useCallback(() => {
    if (!transport || !sessionId) {
      setPlanActive(false)
      setTodos([])
      setGoal(undefined)
      setRuns([])
      return
    }
    void Promise.all([
      transport.invoke<{ active?: boolean }>('plan.status', { sessionId }),
      transport.invoke<{ todos?: TodoItem[] }>('todo.status', { sessionId }),
      transport.invoke<{ goal?: Goal | null }>('goal.status', { sessionId }),
      transport.invoke<{ runs?: RunInfo[] }>('subagent.status', { sessionId }),
    ]).then(([plan, todo, goalResult, agent]) => {
      setPlanActive(plan.active === true)
      setTodos(todo.todos ?? [])
      setGoal(goalResult.goal ?? undefined)
      setRuns((agent.runs ?? []).filter((run) => run.running))
    }).catch(() => {
      setPlanActive(false)
      setTodos([])
      setGoal(undefined)
      setRuns([])
    })
  }, [transport, sessionId])

  React.useEffect(load, [load])

  React.useEffect(() => {
    if (!transport || !sessionId) return
    return transport.subscribe((event) => {
      if (event.sessionId !== sessionId) return
      if (
        event.type === 'plan/mode' || event.type === 'plan/submitted' ||
        event.type === 'todo/write' || event.type === 'goal/change' ||
        event.type === 'subagent/started' || event.type === 'subagent/completed'
      ) load()
    })
  }, [transport, sessionId, load])

  React.useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const completed = todos.filter((item) => item.status === 'completed').length
  const activeRuns = runs.length
  const activeLabel = planActive ? 'Plan' : goal?.phase === 'active' ? 'Goal' : todos.length > 0 ? `Todo ${completed}/${todos.length}` : activeRuns > 0 ? '子智能体' : '协作'
  const hasActivity = planActive || todos.length > 0 || goal !== undefined || activeRuns > 0

  async function sid(): Promise<string | undefined> {
    const current = resolvedSession.current
    if (current) return current
    const created = await ensureSession?.('协作任务')
    if (created) resolvedSession.current = created
    return created
  }

  async function togglePlan() {
    if (!transport || working) return
    setWorking(true)
    try {
      const target = await sid()
      if (!target) return
      await transport.invoke('plan.set', { sessionId: target, active: !planActive })
      setPlanActive((value) => !value)
      setOpen(false)
    } finally {
      setWorking(false)
    }
  }

  async function controlGoal(action: 'pause' | 'resume' | 'complete') {
    if (!transport || !sessionId || working) return
    setWorking(true)
    try {
      await transport.invoke('goal.control', { sessionId, action })
      load()
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="collab-root" ref={root}>
      <button
        type="button"
        className="collab-trigger"
        data-active={hasActivity ? 'true' : 'false'}
        aria-haspopup="menu"
        aria-expanded={open}
        title="计划、待办、长期目标和子智能体"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="collab-symbol" aria-hidden="true"><i /><i /><i /></span>
        <span>{activeLabel}</span>
        <span className="collab-chevron" aria-hidden="true">⌄</span>
      </button>

      {open && (
        <div className="collab-pop" role="menu">
          <div className="collab-tabs" role="tablist" aria-label="协作类型">
            <TabButton value="plan" selected={tab} set={setTab} label="Plan" />
            <TabButton value="todo" selected={tab} set={setTab} label="Todo" count={todos.length ? `${completed}/${todos.length}` : undefined} />
            <TabButton value="goal" selected={tab} set={setTab} label="Goal" dot={goal?.phase === 'active'} />
            <TabButton value="agents" selected={tab} set={setTab} label="子智能体" count={activeRuns ? String(activeRuns) : undefined} />
          </div>

          {tab === 'plan' && (
            <div className="collab-panel">
              <div className="collab-row">
                <div>
                  <strong>{planActive ? 'Plan 模式开启' : '先规划再执行'}</strong>
                  <p>{planActive ? '当前只调研，方案批准后才退出。' : '进入后会先出完整方案，等你批准。'}</p>
                </div>
                <button type="button" className="collab-primary" disabled={working || busy} onClick={() => void togglePlan()}>
                  {planActive ? '退出' : '进入'}
                </button>
              </div>
            </div>
          )}

          {tab === 'todo' && (
            <div className="collab-panel">
              {todos.length === 0 ? <Empty text="当前还没有执行清单" /> : (
                <>
                  <div className="collab-summary"><strong>{completed}/{todos.length}</strong><span>已完成</span></div>
                  <ol className="collab-todos">
                    {todos.map((item) => (
                      <li key={item.content} data-status={item.status}>
                        <span aria-hidden="true">{item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '•' : ''}</span>
                        <span>{item.content}</span>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          )}

          {tab === 'goal' && (
            <div className="collab-panel">
              {goal ? (
                <>
                  <div className="collab-summary"><strong>{goal.roundsStarted}/{goal.maxGoalRounds}</strong><span>{phaseLabel(goal.phase)}</span></div>
                  <p className="collab-objective">{goal.objective}</p>
                  {goal.blockedReason && <p className="collab-reason">{goal.blockedReason}</p>}
                  <div className="collab-actions">
                    {goal.phase === 'active' && <button type="button" disabled={working} onClick={() => void controlGoal('pause')}>暂停</button>}
                    {(goal.phase === 'paused' || goal.phase === 'blocked') && <button type="button" disabled={working} onClick={() => void controlGoal('resume')}>继续</button>}
                    {goal.phase === 'active' && <button type="button" disabled={working} onClick={() => void controlGoal('complete')}>完成</button>}
                  </div>
                </>
              ) : <Empty text="当前没有长期目标" />}
            </div>
          )}

          {tab === 'agents' && (
            <div className="collab-panel">
              {activeRuns.length === 0 ? <Empty text="当前没有运行中的子智能体" /> : (
                <>
                  <div className="collab-summary"><strong>{activeRuns.length}</strong><span>个独立会话运行中</span></div>
                  <div className="collab-agent-list">{activeRuns.map((run) => <div key={run.id}>子智能体 · {run.sessionId.slice(-8)}</div>)}</div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TabButton({ value, selected, set, label, count, dot }: {
  value: Tab
  selected: Tab
  set: (value: Tab) => void
  label: string
  count?: string
  dot?: boolean
}) {
  return (
    <button type="button" role="tab" aria-selected={selected === value} data-active={selected === value ? 'true' : 'false'} onClick={() => set(value)}>
      {label}{count ? <span>{count}</span> : null}{dot ? <i aria-hidden="true" /> : null}
    </button>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="collab-empty">{text}</p>
}

function phaseLabel(phase: Goal['phase']): string {
  if (phase === 'active') return '自动续轮'
  if (phase === 'paused') return '已暂停'
  if (phase === 'completed') return '已完成'
  return '已阻塞'
}
