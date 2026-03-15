/**
 * ClawTerm binary protocol implementation.
 *
 * Wire format: [FLAG:0x7E][SESSION_ID:4BE][SEQ:4BE][TYPE:1][FLAGS:1][LEN:2BE][PAYLOAD:N][CRC16:2BE]
 *
 * CRC-16/IBM: poly=0x8005, init=0x0000, no reflection (CRC-16/BUYPASS)
 * CRC covers: from FLAG byte through end of PAYLOAD.
 */

import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// Frame type constants
export const CT_CONNECT    = 0x01;
export const CT_ACCEPT     = 0x02;
export const CT_DATA       = 0x10;
export const CT_KEEPALIVE  = 0x20;
export const CT_SUSPEND    = 0x30;
export const CT_RESUME     = 0x03;
export const CT_DISCONNECT = 0x40;

// Frame field sizes
const FRAME_FLAG_SIZE       = 1;
const FRAME_SESSION_ID_SIZE = 4;
const FRAME_SEQ_SIZE        = 4;
const FRAME_TYPE_SIZE       = 1;
const FRAME_FLAGS_SIZE      = 1;
const FRAME_LEN_SIZE        = 2;
const FRAME_CRC_SIZE        = 2;
const FRAME_HEADER_SIZE     = FRAME_FLAG_SIZE + FRAME_SESSION_ID_SIZE + FRAME_SEQ_SIZE + FRAME_TYPE_SIZE + FRAME_FLAGS_SIZE + FRAME_LEN_SIZE; // 13
const FRAME_MIN_SIZE        = FRAME_HEADER_SIZE + FRAME_CRC_SIZE; // 15

/**
 * CRC-16/IBM: poly=0x8005, init=0x0000, no reflection (CRC-16/BUYPASS / CRC-16/UMTS)
 * Over all bytes from FLAG through end of PAYLOAD.
 */
function crc16(buf) {
  let crc = 0x0000;
  for (let i = 0; i < buf.length; i++) {
    crc ^= (buf[i] << 8);
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x8005) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return crc;
}

/**
 * Build a ClawTerm frame.
 */
function buildFrame(sessionId, seq, type, flags, payload) {
  const payloadBuf = payload || Buffer.alloc(0);
  const headerAndPayload = Buffer.alloc(FRAME_HEADER_SIZE + payloadBuf.length);

  headerAndPayload[0] = 0x7E;
  headerAndPayload.writeUInt32BE(sessionId >>> 0, 1);
  headerAndPayload.writeUInt32BE(seq >>> 0, 5);
  headerAndPayload[9]  = type & 0xFF;
  headerAndPayload[10] = flags & 0xFF;
  headerAndPayload.writeUInt16BE(payloadBuf.length, 11);
  if (payloadBuf.length > 0) payloadBuf.copy(headerAndPayload, FRAME_HEADER_SIZE);

  const checksum = crc16(headerAndPayload);
  const frame = Buffer.alloc(headerAndPayload.length + FRAME_CRC_SIZE);
  headerAndPayload.copy(frame);
  frame.writeUInt16BE(checksum, headerAndPayload.length);
  return frame;
}

/**
 * Build the CT_CONNECT payload.
 * version=1, capabilities=0, tenant_id=0, agent_id=0, token=32 zero bytes, nonce=16 random bytes
 */
function buildConnectPayload() {
  // 1 + 4 + 4 + 4 + 32 + 16 = 61 bytes
  const payload = Buffer.alloc(61, 0);
  let off = 0;
  payload[off++] = 0x01;             // version = 1
  payload.writeUInt32BE(0, off); off += 4; // capabilities = 0
  payload.writeUInt32BE(0, off); off += 4; // tenant_id = 0
  payload.writeUInt32BE(0, off); off += 4; // agent_id = 0
  // token: 32 zero bytes (already zeroed)
  off += 32;
  // nonce: 16 random bytes
  crypto.randomFillSync(payload, off, 16);
  return payload;
}

/**
 * Build the CT_RESUME payload.
 * session_id: 4 bytes BE
 */
function buildResumePayload(sessionId) {
  const payload = Buffer.alloc(4);
  payload.writeUInt32BE(sessionId >>> 0, 0);
  return payload;
}

/**
 * ClawTermClient — manages a TCP connection to clawtermd.
 *
 * Events:
 *   'connected'    (sessionId: number)
 *   'data'         (text: string)
 *   'disconnect'   (reason: string)
 *   'error'        (err: Error)
 */
export class ClawTermClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.host       = opts.host || 'localhost';
    this.port       = opts.port || 7220;
    this.sessionId  = opts.sessionId || 0; // 0 means new session
    this.seq        = 0;
    this.socket     = null;
    this.recvBuf    = Buffer.alloc(0);
    this.keepaliveTimer = null;
    this.connected  = false;
    this._destroyed = false;
  }

  /** Connect (or reconnect with stored sessionId). */
  connect() {
    if (this._destroyed) return;
    this.socket = new net.Socket();

    this.socket.on('connect', () => {
      if (this.sessionId !== 0) {
        // Resume existing session
        this._send(CT_RESUME, 0, buildResumePayload(this.sessionId));
      } else {
        // New session
        this._send(CT_CONNECT, 0, buildConnectPayload());
      }
    });

    this.socket.on('data', (chunk) => {
      this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
      this._processBuffer();
    });

    this.socket.on('error', (err) => {
      this.emit('error', err);
    });

    this.socket.on('close', () => {
      this.connected = false;
      this._stopKeepalive();
      if (!this._destroyed) {
        this.emit('disconnect', 'connection closed');
      }
    });

    this.socket.connect(this.port, this.host);
  }

  _nextSeq() {
    const s = this.seq;
    this.seq = (this.seq + 1) >>> 0;
    return s;
  }

  _send(type, flags, payload) {
    if (!this.socket || this.socket.destroyed) return;
    const frame = buildFrame(this.sessionId, this._nextSeq(), type, flags, payload);
    try {
      this.socket.write(frame);
    } catch (_) {
      // socket closed
    }
  }

  _processBuffer() {
    while (this.recvBuf.length >= FRAME_MIN_SIZE) {
      // Sync to FLAG byte
      let start = 0;
      while (start < this.recvBuf.length && this.recvBuf[start] !== 0x7E) start++;
      if (start > 0) this.recvBuf = this.recvBuf.slice(start);
      if (this.recvBuf.length < FRAME_MIN_SIZE) break;

      const payloadLen = this.recvBuf.readUInt16BE(11);
      const totalLen   = FRAME_HEADER_SIZE + payloadLen + FRAME_CRC_SIZE;

      if (this.recvBuf.length < totalLen) break; // wait for more data

      const frameData    = this.recvBuf.slice(0, totalLen);
      this.recvBuf       = this.recvBuf.slice(totalLen);

      // Verify CRC
      const receivedCrc  = frameData.readUInt16BE(totalLen - FRAME_CRC_SIZE);
      const computedCrc  = crc16(frameData.slice(0, totalLen - FRAME_CRC_SIZE));
      if (receivedCrc !== computedCrc) {
        // CRC mismatch — skip this frame
        continue;
      }

      const frameSessionId = frameData.readUInt32BE(1);
      const seq            = frameData.readUInt32BE(5);
      const frameType      = frameData[9];
      const frameFlags     = frameData[10];
      const payload        = frameData.slice(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + payloadLen);

      void seq; void frameFlags; void frameSessionId; // used for debugging only
      this._handleFrame(frameType, payload);
    }
  }

  _handleFrame(type, payload) {
    switch (type) {
      case CT_ACCEPT: {
        this.sessionId = payload.readUInt32BE(0);
        this.connected = true;
        this._startKeepalive();
        this.emit('connected', this.sessionId);
        break;
      }
      case CT_DATA: {
        this.emit('data', payload.toString('utf8'));
        break;
      }
      case CT_KEEPALIVE: {
        // Echo keepalive back
        this._send(CT_KEEPALIVE, 0);
        break;
      }
      case CT_DISCONNECT: {
        this.connected = false;
        this._stopKeepalive();
        this.socket?.destroy();
        this.emit('disconnect', 'server disconnected');
        break;
      }
      default:
        // Unknown frame type — ignore
        break;
    }
  }

  _startKeepalive() {
    this._stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.connected) this._send(CT_KEEPALIVE, 0);
    }, 30_000);
    if (this.keepaliveTimer.unref) this.keepaliveTimer.unref();
  }

  _stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  /** Send text data to the server. */
  sendData(text) {
    if (!this.connected) return false;
    this._send(CT_DATA, 0, Buffer.from(text, 'utf8'));
    return true;
  }

  /** Notify server we're suspending (session kept alive server-side). */
  suspend() {
    if (this.connected) this._send(CT_SUSPEND, 0);
  }

  /** Clean shutdown. */
  disconnect() {
    if (this.connected) this._send(CT_DISCONNECT, 0);
    this._stopKeepalive();
    // Give the disconnect frame a moment to flush
    setTimeout(() => this.socket?.destroy(), 100).unref?.();
  }

  /** Force destroy the socket. */
  destroy() {
    this._destroyed = true;
    this._stopKeepalive();
    this.socket?.destroy();
  }
}
