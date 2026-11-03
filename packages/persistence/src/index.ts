/**
 * @meng/persistence — 会话落盘。
 *
 * 用 **append-only JSONL**, 不用 SQLite。理由: 会话的语义本来就是只追加,
 * 落盘格式和内存结构同构, 于是"回放"就是 hydrate(), 不需要 ORM、
 * 不需要迁移脚本、不需要处理"行被改了"这种本不该存在的情况。
 * 等真需要按 sessionId 建索引/全文检索时再引入 SQLite 做**二级索引**,
 * 真相源仍然是这个 JSONL —— 千万别反过来。
 *
 * 注意 chunk 不在里面: llm/chunk 不落库(一轮几千条会把文件撑爆),
 * 所以重开进程后拿不到逐字增量, 靠 llm/completed 的整段文本补齐。
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import type { SessionEvent, SessionService } from '@meng/session'

export const name = 'meng-persistence'
export const inject = ['session']

export interface PersistenceService {
  readonly file: string
  /** 已落盘事件数 */
  readonly written: number
  /** 启动时回放的历史事件数 */
  readonly replayed: number
  flush(): Promise<void>
}

/** async 且 await 回放完成: 回放没结束就开始写新事件, seq 会和历史的撞车 */
export async function apply(ctx: Ctx, config: { dir?: string; file?: string } = {}): Promise<Disposer> {
  const file = config.file ?? join(config.dir ?? '.meng', 'events.jsonl')
  const maybeSession = ctx.get<SessionService>('session')
  if (!maybeSession) throw new Error('persistence 依赖 session')
  // 显式标注一次: 下面的 replay() 是函数声明, 闭包里不会继承外层 if 的收窄,
  // 所以"已经确认存在"这件事必须落到类型上, 而不是靠调用顺序暗示
  const session: SessionService = maybeSession

  let written = 0
  let replayed = 0

  await mkdir(dirname(file), { recursive: true })
  // 回放必须在装载完成前结束: 之后产生的事件才不会和历史的 seq 撞车
  await replay()

  async function replay(): Promise<void> {
    const events: SessionEvent[] = []
    try {
      const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
      for await (const line of rl) {
        const text = line.trim()
        if (!text) continue
        try {
          events.push(JSON.parse(text) as SessionEvent)
        } catch {
          // 坏行不阻断启动。修一半的 JSONL 比整个会话丢失好
          console.warn(`[meng] 跳过损坏的事件行: ${text.slice(0, 80)}`)
        }
      }
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code !== 'ENOENT') console.warn('[meng] 回放失败, 按空启动:', err)
    }
    events.sort((a, b) => a.seq - b.seq)
    // hydrate 不发事件: 否则下面的监听器会把历史再写一遍, 文件翻倍
    session.hydrate(events)
    replayed = events.length
  }

  const out = createWriteStream(file, { flags: 'a' })

  const off = ctx.on('session/event', (event: SessionEvent) => {
    out.write(JSON.stringify(event) + '\n')
    written++
  })

  const service: PersistenceService = {
    file,
    get written() {
      return written
    },
    get replayed() {
      return replayed
    },
    flush() {
      return new Promise<void>((ok) => out.write('', () => ok()))
    },
  }

  ctx.set('persistence', service)

  return async () => {
    off()
    await new Promise<void>((ok) => out.end(() => ok()))
  }
}

/** 给 CLI / 测试用: 只读回放, 不挂载 */
export async function readAll(file: string): Promise<SessionEvent[]> {
  const events: SessionEvent[] = []
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    const text = line.trim()
    if (text) events.push(JSON.parse(text) as SessionEvent)
  }
  return events.sort((a, b) => a.seq - b.seq)
}

export const invariant = defineInvariant('@meng/persistence', [
  {
    id: 'replayed',
    run(ctx) {
      const p = ctx.get<PersistenceService & { replayed?: number }>('persistence')
      if (!p) throw new Error('能力面 persistence 未注册')
      if (typeof p.written !== 'number') throw new Error('written 计数缺失')
    },
  },
])

export type { SessionEvent }
