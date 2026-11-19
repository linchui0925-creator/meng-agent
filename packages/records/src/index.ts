/**
 * @meng/records —— 工具调用的**完整记录**（本地 SQLite）。
 *
 * ## 为什么这里用 SQLite, 而会话仍然用 JSONL
 *
 * 两者存的是**两种东西**:
 *
 *   · 会话事件流 = 真相源。只追加、可回放、是"发生了什么"的唯一账本
 *   · 工具记录   = 附属数据。可丢、可清、要按会话/工具查、要能统计
 *
 * 把工具输出塞进事件流会毁掉第一条: 一次 bash 的完整 stdout 可能几 MB,
 * 而"回放"要把它们全读一遍才能算出 seq。现在事件流里只留 2000 字回显 + 一个
 * `recordId`, 全文在这张表里 —— 要看的时候按 id 取。
 *
 * ## 三层分离
 *
 * 一次工具调用的结果有三个消费者, 它们要的东西不一样:
 *
 *   | 层 | 谁看 | 存在哪 |
 *   |---|---|---|
 *   | `text`（render） | **模型** | 事件流里截断的那份 + 这里全文 |
 *   | `value`（canonical） | 代码（后续处理 / 断言） | 只有这里 |
 *   | `presentation` | **界面**（摘要、耗时、字节数） | 只有这里 |
 *
 * 以前只有一个 `text` 字符串: 界面想显示"读了多少行"只能去正则解析那段文本
 * (前端确实这么干了, 见 `toolSummary`)。那是**从给人看的文字里反推结构**,
 * 文字一改就静默失效。
 *
 * ## 为什么是 `node:sqlite` 而不是 better-sqlite3
 *
 * 零原生依赖、随 Node 走、不需要编译。代价是它标记为实验特性 (22 上会打一行
 * warning), API 可能变 —— 所以**只有本文件认识 SQL**, 外面看到的全是普通对象。
 * 换实现只改这一个文件。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defineInvariant, type Ctx, type Disposer } from '@meng/core'

export const RECORDS_CAPABILITY = 'records'

/** 一次工具调用的三层结果 + 上下文 */
export interface ToolRecordInput {
  sessionId?: string
  runId?: string
  /** 模型给的调用 id。**不是主键** —— 同一个 id 在不同会话里可能重复 */
  callId: string
  tool: string
  args?: unknown
  ok: boolean
  error?: string
  /** 层 1: 给模型看的文本（render 层） */
  text: string
  /** 层 2: 结构化真值。工具没给就是 undefined */
  value?: unknown
  /** 层 3: 界面渲染用的元信息 */
  presentation?: Record<string, unknown>
  startedAt: number
  finishedAt: number
}

export interface ToolRecord extends ToolRecordInput {
  id: string
  /** `text` 的字节数。事件流里截断了, 这里才是真的 */
  bytes: number
}

/** 列表用的轻量行: **不带 text** —— 列表页不需要几 MB 正文 */
export interface ToolRecordMeta {
  id: string
  sessionId?: string
  callId: string
  tool: string
  ok: boolean
  bytes: number
  startedAt: number
  finishedAt: number
}

export interface ToolStat {
  tool: string
  count: number
  lastAt: number
}

export interface RecordStore {
  put(input: ToolRecordInput): string
  get(id: string): ToolRecord | undefined
  list(opts?: { sessionId?: string; tool?: string; limit?: number }): ToolRecordMeta[]
  /** 每个工具用过几次、最后一次什么时候 —— 工具开关那张表的数据源 */
  stats(): ToolStat[]
  close(): void
}

interface Row {
  id: string
  session_id: string | null
  run_id: string | null
  call_id: string
  tool: string
  args: string | null
  ok: number
  error: string | null
  text: string
  value: string | null
  presentation: string | null
  bytes: number
  started_at: number
  finished_at: number
}

/**
 * 打开一个记录库。`':memory:'` 是合法路径 —— 自检用它, 不去碰用户的真文件。
 *
 * 表结构在打开时建 (`if not exists`), 没有迁移框架: 这张表是**可丢的附属数据**,
 * 将来真需要加列, 加一列默认值比写一套迁移便宜。真相源不在这里。
 */
export function createRecordStore(file: string): RecordStore {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)

  db.exec(`
    create table if not exists tool_calls (
      id           text primary key,
      session_id   text,
      run_id       text,
      call_id      text not null,
      tool         text not null,
      args         text,
      ok           integer not null,
      error        text,
      text         text not null,
      value        text,
      presentation text,
      bytes        integer not null,
      started_at   integer not null,
      finished_at  integer not null
    );
    create index if not exists idx_tool_calls_session on tool_calls(session_id, started_at desc);
    create index if not exists idx_tool_calls_tool on tool_calls(tool, started_at desc);
  `)

  const insert = db.prepare(`
    insert into tool_calls
      (id, session_id, run_id, call_id, tool, args, ok, error, text, value, presentation, bytes, started_at, finished_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const selectOne = db.prepare('select * from tool_calls where id = ?')
  const selectList = db.prepare(`
    select id, session_id, call_id, tool, ok, bytes, started_at, finished_at
    from tool_calls
    where (? is null or session_id = ?) and (? is null or tool = ?)
    order by started_at desc
    limit ?
  `)
  const selectStats = db.prepare(
    'select tool, count(*) as n, max(started_at) as last from tool_calls group by tool order by n desc',
  )

  const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v))
  const parse = <T>(raw: string | null): T | undefined => {
    if (raw === null) return undefined
    try {
      return JSON.parse(raw) as T
    } catch {
      // 写坏的 JSON 只该坏那一格, 不该让整条记录读不出来
      return undefined
    }
  }

  return {
    put(input) {
      const id = randomUUID().slice(0, 12)
      insert.run(
        id,
        input.sessionId ?? null,
        input.runId ?? null,
        input.callId,
        input.tool,
        json(input.args) ?? null,
        input.ok ? 1 : 0,
        input.error ?? null,
        input.text,
        json(input.value),
        json(input.presentation),
        Buffer.byteLength(input.text),
        input.startedAt,
        input.finishedAt,
      )
      return id
    },

    get(id) {
      const row = selectOne.get(id) as Row | undefined
      if (!row) return undefined
      return {
        id: row.id,
        ...(row.session_id === null ? {} : { sessionId: row.session_id }),
        ...(row.run_id === null ? {} : { runId: row.run_id }),
        callId: row.call_id,
        tool: row.tool,
        args: parse(row.args),
        ok: row.ok === 1,
        ...(row.error === null ? {} : { error: row.error }),
        text: row.text,
        value: parse(row.value),
        presentation: parse<Record<string, unknown>>(row.presentation),
        bytes: row.bytes,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      }
    },

    list(opts = {}) {
      const sessionId = opts.sessionId ?? null
      const tool = opts.tool ?? null
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
      const rows = selectList.all(sessionId, sessionId, tool, tool, limit) as Array<
        Pick<Row, 'id' | 'session_id' | 'call_id' | 'tool' | 'ok' | 'bytes' | 'started_at' | 'finished_at'>
      >
      return rows.map((r) => ({
        id: r.id,
        ...(r.session_id === null ? {} : { sessionId: r.session_id }),
        callId: r.call_id,
        tool: r.tool,
        ok: r.ok === 1,
        bytes: r.bytes,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
      }))
    },

    stats() {
      return (selectStats.all() as Array<{ tool: string; n: number; last: number }>).map((r) => ({
        tool: r.tool,
        count: Number(r.n),
        lastAt: Number(r.last),
      }))
    },

    close() {
      db.close()
    },
  }
}

export function apply(
  ctx: Ctx,
  config: { dir?: string; file?: string } = {},
): Disposer {
  const file = config.file ?? join(config.dir ?? process.env['MENG_DATA_DIR'] ?? '.meng', 'records.db')
  const store = createRecordStore(file)
  const dispose = ctx.set<RecordStore>(RECORDS_CAPABILITY, store)
  if (!process.env['MENG_QUIET']) {
    console.log(`[meng] records · ${file} · ${store.stats().length} 个工具有过记录`)
  }
  return () => {
    dispose()
    store.close()
  }
}

/** 取能力面。工具管线是**可选**依赖: 没装就不记录, 而不是报错 */
export function getRecords(ctx: Ctx): RecordStore | undefined {
  return ctx.get<RecordStore>(RECORDS_CAPABILITY)
}

export const invariant = defineInvariant('@meng/records', [
  {
    /**
     * 三层必须都能原样取回。**用内存库** —— 自检不许往用户的记录文件里写探针。
     *
     * 这条守的是"落进去的和读出来的不是同一份": 事件流里只留 2000 字回显,
     * 全文只有这里一份。取回来少了字节, 用户点"查看完整输出"就会看到截断版,
     * 而他永远不会知道那是截断的。
     */
    id: 'roundtrip-keeps-three-layers',
    run() {
      const store = createRecordStore(':memory:')
      try {
        const text = 'x'.repeat(5000) + '\n尾巴'
        const id = store.put({
          sessionId: 's1',
          callId: 'c1',
          tool: 'bash',
          args: { command: 'echo hi' },
          ok: true,
          text,
          value: { exitCode: 0, lines: 1 },
          presentation: { summary: 'echo hi', elapsedMs: 3 },
          startedAt: 1,
          finishedAt: 4,
        })
        const back = store.get(id)
        if (!back) throw new Error('记录写进去了却取不回来')
        if (back.text !== text) throw new Error(`全文不一致: ${back.text.length} vs ${text.length}`)
        if (back.bytes !== Buffer.byteLength(text)) throw new Error('字节数算错了')
        if ((back.value as { exitCode?: number }).exitCode !== 0) throw new Error('canonical 层丢了')
        if (back.presentation?.['summary'] !== 'echo hi') throw new Error('presentation 层丢了')
        if (back.ok !== true) throw new Error('ok 位丢了')

        // 列表不带正文 (列表页不该拉几 MB)
        const rows = store.list({ sessionId: 's1' })
        if (rows.length !== 1) throw new Error(`list 应有 1 条, 实际 ${rows.length}`)
        if ('text' in (rows[0] as object)) throw new Error('list 不该带正文')

        const stats = store.stats()
        if (stats[0]?.tool !== 'bash' || stats[0]?.count !== 1) throw new Error('stats 不对')
      } finally {
        store.close()
      }
    },
  },
])
