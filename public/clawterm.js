// ClawTerm frame constants
const CF = {
  CONNECT:    0x01,
  ACCEPT:     0x02,
  RESUME:     0x03,
  RESUMED:    0x04,
  DATA:       0x05,
  SUSPEND:    0x06,
  DISCONNECT: 0x07,
  ERROR:      0x08,
  PING:       0x09,
  PONG:       0x0A,
};

const CF_NAMES = {
  0x01: 'CF_CONNECT',
  0x02: 'CF_ACCEPT',
  0x03: 'CF_RESUME',
  0x04: 'CF_RESUMED',
  0x05: 'CF_DATA',
  0x06: 'CF_SUSPEND',
  0x07: 'CF_DISCONNECT',
  0x08: 'CF_ERROR',
  0x09: 'CF_PING',
  0x0A: 'CF_PONG',
};

// CRC-16/CCITT
function crc16(buf) {
  let crc = 0xFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
      else crc <<= 1;
    }
  }
  return crc & 0xFFFF;
}

// Encode a ClawTerm frame to ArrayBuffer
function encodeFrame(sessionId, seq, type, flags, payload) {
  const payloadLen = payload ? payload.length : 0;
  const buf = new ArrayBuffer(13 + payloadLen + 2);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  view.setUint8(0, 0x7E);           // flag
  view.setUint32(1, sessionId);     // session_id (big-endian)
  view.setUint32(5, seq);           // seq
  view.setUint8(9, type);           // type
  view.setUint8(10, flags);         // flags
  view.setUint16(11, payloadLen);   // len

  if (payload) {
    u8.set(new Uint8Array(payload), 13);
  }

  // CRC over everything except flag byte and CRC itself
  const crcBuf = u8.slice(1, 13 + payloadLen);
  const crc = crc16(crcBuf);
  view.setUint16(13 + payloadLen, crc);

  return buf;
}

// Decode a ClawTerm frame from ArrayBuffer
function decodeFrame(buf) {
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  if (u8.length < 15) return null;
  if (view.getUint8(0) !== 0x7E) return null;

  const sessionId = view.getUint32(1);
  const seq = view.getUint32(5);
  const type = view.getUint8(9);
  const flags = view.getUint8(10);
  const len = view.getUint16(11);

  if (u8.length < 13 + len + 2) return null;

  const payload = u8.slice(13, 13 + len);
  const crcReceived = view.getUint16(13 + len);
  const crcComputed = crc16(u8.slice(1, 13 + len));

  if (crcReceived !== crcComputed) {
    console.warn('CRC mismatch', crcReceived, crcComputed);
    return null;
  }

  return { sessionId, seq, type, flags, len, payload };
}

class ClawTermClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.sessionId = 0;
    this.seq = 0;
    this.connected = false;
    this.onData = null;      // callback(text)
    this.onConnect = null;   // callback(sessionId)
    this.onDisconnect = null;
    this.recvBuf = new Uint8Array(0);
  }

  connect(resumeSessionId) {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      console.log('[ClawTerm] WS open, sending CF_CONNECT');
      const payload = new Uint8Array(4);
      if (resumeSessionId) {
        // CF_RESUME
        const view = new DataView(payload.buffer);
        view.setUint32(0, resumeSessionId);
        this._send(resumeSessionId, CF.RESUME, 0, payload.buffer);
      } else {
        // CF_CONNECT
        this._send(0, CF.CONNECT, 0, null);
      }
    };

    this.ws.onmessage = (evt) => {
      this._recv(evt.data);
    };

    this.ws.onclose = () => {
      this.connected = false;
      if (this.onDisconnect) this.onDisconnect();
    };
  }

  sendData(text) {
    if (!this.connected) return;
    const enc = new TextEncoder();
    const payload = enc.encode(text);
    this._send(this.sessionId, CF.DATA, 0, payload.buffer);
  }

  sendPing() {
    this._send(this.sessionId, CF.PING, 0, null);
  }

  disconnect() {
    this._send(this.sessionId, CF.DISCONNECT, 0, null);
    this.ws.close();
  }

  _send(sessionId, type, flags, payload) {
    const frame = encodeFrame(sessionId, ++this.seq, type, flags, payload);
    this.ws.send(frame);
    console.log(`[ClawTerm] → ${CF_NAMES[type]} session=0x${sessionId.toString(16).padStart(8,'0')}`);
  }

  _recv(data) {
    // Append to receive buffer
    const incoming = new Uint8Array(data);
    const combined = new Uint8Array(this.recvBuf.length + incoming.length);
    combined.set(this.recvBuf);
    combined.set(incoming, this.recvBuf.length);
    this.recvBuf = combined;

    // Parse frames
    while (this.recvBuf.length >= 15) {
      const frame = decodeFrame(this.recvBuf.buffer);
      if (!frame) break;

      const frameSize = 13 + frame.len + 2;
      this.recvBuf = this.recvBuf.slice(frameSize);

      console.log(`[ClawTerm] ← ${CF_NAMES[frame.type]} session=0x${frame.sessionId.toString(16).padStart(8,'0')}`);

      switch (frame.type) {
        case CF.ACCEPT:
          this.sessionId = frame.sessionId;
          this.connected = true;
          localStorage.setItem('clawterm_session_id', frame.sessionId);
          if (this.onConnect) this.onConnect(frame.sessionId);
          break;

        case CF.RESUMED:
          this.sessionId = frame.sessionId;
          this.connected = true;
          if (this.onConnect) this.onConnect(frame.sessionId);
          break;

        case CF.DATA:
          if (this.onData) {
            const text = new TextDecoder().decode(frame.payload);
            this.onData(text);
          }
          break;

        case CF.PONG:
          console.log('[ClawTerm] PONG received');
          break;

        case CF.ERROR:
          console.error('[ClawTerm] Error from server');
          break;
      }
    }
  }
}
