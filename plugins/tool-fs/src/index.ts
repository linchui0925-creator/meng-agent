/**
 * @meng/plugin-tool-fs —— read / write / edit, 对齐 dsh-tool-fs。
 *
 * 薄壳纪律: 本文件**不许 import node:fs**。真活在 ctx.fs (seam) 里,
 * 这里只做三件事: 工具名 + JSON Schema + 上限与渲染。
 * 参数一律 snake_case (file_path / old_string / replace_all) ——
 * 模型见过这些 schema (dsh 与 Claude Code 同款), 迁移成本为零。
 *
 * 上限抄 dsh 默认值, 不自创:
 *   readLimit          2000 行   一次 read 的默认与最大行数
 *   readMaxLineLength  2000 字符 单行截断 (带说明后缀)
 *   readMaxBytes       51200     50KB 字节上限, 溢出 → footer 提示用 offset 继续
 * 旧项目 P95 慢的根因就是工具回显太大 (旧 maxReadBytes 是这里的 4 倍)。
 * 不实现 spill: 超了就明确告诉模型"已截断", 模型要看全量就分段读。
 */

import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import { FsError, type FsCallOptions, type FsService } from '@meng/fs'
import type { SessionService } from '@meng/session'
import type { ToolCall, ToolDef, ToolResult, ToolService } from '@meng/tools'

export const name = 'meng-plugin-tool-fs'
export const inject = ['tools', 'fs']

export interface Config {
  readLimit?: number
  readMaxLineLength?: number
  readMaxBytes?: number
}

const ok = (text: string): ToolResult => ({ ok: true, text })
const fail = (error: string): ToolResult => ({ ok: false, text: '', error })

/**
 * 把"本次调用已获批准越界"这件事从 call 上取出来交给 seam。
 *
 * 这一行是审批能真正生效的**唯一**通路: 用户在工具执行前点了"允许",
 * 凭据挂在 call 上; 围栏在 seam 里, 它只看得到 opts。少了这一行,
 * 界面会说"已允许", 而工具照样报越界。
 */
const optionsOf = (call: ToolCall | undefined, session: SessionService | undefined): FsCallOptions | undefined => {
  const workspace = call?.sessionId ? session?.workspaceOf(call.sessionId) : undefined
  const g = call?.grants
  const out: FsCallOptions = {
    ...(workspace ? { root: workspace } : {}),
    ...(g?.outside === true ? { outside: true } : {}),
    ...(g?.sensitive === true ? { sensitive: true } : {}),
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function errText(err: unknown): string {
  if (err instanceof FsError) return `${err.code}: ${err.message}`
  if (err instanceof Error) return err.message
  return String(err)
}

function toInt(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

export function apply(ctx: Ctx, config: Config = {}): Disposer {
  const tools = ctx.get<ToolService>('tools')
  if (!tools) throw new Error('能力面 tools 未装载')
  const fs = ctx.get<FsService>('fs')
  if (!fs) throw new Error('能力面 fs 未装载')
  const session = ctx.get<SessionService>('session')

  const readLimit = config.readLimit ?? 2000
  const readMaxLineLength = config.readMaxLineLength ?? 2000
  const readMaxBytes = config.readMaxBytes ?? 51_200

  const defs: ToolDef[] = [
    {
      name: 'read',
      description:
        '读取文本文件。返回带行号的内容。offset/limit 是 1 起始的行号; ' +
        `单次最多 ${readLimit} 行 / 50KB, 大文件务必带上 offset 分段读`,
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '相对工作区的文件路径' },
          offset: { type: 'number', description: '从第几行开始读 (1 起始)' },
          limit: { type: 'number', description: `最多读几行, 默认 ${readLimit}` },
        },
        required: ['file_path'],
      },
      async handler(args, _ctx, call) {
        try {
          const r = await fs.readText(String(args.file_path ?? ''), optionsOf(call, session))
          const offset = Math.max(1, toInt(args.offset) ?? 1)
          const limit = Math.min(toInt(args.limit) ?? readLimit, readLimit)
          const slice = r.lines.slice(offset - 1, offset - 1 + limit)

          const body: string[] = []
          let bytes = 0
          let stopAt = 0
          for (let i = 0; i < slice.length; i++) {
            let line = slice[i] ?? ''
            if (line.length > readMaxLineLength) {
              line = line.slice(0, readMaxLineLength) + '… [单行超长已截断]'
            }
            const rendered = `${offset + i}\t${line}`
            const cost = Buffer.byteLength(rendered)
            if (bytes + cost > readMaxBytes) {
              stopAt = offset + i
              break
            }
            bytes += cost
            body.push(rendered)
          }

          const head = `${r.rel} (共 ${r.totalLines} 行)`
          const footers: string[] = []
          if (stopAt > 0) footers.push(`… 已达 ${readMaxBytes} 字节上限, 只显示到第 ${stopAt} 行 — 用 offset=${stopAt} 继续`)
          else if (offset - 1 + slice.length < r.totalLines) {
            footers.push(`… 后面还有 ${r.totalLines - (offset - 1 + slice.length)} 行 — 用 offset=${offset + slice.length} 继续`)
          }
          return ok([head, ...body, ...footers].join('\n'))
        } catch (err) {
          return fail(`read 失败: ${errText(err)}`)
        }
      },
    },

    {
      name: 'write',
      description:
        '写入文件 (整文件覆盖)。父目录自动创建。覆盖已有文件前必须先 read 过它 —— ' +
        '这是部署的策略 (policy-fs), 未读先写会收到 FS_NOT_OBSERVED',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '相对工作区的文件路径' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['file_path', 'content'],
      },
      mutates: true,
      async handler(args, _ctx, call) {
        try {
          const content = String(args.content ?? '')
          const r = await fs.writeText(String(args.file_path ?? ''), content, optionsOf(call, session))
          return ok(`已${r.operation === 'create' ? '创建' : '更新'} ${r.rel} (${r.bytes} 字节)`)
        } catch (err) {
          return fail(`write 失败: ${errText(err)}`)
        }
      },
    },

    {
      name: 'edit',
      description:
        '精确替换文件中的一段文本。old_string 必须在文件中唯一 (出现多次需 replace_all 或补上下文); ' +
        'new_string 留空即删除。编辑前必须先 read 过该文件',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '相对工作区的文件路径' },
          old_string: { type: 'string', description: '要替换的原文 (非空)' },
          new_string: { type: 'string', description: '替换后的文本, 留空即删除' },
          replace_all: { type: 'boolean', description: '替换全部出现处 (默认 false, 仅唯一匹配时替换)' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
      mutates: true,
      async handler(args, _ctx, call) {
        try {
          const r = await fs.editText(
            String(args.file_path ?? ''),
            String(args.old_string ?? ''),
            String(args.new_string ?? ''),
            args.replace_all === true,
            optionsOf(call, session),
          )
          return ok(`已替换 ${r.replaced} 处 (${r.rel})`)
        } catch (err) {
          return fail(`edit 失败: ${errText(err)}`)
        }
      },
    },
  ]

  const disposers = defs.map((def) => ctx.effect(() => tools.register(def)))
  return () => {
    for (const off of disposers.reverse()) off()
  }
}

export const invariant = defineInvariant('@meng/plugin-tool-fs', [
  {
    id: 'tools-registered',
    run(ctx) {
      const tools = ctx.get<ToolService>('tools')
      if (!tools) throw new Error('能力面 tools 未装载')
      const names = tools.list().map((t) => t.name)
      for (const required of ['read', 'write', 'edit']) {
        if (!names.includes(required)) throw new Error(`文件工具 ${required} 未注册`)
      }
    },
  },
])
