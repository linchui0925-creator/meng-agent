/**
 * DeepSeek SSE 行 → 原始 payload 字符串。
 *
 * 和 `provider-openai/src/sse.ts` 的**唯一区别**：这里把 `[DONE]` 哨兵**留下来**。
 *
 * 为什么留：DeepSeek 的 `finish_reason` 可能出现在某个普通 chunk 里，而 `usage`
 * 又可能单独跟在最后一个 chunk 后面。只有见到 `[DONE]` 才知道"这轮真的说完了"，
 * 才能安全地一次性吐 usage + finish。openai 那个版本直接丢掉 `[DONE]`，
 * 于是只能"见到 finish_reason 就收尾"，撞上"usage 在 finish 之后"的部署就会漏计费。
 *
 * 几件必须按行处理、不能按 chunk 切的事（Python 版在这里出过事）：
 *   - 一个 `data:` 行可能跨 chunk 边界
 *   - 心跳是空行或 `:` 注释行，要跳过而不是当解析失败
 *   - 流不带 `[DONE]` 就断开 = 传输中断，不是正常结束（由 assemble() 判 TRANSPORT）
 */

/** 见到它就说明本轮结束。translate 拿这个当唯一收尾信号 */
export const DONE = '[DONE]'

/**
 * 把字节流切成 payload 字符串（已去掉 `data:` 前缀）。
 * 非 `data:` 行（`event:` / `:` 心跳 / 空行）一律跳过。
 */
export async function* ssePayloads(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // stream: true 让跨 chunk 的多字节汉字不会被切坏
      buffer += decoder.decode(value, { stream: true })

      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const payload = payloadOf(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
        if (payload !== null) yield payload
        nl = buffer.indexOf('\n')
      }
    }
    // 末尾没有换行的情况：最后一行的内容仍然要吐出去
    const tail = payloadOf(buffer)
    if (tail !== null) yield tail
  } finally {
    reader.releaseLock()
  }
}

/** 一行 → payload。不是 data 行就返回 null */
function payloadOf(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const payload = trimmed.slice(5).trim()
  return payload.length > 0 ? payload : null
}
