const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/clawterm-ws' });

const CLAWD_HOST = process.env.CLAWD_HOST || '100.114.163.66';
const CLAWD_PORT = parseInt(process.env.CLAWD_PORT || '7220');
const PORT = parseInt(process.env.PORT || '3013');
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || 'claw2026';

// APPLID → baby claw gateway mapping
const BABY_ROUTES = {
  'BABY1':  { host: '100.114.163.66', port: 30801 },
  'BABY2':  { host: '100.114.163.66', port: 30802 },
  'BABY3':  { host: '100.114.163.66', port: 30805 },
  'BABY4':  { host: '100.114.163.66', port: 30803 },
  'BABY5':  { host: '100.114.163.66', port: 30804 },
};

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
  }
}));

wss.on('connection', (ws, req) => {
  console.log('[clawterm-client] RAW req.url:', JSON.stringify(req.url));
  const url = new URL(req.url, 'http://localhost');
  const applid = (url.searchParams.get('applid') || '').toUpperCase().trim();
  console.log('[clawterm-client] req.url=', req.url, 'applid=', applid);
  const babyRoute = BABY_ROUTES[applid];

  if (babyRoute) {
    console.log(`[clawterm-client] BABY connect: APPLID=${applid} -> ${babyRoute.host}:${babyRoute.port}`);
    handleBabySession(ws, applid, babyRoute);
  } else {
    console.log(`[clawterm-client] WS connect from ${req.socket.remoteAddress}`);
    handleClawdSession(ws);
  }
});

function handleClawdSession(ws) {
  const tcp = new net.Socket();
  tcp.connect(CLAWD_PORT, CLAWD_HOST, () => {
    console.log(`[clawterm-client] TCP connected to clawd ${CLAWD_HOST}:${CLAWD_PORT}`);
  });
  ws.on('message', (data) => { if (tcp.writable) tcp.write(data); });
  tcp.on('data', (data) => { if (ws.readyState === ws.OPEN) ws.send(data, { binary: true }); });
  ws.on('close', () => { console.log('[clawterm-client] WS closed'); tcp.destroy(); });
  tcp.on('close', () => {
    console.log('[clawterm-client] TCP closed');
    if (ws.readyState === ws.OPEN) { ws.send(JSON.stringify({ _ctrl: 'ip_down', reason: 'TCP closed' })); ws.close(); }
  });
  tcp.on('error', (err) => {
    console.error('[clawterm-client] TCP error:', err.message);
    if (ws.readyState === ws.OPEN) { ws.send(JSON.stringify({ _ctrl: 'ip_down', reason: err.message })); ws.close(); }
  });
}

function handleBabySession(ws, applid, route) {
  let gws = null;
  let gwReady = false;
  let reqId = 1;
  let pending = [];

  function gwSendRaw(obj) {
    if (gws && gws.readyState === WebSocket.OPEN) gws.send(JSON.stringify(obj));
  }

  function sendToAgent(text) {
    const msg = {
      type: 'req',
      id: String(reqId++),
      method: 'chat.send',
      params: { sessionKey: 'main', message: text, idempotencyKey: crypto.randomUUID() }
    };
    if (gwReady) gwSendRaw(msg);
    else pending.push(msg);
  }

  function termWrite(text) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ _ctrl: 'data', text }));
  }

  const gwUrl = 'ws://' + route.host + ':' + route.port + '/';
  gws = new WebSocket(gwUrl);

  gws.on('open', () => console.log('[clawterm-client] GW open ' + applid));

  gws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch(e) { return; }

    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      gwSendRaw({ type: 'req', id: String(reqId++), method: 'connect', params: {
        minProtocol: 3, maxProtocol: 3,
        client: { id: 'gateway-client', version: '1.0.0', platform: 'linux', mode: 'backend' },
        caps: [], role: 'operator', scopes: ['operator.admin'],
        auth: { token: GATEWAY_TOKEN }
      }});
      return;
    }

    if (msg.type === 'res' && msg.payload && msg.payload.type === 'hello-ok') {
      console.log('[clawterm-client] GW authenticated ' + applid);
      gwReady = true;
      // Signal IP and session up to browser
      ws.send(JSON.stringify({ _ctrl: 'ip_up' }));
      ws.send(JSON.stringify({ _ctrl: 'session_open', sessionId: Math.floor(Math.random() * 0xFFFFFFFF) }));
      termWrite('\r\n\x1b[32m[VT]\x1b[0m \u2713 CF_ACCEPT \u2014 ' + applid + ' live\r\n\x1b[90m    All layers green. Type to send CF_DATA.\x1b[0m\r\n\r\n\x1b[32m$\x1b[0m ');
      for (const m of pending) gwSendRaw(m);
      pending = [];
      return;
    }

    // Streaming agent response deltas
    if (msg.type === 'event' && msg.event === 'agent') {
      const delta = msg.payload && msg.payload.data && msg.payload.data.delta;
      if (delta) termWrite(delta);
      if (msg.payload && msg.payload.stream === 'lifecycle' && msg.payload.data && msg.payload.data.phase === 'end') {
        termWrite('\r\n\x1b[32m$\x1b[0m ');
      }
      return;
    }
  });

  gws.on('close', () => {
    console.log('[clawterm-client] GW closed ' + applid);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ _ctrl: 'ip_down', reason: 'gateway closed' }));
      ws.close();
    }
  });

  gws.on('error', (err) => {
    console.error('[clawterm-client] GW error ' + applid + ':', err.message);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ _ctrl: 'ip_down', reason: err.message }));
      ws.close();
    }
  });

  // Browser input -> baby claw (handles CNA binary frames or plain text)
  let lineBuffer = '';
  ws.on('message', (data) => {
    // JSON ctrl
    try {
      const obj = JSON.parse(data.toString());
      if (obj._ctrl === 'send' && obj.text) { sendToAgent(obj.text); return; }
    } catch(e) {}
    // CNA binary frame
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let text = '';
    if (buf.length >= 15 && buf[0] === 0x7E) {
      const type = buf[9];
      const len  = buf.readUInt16BE(11);
      if (type === 0x05 && buf.length >= 13 + len) {
        text = buf.slice(13, 13 + len).toString('utf8');
      } else {
        return; // PING, SUSPEND etc - ignore
      }
    } else {
      text = buf.toString('utf8');
    }
    // Buffer until Enter
    for (const ch of text) {
      if (ch === '' || ch === '
') {
        if (lineBuffer.trim()) {
          console.log('[clawterm-client] SEND ->', JSON.stringify(lineBuffer));
          sendToAgent(lineBuffer.trim());
          lineBuffer = '';
        }
      } else if (ch === '' || ch === '') {
        lineBuffer = lineBuffer.slice(0, -1); // backspace
      } else if (ch >= ' ' || ch === '	') {
        lineBuffer += ch;
      }
    }
  });

  ws.on('close', () => {
    console.log('[clawterm-client] browser disconnected ' + applid);
    if (gws) gws.close();
  });
}

server.listen(PORT, () => {
  console.log('clawterm-client listening on :' + PORT);
});
