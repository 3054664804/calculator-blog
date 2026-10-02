/**
 * 最小可用 WebSocket 客户端（仅客户端、仅文本帧）。
 *
 * 为什么不用 Node 内置的 `WebSocket`：
 *   在受限安全环境（企业策略 / 沙箱）下，Node 内置实现（undici）向
 *   Chromium 的 DevTools 端口发起握手会被直接断开（close 1006），
 *   而手工构造的升级请求可以正常拿到 101 Switching Protocols。
 *   为了不把截图流程卡在这个依赖上，这里用 node:net 自己实现了
 *   RFC 6455 的客户端侧：握手、掩码、分片、以及 ping/pong 控制帧。
 *
 * 能力范围（够 CDP 用即可）：
 *   * 文本帧、掩码发送；
 *   * 接收分片（continuation）与 8/9/10 控制帧，超过 64KB 的大消息也能收；
 *   * 不做扩展协商（不发 permessage-deflate），不做 TLS。
 */

import { randomBytes } from 'node:crypto'
import net from 'node:net'

const OPCODE_CONTINUATION = 0x0
const OPCODE_TEXT = 0x1
const OPCODE_CLOSE = 0x8
const OPCODE_PING = 0x9
const OPCODE_PONG = 0xa

export class MiniWebSocket {
  #socket
  #buffer = Buffer.alloc(0)
  #handshakeDone = false
  #fragments = []
  #listeners = new Map()

  constructor(url) {
    const target = new URL(url)
    if (target.protocol !== 'ws:') throw new Error(`MiniWebSocket 只支持 ws:// ，收到 ${url}`)

    this.#socket = net.connect({
      host: target.hostname,
      port: Number(target.port || 80),
    })

    const key = randomBytes(16).toString('base64')

    this.#socket.on('connect', () => {
      this.#socket.write(
        [
          `GET ${target.pathname}${target.search} HTTP/1.1`,
          `Host: ${target.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      )
    })

    this.#socket.on('data', (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk])
      if (!this.#handshakeDone) {
        const headerEnd = this.#buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const header = this.#buffer.subarray(0, headerEnd).toString('latin1')
        this.#buffer = this.#buffer.subarray(headerEnd + 4)
        const statusLine = header.split('\r\n')[0]
        if (!/ 101 /.test(statusLine)) {
          this.#emit('error', new Error(`WebSocket 握手失败：${statusLine}`))
          this.#socket.destroy()
          return
        }
        this.#handshakeDone = true
        this.#emit('open')
      }
      this.#parseFrames()
    })

    this.#socket.on('error', (error) => this.#emit('error', error))
    this.#socket.on('close', () => this.#emit('close'))
  }

  on(event, handler) {
    const list = this.#listeners.get(event) || []
    list.push(handler)
    this.#listeners.set(event, list)
    return this
  }

  #emit(event, payload) {
    for (const handler of this.#listeners.get(event) || []) handler(payload)
  }

  /** 发送一个文本帧（客户端必须掩码） */
  send(text) {
    const payload = Buffer.from(text, 'utf8')
    const mask = randomBytes(4)

    let header
    if (payload.length < 126) {
      header = Buffer.alloc(2)
      header[1] = 0x80 | payload.length
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4)
      header[1] = 0x80 | 126
      header.writeUInt16BE(payload.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    header[0] = 0x80 | OPCODE_TEXT

    const masked = Buffer.alloc(payload.length)
    for (let index = 0; index < payload.length; index += 1) {
      masked[index] = payload[index] ^ mask[index % 4]
    }

    this.#socket.write(Buffer.concat([header, mask, masked]))
  }

  close() {
    this.#socket.destroy()
  }

  #parseFrames() {
    for (;;) {
      if (this.#buffer.length < 2) return

      const first = this.#buffer[0]
      const second = this.#buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0

      let length = second & 0x7f
      let offset = 2

      if (length === 126) {
        if (this.#buffer.length < offset + 2) return
        length = this.#buffer.readUInt16BE(offset)
        offset += 2
      } else if (length === 127) {
        if (this.#buffer.length < offset + 8) return
        length = Number(this.#buffer.readBigUInt64BE(offset))
        offset += 8
      }

      let maskKey = null
      if (masked) {
        if (this.#buffer.length < offset + 4) return
        maskKey = this.#buffer.subarray(offset, offset + 4)
        offset += 4
      }

      if (this.#buffer.length < offset + length) return

      let payload = this.#buffer.subarray(offset, offset + length)
      if (masked && maskKey) {
        const unmasked = Buffer.from(payload)
        for (let index = 0; index < unmasked.length; index += 1) {
          unmasked[index] ^= maskKey[index % 4]
        }
        payload = unmasked
      }
      this.#buffer = this.#buffer.subarray(offset + length)

      this.#handleFrame(fin, opcode, payload)
    }
  }

  #handleFrame(fin, opcode, payload) {
    this.#emit('frame', { fin, opcode, length: payload.length })

    if (opcode === OPCODE_PING) {
      // 回一个 pong（控制帧不允许分片）
      const mask = randomBytes(4)
      const header = Buffer.alloc(2)
      header[0] = 0x80 | OPCODE_PONG
      header[1] = 0x80 | payload.length
      const masked = Buffer.from(payload)
      for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4]
      this.#socket.write(Buffer.concat([header, mask, masked]))
      return
    }

    if (opcode === OPCODE_PONG) return

    if (opcode === OPCODE_CLOSE) {
      this.#emit('close')
      this.#socket.destroy()
      return
    }

    if (opcode === OPCODE_TEXT || opcode === OPCODE_CONTINUATION) {
      this.#fragments.push(payload)
      if (!fin) return
      const message = Buffer.concat(this.#fragments).toString('utf8')
      this.#fragments = []
      this.#emit('message', message)
      return
    }

    // 其它 opcode（二进制等）本项目用不到，直接忽略
  }
}
