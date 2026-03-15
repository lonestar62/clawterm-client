'use strict';
/**
 * ClawTermClient — wraps ClawTermProtocol with JSON-RPC request/response and
 * event dispatch, exposing the same interface the original GatewayChatClient did.
 */

const { ClawTermProtocol } = require('./protocol');
const { randomUUID } = require('crypto');

class ClawTermClient {
  constructor(opts) {
    this._pending = new Map(); // id → { resolve, reject, timer }
    this._seq     = 0;

    // public callbacks (set by app)
    this.onConnected    = null;
    this.onDisconnected = null;
    this.onEvent        = null;
    this.onGap          = null;

    // last received event seq for gap detection
    this._lastSeq = -1;

    this._proto = new ClawTermProtocol({
      host:        opts.host,
      port:        opts.port,
      sessionFile: opts.sessionFile,

      onConnected: () => {
        this._lastSeq = -1;
        this.onConnected?.();
      },

      onDisconnected: (reason) => {
        // reject all pending requests
        for (const [, p] of this._pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`disconnected: ${reason}`));
        }
        this._pending.clear();
        this.onDisconnected?.(reason);
      },

      onMessage: (msg) => this._onMessage(msg),
    });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  start() { this._proto.start(); }
  stop()  { this._proto.stop(); }

  get connected() { return this._proto.connected; }

  // ── JSON-RPC request ──────────────────────────────────────────────────────

  request(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = `req-${++this._seq}`;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`request "${method}" timed out`));
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timer });

      const sent = this._proto.sendData({ id, method, params: params || {} });
      if (!sent) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new Error('not connected'));
      }
    });
  }

  // ── outbound helpers ──────────────────────────────────────────────────────

  async sendChat(opts) {
    const runId = opts.runId || randomUUID();
    await this.request('chat.send', {
      sessionKey:     opts.sessionKey,
      message:        opts.message,
      thinking:       opts.thinking,
      deliver:        opts.deliver,
      timeoutMs:      opts.timeoutMs,
      idempotencyKey: runId,
    });
    return { runId };
  }

  async abortChat(opts) {
    return this.request('chat.abort', {
      sessionKey: opts.sessionKey,
      runId:      opts.runId,
    });
  }

  async loadHistory(opts) {
    return this.request('chat.history', {
      sessionKey: opts.sessionKey,
      limit:      opts.limit,
    });
  }

  async listSessions(opts) {
    return this.request('sessions.list', {
      limit:               opts?.limit,
      activeMinutes:       opts?.activeMinutes,
      includeGlobal:       opts?.includeGlobal,
      includeUnknown:      opts?.includeUnknown,
      includeDerivedTitles: opts?.includeDerivedTitles,
      includeLastMessage:  opts?.includeLastMessage,
      agentId:             opts?.agentId,
    });
  }

  async listAgents() {
    return this.request('agents.list', {});
  }

  async patchSession(opts) {
    return this.request('sessions.patch', opts);
  }

  async resetSession(key, reason) {
    return this.request('sessions.reset', { key, ...(reason ? { reason } : {}) });
  }

  async getStatus() {
    return this.request('status', {});
  }

  async listModels() {
    const res = await this.request('models.list', {});
    return Array.isArray(res?.models) ? res.models : [];
  }

  // ── inbound message handler ───────────────────────────────────────────────

  _onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    // JSON-RPC response
    if (typeof msg.id === 'string' && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        p.resolve(msg.result !== undefined ? msg.result : msg);
      }
      return;
    }

    // Server event (chat, agent, etc.)
    if (typeof msg.event === 'string') {
      // Gap detection
      if (typeof msg.seq === 'number' && this._lastSeq >= 0 && msg.seq !== this._lastSeq + 1) {
        this.onGap?.({ expected: this._lastSeq + 1, received: msg.seq });
      }
      if (typeof msg.seq === 'number') this._lastSeq = msg.seq;

      this.onEvent?.({ event: msg.event, payload: msg.payload, seq: msg.seq });
    }
  }
}

module.exports = { ClawTermClient };
