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
  const payloadLen = payload ? payload.byteLength || payload.length : 0;
  const buf = new ArrayBuffer(13 + payloadLen + 2);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  view.setUint8(0, 0x7E);
  view.setUint32(1, sessionId);
  view.setUint32(5, seq);
  view.setUint8(9, type);
  view.setUint8(10, flags);
  view.setUint16(11, payloadLen);

  if (payload) {
    u8.set(new Uint8Array(payload instanceof ArrayBuffer ? payload : payload.buffer || payload), 13);
  }

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
    this.onData = null;
    this.onConnect = null;
    this.onDisconnect = null;
    this.onIpUp = null;
    this.onIpDown = null;
    this.recvBuf = new Uint8Array(0);
  }

  // applid: 8-char string, space-padded, uppercase (e.g. "CLAW    ")
  connect(resumeSessionId, applid) {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      if (resumeSessionId) {
        // CF_RESUME
        const view = new DataView(new ArrayBuffer(8));
        view.setUint32(0, resumeSessionId);
        view.setUint32(4, 0); // last_seq = 0
        this._send(resumeSessionId, CF.RESUME, 0, view.buffer);
      } else {
        // CF_CONNECT with APPLID payload
        const enc = new TextEncoder();
        const applidStr = (applid || 'CLAW    ')
          .toUpperCase()
          .padEnd(8, ' ')
          .substring(0, 8);
        const applidBytes = enc.encode(applidStr); // 8 bytes
        this._send(0, CF.CONNECT, 0, applidBytes.buffer);
        console.log('[ClawTerm] CF_CONNECT APPLID=' + JSON.stringify(applidStr));
      }
    };

    this.ws.onmessage = (evt) => this._recv(evt.data);

    this.ws.onclose = () => {
      this.connected = false;
      if (this.onDisconnect) this.onDisconnect();
    };

    this.ws.onerror = () => {
      // onerror fires before onclose, let onclose handle state
    };
  }

  sendData(text) {
    if (!this.connected) return;
    const enc = new TextEncoder();
    this._send(this.sessionId, CF.DATA, 0, enc.encode(text).buffer);
  }

  sendPing() {
    this._send(this.sessionId, CF.PING, 0, null);
  }

  suspend() {
    if (this.connected) {
      this._send(this.sessionId, CF.SUSPEND, 0, null);
    }
    if (this.ws) this.ws.close();
    this.connected = false;
  }

  disconnect() {
    this._send(this.sessionId, CF.DISCONNECT, 0, null);
    if (this.ws) this.ws.close();
    this.connected = false;
  }

  _send(sessionId, type, flags, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const frame = encodeFrame(sessionId, ++this.seq, type, flags, payload);
    this.ws.send(frame);
    console.log(`[ClawTerm] \u2192 ${CF_NAMES[type]} session=0x${sessionId.toString(16).padStart(8,'0')}`);
  }

  _recv(data) {
    // Check for JSON control messages (string or ArrayBuffer)
    let ctrlText = null;
    if (typeof data === 'string') ctrlText = data;
    else if (data instanceof ArrayBuffer) {
      const t = new TextDecoder().decode(data);
      if (t.startsWith('{')) ctrlText = t;
    }
    if (ctrlText && ctrlText.startsWith('{')) {
      try {
        const ctrl = JSON.parse(ctrlText);
        if (ctrl._ctrl === 'ip_up'   && this.onIpUp)   { this.onIpUp();              return; }
        if (ctrl._ctrl === 'ip_down' && this.onIpDown)  { this.onIpDown(ctrl.reason); return; }
        if (ctrl._ctrl === 'session_open') {
          this.sessionId = ctrl.sessionId;
          this.connected = true;
          localStorage.setItem('clawterm_session_id', ctrl.sessionId);
          if (this.onConnect) this.onConnect(ctrl.sessionId);
          return;
        }
        if (ctrl._ctrl === 'data' && this.onData) { this.onData(ctrl.text); return; }
      } catch(e) {}
    }
    if (typeof data === 'string') return; // ignore non-JSON strings

    const incoming = new Uint8Array(data);
    const combined = new Uint8Array(this.recvBuf.length + incoming.length);
    combined.set(this.recvBuf);
    combined.set(incoming, this.recvBuf.length);
    this.recvBuf = combined;

    while (this.recvBuf.length >= 15) {
      const frame = decodeFrame(this.recvBuf.buffer);
      if (!frame) break;

      const frameSize = 13 + frame.len + 2;
      this.recvBuf = this.recvBuf.slice(frameSize);

      console.log(`[ClawTerm] \u2190 ${CF_NAMES[frame.type]} session=0x${frame.sessionId.toString(16).padStart(8,'0')}`);

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
