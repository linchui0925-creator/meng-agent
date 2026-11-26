import type { Ctx, Disposer } from '@meng/core'
import { getSubagent } from '@meng/subagent'
import type { ToolService } from '@meng/tools'

export const name = 'meng-plugin-tool-subagent'
export const inject = ['tools', 'subagent']

export function apply(ctx: Ctx): Disposer {
  const tools = ctx.get<ToolService>('tools')
  const subagent = getSubagent(ctx)
  if (!tools || !subagent) throw new Error('tool-subagent 需要 tools / subagent')
  const offs: Disposer[] = []

  offs.push(tools.register({
    name: 'subagent',
    group: 'subagent',
    description:
      '主动把边界清楚、可独立验收的旁路目标交给子智能体。主代理应继续关键路径；Explorer/Reviewer 只读调查，Worker 只能在声明的 write_scope 内写。需要共享连续推理的主任务不要拆。子智能体不继承当前对话，只看目标和工作区。',
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: '完整目标、约束和验收标准' },
        title: { type: 'string', description: '给用户看的短标题' },
        role: { type: 'string', enum: ['explorer', 'reviewer', 'worker'], description: '缺省 explorer。explorer/reviewer 只读；worker 可写但必须给 write_scope' },
        write_scope: { type: 'array', items: { type: 'string' }, description: 'worker 可修改的路径范围，必须互不重叠' },
        model: { type: 'string', description: '可选模型；缺省沿用父会话最近模型' },
      },
      required: ['objective'],
      additionalProperties: false,
    },
    mutates: true,
    timeoutMs: 10 * 60_000,
    async handler(args, _ctx, call) {
      const parentSessionId = call?.sessionId
      if (!parentSessionId) return { ok: false, text: '', error: 'subagent 需要父会话' }
      const objective = String(args.objective ?? '').trim()
      if (!objective) return { ok: false, text: '', error: 'objective 不能为空' }
      const role = args.role === 'reviewer' || args.role === 'worker' ? args.role : 'explorer'
      const writeScope = Array.isArray(args.write_scope)
        ? args.write_scope.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
        : []
      if (role === 'worker' && writeScope.length === 0) {
        return { ok: false, text: '', error: 'worker 必须提供 write_scope，写范围不能为空' }
      }
      let run
      try {
        run = subagent.start({
          parentSessionId,
          objective,
          ...(typeof args.title === 'string' && args.title.trim() ? { title: args.title.trim() } : {}),
          role,
          ...(writeScope.length ? { writeScope } : {}),
          ...(typeof args.model === 'string' && args.model.trim() ? { model: args.model.trim() } : {}),
          ...(call?.runId ? { runId: call.runId } : {}),
          ...(call?.signal ? { signal: call.signal } : {}),
        })
      } catch (error) {
        return { ok: false, text: '', error: error instanceof Error ? error.message : String(error) }
      }
      const result = await run.done
      if (result.status !== 'completed') {
        return {
          ok: false,
          text: '',
          error: `子智能体 ${result.status}: ${result.error ?? result.summary}`,
          value: result,
        }
      }
      return {
        ok: true,
        text: `子智能体 ${role} 完成 (${result.sessionId})\n${result.summary}`,
        value: { ...result, role, ...(writeScope.length ? { writeScope } : {}) },
      }
    },
  }))

  offs.push(ctx.get<{ section(section: { id: string; order: number; render: () => string }): Disposer }>('prompt')?.section({
    id: 'tool/subagent',
    order: 128,
    render: () => [
      '主代理负责关键路径。出现至少两个独立旁路任务时，主动启动 Explorer/Reviewer/Worker，不要等用户点名。',
      'Explorer 只做只读定位和证据收集；Reviewer 只做独立审查；Worker 才可写，且必须声明 write_scope。',
      '并行 Worker 的 write_scope 必须互不重叠；重叠时串行执行。',
      '强依赖当前推理、目标未定义或需要完整父上下文的任务不要拆。父代理不要重复子代理已经完成的工作。',
    ].join('\n'),
  }) ?? (() => undefined))

  return () => {
    for (const off of offs.reverse()) off()
  }
}
