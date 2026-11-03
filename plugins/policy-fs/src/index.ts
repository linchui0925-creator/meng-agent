/**
 * @meng/plugin-policy-fs —— 对位 dsh-fs-observation-policy。
 *
 * 零能力面: 不注册任何 service、任何工具。存在的全部意义是**占槽** ——
 * fs seam 在写之前会过 fs/write-intent / fs/edit-intent 两个单决策槽,
 * 这里把它们占住:
 *
 *   1. 先读后写: 目标文件存在 && 本次进程里没 read 过 && 没写过
 *      → 抛 FS_NOT_OBSERVED。模型必须先看再改, 不许盲改。
 *   2. 敏感路径: .git / .env / .ssh / id_rsa / .npmrc 不许写。
 *   3. 围栏: 越界路径直接拒 (seam 有一道, 这里第二道 —— 纵深防御)。
 *
 * "先读后写"是**部署决策**不是硬编码: 不装这个插件 = 裸提供方 = 无条件写。
 * dsh 同款 —— 删掉它, 写就不设防, 这是特性不是漏洞。
 *
 * 观察记账靠 seam 广播的两个事件:
 *   fs/read   (read 工具读过)        → 记为已观察
 *   fs/written (write/edit 刚写完)    → 也记为已观察 (连续改自己刚写的文件不该被拦)
 * 注意 grep 扫过的文件**不算**已观察 —— tool-search 刻意不发 fs/read。
 */

import { relative, resolve } from 'node:path'
import { sandboxRoot } from '@meng/config'
import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import { FsError, isWithin, type FsIntent } from '@meng/fs'

export const name = 'meng-plugin-policy-fs'
/** 刻意不写 inject: 钩子先挂上, seam 后装载也一样拦得住 */
export const inject: string[] = []

export interface Config {
  // 工作区根由 @meng/config 统一给, 见 sandboxRoot()
  noWrite?: string[]
  requireRead?: boolean
}

const DEFAULT_NO_WRITE = ['.git/', '.env', '.ssh/', 'id_rsa', '.npmrc']

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  const root = sandboxRoot(ctx)
  const noWrite = config.noWrite ?? DEFAULT_NO_WRITE
  const requireRead = config.requireRead ?? true

  const observed = new Set<string>()

  const offRead = ctx.on('fs/read', (info: { rel: string }) => {
    observed.add(info.rel)
  })
  const offWritten = ctx.on('fs/written', (info: { rel: string }) => {
    observed.add(info.rel)
  })

  /** intent 槽的检查。抛错即否决; 调 next() 即放行 */
  const check = (intent: FsIntent, next: () => unknown) => {
    if (!isWithin(root, intent.path)) {
      throw new FsError('FS_OUT_OF_ROOT', `不允许写到工作区之外: ${intent.rel}`)
    }
    const rel = intent.rel.split('\\').join('/')
    for (const pattern of noWrite) {
      const p = pattern.split('\\').join('/')
      if (rel === p || rel.startsWith(p.endsWith('/') ? p : p + '/')) {
        throw new FsError('FS_SENSITIVE', `敏感路径禁止写入: ${rel}`)
      }
    }
    if (requireRead && intent.exists && !observed.has(rel)) {
      throw new FsError(
        'FS_NOT_OBSERVED',
        `先读后写: ${rel} 还没有被 read 过。先 read 它, 确认原内容再改`,
      )
    }
    return next()
  }

  const offWrite = ctx.on('fs/write-intent', check, { priority: 100 })
  const offEdit = ctx.on('fs/edit-intent', check, { priority: 100 })

  return () => {
    offEdit()
    offWrite()
    offWritten()
    offRead()
  }
}

export const invariant = defineInvariant('@meng/plugin-policy-fs', [
  {
    id: 'intent-slot-vetoes',
    async run(ctx) {
      const root = sandboxRoot(ctx)
      const rel = (p: string) => relative(root, p) || '.'

      // 1) 敏感路径: 未读、也不存在, 单独验证 noWrite 命中
      const sensitive: FsIntent = { kind: 'write', path: resolve(root, '.env'), rel: rel('.env'), exists: false }
      await expectVeto(ctx, 'fs/write-intent', sensitive, 'FS_SENSITIVE')

      // 2) 先读后写: 存在但没读过 (README 在 boot 阶段不会经 seam 被读)
      const unread: FsIntent = { kind: 'edit', path: resolve(root, 'README.md'), rel: 'README.md', exists: true }
      await expectVeto(ctx, 'fs/edit-intent', unread, 'FS_NOT_OBSERVED')
    },
  },
])

async function expectVeto(ctx: Ctx, event: string, intent: FsIntent, wantCode: string): Promise<void> {
  try {
    await ctx.waterfall(event, [intent], () => undefined)
  } catch (err) {
    if (err instanceof FsError && err.code === wantCode) return
    throw new Error(
      `intent 槽拦错了: ${intent.rel} 应抛 ${wantCode}, 实际 ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  throw new Error(`intent 槽没拦住: ${intent.rel} 应抛 ${wantCode} 却放行了`)
}
