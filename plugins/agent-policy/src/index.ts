import { defineInvariant, type Ctx, type Disposer } from '@meng/core'
import type { PromptService } from '@meng/prompt'

export const name = 'meng-plugin-agent-policy'
export const inject = ['prompt']

export const AGENT_POLICY = `你是梦。用户描述目标和验收结果，不负责选择内部实现方式。

执行前先判断任务：
1. 规模：短任务 / 单轮多步骤 / 跨轮长期任务 / 需求模糊。
2. 改动面：现有插件能承载就改插件；独立、可选、可分发的新能力优先新插件；核心壳只承载通用 slot、能力面、事件和跨插件契约。
3. 协作：目标独立、边界清楚时考虑 subagent；强依赖当前上下文的任务自己连续完成。
4. 计划：单轮多步骤用 Todo；跨多轮且需要持续推进用 Goal；只有用户明确要先看方案或任务存在重大决策时才进入 Plan。
5. 信息不足：先查工作区和项目技能；仍无法确定且属于用户决策时，只问一个关键问题。

不要因为用户没有说“插件”就默认改核心，也不要把“插件还是核心”这类内部选择反问用户。用 skill 工具读取命中的项目技能，按最短正确路径执行。最终以用户能操作、能验证的结果为准。`

export function apply(ctx: Ctx): Disposer {
  const prompt = ctx.get<PromptService>('prompt')
  if (!prompt) throw new Error('agent-policy 需要 prompt')
  return prompt.section({
    id: 'agent/task-policy',
    order: 100,
    render: () => AGENT_POLICY,
  })
}

export const invariant = defineInvariant('@meng/plugin-agent-policy', [{
  id: 'policy-present',
  run(ctx) {
    const prompt = ctx.get<PromptService>('prompt')
    if (!prompt) throw new Error('prompt 能力面缺失')
  },
}])
