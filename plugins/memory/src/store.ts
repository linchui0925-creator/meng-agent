/**
 * 可丢弃的记忆检索库。原始会话不在这里；这里只放从事件流提取出的可搜索文档。
 *
 * 用独立 SQLite 文件，坏了可以重建；原文仍在 sessions.db。
 */
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface MemoryDoc {
  sessionId: string
  seq: number
  kind: 'user' | 'assistant' | 'tool' | 'summary' | 'job'
  title: string
  text: string
  at: number
  recordId?: string
}

export interface MemoryHit extends MemoryDoc {
  snippet: string
  score: number
}

export interface MemoryStore {
  index(doc: MemoryDoc): void
  search(input: { query: string; sessionId?: string; kinds?: readonly string[]; limit?: number }): MemoryHit[]
  close(): void
}

export function createMemoryStore(file: string): MemoryStore {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true })
  }
  const db = new DatabaseSync(file)
  if (file !== ':memory:') chmodSync(file, 0o600)
  db.exec(`
    pragma journal_mode = wal;
    pragma busy_timeout = 5000;
    create table if not exists memory_docs (
      doc_key text primary key,
      session_id text not null,
      seq integer not null,
      kind text not null,
      title text not null,
      text text not null,
      at integer not null,
      record_id text
    );
    create index if not exists idx_memory_docs_session on memory_docs(session_id, seq);
    create virtual table if not exists memory_docs_fts using fts5(
      text,
      content='memory_docs',
      content_rowid='rowid',
      tokenize='trigram'
    );
    create trigger if not exists memory_docs_ai after insert on memory_docs begin
      insert into memory_docs_fts(rowid, text) values (new.rowid, new.text);
    end;
    create trigger if not exists memory_docs_ad after delete on memory_docs begin
      insert into memory_docs_fts(memory_docs_fts, rowid, text) values ('delete', old.rowid, old.text);
    end;
    create trigger if not exists memory_docs_au after update on memory_docs begin
      insert into memory_docs_fts(memory_docs_fts, rowid, text) values ('delete', old.rowid, old.text);
      insert into memory_docs_fts(rowid, text) values (new.rowid, new.text);
    end;
  `)

  const upsert = db.prepare(`
    insert into memory_docs (doc_key, session_id, seq, kind, title, text, at, record_id)
    values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(doc_key) do update set
      session_id=excluded.session_id,
      seq=excluded.seq,
      kind=excluded.kind,
      title=excluded.title,
      text=excluded.text,
      at=excluded.at,
      record_id=excluded.record_id
  `)
  let closed = false

  return {
    index(doc) {
      if (closed || doc.text.trim() === '') return
      upsert.run(
        `${doc.sessionId}:${doc.seq}:${doc.kind}`,
        doc.sessionId,
        doc.seq,
        doc.kind,
        doc.title.slice(0, 160),
        doc.text.slice(0, 20_000),
        doc.at,
        doc.recordId ?? null,
      )
    },

    search(input) {
      if (closed) return []
      const q = input.query.replace(/\s+/g, ' ').trim()
      if (!q) return []
      const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 8)))
      const filters: string[] = []
      const params: Array<string | number> = []
      if (input.sessionId) {
        filters.push('d.session_id = ?')
        params.push(input.sessionId)
      }
      const kinds = (input.kinds ?? []).filter((k) => k === 'user' || k === 'assistant' || k === 'tool' || k === 'summary' || k === 'job')
      if (kinds.length > 0) {
        filters.push(`d.kind in (${kinds.map(() => '?').join(',')})`)
        params.push(...kinds)
      }
      const where = filters.length > 0 ? ` and ${filters.join(' and ')}` : ''
      // trigram 的 MATCH 对 1–2 个字符没有有效匹配；短查询走字面子串，
      // 避免用户在中文里搜“压缩”时得到空结果。
      if ([...q].length < 3) {
        const rows = db.prepare(`
          select d.session_id, d.seq, d.kind, d.title, d.text, d.at, d.record_id
          from memory_docs d
          where instr(d.text, ?) > 0${where}
          order by d.at desc, d.seq desc
          limit ?
        `).all(q, ...params, limit) as Record<string, unknown>[]
        return rows.map(rowOf)
      }
      const match = `"${q.replaceAll('"', '""')}"`
      const rows = db.prepare(`
        select d.session_id, d.seq, d.kind, d.title, d.text, d.at, d.record_id,
               snippet(memory_docs_fts, 0, '[', ']', '…', 18) as snippet,
               bm25(memory_docs_fts) as score
        from memory_docs_fts
        join memory_docs d on d.rowid = memory_docs_fts.rowid
        where memory_docs_fts match ?${where}
        order by score, d.at desc, d.seq desc
        limit ?
      `).all(match, ...params, limit) as Record<string, unknown>[]
      return rows.map(rowOf)
    },

    close() {
      if (closed) return
      closed = true
      db.close()
    },
  }
}

function rowOf(row: Record<string, unknown>): MemoryHit {
  const text = String(row.text ?? '')
  return {
    sessionId: String(row.session_id ?? ''),
    seq: Number(row.seq ?? 0),
    kind: String(row.kind ?? 'user') as MemoryHit['kind'],
    title: String(row.title ?? ''),
    text,
    at: Number(row.at ?? 0),
    ...(typeof row.record_id === 'string' && row.record_id ? { recordId: row.record_id } : {}),
    snippet: typeof row.snippet === 'string' ? row.snippet : text.slice(0, 240),
    score: typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : 0,
  }
}
