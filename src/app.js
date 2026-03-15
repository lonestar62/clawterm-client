'use strict';
/**
 * ClawTerm — main application
 * Wires ClawTermClient (TCP binary protocol) + ClawTermTUI (blessed UI)
 * to provide an OpenClaw-TUI-identical experience over clawtermd.
 */

const os     = require('os');
const path   = require('path');
const { randomUUID } = require('crypto');
const chalk  = require('chalk');

const { ClawTermClient }  = require('./client');
const { ClawTermTUI }     = require('./tui');
const { StreamAssembler } = require('./assembler');
const { P }               = require('./markdown');

// ── slash commands ────────────────────────────────────────────────────────────

const SLASH_COMMANDS = [
  { name: 'help',       description: 'Show help' },
  { name: 'status',     description: 'Show server status' },
  { name: 'session',    description: 'Switch session (or open picker)' },
  { name: 'sessions',   description: 'Open session picker' },
  { name: 'model',      description: 'Set model (or open picker)' },
  { name: 'models',     description: 'Open model picker' },
  { name: 'think',      description: 'Set thinking level (off/low/medium/high)' },
  { name: 'verbose',    description: 'Set verbose on/off' },
  { name: 'usage',      description: 'Toggle usage footer off/tokens/full' },
  { name: 'new',        description: 'Start a new session' },
  { name: 'reset',      description: 'Reset current session' },
  { name: 'abort',      description: 'Abort active run' },
  { name: 'settings',   description: 'Open settings' },
  { name: 'exit',       description: 'Exit ClawTerm' },
  { name: 'quit',       description: 'Exit ClawTerm' },
];

function helpText() {
  return [
    'Slash commands:',
    '/help                  — this message',
    '/status                — server status',
    '/session <key>         — switch session',
    '/sessions              — session picker',
    '/model <name>          — set model',
    '/models                — model picker',
    '/think <off|low|med|high> — thinking level',
    '/verbose <on|off>      — verbose tool output',
    '/usage <off|tokens|full> — token usage footer',
    '/new                   — new session',
    '/reset                 — reset session',
    '/abort                 — abort active run',
    '/settings              — open settings',
    '/exit  /quit           — exit',
    '',
    'Keyboard shortcuts:',
    'Enter        — send message',
    'Up/Down      — input history',
    'Ctrl+T       — toggle thinking display',
    'Ctrl+O       — toggle tool output',
    'Ctrl+C       — clear / exit',
    'Ctrl+D       — exit',
    'Escape       — abort active run',
  ].join('\n');
}

// ── token formatting ──────────────────────────────────────────────────────────

function fmtTokens(n) {
  if (n == null) return '?';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(0) + 'k';
  return String(n);
}

function fmtTokenLine(total, ctx) {
  const t = fmtTokens(total);
  const c = fmtTokens(ctx);
  if (ctx && total != null) {
    const pct = Math.min(999, Math.round((total / ctx) * 100));
    return `tokens ${t}/${c} (${pct}%)`;
  }
  return `tokens ${t}`;
}

// ── elapsed ───────────────────────────────────────────────────────────────────

function fmtElapsed(startMs) {
  const s = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ── main runApp ───────────────────────────────────────────────────────────────

async function runApp(opts) {
  const host        = opts.host || process.env.CT_HOST || 'localhost';
  const port        = parseInt(opts.port || process.env.CT_PORT || '7220', 10);
  const sessionFile = opts.sessionFile || path.join(os.homedir(), '.clawterm', 'session.json');
  const autoMessage = opts.message?.trim() || null;

  // mutable state
  let currentSessionKey = opts.session || 'main';
  let activeChatRunId   = null;
  let isConnected       = false;
  let wasDisconnected   = false;
  let showThinking      = false;
  let toolsExpanded     = false;
  let exitRequested     = false;
  let autoMessageSent   = false;
  let activityStatus    = 'idle';
  let connectionStatus  = 'connecting';
  let lastCtrlCAt       = 0;
  let busyStartedAt     = null;

  let sessionInfo = {
    model:         null,
    modelProvider: null,
    thinkingLevel: null,
    verboseLevel:  null,
    responseUsage: null,
    totalTokens:   null,
    contextTokens: null,
    displayName:   null,
  };

  const localRunIds   = new Set();
  const sessionRuns   = new Map();
  const finalizedRuns = new Map();
  const assembler     = new StreamAssembler();

  // running assistant entries (runId → { lines, rendered })
  const streamingEntries = new Map();

  // ── TUI setup ─────────────────────────────────────────────────────────────

  const tui = new ClawTermTUI();

  // ── Client setup ──────────────────────────────────────────────────────────

  const client = new ClawTermClient({ host, port, sessionFile });

  // ── helpers ───────────────────────────────────────────────────────────────

  const isBusy = () => ['sending','waiting','streaming','running'].includes(activityStatus);

  const setActivity = (status) => {
    activityStatus = status;
    if (isBusy()) {
      if (!busyStartedAt) busyStartedAt = Date.now();
      tui.setBusyStart(busyStartedAt);
      tui.setConnStatus(connectionStatus);
      tui.setStatus(`${status} • ${fmtElapsed(busyStartedAt)} | ${connectionStatus}`, true);
    } else {
      busyStartedAt = null;
      tui.setStatus(`${connectionStatus} | ${status}`, false);
    }
  };

  const setConnection = (text, ttlMs) => {
    connectionStatus = text;
    tui.setConnStatus(text);
    if (!isBusy()) {
      tui.setStatus(`${text} | ${activityStatus}`, false);
    }
    if (ttlMs) {
      setTimeout(() => {
        connectionStatus = isConnected ? 'connected' : 'disconnected';
        tui.setConnStatus(connectionStatus);
        if (!isBusy()) tui.setStatus(`${connectionStatus} | ${activityStatus}`, false);
      }, ttlMs);
    }
  };

  const updateHeader = () => {
    tui.setHeader(`clawterm - ${host}:${port} - session ${currentSessionKey}`);
  };

  const updateFooter = () => {
    const session = currentSessionKey;
    const model   = sessionInfo.model
      ? (sessionInfo.modelProvider ? `${sessionInfo.modelProvider}/${sessionInfo.model}` : sessionInfo.model)
      : 'unknown';
    const tokens  = fmtTokenLine(sessionInfo.totalTokens, sessionInfo.contextTokens);
    const think   = sessionInfo.thinkingLevel && sessionInfo.thinkingLevel !== 'off'
      ? ` | think ${sessionInfo.thinkingLevel}` : '';
    const verbose = sessionInfo.verboseLevel && sessionInfo.verboseLevel !== 'off'
      ? ` | verbose ${sessionInfo.verboseLevel}` : '';
    tui.setFooter(`session ${session} | ${model}${think}${verbose} | ${tokens}`);
  };

  const noteLocalRun = (id) => { localRunIds.add(id); };
  const isLocalRun   = (id) => localRunIds.has(id);
  const forgetRun    = (id) => { localRunIds.delete(id); };
  const clearRuns    = ()   => { localRunIds.clear(); };

  // ── history loading ───────────────────────────────────────────────────────

  const loadHistory = async () => {
    try {
      const record = await client.loadHistory({ sessionKey: currentSessionKey, limit: 200 });
      const showTools = (sessionInfo.verboseLevel || 'off') !== 'off';

      tui.clearLog();
      tui.addSystem(`session ${currentSessionKey}`);

      for (const msg of (record?.messages || [])) {
        if (!msg || typeof msg !== 'object') continue;
        if (msg.command === true) {
          const t = extractText(msg);
          if (t) tui.addSystem(t);
          continue;
        }
        if (msg.role === 'user') {
          const t = extractText(msg);
          if (t) tui.addUser(t);
          continue;
        }
        if (msg.role === 'assistant') {
          const thinkText   = extractThinkingText(msg);
          const contentText = extractContentText(msg);
          tui.addAssistant(thinkText, contentText, showThinking);
          continue;
        }
      }

      // Update session info from history record
      if (record?.thinkingLevel) sessionInfo.thinkingLevel = record.thinkingLevel;
      if (record?.verboseLevel)  sessionInfo.verboseLevel  = record.verboseLevel;

    } catch (err) {
      tui.addSystem(`history failed: ${err.message}`);
    }
    await refreshSessionInfo();
    tui.render();
  };

  const refreshSessionInfo = async () => {
    try {
      const result = await client.listSessions({ includeGlobal: false });
      const entry  = result?.sessions?.find((s) => s.key === currentSessionKey);
      if (entry) {
        if (entry.model)         sessionInfo.model         = entry.model;
        if (entry.modelProvider) sessionInfo.modelProvider = entry.modelProvider;
        if (entry.thinkingLevel !== undefined) sessionInfo.thinkingLevel = entry.thinkingLevel;
        if (entry.verboseLevel  !== undefined) sessionInfo.verboseLevel  = entry.verboseLevel;
        if (entry.totalTokens   !== undefined) sessionInfo.totalTokens   = entry.totalTokens;
        if (entry.contextTokens !== undefined) sessionInfo.contextTokens = entry.contextTokens;
        if (entry.displayName   !== undefined) sessionInfo.displayName   = entry.displayName;
      }
      updateFooter();
    } catch {
      // server may not support sessions.list — silently ignore
    }
  };

  // ── text extraction (mirrors OpenClaw formatters) ─────────────────────────

  function extractText(msg) {
    const c = msg?.content;
    if (typeof c === 'string') return c.trim();
    if (Array.isArray(c)) {
      return c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
    }
    return '';
  }

  function extractThinkingText(msg) {
    const c = msg?.content;
    if (!Array.isArray(c)) return '';
    return c.filter((b) => b?.type === 'thinking').map((b) => b.thinking || '').join('\n').trim();
  }

  function extractContentText(msg) {
    const c = msg?.content;
    if (typeof c === 'string') return c.trim();
    if (!Array.isArray(c)) return '';
    const parts = c.filter((b) => b?.type === 'text').map((b) => b.text);
    if (parts.length) return parts.join('\n').trim();
    if (msg?.stopReason === 'error') return `[error] ${msg?.errorMessage || ''}`;
    return '';
  }

  // ── event handlers ─────────────────────────────────────────────────────────

  const pruneMap = (map) => {
    if (map.size <= 200) return;
    const keep = Date.now() - 600000;
    for (const [k, ts] of map) {
      if (map.size <= 150) break;
      if (ts < keep) map.delete(k);
    }
  };

  client.onEvent = ({ event, payload }) => {
    if (event === 'chat')  handleChatEvent(payload);
    if (event === 'agent') handleAgentEvent(payload);
  };

  function handleChatEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    const evt = payload;

    // ignore events for other sessions
    if (evt.sessionKey && evt.sessionKey !== currentSessionKey) return;

    // ignore already-finalized runs on delta/final
    if (finalizedRuns.has(evt.runId)) {
      if (evt.state === 'delta' || evt.state === 'final') return;
    }

    sessionRuns.set(evt.runId, Date.now());
    pruneMap(sessionRuns);

    if (!activeChatRunId) activeChatRunId = evt.runId;

    if (evt.state === 'delta') {
      const result = assembler.ingestDelta(evt.runId, evt.message, showThinking);
      if (!result) return;

      // Streaming: show thinking block and text progressively
      // We track a single "current" entry per runId
      if (!streamingEntries.has(evt.runId)) {
        streamingEntries.set(evt.runId, { started: false });
      }
      const entry = streamingEntries.get(evt.runId);
      if (!entry.started) {
        entry.started = true;
        tui.addSystem(''); // blank line before streaming response
      }

      // Show the latest delta text
      if (result.thinkingText && showThinking && !entry.shownThinkHeader) {
        entry.shownThinkHeader = true;
        tui.addSystem(chalk.hex(P.thinking)('[🤔 thinking]'));
      }
      if (result.thinkingText && showThinking) {
        const last = result.thinkingText.split('\n').slice(-3).join('\n');
        // don't spam; just update in-place via last few lines
      }

      setActivity('streaming');
    }

    if (evt.state === 'final') {
      const wasActive = activeChatRunId === evt.runId;
      if (!evt.message) {
        assembler.drop(evt.runId);
        streamingEntries.delete(evt.runId);
        finalizedRuns.set(evt.runId, Date.now());
        if (wasActive) { activeChatRunId = null; setActivity('idle'); }
        tui.render();
        return;
      }

      const result = assembler.finalize(evt.runId, evt.message, showThinking, evt.errorMessage);
      streamingEntries.delete(evt.runId);
      finalizedRuns.set(evt.runId, Date.now());
      sessionRuns.delete(evt.runId);
      pruneMap(finalizedRuns);

      if (result.displayText && result.displayText !== '(no output)') {
        tui.addAssistant(result.thinkingText, result.contentText, showThinking);
      } else if (!isLocalRun(evt.runId)) {
        // drop — no output, not our run
      }

      forgetRun(evt.runId);
      if (wasActive) {
        activeChatRunId = null;
        const sr = typeof evt.message?.stopReason === 'string' ? evt.message.stopReason : '';
        setActivity(sr === 'error' ? 'error' : 'idle');
      }
      refreshSessionInfo().catch(() => {});
      tui.render();
    }

    if (evt.state === 'aborted') {
      const wasActive = activeChatRunId === evt.runId;
      tui.addSystem('run aborted');
      assembler.drop(evt.runId);
      streamingEntries.delete(evt.runId);
      sessionRuns.delete(evt.runId);
      if (wasActive) { activeChatRunId = null; setActivity('aborted'); }
      tui.render();
    }

    if (evt.state === 'error') {
      const wasActive = activeChatRunId === evt.runId;
      tui.addSystem(`run error: ${evt.errorMessage || 'unknown'}`);
      assembler.drop(evt.runId);
      streamingEntries.delete(evt.runId);
      sessionRuns.delete(evt.runId);
      if (wasActive) { activeChatRunId = null; setActivity('error'); }
      tui.render();
    }
  }

  function handleAgentEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    const evt  = payload;
    const verbose = sessionInfo.verboseLevel || 'off';
    if (verbose === 'off') return;
    if (evt.stream === 'lifecycle') {
      const phase = evt.data?.phase;
      if (phase === 'start') setActivity('running');
      if (phase === 'end')   setActivity('idle');
      if (phase === 'error') setActivity('error');
      tui.render();
    }
  }

  // ── send message ──────────────────────────────────────────────────────────

  const sendMessage = async (text) => {
    if (!isConnected) {
      tui.addSystem('not connected — message not sent');
      setActivity('disconnected');
      tui.render();
      return;
    }
    try {
      tui.addUser(text);
      tui.render();
      const runId = randomUUID();
      noteLocalRun(runId);
      activeChatRunId = runId;
      setActivity('sending');
      tui.render();

      await client.sendChat({
        sessionKey: currentSessionKey,
        message:    text,
        thinking:   opts.thinking,
        deliver:    opts.deliver || false,
        timeoutMs:  opts.timeoutMs,
        runId,
      });
      setActivity('waiting');
      tui.render();
    } catch (err) {
      if (activeChatRunId) forgetRun(activeChatRunId);
      activeChatRunId = null;
      tui.addSystem(`send failed: ${err.message}`);
      setActivity('error');
      tui.render();
    }
  };

  // ── abort ─────────────────────────────────────────────────────────────────

  const abortActive = async () => {
    if (!activeChatRunId) {
      tui.addSystem('no active run');
      tui.render();
      return;
    }
    try {
      await client.abortChat({ sessionKey: currentSessionKey, runId: activeChatRunId });
      setActivity('aborted');
    } catch (err) {
      tui.addSystem(`abort failed: ${err.message}`);
    }
    tui.render();
  };

  // ── slash commands ────────────────────────────────────────────────────────

  const handleCommand = async (raw) => {
    const trimmed = raw.replace(/^\//, '').trim();
    if (!trimmed) return;
    const [name, ...rest] = trimmed.split(/\s+/);
    const cmd  = name.toLowerCase();
    const args = rest.join(' ').trim();

    switch (cmd) {
      case 'help':
        tui.addSystem(helpText());
        break;

      case 'status':
        try {
          const s = await client.getStatus();
          if (typeof s === 'string') tui.addSystem(s);
          else if (s) tui.addSystem(JSON.stringify(s, null, 2));
          else tui.addSystem('status: no response');
        } catch (e) { tui.addSystem(`status failed: ${e.message}`); }
        break;

      case 'session':
        if (args) await setSession(args);
        else      await openSessionPicker();
        break;

      case 'sessions':
        await openSessionPicker();
        break;

      case 'model':
        if (args) await setModel(args);
        else      await openModelPicker();
        break;

      case 'models':
        await openModelPicker();
        break;

      case 'think':
        if (!args) { tui.addSystem('usage: /think <off|low|medium|high|budget|turbo>'); break; }
        try {
          const r = await client.patchSession({ key: currentSessionKey, thinkingLevel: args });
          tui.addSystem(`thinking set to ${args}`);
          applyPatch(r);
        } catch (e) { tui.addSystem(`think failed: ${e.message}`); }
        break;

      case 'verbose':
        if (!args) { tui.addSystem('usage: /verbose <on|off>'); break; }
        try {
          const r = await client.patchSession({ key: currentSessionKey, verboseLevel: args });
          tui.addSystem(`verbose set to ${args}`);
          applyPatch(r);
          await loadHistory();
        } catch (e) { tui.addSystem(`verbose failed: ${e.message}`); }
        break;

      case 'usage': {
        const levels = ['off', 'tokens', 'full'];
        const cur    = sessionInfo.responseUsage || 'off';
        const next   = args || levels[(levels.indexOf(cur) + 1) % levels.length];
        try {
          const r = await client.patchSession({ key: currentSessionKey, responseUsage: next === 'off' ? null : next });
          tui.addSystem(`usage footer: ${next}`);
          applyPatch(r);
        } catch (e) { tui.addSystem(`usage failed: ${e.message}`); }
        break;
      }

      case 'new': {
        const newKey = `ct-${randomUUID().slice(0, 8)}`;
        await setSession(newKey);
        tui.addSystem(`new session: ${newKey}`);
        break;
      }

      case 'reset':
        try {
          await client.resetSession(currentSessionKey, 'reset');
          tui.addSystem(`session ${currentSessionKey} reset`);
          await loadHistory();
        } catch (e) { tui.addSystem(`reset failed: ${e.message}`); }
        break;

      case 'abort':
        await abortActive();
        break;

      case 'settings':
        openSettings();
        break;

      case 'exit':
      case 'quit':
        requestExit();
        break;

      default:
        // forward unknown commands as chat messages
        await sendMessage(raw);
        break;
    }
    tui.render();
  };

  // ── session / model helpers ───────────────────────────────────────────────

  const setSession = async (key) => {
    currentSessionKey = key;
    activeChatRunId   = null;
    clearRuns();
    updateHeader();
    updateFooter();
    await loadHistory();
  };

  const setModel = async (model) => {
    try {
      const r = await client.patchSession({ key: currentSessionKey, model });
      tui.addSystem(`model set to ${model}`);
      applyPatch(r);
      await refreshSessionInfo();
    } catch (e) { tui.addSystem(`model set failed: ${e.message}`); }
  };

  const applyPatch = (r) => {
    if (!r) return;
    const e = r.entry || r;
    if (e.model)         sessionInfo.model         = e.model;
    if (e.modelProvider) sessionInfo.modelProvider = e.modelProvider;
    if (e.thinkingLevel !== undefined) sessionInfo.thinkingLevel = e.thinkingLevel;
    if (e.verboseLevel  !== undefined) sessionInfo.verboseLevel  = e.verboseLevel;
    if (e.responseUsage !== undefined) sessionInfo.responseUsage = e.responseUsage;
    updateFooter();
  };

  const openSessionPicker = async () => {
    let sessions = [];
    try {
      const r = await client.listSessions({ includeGlobal: false, includeDerivedTitles: true });
      sessions = (r?.sessions || []).map((s) => ({
        value: s.key,
        label: s.derivedTitle || s.displayName || s.key,
      }));
    } catch {
      tui.addSystem('could not list sessions');
      tui.render();
      return;
    }
    if (!sessions.length) { tui.addSystem('no sessions found'); tui.render(); return; }
    tui.showSelect(sessions, async (item) => {
      await setSession(item.value);
    }, () => { tui.render(); });
  };

  const openModelPicker = async () => {
    let models = [];
    try {
      models = await client.listModels();
    } catch {
      tui.addSystem('could not list models');
      tui.render();
      return;
    }
    if (!models.length) { tui.addSystem('no models found'); tui.render(); return; }
    const items = models.map((m) => ({
      value: typeof m === 'string' ? m : (m.id || m.name || String(m)),
      label: typeof m === 'string' ? m : (m.name || m.id || String(m)),
    }));
    tui.showSelect(items, async (item) => {
      await setModel(item.value);
    }, () => { tui.render(); });
  };

  const openSettings = () => {
    const items = [
      { id: 'thinking', label: 'Show thinking', currentValue: showThinking ? 'on' : 'off', values: ['off', 'on'] },
      { id: 'tools',    label: 'Tool output',   currentValue: toolsExpanded ? 'expanded' : 'collapsed', values: ['collapsed', 'expanded'] },
    ];
    tui.showSettings(items, (id, val) => {
      if (id === 'thinking') { showThinking = val === 'on'; loadHistory().catch(() => {}); }
      if (id === 'tools')    { toolsExpanded = val === 'expanded'; }
      tui.render();
    }, () => { tui.render(); });
  };

  // ── exit ──────────────────────────────────────────────────────────────────

  const requestExit = () => {
    if (exitRequested) return;
    exitRequested = true;
    client.stop();
    tui.stop();
    process.exit(0);
  };

  // ── Ctrl+C handler ────────────────────────────────────────────────────────

  const handleCtrlC = () => {
    const now = Date.now();
    if (now - lastCtrlCAt <= 1000) { requestExit(); return; }
    lastCtrlCAt = now;
    setActivity('press ctrl+c again to exit');
    tui.render();
  };

  // ── TUI callbacks ─────────────────────────────────────────────────────────

  tui.onSubmit = (text) => {
    const val = text.trim();
    if (!val) return;
    if (val.startsWith('/')) {
      handleCommand(val).catch((e) => { tui.addSystem(`command error: ${e.message}`); tui.render(); });
    } else {
      sendMessage(val).catch((e) => { tui.addSystem(`error: ${e.message}`); tui.render(); });
    }
  };

  tui.onCtrlC   = handleCtrlC;
  tui.onCtrlD   = requestExit;
  tui.onCtrlT   = () => { showThinking = !showThinking; loadHistory().catch(() => {}); };
  tui.onCtrlO   = () => { toolsExpanded = !toolsExpanded; setActivity(toolsExpanded ? 'tools expanded' : 'tools collapsed'); tui.render(); };
  tui.onEscape  = () => { abortActive().catch(() => {}); };

  // ── client callbacks ───────────────────────────────────────────────────────

  client.onConnected = async () => {
    isConnected     = true;
    const reconnect = wasDisconnected;
    wasDisconnected = false;
    setConnection('connected');
    await loadHistory();
    setConnection(reconnect ? 'reconnected' : 'connected', 4000);
    tui.render();
    if (!autoMessageSent && autoMessage) {
      autoMessageSent = true;
      await sendMessage(autoMessage);
    }
    updateFooter();
    tui.render();
  };

  client.onDisconnected = (reason) => {
    isConnected     = false;
    wasDisconnected = true;
    const msg = `disconnected: ${reason || 'closed'}`;
    setConnection(msg, 5000);
    setActivity('idle');
    updateFooter();
    tui.render();
  };

  client.onGap = ({ expected, received }) => {
    setConnection(`event gap: expected ${expected}, got ${received}`, 5000);
    tui.render();
  };

  // ── SIGINT / SIGTERM ──────────────────────────────────────────────────────

  process.on('SIGINT',  handleCtrlC);
  process.on('SIGTERM', requestExit);

  // ── start ─────────────────────────────────────────────────────────────────

  updateHeader();
  setConnection('connecting');
  updateFooter();

  tui.start();
  client.start();

  // keep process alive
  await new Promise((resolve) => {
    process.once('exit', resolve);
  });
}

module.exports = { runApp };
