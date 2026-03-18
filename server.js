const express = require('express');
const { WebSocketServer } = require('ws');
const net = require('net');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/clawterm-ws' });

const CLAWD_HOST = process.env.CLAWD_HOST || '100.114.163.66';
const CLAWD_PORT = parseInt(process.env.CLAWD_PORT || '7220');
const PORT = parseInt(process.env.PORT || '3013');

app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', (ws, req) => {
  console.log(`[clawterm-client] WS connect from ${req.socket.remoteAddress}`);

  const tcp = new net.Socket();

  tcp.connect(CLAWD_PORT, CLAWD_HOST, () => {
    console.log(`[clawterm-client] TCP connected to clawd ${CLAWD_HOST}:${CLAWD_PORT}`);
  });

  // WS → TCP (client sends frame to clawd)
  ws.on('message', (data) => {
    if (tcp.writable) {
      tcp.write(data);
    }
  });

  // TCP → WS (clawd sends frame to client)
  tcp.on('data', (data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data, { binary: true });
    }
  });

  ws.on('close', () => {
    console.log('[clawterm-client] WS closed');
    tcp.destroy();
  });

  tcp.on('close', () => {
    console.log('[clawterm-client] TCP closed');
    if (ws.readyState === ws.OPEN) ws.close();
  });

  tcp.on('error', (err) => {
    console.error('[clawterm-client] TCP error:', err.message);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
      ws.close();
    }
  });
});

server.listen(PORT, () => {
  console.log(`clawterm-client listening on :${PORT}`);
});
