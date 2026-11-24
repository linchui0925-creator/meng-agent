# @meng/plugin-memory

一个插件，内部拆成四个职责：

- `compaction.ts`：先剪旧工具结果；仍超预算时把较早轮次压成结构化 `context/compacted` 检查点。
- `store.ts`：独立 `retrieval.db`，FTS5 检索消息、工具结果和摘要；原始会话仍在 `sessions.db`。
- `prune.ts` / `tokens.ts`：无模型的可测试预处理和保守 token 估算。
- `skills/memory-retrieval/SKILL.md`：告诉模型什么时候搜、怎么读原文核对。

工具：

- `memory_search`：返回带 `sessionId / seq / kind / snippet / score` 的命中。
- `memory_read`：按会话和事件序号读取原文。

默认策略来自 Anthropic 式分层压缩：上下文约 80% 触发，保留最近约 16% 原文，摘要最多 8192 tokens；工具结果超过 8192 字符时先保留头尾。摘要事件追加到原会话，不删除原始记录。
