/**
 * 最小 WebSocket 服务端 (RFC 6455 的子集)。
 *
 * 为什么手写: 这个仓库强制"内核零第三方依赖" —— 沙箱无外网装不了 ws 包,
 * 更重要的是我们要的只是「服务端推文本帧 + 收 ping/close」这几十行,
 * 引一个包进来等于把内核的下行通道交给别人的版本节奏。
 *
 * 支持: 握手 / 文本帧收发 / 分片不处理(客户端不会发) / ping→pong / close
 * 不支持: 二进制帧、扩展(permessage-deflate)、子协议协商
 *   → 需要时再说; 现在加了都属于猜需求
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface WSConnection {
  send(text: string): void
  close(code?: number, reason?: string): void
  readonly closed: boolean
}

export interface WSServer {
  /** 广播给所有在线连接 */
  broadcast(text: string): void
  readonly size: number
  dispose(): void
}

/** 挂到已有 http.Server 的 upgrade 事件上 */
export function attachWebSocket(
  server: { on(event: 'upgrade', fn: (req: IncomingMessage, socket: Socket, head: Buffer) => void): unknown },
  options: { path?: string; onConnect(conn: WSConnection, req: IncomingMessage): void },
): WSServer {
  const path = options.path ?? '/ws'
  const conns = new Set<WSConnection>()

  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '/'
    if (!url.split('?')[0]?.endsWith(path)) {
      socket.destroy()
      return
    }
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }

    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.setNoDelay(true)

    const conn = createConnection(socket)
    conns.add(conn)
    socket.on('close', () => conns.delete(conn))
    socket.on('error', () => conns.delete(conn))

    // 代理/握手期间可能已经有数据到了, 先喂进去
    if (head.length) conn.feed(head)
    options.onConnect(conn, req)
  })

  return {
    broadcast(text) {
      for (const conn of conns) if (!conn.closed) conn.send(text)
    },
    get size() {
      return conns.size
    },
    dispose() {
      for (const conn of conns) conn.close(1001, 'server shutdown')
      conns.clear()
    },
  }
}

interface InternalConn extends WSConnection {
  feed(chunk: Buffer): void
}

function createConnection(socket: Socket): InternalConn {
  // Buffer.concat 的返回是 Buffer<ArrayBufferLike>, 显式标宽类型, 否则 concat 一来就赋不进
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let closed = false

  socket.on('data', (chunk) => {
    try {
      feed(chunk)
    } catch {
      close(1011, 'frame error')
    }
  })

  function feed(chunk: Buffer): void {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk

    // 一个包里可能有多个帧, 循环到解不出完整帧为止
    for (;;) {
      if (buffer.length < 2) return
      // 长度刚检查过 >= 2, 索引访问收窄掉 undefined
      const b0 = buffer[0]!
      const b1 = buffer[1]!
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let offset = 2

      if (len === 126) {
        if (buffer.length < offset + 2) return
        len = buffer.readUInt16BE(offset)
        offset += 2
      } else if (len === 127) {
        if (buffer.length < offset + 8) return
        const big = buffer.readBigUInt64BE(offset)
        if (big > 8n * 1024n * 1024n) throw new Error('frame too large')
        len = Number(big)
        offset += 8
      }

      let mask: Buffer | null = null
      if (masked) {
        if (buffer.length < offset + 4) return
        mask = buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (buffer.length < offset + len) return

      const payload = Buffer.from(buffer.subarray(offset, offset + len))
      buffer = buffer.subarray(offset + len)
      if (mask) {
        // 掩码异或。两个索引访问都可能 undefined (noUncheckedIndexedAccess), 收窄后再算
        const m = mask
        for (let i = 0; i < payload.length; i++) {
          const k = m[i % 4] ?? 0
          payload[i] = payload[i]! ^ k
        }
      }

      // 客户端只发控制帧给我们; 文本帧目前不解析 (上行走 HTTP)
      if (opcode === 0x8) {
        close(1000, 'client closed')
        return
      }
      if (opcode === 0x9) {
        writeFrame(socket, 0x0a, payload)
      }
    }
  }

  function send(text: string): void {
    if (closed) return
    writeFrame(socket, 0x01, Buffer.from(text, 'utf8'))
  }

  function close(code = 1000, reason = ''): void {
    if (closed) return
    closed = true
    try {
      const body = Buffer.alloc(2 + Buffer.byteLength(reason))
      body.writeUInt16BE(code, 0)
      body.write(reason, 2)
      writeFrame(socket, 0x08, body)
      socket.end()
    } catch {
      socket.destroy()
    }
  }

  return { send, close, feed, get closed() { return closed } }
}

/** 服务端→客户端不掩码 */
function writeFrame(socket: Socket, opcode: number, payload: Buffer): void {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x80 | opcode
  socket.write(Buffer.concat([header, payload]))
}
