export const STUDIO_STEP_NAMES = [
  '创建插件骨架',
  '实现业务代码',
  '规范校验',
  '构建插件',
  '打包分发',
  '隔离验证',
  '安装到 profile',
  '重启后页面验收',
] as const

export type StudioStepName = typeof STUDIO_STEP_NAMES[number]
export type StudioStepStatus = 'pending' | 'in_progress' | 'completed'

export interface StudioStep {
  content: string
  status: StudioStepStatus
}

function contentOf(label: string, step: StudioStepName): string {
  return `${label} · ${step}`
}

export function initialStudioWorkflow(label: string): StudioStep[] {
  return STUDIO_STEP_NAMES.map((step, index) => ({
    content: contentOf(label, step),
    status: index === 0 ? 'completed' : index === 1 ? 'in_progress' : 'pending',
  }))
}

export function advanceStudioWorkflow(steps: readonly StudioStep[], label: string, completed: StudioStepName): StudioStep[] {
  const completedIndex = STUDIO_STEP_NAMES.indexOf(completed)
  const source = steps.length === STUDIO_STEP_NAMES.length ? steps : initialStudioWorkflow(label)
  return source.map((step, index) => ({
    content: step.content,
    status: index <= completedIndex ? 'completed' : index === completedIndex + 1 ? 'in_progress' : 'pending',
  }))
}

export function isStudioWorkflow(steps: readonly StudioStep[], label: string): boolean {
  return steps.length === STUDIO_STEP_NAMES.length &&
    STUDIO_STEP_NAMES.every((step, index) => steps[index]?.content === contentOf(label, step))
}
