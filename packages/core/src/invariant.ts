/**
 * Invariant —— 每个包必须能回答"我在什么条件下不可用"。
 *
 * dsh 的 invariant 伴生包 `install` 是空函数 (`const install = () => {}`),
 * 纯占位。我们反过来: **不许空**。哪怕只检查一件事 ("session 目录可写"),
 * 也要写出来。理由: 装机现场的故障 90% 是"看起来装上了, 其实半残",
 * 而一条可执行的检查能在 200ms 内把它变成一句人话。
 */

import type { Ctx } from './context.ts'

export interface Check {
  id: string
  /** 不通过时抛出, message 是要给人看的那句话 */
  run(ctx: Ctx): void | Promise<void>
}

export interface Invariant {
  pkg: string
  checks: Check[]
}

export interface CheckResult {
  pkg: string
  id: string
  ok: boolean
  message?: string
  ms: number
}

export function defineInvariant(pkg: string, checks: Check[]): Invariant {
  if (checks.length === 0) {
    throw new Error(`${pkg}: invariant 不允许为空, 至少写一条真实检查`)
  }
  return { pkg, checks }
}

/** 单条不变量最多跑多久。挂住的检查比失败的检查更糟 —— 它连一句话都不给 */
export const CHECK_TIMEOUT_MS = 10_000

export async function runInvariants(
  ctx: Ctx,
  invariants: Invariant[],
): Promise<{ ok: boolean; results: CheckResult[] }> {
  const results: CheckResult[] = []
  for (const inv of invariants) {
    for (const check of inv.checks) {
      const started = Date.now()
      // 不加超时的话, 一条 `await` 永不 resolve 的检查会让 bootKernel 永远
      // 不返回 —— 现场表现是"进程起来了、什么都不打印、端口也不监听",
      // 没有任何线索指向是哪一条。超时至少把名字说出来
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.resolve(check.run(ctx)),
          new Promise<never>((_, reject) => {
            // 同样不能 unref: unref 之后"检查挂住 + 进程没有别的 handle"
            // 会让进程直接退出, 连这句超时都报不出来 —— 现场看到的是
            // "启动后什么都不打印", 正是这个 bug 最初的模样
            timer = setTimeout(
              () => reject(new Error(`检查超过 ${CHECK_TIMEOUT_MS}ms 没返回 (挂住了)`)),
              CHECK_TIMEOUT_MS,
            )
          }),
        ])
        results.push({ pkg: inv.pkg, id: check.id, ok: true, ms: Date.now() - started })
      } catch (err) {
        results.push({
          pkg: inv.pkg,
          id: check.id,
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          ms: Date.now() - started,
        })
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
  }
  return { ok: results.every((r) => r.ok), results }
}
