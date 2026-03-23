const express = require('express');
const { WebSocketServer } = require('ws');
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

app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const applid = (url.searchParams.get('applid') || '').toUpperCase().trim();
  const babyRoute = BABY_ROUTES[applid];

  if (babyRoute) {
    // Baby claw: direct WebSocket gateway bridge
    console.log();
    handleBabySession(ws, applid, babyRoute);
  } else {
    // Default: raw TCP proxy to clawd
    console.log();
    handleClawdSession(ws);
  }
});

function handleClawdSession(ws) {
  const tcp = new net.Socket();
  tcp.connect(CLAWD_PORT, CLAWD_HOST, () => {
    console.log();
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
  const WebSocket = require('ws');
  let gws = null;
  let gwReady = false;
  let reqId = 1;
  let pending = [];

  function gwSendRaw(obj) {
    if (gws && gws.readyState === WebSocket.OPEN) gws.send(JSON.stringify(obj));
  }

  function sendToAgent(text) {
    const msg = { type: 'req', id: String(reqId++), method: 'chat.send', params: { sessionKey: 'main', message: text, idempotencyKey: crypto.randomUUID() } };
    if (gwReady) gwSendRaw(msg);
    else pending.push(msg);
  }

  // Signal to browser: IP layer up
  function signalIpUp() {
    ws.send(JSON.stringify({ _ctrl: 'ip_up' }));
  }
  // Signal session established with fake session ID
  function signalSessionOpen() {
    ws.send(JSON.stringify({ _ctrl: 'session_open', sessionId: Math.floor(Math.random() * 0xFFFFFFFF) }));
  }
  // Send text to terminal
  function termWrite(text) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ _ctrl: 'data', text }));
  }

  gws = new WebSocket();

  gws.on('open', () => console.log());

  gws.on('message', raw => {
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

    if (msg.type === 'res' && msg.payload?.type === 'hello-ok') {
      console.log();
      gwReady = true;
      signalIpUp();
      signalSessionOpen();
      termWrite();
      for (const m of pending) gwSendRaw(m);
      pending = [];
      return;
    }

    // Streaming agent response
    if (msg.type === 'event' && msg.event === 'agent') {
      const delta = msg.payload?.data?.delta;
      if (delta) termWrite(delta);
      // End of turn
      if (msg.payload?.stream === 'lifecycle' && msg.payload?.data?.phase === 'end') {
        termWrite('\r\n\x1b[32m$\x1b[0m ');
      }
      return;
    }
  });

  gws.on('close', () => {
    console.log();
    if (ws.readyState === ws.OPEN) { ws.send(JSON.stringify({ _ctrl: 'ip_down', reason: 'gateway closed' })); ws.close(); }
  });

  gws.on('error', err => {
    console.error(, err.message);
    if (ws.readyState === ws.OPEN) { ws.send(JSON.stringify({ _ctrl: 'ip_down', reason: err.message })); ws.close(); }
  });

  // Browser → baby claw
  ws.on('message', (data) => {
    // Try JSON control message first
    try {
      const str = data.toString();
      const obj = JSON.parse(str);
      if (obj._ctrl === 'send' && obj.text) { sendToAgent(obj.text); return; }
    } catch(e) {}
    // Raw text
    const text = data.toString().trim();
    if (text) sendToAgent(text);
  });

  ws.on('close', () => {
    console.log();
    if (gws) gws.close();
  });
}

server.listen(PORT, () => {
  console.log();
});
