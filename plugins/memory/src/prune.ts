/**
 * 工具结果裁剪：只改本次送给模型的表层，不改会话事件流。
 *
 * 这是 Anthropic 式上下文管理的第一步：旧工具输出通常信息密度最低，
 * 先保留头部、尾部和省略标记；真正不够时再做摘要压缩。
 */
import type { ContentBlock, Message } from '@meng/llm'

export interface PruneOptions {
  thresholdChars: number
  headChars: number
  tailChars: number
}

export const DEFAULT_PRUNE: PruneOptions = {
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
}

export function pruneToolResults(
  messages: readonly Message[],
  options: PruneOptions = DEFAULT_PRUNE,
): { messages: Message[]; pruned: number; beforeChars: number; afterChars: number } {
  let pruned = 0
  let beforeChars = 0
  let afterChars = 0
  const next = messages.map((message) => {
    let changed = false
    const content = message.content.map((block) => {
      if (block.type !== 'tool-result') {
        const size = blockChars(block)
        beforeChars += size
        afterChars += size
        return block
      }
      const text = block.content.map(blockText).join('')
      beforeChars += text.length
      const clipped = clip(text, options)
      if (clipped !== text) changed = true
      afterChars += clipped.length
      if (clipped === text) return block
      pruned++
      return { ...block, content: [{ type: 'text', text: clipped } as ContentBlock] }
    })
    return changed ? { ...message, content } : message
  })
  return { messages: next, pruned, beforeChars, afterChars }
}

function clip(text: string, options: PruneOptions): string {
  if (text.length <= options.thresholdChars) return text
  const marker = '\n\n[... tool result middle pruned ...]\n\n'
  return text.slice(0, options.headChars) + marker + text.slice(-options.tailChars)
}

function blockText(block: ContentBlock): string {
  return block.type === 'text' ? block.text : ''
}

function blockChars(block: ContentBlock): number {
  if (block.type === 'text' || block.type === 'reasoning') return block.text.length
  if (block.type === 'tool-call') return block.arguments.length
  if (block.type === 'tool-result') return block.content.map(blockText).join('').length
  if (block.type === 'image') return 4_000
  return 0
}
