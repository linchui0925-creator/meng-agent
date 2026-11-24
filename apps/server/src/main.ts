/**
 * meng CLI —— 内核的唯一入口。
 *
 * 子命令:
 *   meng             起 HTTP(4721) + WS, 长驻
 *   meng chat "文本"  一次性对话, 打印到 stdout (不经 web, 用来验证内核)
 *   meng graph       状态图 JSON, 给 CI / 调试面板
 *   meng demo        拦截验收: 插件能不能真的拦住一次工具调用
 */

import { fileURLToPath } from 'node:url'
import type { LoopService } from '@meng/loop'
import type { ToolService } from '@meng/tools'
import { bootKernel, mockPatch, providersPatch } from './boot.ts'

const args = process.argv.slice(2)
const command = args.find((a) => !a.startsWith('-')) ?? 'serve'
const text = args.slice(args.indexOf(command) + 1).join(' ')

async function main(): Promise<void> {
  if (command === 'graph') return graph()
  if (command === 'demo') return demo()
  if (command === 'chat') return chat(text)
  return serve()
}

async function serve(): Promise<void> {
  const kernel = await bootKernel({ web: true, patches: [providersPatch(), mockPatch()] })
  if (!kernel.ok) {
    process.exitCode = 1
    console.error('[meng] 启动不健康, 已关闭。请先处理上面的 failed / pending 节点。')
    await kernel.dispose()
    return
  }

  const stop = async () => {
    console.log('\n[meng] 关闭中...')
    await kernel.dispose()
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())
  // 没有 web 时进程会立刻退出, 这里明确一下: serve 是长驻的
}

async function chat(prompt: string): Promise<void> {
  if (!prompt) {
    console.error('用法: meng chat "要说的话"')
    process.exitCode = 1
    return
  }
  // 带上 hello 插件: mock 脚本第一步就是调它, 这样一次 chat 同时验证
  // 「工具循环」和「文本流式」两条路径
  const kernel = await bootKernel({ patches: [providersPatch(), mockPatch(), helloPatch()], quiet: true })
  // 用真类型而不是手抄一份结构: 手抄的那份不会随 LoopEvent 一起改,
  // 于是"新增一个 error 字段"在这里静默变成"读不到" (类型检查当场红)
  const loop = kernel.ctx.get<LoopService>('loop')
  if (!loop) throw new Error('loop 未就绪 (没装 plugins/loop-* 插件?)')

  const sessionId = 'cli'
  for await (const ev of loop.run({ sessionId, text: prompt })) {
    if (ev.type === 'text' && ev.text) process.stdout.write(ev.text)
    if (ev.type === 'tool' && ev.call) {
      process.stdout.write(`\n[工具 ${ev.call.name}] ${ev.result ?? ''}\n`)
    }
    if (ev.type === 'done' && ev.error) {
      console.error(`\n[失败] ${ev.error}`)
      process.exitCode = 1
    }
  }
  process.stdout.write('\n')
  await kernel.dispose()
}

async function graph(): Promise<void> {
  const kernel = await bootKernel({ patches: [providersPatch(), mockPatch()], quiet: true })
  console.log(JSON.stringify({
    ...kernel.graph.toJSON(),
    invariants: kernel.invariants,
  }, null, 2))
  await kernel.dispose()
}


function helloPatch(): string {
  return fileURLToPath(new URL('../../../plugins/hello/meng.patch.yml', import.meta.url))
}

/**
 * 验收演示 (docs/02 §9 第 4 项): 插件能不能**真的**拦住一次工具调用。
 *
 * Python 版这条件是"文档里写了, 代码里从来没生效" —— 因为 17 个 hook 调用点
 * 全部丢弃返回值。这里没有第二条执行路径可绕, 拦不住才是异常。
 */
async function demo(): Promise<void> {
  const kernel = await bootKernel({ patches: [providersPatch(), mockPatch(), helloPatch()], quiet: true })

  // 同上: ToolService 的 call 入参是 ToolCall (含 sessionId), 手抄的窄类型
  // 会把 sessionId 判成"不存在的字段"
  const tools = kernel.ctx.get<ToolService>('tools')
  if (!tools) throw new Error('tools 能力面缺失')

  console.log('工具列表:', tools.list().map((t) => t.name).join(', ') || '(空)')
  console.log('')

  // 事件要归属到本次 demo 的会话: 用游离会话的话, 打印出来的是
  // 历史上所有跑过的事件 (持久化会重放), 看上去像"拦截触发了 15 次"
  const sessionId = 'demo'
  const ok = await tools.call({ id: 'call_1', name: 'hello', args: { name: '梦' }, sessionId })
  console.log(`正常调用    ok=${ok.ok}  ${ok.text}`)

  const blocked = await tools.call({
    id: 'call_2', name: 'hello', args: { name: '梦', panic: true }, sessionId,
  })
  console.log(`触发拦截    ok=${blocked.ok}  ${blocked.error ?? blocked.text}`)

  const session = kernel.ctx.get<{ read(id: string): Array<{ type: string }> }>('session')
  const events = session?.read(sessionId).map((e) => e.type) ?? []
  console.log(`事件流      ${events.join(' → ') || '(空)'}`)

  const pass = ok.ok && !blocked.ok && events.includes('tool/blocked')
  console.log('')
  console.log(pass ? '✓ 拦截生效 (验收 §9-4 通过)' : '✗ 拦截未生效')
  process.exitCode = pass ? 0 : 1
  await kernel.dispose()
}

main().catch((err) => {
  console.error('[meng] 启动失败:', err)
  process.exit(1)
})
