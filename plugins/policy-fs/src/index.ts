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
import { FsError, type FsIntent } from '@meng/fs'

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
  const noWrite = config.noWrite ?? DEFAULT_NO_WRITE
  const requireRead = config.requireRead ?? true

  const observed = new Set<string>()
  const observedKey = (root: string, rel: string): string => `${resolve(root)}\0${rel.split('\\').join('/')}`

  const offRead = ctx.on('fs/read', (info: { root: string; rel: string }) => {
    observed.add(observedKey(info.root, info.rel))
  })
  const offWritten = ctx.on('fs/written', (info: { root: string; rel: string }) => {
    observed.add(observedKey(info.root, info.rel))
  })

  /** intent 槽的检查。抛错即否决; 调 next() 即放行 */
  const check = (intent: FsIntent, next: () => unknown) => {
    // **围栏不在这里了。** 它搬进了 fs seam —— 因为"越界"现在可以是**被批准的**:
    // 用户在工具执行前点了"允许", 凭据挂在 call 上, 一路传到 seam 的 resolve。
    // 这一层拿到的是 FsIntent, 里面没有凭据, 分不清"越界且没批准"和"越界但刚批准过",
    // 只能一刀切拒 —— 那样审批就成了摆设 ("我明明点了允许, 它还是说越界")。
    //
    // 纵深防御没有变: seam 那道围栏还在, 只是它现在看得见授权。
    const rel = intent.rel.split('\\').join('/')
    // 敏感路径也是"可以问"的: 用户批准过 (granted.sensitive) 就放行。
    // 一刀切拒会让"我想让模型改一下 .env"变成必须卸载策略才能做到
    const patterns = intent.granted?.sensitive === true ? [] : noWrite
    for (const pattern of patterns) {
      const p = pattern.split('\\').join('/')
      if (rel === p || rel.startsWith(p.endsWith('/') ? p : p + '/')) {
        throw new FsError('FS_SENSITIVE', `敏感路径禁止写入: ${rel}`)
      }
    }
    if (requireRead && intent.exists && !observed.has(observedKey(intent.root, rel))) {
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
      const sensitive: FsIntent = { kind: 'write', path: resolve(root, '.env'), root, rel: rel('.env'), exists: false }
      await expectVeto(ctx, 'fs/write-intent', sensitive, 'FS_SENSITIVE')

      // 2) 先读后写: 存在但没读过 (README 在 boot 阶段不会经 seam 被读)
      const unread: FsIntent = { kind: 'edit', path: resolve(root, 'README.md'), root, rel: 'README.md', exists: true }
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
