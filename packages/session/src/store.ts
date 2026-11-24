/**
 * session 的本机 SQLite 存储。
 *
 * 事件仍是只追加账本；sessions 表是侧栏用的可更新投影（标题、预览、轮数）。
 * 删除会话时事件随外键级联删除，不存在“界面删了、磁盘还留着”的第二份数据。
 * SQL 只留在本文件，未来增加 OSS 归档也不需要改变 SessionService 契约。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionEvent, SessionEventType, SessionMeta } from './index.ts'

export type SessionPermissionMode = 'ask' | 'auto' | 'full'

export interface SessionStorageInfo {
  readonly file: string
  /** 本次打开后读到的事件总数（SQLite 原数据 + 本次旧文件导入）。 */
  readonly replayed: number
  /** 本次从旧 JSONL 导入的事件数。 */
  readonly imported: number
  /** 本次打开后新追加的事件数。 */
  readonly written: number
}

export interface SessionPage {
  events: SessionEvent[]
  /** 是否还有比本页最旧事件更早的数据。 */
  hasMore: boolean
}

export interface DeleteSessionResult {
  ok: true
  /** 删除后建议前端切到的最近会话；删空了就没有。 */
  nextSessionId?: string
}

export interface SessionAttachment {
  id: string
  sessionId: string
  name: string
  mime: string
  size: number
  createdAt: number
}

export interface SessionAttachmentContent extends SessionAttachment {
  dataBase64: string
}

export interface PutAttachmentInput {
  sessionId: string
  name: string
  mime: string
  dataBase64: string
}

export interface SessionStore {
  readonly storage: SessionStorageInfo
  append<T>(sessionId: string, type: SessionEventType, data: T): SessionEvent<T>
  read(sessionId: string): SessionEvent[]
  readPage(sessionId: string, options?: { before?: number; limit?: number }): SessionPage
  all(): SessionEvent[]
  sessions(): SessionMeta[]
  /** 当前会话绑定的执行目录；普通会话返回 undefined。 */
  workspaceOf(sessionId: string): string | undefined
  /** 会话自己的权限档；undefined = 继承全局 sandbox.mode。 */
  permissionOf(sessionId: string): SessionPermissionMode | undefined
  /** 设置或清除（缺省）会话权限覆盖。 */
  setPermission(sessionId: string, mode?: SessionPermissionMode): SessionMeta
  /** 图片本体落本地文件，SQLite 只存元数据与所属会话。 */
  putAttachment(input: PutAttachmentInput): SessionAttachment
  /** 按传入 id 顺序读取；不存在或跨会话都拒绝。 */
  readAttachments(sessionId: string, ids: readonly string[]): SessionAttachmentContent[]
  nextSeq(): number
  hydrate(events: SessionEvent[]): void
  rename(sessionId: string, title: string): SessionMeta
  delete(sessionId: string): DeleteSessionResult
  flush(): Promise<void>
  close(): void
}

interface EventRow {
  seq: number
  session_id: string
  type: SessionEventType
  at: number
  data: string
}

interface AttachmentRow {
  id: string
  session_id: string
  name: string
  mime: string
  size: number
  created_at: number
}

interface MetaRow {
  session_id: string
  title: string
  workspace: string | null
  created_at: number
  last_seq: number
  turns: number
  preview: string | null
  permission_mode: SessionPermissionMode | null
}

const LEGACY_MARKER = 'legacy.events_jsonl.imported.v1'
const DEFAULT_PAGE_SIZE = 200
const MAX_PAGE_SIZE = 500
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export function createSessionStore(file: string, legacyFile?: string): SessionStore {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  let closed = false

  db.exec(`
    pragma journal_mode = wal;
    pragma foreign_keys = on;
    pragma busy_timeout = 5000;

    create table if not exists session_schema (
      key text primary key,
      value text not null
    );

    create table if not exists sessions (
      session_id text primary key,
      title text not null,
      workspace text,
      created_at integer not null,
      last_seq integer not null,
      turns integer not null default 0,
      preview text
    );

    create table if not exists session_events (
      seq integer primary key,
      session_id text not null references sessions(session_id) on delete cascade,
      type text not null,
      at integer not null,
      data text not null
    );

    create table if not exists session_attachments (
      id text primary key,
      session_id text not null references sessions(session_id) on delete cascade,
      name text not null,
      mime text not null,
      size integer not null,
      created_at integer not null
    );

    create index if not exists idx_session_attachments_session
      on session_attachments(session_id, id);

    create index if not exists idx_session_events_session_seq
      on session_events(session_id, seq);
    create index if not exists idx_sessions_list
      on sessions(created_at desc, last_seq desc);
  `)

  const sessionColumns = db.prepare('pragma table_info(sessions)').all() as Array<{ name: string }>
  if (!sessionColumns.some((column) => column.name === 'permission_mode')) {
    db.exec('alter table sessions add column permission_mode text')
  }

  const insertEvent = db.prepare(`
    insert or ignore into session_events (seq, session_id, type, at, data)
    values (?, ?, ?, ?, ?)
  `)
  const insertSession = db.prepare(`
    insert into sessions (session_id, title, workspace, created_at, last_seq, turns, preview)
    values (?, ?, ?, ?, ?, 0, null)
  `)
  const selectSession = db.prepare('select * from sessions where session_id = ?')
  const updateCreated = db.prepare(`
    update sessions
    set title = ?, workspace = ?, created_at = min(created_at, ?)
    where session_id = ?
  `)
  const updateActivity = db.prepare(`
    update sessions
    set last_seq = max(last_seq, ?),
        turns = turns + ?,
        preview = case when ? = 1 then ? else preview end
    where session_id = ?
  `)
  const selectRead = db.prepare('select * from session_events where session_id = ? order by seq')
  const selectAll = db.prepare('select * from session_events order by seq')
  const selectPage = db.prepare(`
    select * from session_events
    where session_id = ? and (? is null or seq < ?)
    order by seq desc limit ?
  `)
  const selectSessions = db.prepare('select * from sessions order by created_at desc, last_seq desc')
  const updateTitle = db.prepare('update sessions set title = ? where session_id = ?')
  const updatePermission = db.prepare('update sessions set permission_mode = ? where session_id = ?')
  const insertAttachment = db.prepare(`
    insert into session_attachments (id, session_id, name, mime, size, created_at)
    values (?, ?, ?, ?, ?, ?)
  `)
  const selectAttachment = db.prepare(`
    select * from session_attachments where id = ? and session_id = ?
  `)
  const selectAttachmentIds = db.prepare('select id from session_attachments where session_id = ?')
  const deleteSession = db.prepare('delete from sessions where session_id = ?')
  const selectNext = db.prepare(`
    select session_id from sessions
    order by created_at desc, last_seq desc limit 1
  `)
  const maxSeq = Number((db.prepare('select coalesce(max(seq), -1) as value from session_events').get() as { value: number }).value)
  let seq = maxSeq + 1
  let written = 0
  let imported = 0
  const deleted = new Set<string>()
  const temporaryAttachmentDir = file === ':memory:'
    ? mkdtempSync(join(tmpdir(), 'meng-session-attachments-'))
    : undefined
  const attachmentDir = temporaryAttachmentDir ?? join(dirname(file), 'attachments')

  if (legacyFile) importLegacy(legacyFile)
  const replayed = countEvents()

  function eventOf(row: EventRow): SessionEvent {
    return {
      seq: Number(row.seq),
      sessionId: row.session_id,
      type: row.type,
      at: Number(row.at),
      data: JSON.parse(row.data) as unknown,
    }
  }

  function metaOf(row: MetaRow): SessionMeta {
    return {
      sessionId: row.session_id,
      title: row.title,
      at: Number(row.created_at),
      lastSeq: Number(row.last_seq),
      turns: Number(row.turns),
      ...(row.preview === null ? {} : { preview: row.preview }),
      ...(row.workspace === null ? {} : { workspace: row.workspace }),
      ...(row.permission_mode === null ? {} : { permissionMode: row.permission_mode }),
    }
  }

  function meta(sessionId: string): MetaRow | undefined {
    return selectSession.get(sessionId) as MetaRow | undefined
  }

  function titleFor(event: SessionEvent): string {
    if (event.type === 'session/created') {
      const title = (event.data as { title?: unknown } | null)?.title
      if (typeof title === 'string' && title.trim()) return title.trim().slice(0, 200)
    }
    if (event.type === 'turn/started') {
      const text = (event.data as { text?: unknown } | null)?.text
      if (typeof text === 'string' && text.trim()) return text.trim().slice(0, 20)
    }
    return '未命名会话'
  }

  function workspaceFor(event: SessionEvent): string | null {
    if (event.type !== 'session/created') return null
    const workspace = (event.data as { workspace?: unknown } | null)?.workspace
    return typeof workspace === 'string' && workspace ? workspace : null
  }

  function previewFor(event: SessionEvent): string | null {
    const text = (event.data as { text?: unknown } | null)?.text
    if (typeof text !== 'string') return null
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat ? flat.slice(0, 60) : null
  }

  function putHistorical(event: SessionEvent): boolean {
    const result = insertEvent.run(event.seq, event.sessionId, event.type, event.at, JSON.stringify(event.data ?? null))
    if (Number(result.changes) === 0) return false
    // 外键要求投影行先存在；历史数据由本函数单独调整顺序。
    return true
  }

  function insertHistorical(event: SessionEvent): boolean {
    deleted.delete(event.sessionId)
    const existing = meta(event.sessionId)
    if (!existing) insertSession.run(event.sessionId, titleFor(event), workspaceFor(event), event.at, event.seq)
    const inserted = putHistorical(event)
    if (!inserted) {
      if (!existing) deleteSession.run(event.sessionId)
      return false
    }
    if (existing && event.type === 'session/created') {
      updateCreated.run(titleFor(event), workspaceFor(event), event.at, event.sessionId)
    }
    const isTurn = event.type === 'turn/started'
    updateActivity.run(event.seq, isTurn ? 1 : 0, isTurn ? 1 : 0, isTurn ? previewFor(event) : null, event.sessionId)
    if (event.seq >= seq) seq = event.seq + 1
    return true
  }

  function importLegacy(path: string): void {
    const marked = db.prepare('select value from session_schema where key = ?').get(LEGACY_MARKER)
    if (marked) return

    const events: SessionEvent[] = []
    if (existsSync(path)) {
      let text = ''
      try {
        text = readFileSync(path, 'utf8')
      } catch (err) {
        db.close()
        closed = true
        throw new Error(`旧会话文件读取失败，已停止启动以避免数据丢失: ${path}`, { cause: err })
      }
      for (const line of text.split(/\r?\n/)) {
        const raw = line.trim()
        if (!raw) continue
        try {
          const event = JSON.parse(raw) as SessionEvent
          if (!Number.isSafeInteger(event.seq) || !event.sessionId || !event.type || !Number.isFinite(event.at)) {
            throw new Error('事件字段不完整')
          }
          events.push(event)
        } catch {
          console.warn(`[meng] 跳过损坏的旧事件行: ${raw.slice(0, 80)}`)
        }
      }
    }

    db.exec('begin immediate')
    try {
      events.sort((a, b) => a.seq - b.seq)
      for (const event of events) if (insertHistorical(event)) imported++
      db.prepare('insert into session_schema (key, value) values (?, ?)').run(LEGACY_MARKER, new Date().toISOString())
      db.exec('commit')
    } catch (err) {
      db.exec('rollback')
      db.close()
      closed = true
      throw err
    }

    if (existsSync(path)) {
      let backup = `${path}.migrated`
      if (existsSync(backup)) backup = `${path}.migrated-${Date.now()}`
      try {
        renameSync(path, backup)
      } catch (err) {
        // 已有迁移标记，重启不会重复导入。保留原文件只是备份，绝不再写。
        console.warn(`[meng] 旧事件已入库，但备份重命名失败: ${path}`, err)
      }
    }
  }

  function countEvents(): number {
    const row = db.prepare('select count(*) as value from session_events').get() as { value: number }
    return Number(row.value)
  }

  function append<T>(sessionId: string, type: SessionEventType, data: T): SessionEvent<T> {
    if (closed) throw new Error('session 存储已关闭')
    if (!sessionId) throw new Error('sessionId 不能为空')
    const existing = meta(sessionId)
    if (type === 'session/created' && existing) throw new Error(`会话 ${sessionId} 已存在`)
    if (type !== 'session/created' && deleted.has(sessionId)) {
      throw new Error(`会话 ${sessionId} 不存在或已删除`)
    }

    const event: SessionEvent<T> = { seq, sessionId, type, at: Date.now(), data }
    db.exec('begin immediate')
    try {
      if (!existing) {
        // 老插件（jobs/questions）会直接写事件，没有 session/created；为其补投影行。
        // 唯一禁止的是已删除 id 被后续事件复活。
        insertSession.run(sessionId, titleFor(event), workspaceFor(event), event.at, event.seq)
        deleted.delete(sessionId)
      }
      const result = db.prepare(`
        insert into session_events (seq, session_id, type, at, data) values (?, ?, ?, ?, ?)
      `).run(event.seq, sessionId, type, event.at, JSON.stringify(data ?? null))
      if (Number(result.changes) !== 1) throw new Error(`事件序号冲突: ${event.seq}`)
      if (type !== 'session/created') {
        const isTurn = type === 'turn/started'
        updateActivity.run(event.seq, isTurn ? 1 : 0, isTurn ? 1 : 0, isTurn ? previewFor(event) : null, sessionId)
      }
      db.exec('commit')
    } catch (err) {
      db.exec('rollback')
      throw err
    }
    seq++
    written++
    return event
  }

  function attachmentMeta(row: AttachmentRow): SessionAttachment {
    return {
      id: row.id,
      sessionId: row.session_id,
      name: row.name,
      mime: row.mime,
      size: Number(row.size),
      createdAt: Number(row.created_at),
    }
  }

  function putAttachment(input: PutAttachmentInput): SessionAttachment {
    if (closed) throw new Error('session 存储已关闭')
    const sessionId = input.sessionId.trim()
    if (!meta(sessionId) || deleted.has(sessionId)) throw new Error(`会话 ${sessionId || '(空)'} 不存在`)
    const name = input.name.trim()
    if (!name) throw new Error('附件文件名不能为空')
    if (name.length > 200) throw new Error('附件文件名不能超过 200 字')
    const mime = input.mime.trim().toLowerCase()
    if (!IMAGE_MIMES.has(mime)) throw new Error('目前仅支持 PNG / JPEG / WebP / GIF 图片')
    const encoded = input.dataBase64
    if (!encoded) throw new Error('图片内容不能为空')
    if (
      encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    ) throw new Error('dataBase64 不是合法 Base64')
    const data = Buffer.from(encoded, 'base64')
    if (data.toString('base64') !== encoded) throw new Error('dataBase64 不是合法 Base64')
    if (data.length > MAX_ATTACHMENT_BYTES) throw new Error('附件超过 10MB，无法上传')

    const id = randomUUID()
    const target = join(attachmentDir, id)
    mkdirSync(attachmentDir, { recursive: true })
    try {
      writeFileSync(target, data, { flag: 'wx' })
      insertAttachment.run(id, sessionId, name, mime, data.length, Date.now())
    } catch (err) {
      rmSync(target, { force: true })
      throw err
    }
    const row = selectAttachment.get(id, sessionId) as AttachmentRow | undefined
    if (!row) throw new Error('附件元数据写入失败')
    return attachmentMeta(row)
  }

  function readAttachments(sessionId: string, ids: readonly string[]): SessionAttachmentContent[] {
    return ids.map((id) => {
      const row = selectAttachment.get(id, sessionId) as AttachmentRow | undefined
      if (!row || deleted.has(sessionId)) throw new Error(`附件 ${id} 不存在或不属于当前会话`)
      const target = join(attachmentDir, id)
      if (!existsSync(target)) throw new Error(`附件文件已丢失: ${row.name}`)
      return { ...attachmentMeta(row), dataBase64: readFileSync(target).toString('base64') }
    })
  }

  const store: SessionStore = {
    storage: {
      file,
      get replayed() { return replayed },
      get imported() { return imported },
      get written() { return written },
    },

    append,

    read(sessionId) {
      return (selectRead.all(sessionId) as unknown as EventRow[]).map(eventOf)
    },

    readPage(sessionId, options = {}) {
      const limit = options.limit ?? DEFAULT_PAGE_SIZE
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit 必须是正整数')
      const capped = Math.min(limit, MAX_PAGE_SIZE)
      const before = options.before
      if (before !== undefined && !Number.isSafeInteger(before)) throw new Error('before 必须是整数事件序号')
      const rows = selectPage.all(sessionId, before ?? null, before ?? null, capped + 1) as unknown as EventRow[]
      const hasMore = rows.length > capped
      return { events: rows.slice(0, capped).reverse().map(eventOf), hasMore }
    },

    all() {
      return (selectAll.all() as unknown as EventRow[]).map(eventOf)
    },

    sessions() {
      return (selectSessions.all() as unknown as MetaRow[]).map(metaOf)
    },

    workspaceOf(sessionId) {
      return meta(sessionId)?.workspace ?? undefined
    },

    permissionOf(sessionId) {
      return meta(sessionId)?.permission_mode ?? undefined
    },

    putAttachment,
    readAttachments,

    setPermission(sessionId, mode) {
      if (mode !== undefined && !['ask', 'auto', 'full'].includes(mode)) throw new Error(`未知权限档: ${String(mode)}`)
      const result = updatePermission.run(mode ?? null, sessionId)
      if (Number(result.changes) === 0) throw new Error(`会话 ${sessionId} 不存在`)
      const row = meta(sessionId)
      if (!row) throw new Error(`会话 ${sessionId} 不存在`)
      return metaOf(row)
    },

    nextSeq() {
      return seq++
    },

    hydrate(events) {
      db.exec('begin immediate')
      try {
        for (const event of [...events].sort((a, b) => a.seq - b.seq)) insertHistorical(event)
        db.exec('commit')
      } catch (err) {
        db.exec('rollback')
        throw err
      }
    },

    rename(sessionId, rawTitle) {
      const title = rawTitle.trim()
      if (!title) throw new Error('会话标题不能为空')
      if (title.length > 200) throw new Error('会话标题不能超过 200 字')
      const result = updateTitle.run(title, sessionId)
      if (Number(result.changes) === 0) throw new Error(`会话 ${sessionId} 不存在`)
      const row = meta(sessionId)
      if (!row) throw new Error(`会话 ${sessionId} 不存在`)
      return metaOf(row)
    },

    delete(sessionId) {
      const attachmentIds = (selectAttachmentIds.all(sessionId) as Array<{ id: string }>).map((row) => row.id)
      const result = deleteSession.run(sessionId)
      if (Number(result.changes) === 0) throw new Error(`会话 ${sessionId} 不存在`)
      deleted.add(sessionId)
      for (const id of attachmentIds) rmSync(join(attachmentDir, id), { force: true })
      const next = selectNext.get() as { session_id: string } | undefined
      return { ok: true, ...(next ? { nextSessionId: next.session_id } : {}) }
    },

    async flush() {
      if (!closed && file !== ':memory:') db.exec('pragma wal_checkpoint(passive)')
    },

    close() {
      if (closed) return
      closed = true
      db.close()
      if (temporaryAttachmentDir) rmSync(temporaryAttachmentDir, { recursive: true, force: true })
    },
  }

  return store
}
