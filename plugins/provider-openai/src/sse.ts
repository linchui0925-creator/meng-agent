/**
 * OpenAI 风格 SSE 行解析。
 *
 * 这是 provider 里唯一有真实难度的部分, 也是 Python 版出过事的地方:
 *   - `data:` 行可能跨 chunk 边界 → 必须用缓冲按行切, 不能按 chunk 切
 *   - tool_calls 的 arguments 是**字符串分片**, 按 index 逐片吐出即可 ——
 *     累积是 @meng/llm 的 assemble() 的活, 不在这里 (以前那个
 *     ToolCallAccumulator 已经删了: 每个厂商各写一遍必然长出不一致行为)
 *   - 一个 chunk 里可能同时有 content 和 tool_calls
 *   - 流可能不带 [DONE] 就断开 → 缺 finish 由 assemble() 判 error, 不伪装成功
 */

export interface SSEChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  }
  error?: { message?: string }
}

/** 把字节流切成完整的 `data:` 行。跨 chunk 边界靠 buffer 兜住 */
export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) yield line
        nl = buffer.indexOf('\n')
      }
    }
    if (buffer.trim()) yield buffer.trim()
  } finally {
    reader.releaseLock()
  }
}

/** 解析一行。`[DONE]` 与心跳都返回 null —— 收尾由 provider 的 finish 与 assemble() 管 */
export function parseLine(line: string): SSEChunk | null {
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  try {
    return JSON.parse(payload) as SSEChunk
  } catch {
    // provider 偶尔会吐一行非 JSON 的心跳, 静默跳过
    return null
  }
}
