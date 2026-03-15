'use strict';
/**
 * ClawTerm Binary Protocol
 * Wire: [FLAG:0x7E][SESSION_ID:4BE][SEQ:4BE][TYPE:1][FLAGS:1][LEN:2BE][PAYLOAD:N][CRC16:2BE]
 * CRC-16/IBM (poly 0x8005, refIn=true, refOut=true) over FLAG..PAYLOAD
 */

const net = require('net');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Frame types
const CT = {
  CONNECT:    0x01,
  ACCEPT:     0x02,
  RESUME:     0x03,
  DATA:       0x10,
  KEEPALIVE:  0x20,
  SUSPEND:    0x30,
  DISCONNECT: 0x40,
};

const FLAG_BYTE = 0x7E;
const HEADER_SIZE = 13; // FLAG(1)+SID(4)+SEQ(4)+TYPE(1)+FLAGS(1)+LEN(2)
const FOOTER_SIZE = 2;  // CRC16

/** CRC-16/IBM (reflected poly 0xA001 = reflected 0x8005) */
function crc16(buf) {
  let crc = 0x0000;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xA001;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return crc & 0xFFFF;
}

function buildFrame(type, sessionId, seq, flags, payload) {
  const payLen = payload ? payload.length : 0;
  const hdr = Buffer.alloc(HEADER_SIZE);
  hdr[0] = FLAG_BYTE;
  hdr.writeUInt32BE(sessionId >>> 0, 1);
  hdr.writeUInt32BE(seq >>> 0, 5);
  hdr[9]  = type;
  hdr[10] = flags;
  hdr.writeUInt16BE(payLen, 11);

  const data = payload ? Buffer.concat([hdr, payload]) : hdr;
  const crc  = crc16(data);
  const crcBuf = Buffer.allocUnsafe(2);
  crcBuf.writeUInt16BE(crc, 0);
  return Buffer.concat([data, crcBuf]);
}

/** CT_CONNECT payload (59 bytes) */
function buildConnectPayload() {
  const buf = Buffer.alloc(59, 0);
  buf[0] = 1;                          // version=1
  buf.writeUInt16BE(0, 1);             // capabilities=0
  buf.writeUInt32BE(0, 3);             // tenant_id=0
  buf.writeUInt32BE(0, 7);             // agent_id=0
  // token = 32 zero bytes @ offset 11
  crypto.randomFillSync(buf, 43, 16);  // nonce = 16 random bytes @ offset 43
  return buf;
}

/** CT_RESUME payload (4 bytes = stored session_id) */
function buildResumePayload(sessionId) {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32BE(sessionId >>> 0, 0);
  return buf;
}

class ClawTermProtocol {
  constructor(opts) {
    this.host        = opts.host || 'localhost';
    this.port        = opts.port || 7220;
    this.sessionFile = opts.sessionFile || path.join(os.homedir(), '.clawterm', 'session.json');

    // callbacks
    this.onConnected    = opts.onConnected;
    this.onMessage      = opts.onMessage;
    this.onDisconnected = opts.onDisconnected;

    this._sessionId       = 0;
    this._seq             = 0;
    this._socket          = null;
    this._buf             = Buffer.alloc(0);
    this._keepaliveTimer  = null;
    this._reconnectTimer  = null;
    this._stopping        = false;
    this._connected       = false;
  }

  // ── persistent session ───────────────────────────────────────────────────

  _loadSession() {
    try {
      const raw = fs.readFileSync(this.sessionFile, 'utf8');
      const d   = JSON.parse(raw);
      return (d && typeof d.sessionId === 'number') ? d.sessionId : 0;
    } catch { return 0; }
  }

  _saveSession(id) {
    try {
      fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true });
      fs.writeFileSync(this.sessionFile, JSON.stringify({ sessionId: id }), 'utf8');
    } catch {}
  }

  _clearSession() {
    try { fs.unlinkSync(this.sessionFile); } catch {}
  }

  // ── sequence ─────────────────────────────────────────────────────────────

  _nextSeq() {
    this._seq = (this._seq + 1) >>> 0;
    return this._seq;
  }

  // ── public API ───────────────────────────────────────────────────────────

  start() {
    this._connect();
  }

  stop() {
    this._stopping = true;
    this._stopKeepalive();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._socket && !this._socket.destroyed) {
      try {
        this._socket.write(buildFrame(CT.DISCONNECT, this._sessionId, this._nextSeq(), 0, null));
      } catch {}
      this._socket.destroy();
    }
  }

  sendData(obj) {
    if (!this._socket || this._socket.destroyed || !this._connected) return false;
    try {
      const payload = Buffer.from(JSON.stringify(obj), 'utf8');
      this._socket.write(buildFrame(CT.DATA, this._sessionId, this._nextSeq(), 0, payload));
      return true;
    } catch { return false; }
  }

  get connected() { return this._connected; }

  // ── internals ────────────────────────────────────────────────────────────

  _connect() {
    const storedId = this._loadSession();
    this._buf      = Buffer.alloc(0);
    this._socket   = net.createConnection({ host: this.host, port: this.port });
    this._socket.setNoDelay(true);

    this._socket.once('connect', () => {
      if (storedId > 0) {
        this._socket.write(buildFrame(CT.RESUME, storedId, this._nextSeq(), 0, buildResumePayload(storedId)));
      } else {
        this._socket.write(buildFrame(CT.CONNECT, 0, this._nextSeq(), 0, buildConnectPayload()));
      }
    });

    this._socket.on('data', (chunk) => {
      this._buf = Buffer.concat([this._buf, chunk]);
      this._drain();
    });

    this._socket.on('close', () => {
      this._connected = false;
      this._stopKeepalive();
      this.onDisconnected?.('connection closed');
      if (!this._stopping) {
        this._reconnectTimer = setTimeout(() => {
          this._reconnectTimer = null;
          this._connect();
        }, 3000);
      }
    });

    this._socket.on('error', (err) => {
      // 'close' fires after 'error', so just surface the message
      this.onDisconnected?.(`error: ${err.message}`);
    });
  }

  _drain() {
    while (this._buf.length >= HEADER_SIZE) {
      // sync to FLAG byte
      if (this._buf[0] !== FLAG_BYTE) {
        const next = this._buf.indexOf(FLAG_BYTE, 1);
        this._buf  = next < 0 ? Buffer.alloc(0) : this._buf.slice(next);
        continue;
      }
      const payLen   = this._buf.readUInt16BE(11);
      const frameLen = HEADER_SIZE + payLen + FOOTER_SIZE;
      if (this._buf.length < frameLen) break;

      const frame    = this._buf.slice(0, frameLen);
      this._buf      = this._buf.slice(frameLen);

      // verify CRC
      const expected = crc16(frame.slice(0, frameLen - FOOTER_SIZE));
      const actual   = frame.readUInt16BE(frameLen - FOOTER_SIZE);
      if (expected !== actual) continue; // discard bad frame

      const type      = frame[9];
      const sessionId = frame.readUInt32BE(1);
      const payload   = payLen > 0 ? frame.slice(HEADER_SIZE, HEADER_SIZE + payLen) : null;

      this._handleFrame(type, sessionId, payload);
    }
  }

  _handleFrame(type, sessionId, payload) {
    switch (type) {
      case CT.ACCEPT:
        // server accepted / resumed — payload is unused; session_id in header
        this._sessionId = sessionId;
        this._saveSession(sessionId);
        this._connected = true;
        this._startKeepalive();
        this.onConnected?.();
        break;

      case CT.DATA:
        if (payload) {
          try {
            this.onMessage?.(JSON.parse(payload.toString('utf8')));
          } catch {}
        }
        break;

      case CT.KEEPALIVE:
        // echo keepalive back
        if (this._socket && !this._socket.destroyed) {
          this._socket.write(buildFrame(CT.KEEPALIVE, this._sessionId, this._nextSeq(), 0, null));
        }
        break;

      case CT.DISCONNECT:
        this._stopping = true;
        this._connected = false;
        this._clearSession();
        if (this._socket && !this._socket.destroyed) this._socket.destroy();
        break;

      default:
        break;
    }
  }

  _startKeepalive() {
    this._stopKeepalive();
    this._keepaliveTimer = setInterval(() => {
      if (this._socket && !this._socket.destroyed && this._connected) {
        this._socket.write(buildFrame(CT.KEEPALIVE, this._sessionId, this._nextSeq(), 0, null));
      }
    }, 30000);
  }

  _stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }
}

module.exports = { ClawTermProtocol, CT, crc16, buildFrame };
