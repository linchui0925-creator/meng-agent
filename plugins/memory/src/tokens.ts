/** 不依赖厂商 tokenizer 的保守预算估计。中英文混合时宁可早压一点。 */
import type { Message, ToolSpec } from '@meng/llm'

export function estimateTokens(messages: readonly Message[], system = '', tools: readonly ToolSpec[] = []): number {
  let chars = system.length
  for (const tool of tools) chars += JSON.stringify(tool).length
  for (const message of messages) {
    chars += 12
    for (const block of message.content) {
      if (block.type === 'text' || block.type === 'reasoning') chars += block.text.length
      else if (block.type === 'tool-call') chars += block.arguments.length
      else if (block.type === 'tool-result') chars += block.content.reduce((n, b) => n + blockChars(b), 0)
      else if (block.type === 'image') chars += 12_000
    }
  }
  return Math.max(1, Math.ceil(chars / 3))
}

function blockChars(block: Message['content'][number]): number {
  if (block.type === 'text' || block.type === 'reasoning') return block.text.length
  if (block.type === 'tool-call') return block.arguments.length
  if (block.type === 'tool-result') return block.content.reduce((n, b) => n + blockChars(b), 0)
  if (block.type === 'image') return 12_000
  return 0
}
