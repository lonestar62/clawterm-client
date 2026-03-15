/**
 * ClawTerm — terminal client for clawtermd.
 *
 * Visual design adapted from the OpenClaw TUI (same layout, same theme, same UX).
 * Transport replaced: instead of OpenClaw's gateway WebSocket, we connect via
 * the ClawTerm binary protocol on TCP port 7220.
 */

import { randomUUID }    from 'node:crypto';
import { spawn }         from 'node:child_process';
import chalk             from 'chalk';
import { highlight, supportsLanguage } from 'cli-highlight';
import {
  Box,
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Input,
  Key,
  Loader,
  Markdown,
  ProcessTerminal,
  SelectList,
  Spacer,
  TUI,
  Text,
  getEditorKeybindings,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
} from '@mariozechner/pi-tui';

import { ClawTermClient }           from './protocol.js';
import { loadSessionId, saveSessionId, clearSessionId } from './session.js';

// ─── Theme (identical to OpenClaw TUI) ───────────────────────────────────────

const palette = {
  text:          '#E8E3D5',
  dim:           '#7B7F87',
  accent:        '#F6C453',
  accentSoft:    '#F2A65A',
  border:        '#3C414B',
  userBg:        '#2B2F36',
  userText:      '#F3EEE0',
  systemText:    '#9BA3B2',
  toolPendingBg: '#1F2A2F',
  toolSuccessBg: '#1E2D23',
  toolErrorBg:   '#2F1F1F',
  toolTitle:     '#F6C453',
  toolOutput:    '#E1DACB',
  quote:         '#8CC8FF',
  quoteBorder:   '#3B4D6B',
  code:          '#F0C987',
  codeBlock:     '#1E232A',
  codeBorder:    '#343A45',
  link:          '#7DD3A5',
  error:         '#F97066',
  success:       '#7DD3A5',
};

const fg  = (hex) => (text) => chalk.hex(hex)(text);
const bg  = (hex) => (text) => chalk.bgHex(hex)(text);

function createSyntaxTheme(fallback) {
  return {
    keyword:           chalk.hex('#C586C0'),
    built_in:          chalk.hex('#4EC9B0'),
    type:              chalk.hex('#4EC9B0'),
    literal:           chalk.hex('#569CD6'),
    number:            chalk.hex('#B5CEA8'),
    string:            chalk.hex('#CE9178'),
    regexp:            chalk.hex('#D16969'),
    symbol:            chalk.hex('#B5CEA8'),
    class:             chalk.hex('#4EC9B0'),
    function:          chalk.hex('#DCDCAA'),
    title:             chalk.hex('#DCDCAA'),
    params:            chalk.hex('#9CDCFE'),
    comment:           chalk.hex('#6A9955'),
    doctag:            chalk.hex('#608B4E'),
    meta:              chalk.hex('#9CDCFE'),
    'meta-keyword':    chalk.hex('#C586C0'),
    'meta-string':     chalk.hex('#CE9178'),
    section:           chalk.hex('#DCDCAA'),
    tag:               chalk.hex('#569CD6'),
    name:              chalk.hex('#9CDCFE'),
    attr:              chalk.hex('#9CDCFE'),
    attribute:         chalk.hex('#9CDCFE'),
    variable:          chalk.hex('#9CDCFE'),
    bullet:            chalk.hex('#D7BA7D'),
    code:              chalk.hex('#CE9178'),
    emphasis:          chalk.italic,
    strong:            chalk.bold,
    formula:           chalk.hex('#C586C0'),
    link:              chalk.hex('#4EC9B0'),
    quote:             chalk.hex('#6A9955'),
    addition:          chalk.hex('#B5CEA8'),
    deletion:          chalk.hex('#F44747'),
    'selector-tag':    chalk.hex('#D7BA7D'),
    'selector-id':     chalk.hex('#D7BA7D'),
    'selector-class':  chalk.hex('#D7BA7D'),
    'selector-attr':   chalk.hex('#D7BA7D'),
    'selector-pseudo': chalk.hex('#D7BA7D'),
    'template-tag':    chalk.hex('#C586C0'),
    'template-variable': chalk.hex('#9CDCFE'),
    default: fallback,
  };
}

const syntaxTheme = createSyntaxTheme(fg(palette.code));

function highlightCode(code, lang) {
  try {
    return highlight(code, {
      language: lang && supportsLanguage(lang) ? lang : undefined,
      theme: syntaxTheme,
      ignoreIllegals: true,
    }).split('\n');
  } catch {
    return code.split('\n').map((line) => fg(palette.code)(line));
  }
}

const theme = {
  fg:            fg(palette.text),
  assistantText: (text) => text,
  dim:           fg(palette.dim),
  accent:        fg(palette.accent),
  accentSoft:    fg(palette.accentSoft),
  success:       fg(palette.success),
  error:         fg(palette.error),
  header:        (text) => chalk.bold(fg(palette.accent)(text)),
  system:        fg(palette.systemText),
  userBg:        bg(palette.userBg),
  userText:      fg(palette.userText),
  toolTitle:     fg(palette.toolTitle),
  toolOutput:    fg(palette.toolOutput),
  toolPendingBg: bg(palette.toolPendingBg),
  toolSuccessBg: bg(palette.toolSuccessBg),
  toolErrorBg:   bg(palette.toolErrorBg),
  border:        fg(palette.border),
  bold:          (text) => chalk.bold(text),
  italic:        (text) => chalk.italic(text),
  muted:         fg(palette.dim),
};

const markdownTheme = {
  heading:        (text) => chalk.bold(fg(palette.accent)(text)),
  link:           (text) => fg(palette.link)(text),
  linkUrl:        (text) => chalk.dim(text),
  code:           (text) => fg(palette.code)(text),
  codeBlock:      (text) => fg(palette.code)(text),
  codeBlockBorder:(text) => fg(palette.codeBorder)(text),
  quote:          (text) => fg(palette.quote)(text),
  quoteBorder:    (text) => fg(palette.quoteBorder)(text),
  hr:             (text) => fg(palette.border)(text),
  listBullet:     (text) => fg(palette.accentSoft)(text),
  bold:           (text) => chalk.bold(text),
  italic:         (text) => chalk.italic(text),
  strikethrough:  (text) => chalk.strikethrough(text),
  underline:      (text) => chalk.underline(text),
  highlightCode,
};

const editorTheme = {
  borderColor: (text) => fg(palette.border)(text),
};

// ─── Message components (identical to OpenClaw TUI) ──────────────────────────

class AssistantMessageComponent extends Container {
  constructor(text) {
    super();
    this.body = new Markdown(text, 1, 0, markdownTheme, { color: (line) => theme.assistantText(line) });
    this.addChild(new Spacer(1));
    this.addChild(this.body);
  }
  setText(text) { this.body.setText(text); }
}

class MarkdownMessageComponent extends Container {
  constructor(text, y, options) {
    super();
    this.body = new Markdown(text, 1, y, markdownTheme, options);
    this.addChild(new Spacer(1));
    this.addChild(this.body);
  }
  setText(text) { this.body.setText(text); }
}

class UserMessageComponent extends MarkdownMessageComponent {
  constructor(text) {
    super(text, 1, {
      bgColor: (line) => theme.userBg(line),
      color:   (line) => theme.userText(line),
    });
  }
}

// ─── Chat log ────────────────────────────────────────────────────────────────

class ChatLog extends Container {
  constructor(maxComponents = 180) {
    super();
    this.streamingMsg = null;
    this.maxComponents = Math.max(20, maxComponents);
  }

  _prune() {
    while (this.children.length > this.maxComponents) {
      const oldest = this.children[0];
      if (!oldest) break;
      this.removeChild(oldest);
      if (this.streamingMsg === oldest) this.streamingMsg = null;
    }
  }

  _append(component) {
    this.addChild(component);
    this._prune();
  }

  clearAll() {
    this.clear();
    this.streamingMsg = null;
  }

  addSystem(text) {
    this._append(new Spacer(1));
    this._append(new Text(theme.system(text), 1, 0));
  }

  addUser(text) {
    this.streamingMsg = null; // finalize previous response
    this._append(new UserMessageComponent(text));
  }

  /** Start or update the current streaming assistant response. */
  streamAssistant(text) {
    if (this.streamingMsg) {
      this.streamingMsg.setText(text);
    } else {
      this.streamingMsg = new AssistantMessageComponent(text);
      this._append(this.streamingMsg);
    }
    return this.streamingMsg;
  }

  /** Finalize the current streaming response. */
  finalizeAssistant() {
    this.streamingMsg = null;
  }

  /** Add a completed assistant message (e.g. from history). */
  addAssistant(text) {
    this._append(new AssistantMessageComponent(text));
  }
}

// ─── Custom editor (identical key handling to OpenClaw TUI) ──────────────────

class CustomEditor extends Editor {
  handleInput(data) {
    if (matchesKey(data, Key.alt('enter')) && this.onAltEnter) { this.onAltEnter(); return; }
    if (matchesKey(data, Key.ctrl('l'))    && this.onCtrlL)    { this.onCtrlL();    return; }
    if (matchesKey(data, Key.ctrl('o'))    && this.onCtrlO)    { this.onCtrlO();    return; }
    if (matchesKey(data, Key.ctrl('p'))    && this.onCtrlP)    { this.onCtrlP();    return; }
    if (matchesKey(data, Key.ctrl('g'))    && this.onCtrlG)    { this.onCtrlG();    return; }
    if (matchesKey(data, Key.ctrl('t'))    && this.onCtrlT)    { this.onCtrlT();    return; }
    if (matchesKey(data, Key.shift('tab')) && this.onShiftTab) { this.onShiftTab(); return; }
    if (matchesKey(data, Key.escape)       && this.onEscape && !this.isShowingAutocomplete()) { this.onEscape(); return; }
    if (matchesKey(data, Key.ctrl('c'))    && this.onCtrlC)    { this.onCtrlC();    return; }
    if (matchesKey(data, Key.ctrl('d'))) {
      if (this.getText().length === 0 && this.onCtrlD) this.onCtrlD();
      return;
    }
    super.handleInput(data);
  }
}

// ─── Waiting phrases (identical to OpenClaw TUI) ─────────────────────────────

const defaultWaitingPhrases = [
  'flibbertigibbeting', 'kerfuffling', 'dillydallying', 'twiddling thumbs',
  'noodling', 'bamboozling', 'moseying', 'hobnobbing', 'pondering', 'conjuring',
];

function pickWaitingPhrase(tick, phrases = defaultWaitingPhrases) {
  return phrases[Math.floor(tick / 10) % phrases.length] ?? phrases[0] ?? 'waiting';
}

function shimmerText(t, text, tick) {
  const width = 6;
  const hi    = (ch) => t.bold(t.accentSoft(ch));
  const pos   = tick % (text.length + width);
  const start = Math.max(0, pos - width);
  const end   = Math.min(text.length - 1, pos);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    out += (i >= start && i <= end) ? hi(ch) : t.dim(ch);
  }
  return out;
}

// ─── Slash commands ───────────────────────────────────────────────────────────

const SLASH_COMMANDS = [
  { name: 'help',      description: 'Show slash command help' },
  { name: 'status',    description: 'Show connection status' },
  { name: 'reconnect', description: 'Reconnect to clawtermd' },
  { name: 'exit',      description: 'Exit ClawTerm' },
  { name: 'quit',      description: 'Exit ClawTerm' },
];

function helpText() {
  return [
    'ClawTerm slash commands:',
    '/help     — show this help',
    '/status   — show connection status',
    '/reconnect — reconnect to clawtermd',
    '/exit or /quit — exit ClawTerm',
    '',
    'Keyboard shortcuts:',
    'Enter      — send message',
    'Ctrl+C     — clear input / exit (press twice)',
    'Ctrl+D     — exit',
    'Escape     — cancel',
    '!<cmd>     — run local shell command',
  ].join('\n');
}

// ─── Ctrl+C logic (identical to OpenClaw TUI) ────────────────────────────────

function resolveCtrlCAction(params) {
  const exitWindowMs = Math.max(1, params.exitWindowMs ?? 1000);
  if (params.hasInput) return { action: 'clear',   nextLastCtrlCAt: params.now };
  if (params.now - params.lastCtrlCAt <= exitWindowMs) return { action: 'exit', nextLastCtrlCAt: params.lastCtrlCAt };
  return { action: 'warn', nextLastCtrlCAt: params.now };
}

// ─── Backspace de-duper (identical to OpenClaw TUI) ──────────────────────────

function createBackspaceDeduper(params) {
  const dedupeWindowMs = Math.max(0, Math.floor(params?.dedupeWindowMs ?? 8));
  const now = params?.now ?? (() => Date.now());
  let lastBackspaceAt = -1;
  return (data) => {
    if (!matchesKey(data, Key.backspace)) return data;
    const ts = now();
    if (lastBackspaceAt >= 0 && ts - lastBackspaceAt <= dedupeWindowMs) return '';
    lastBackspaceAt = ts;
    return data;
  };
}

// ─── Windows git-bash paste fallback (identical to OpenClaw TUI) ─────────────

function shouldEnableWindowsGitBashPasteFallback(params) {
  const platform   = params?.platform   ?? process.platform;
  const env        = params?.env        ?? process.env;
  const termProgram = (env.TERM_PROGRAM ?? '').toLowerCase();
  if (platform === 'darwin') {
    return termProgram.includes('iterm') || termProgram.includes('apple_terminal');
  }
  if (platform !== 'win32') return false;
  const msystem = (env.MSYSTEM ?? '').toUpperCase();
  const shell   = env.SHELL ?? '';
  if (msystem.startsWith('MINGW') || msystem.startsWith('MSYS')) return true;
  if (shell.toLowerCase().includes('bash')) return true;
  return termProgram.includes('mintty');
}

// ─── Submit burst coalescer (identical to OpenClaw TUI) ──────────────────────

function createSubmitBurstCoalescer(params) {
  const windowMs   = Math.max(1, params.burstWindowMs ?? 50);
  const now        = params.now       ?? (() => Date.now());
  const setTimer   = params.setTimer  ?? setTimeout;
  const clearTimer = params.clearTimer ?? clearTimeout;
  let pending = null;
  let pendingAt = 0;
  let flushTimer = null;

  const clearFlushTimer = () => { if (flushTimer) { clearTimer(flushTimer); flushTimer = null; } };
  const flushPending    = () => {
    if (pending === null) return;
    const value = pending;
    pending = null; pendingAt = 0;
    clearFlushTimer();
    params.submit(value);
  };
  const scheduleFlush = () => {
    clearFlushTimer();
    flushTimer = setTimer(() => flushPending(), windowMs);
  };

  return (value) => {
    if (!params.enabled) { params.submit(value); return; }
    if (value.includes('\n')) { flushPending(); params.submit(value); return; }
    const ts = now();
    if (pending === null) { pending = value; pendingAt = ts; scheduleFlush(); return; }
    if (ts - pendingAt <= windowMs) { pending = `${pending}\n${value}`; pendingAt = ts; scheduleFlush(); return; }
    flushPending();
    pending = value; pendingAt = ts; scheduleFlush();
  };
}

// ─── TUI stop safety (identical to OpenClaw TUI) ─────────────────────────────

function isIgnorableTuiStopError(error) {
  if (!error || typeof error !== 'object') return false;
  const err     = error;
  const code    = typeof err.code    === 'string' ? err.code    : '';
  const syscall = typeof err.syscall === 'string' ? err.syscall : '';
  const message = typeof err.message === 'string' ? err.message : '';
  if (code === 'EBADF' && syscall === 'setRawMode') return true;
  return /setRawMode/i.test(message) && /EBADF/i.test(message);
}

function stopTuiSafely(stop) {
  try { stop(); } catch (error) { if (!isIgnorableTuiStopError(error)) throw error; }
}

// ─── Overlay helper (identical pattern to OpenClaw TUI) ──────────────────────

function createOverlayHandlers(tui, editor) {
  let overlayContainer = null;

  const openOverlay = (component) => {
    if (overlayContainer) {
      overlayContainer.clear();
      overlayContainer.addChild(component);
    } else {
      overlayContainer = new Container();
      overlayContainer.addChild(new Spacer(1));
      overlayContainer.addChild(component);
      tui.addChild(overlayContainer);
    }
    tui.setFocus(component);
    tui.requestRender();
  };

  const closeOverlay = () => {
    if (overlayContainer) {
      tui.removeChild(overlayContainer);
      overlayContainer = null;
    }
    tui.setFocus(editor);
    tui.requestRender();
  };

  return { openOverlay, closeOverlay };
}

// ─── Local shell runner (! prefix, same as OpenClaw TUI) ─────────────────────

function createLocalShellRunner({ chatLog, tui, openOverlay, closeOverlay }) {
  const runLocalShellLine = (raw) => {
    const cmd = raw.slice(1).trim();
    if (!cmd) return;

    chatLog.addSystem(`$ ${cmd}`);
    tui.requestRender();

    const terminal = new ProcessTerminal();
    const child    = spawn(cmd, [], { shell: true, env: process.env });

    let output = '';
    const onData = (data) => {
      output += String(data);
      chatLog.streamAssistant(output.trimEnd());
      tui.requestRender();
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      chatLog.finalizeAssistant();
      if (code !== 0) chatLog.addSystem(`exit code ${code}`);
      tui.requestRender();
    });
    child.on('error', (err) => {
      chatLog.addSystem(`shell error: ${err.message}`);
      chatLog.finalizeAssistant();
      tui.requestRender();
    });
  };

  return { runLocalShellLine };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runClawTerm(opts = {}) {
  const host       = opts.host || process.env.CT_HOST || 'localhost';
  const port       = Number(opts.port || process.env.CT_PORT || 7220);
  const storedId   = opts.noResume ? 0 : loadSessionId();

  // ── State ────────────────────────────────────────────────────────────────
  let sessionId       = storedId;
  let isConnected     = false;
  let wasDisconnected = false;
  let connectionStatus  = 'connecting';
  let activityStatus    = 'idle';
  let lastActivityStatus = activityStatus;
  let statusTimeout   = null;
  let statusTimer     = null;
  let statusStartedAt = null;
  let waitingTick     = 0;
  let waitingTimer    = null;
  let waitingPhrase   = null;
  let lastCtrlCAt     = 0;
  let exitRequested   = false;

  // Streaming response state
  let currentResponseText = '';
  let responseTimer       = null;
  const RESPONSE_IDLE_MS  = 600; // ms of silence → finalize response

  // ── ClawTerm client ───────────────────────────────────────────────────────
  const client = new ClawTermClient({ host, port, sessionId });

  // ── TUI scaffold ──────────────────────────────────────────────────────────
  const tui     = new TUI(new ProcessTerminal());
  const dedupeBackspace = createBackspaceDeduper();

  tui.addInputListener((data) => {
    const next = dedupeBackspace(data);
    if (next.length === 0) return { consume: true };
    return { data: next };
  });

  const header           = new Text('', 1, 0);
  const statusContainer  = new Container();
  const footer           = new Text('', 1, 0);
  const chatLog          = new ChatLog();
  const editor           = new CustomEditor(tui, editorTheme);

  const root = new Container();
  root.addChild(header);
  root.addChild(chatLog);
  root.addChild(statusContainer);
  root.addChild(footer);
  root.addChild(editor);

  tui.addChild(root);
  tui.setFocus(editor);

  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(SLASH_COMMANDS, process.cwd())
  );

  // ── Header / footer ───────────────────────────────────────────────────────
  const updateHeader = () => {
    const sidLabel = sessionId > 0 ? `session ${sessionId}` : 'no session';
    header.setText(theme.header(`clawterm — ${host}:${port} — ${sidLabel}`));
  };

  const updateFooter = () => {
    footer.setText(theme.dim(`${host}:${port} | ${connectionStatus}`));
  };

  // ── Status line (identical to OpenClaw TUI) ───────────────────────────────
  let statusText   = null;
  let statusLoader = null;

  const busyStates = new Set(['sending', 'waiting', 'streaming', 'receiving']);

  const formatElapsed = (startMs) => {
    const total = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
  };

  const ensureStatusText = () => {
    if (statusText) return;
    statusContainer.clear();
    statusLoader?.stop();
    statusLoader = null;
    statusText = new Text('', 1, 0);
    statusContainer.addChild(statusText);
  };

  const ensureStatusLoader = () => {
    if (statusLoader) return;
    statusContainer.clear();
    statusText = null;
    statusLoader = new Loader(
      tui,
      (spinner) => theme.accent(spinner),
      (text)    => theme.bold(theme.accentSoft(text)),
      ''
    );
    statusContainer.addChild(statusLoader);
  };

  const updateBusyStatusMessage = () => {
    if (!statusLoader || !statusStartedAt) return;
    const elapsed = formatElapsed(statusStartedAt);
    if (activityStatus === 'waiting' || activityStatus === 'receiving') {
      waitingTick++;
      const phrase = waitingPhrase ?? 'waiting';
      statusLoader.setMessage(
        `${shimmerText(theme, `${phrase}…`, waitingTick)} • ${elapsed} | ${connectionStatus}`
      );
    } else {
      statusLoader.setMessage(`${activityStatus} • ${elapsed} | ${connectionStatus}`);
    }
  };

  const stopStatusTimer = () => { if (statusTimer) { clearInterval(statusTimer); statusTimer = null; } };
  const stopWaitingTimer = () => {
    if (waitingTimer) { clearInterval(waitingTimer); waitingTimer = null; waitingPhrase = null; }
  };

  const startStatusTimer = () => {
    if (statusTimer) return;
    statusTimer = setInterval(() => { if (busyStates.has(activityStatus)) updateBusyStatusMessage(); }, 1000);
  };

  const startWaitingTimer = () => {
    if (waitingTimer) return;
    if (!waitingPhrase)
      waitingPhrase = defaultWaitingPhrases[Math.floor(Math.random() * defaultWaitingPhrases.length)] ?? 'waiting';
    waitingTick = 0;
    waitingTimer = setInterval(() => {
      if (activityStatus === 'waiting' || activityStatus === 'receiving') updateBusyStatusMessage();
    }, 120);
  };

  const renderStatus = () => {
    if (busyStates.has(activityStatus)) {
      if (!statusStartedAt || lastActivityStatus !== activityStatus) statusStartedAt = Date.now();
      ensureStatusLoader();
      if (activityStatus === 'waiting' || activityStatus === 'receiving') {
        stopStatusTimer();
        startWaitingTimer();
      } else {
        stopWaitingTimer();
        startStatusTimer();
      }
      updateBusyStatusMessage();
    } else {
      statusStartedAt = null;
      stopStatusTimer();
      stopWaitingTimer();
      statusLoader?.stop();
      statusLoader = null;
      ensureStatusText();
      const text = activityStatus ? `${connectionStatus} | ${activityStatus}` : connectionStatus;
      statusText?.setText(theme.dim(text));
    }
    lastActivityStatus = activityStatus;
  };

  const setConnectionStatus = (text, ttlMs) => {
    connectionStatus = text;
    renderStatus();
    updateFooter();
    if (statusTimeout) clearTimeout(statusTimeout);
    if (ttlMs && ttlMs > 0) {
      statusTimeout = setTimeout(() => {
        connectionStatus = isConnected ? 'connected' : 'disconnected';
        renderStatus();
        updateFooter();
      }, ttlMs);
    }
  };

  const setActivityStatus = (text) => {
    activityStatus = text;
    renderStatus();
  };

  // ── Overlay ───────────────────────────────────────────────────────────────
  const { openOverlay, closeOverlay } = createOverlayHandlers(tui, editor);

  // ── Local shell ───────────────────────────────────────────────────────────
  const { runLocalShellLine } = createLocalShellRunner({ chatLog, tui, openOverlay, closeOverlay });

  // ── Streaming response handler ────────────────────────────────────────────
  const finalizeResponse = () => {
    if (responseTimer) { clearTimeout(responseTimer); responseTimer = null; }
    chatLog.finalizeAssistant();
    currentResponseText = '';
    setActivityStatus('idle');
    tui.requestRender();
  };

  const scheduleResponseFinalize = () => {
    if (responseTimer) clearTimeout(responseTimer);
    responseTimer = setTimeout(finalizeResponse, RESPONSE_IDLE_MS);
  };

  // ── Client event handlers ─────────────────────────────────────────────────
  client.on('connected', (newSessionId) => {
    sessionId    = newSessionId;
    isConnected  = true;
    wasDisconnected = false;
    saveSessionId(sessionId);
    updateHeader();
    const msg = wasDisconnected ? 'clawtermd reconnected' : 'clawtermd connected';
    setConnectionStatus(msg, 4000);
    setActivityStatus('idle');
    chatLog.addSystem(`connected — session ${sessionId}`);
    tui.requestRender();
  });

  client.on('data', (text) => {
    if (!text) return;
    currentResponseText += text;
    setActivityStatus('receiving');
    chatLog.streamAssistant(currentResponseText);
    scheduleResponseFinalize();
    tui.requestRender();
  });

  client.on('disconnect', (reason) => {
    isConnected     = false;
    wasDisconnected = true;
    const label     = reason?.trim() || 'closed';
    setConnectionStatus(`disconnected: ${label}`, 5000);
    setActivityStatus('idle');
    updateHeader();
    updateFooter();
    tui.requestRender();
  });

  client.on('error', (err) => {
    chatLog.addSystem(`connection error: ${err.message}`);
    setConnectionStatus(`error: ${err.message}`, 5000);
    tui.requestRender();
  });

  // ── Command handler ───────────────────────────────────────────────────────
  const handleCommand = async (raw) => {
    const trimmed = raw.replace(/^\//, '').trim();
    if (!trimmed) return;
    const [name, ...rest] = trimmed.split(/\s+/);
    const args = rest.join(' ').trim();

    switch (name.toLowerCase()) {
      case 'help':
        chatLog.addSystem(helpText());
        break;

      case 'status':
        chatLog.addSystem([
          `host:     ${host}:${port}`,
          `session:  ${sessionId > 0 ? sessionId : '(none)'}`,
          `status:   ${isConnected ? 'connected' : 'disconnected'} — ${connectionStatus}`,
          `activity: ${activityStatus}`,
        ].join('\n'));
        break;

      case 'reconnect': {
        chatLog.addSystem('reconnecting…');
        tui.requestRender();
        client.destroy();
        // Brief delay before reconnecting
        setTimeout(() => {
          client.sessionId = sessionId; // resume existing session
          client._destroyed = false;
          client.connected  = false;
          client.connect();
          setConnectionStatus('connecting');
          tui.requestRender();
        }, 500);
        break;
      }

      case 'exit':
      case 'quit':
        requestExit();
        break;

      default:
        // Pass unknown /commands as text messages (allows gateway-style commands)
        await sendMessage(raw);
        break;
    }
    tui.requestRender();
  };

  // ── Message sender ────────────────────────────────────────────────────────
  const sendMessage = async (text) => {
    if (!isConnected) {
      chatLog.addSystem('not connected — message not sent');
      setActivityStatus('disconnected');
      tui.requestRender();
      return;
    }
    // Finalize any in-progress response
    finalizeResponse();

    chatLog.addUser(text);
    setActivityStatus('sending');
    tui.requestRender();

    const sent = client.sendData(text + '\n');
    if (sent) {
      setActivityStatus('waiting');
    } else {
      chatLog.addSystem('send failed: not connected');
      setActivityStatus('error');
    }
    tui.requestRender();
  };

  // ── Exit ──────────────────────────────────────────────────────────────────
  const requestExit = () => {
    if (exitRequested) return;
    exitRequested = true;
    client.suspend();       // tell server to keep session alive
    client.destroy();
    stopTuiSafely(() => tui.stop());
    process.exit(0);
  };

  // ── Editor key bindings ───────────────────────────────────────────────────
  editor.onSubmit = createSubmitBurstCoalescer({
    submit: (text) => {
      const raw   = text;
      const value = raw.trim();
      editor.setText('');
      if (!value) return;
      if (raw.startsWith('!') && raw !== '!') {
        editor.addToHistory(raw);
        runLocalShellLine(raw);
        return;
      }
      editor.addToHistory(value);
      if (value.startsWith('/')) {
        handleCommand(value);
        return;
      }
      sendMessage(value);
    },
    enabled: shouldEnableWindowsGitBashPasteFallback(),
  });

  editor.onEscape = () => { /* no-op for now */ };

  editor.onCtrlC = () => {
    const now      = Date.now();
    const decision = resolveCtrlCAction({ hasInput: editor.getText().trim().length > 0, now, lastCtrlCAt });
    lastCtrlCAt = decision.nextLastCtrlCAt;
    if (decision.action === 'clear') {
      editor.setText('');
      setActivityStatus('cleared input; press ctrl+c again to exit');
      tui.requestRender();
      return;
    }
    if (decision.action === 'exit') { requestExit(); return; }
    setActivityStatus('press ctrl+c again to exit');
    tui.requestRender();
  };

  editor.onCtrlD = () => requestExit();

  // ── Signal handlers ───────────────────────────────────────────────────────
  const sigintHandler  = () => { const now = Date.now(); const d = resolveCtrlCAction({ hasInput: false, now, lastCtrlCAt }); lastCtrlCAt = d.nextLastCtrlCAt; if (d.action === 'exit') requestExit(); else { setActivityStatus('press ctrl+c again to exit'); tui.requestRender(); } };
  const sigtermHandler = () => requestExit();

  process.on('SIGINT',  sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  // ── Start ─────────────────────────────────────────────────────────────────
  updateHeader();
  setConnectionStatus('connecting');
  updateFooter();

  tui.start();
  client.connect();

  await new Promise((resolve) => {
    const finish = () => {
      process.removeListener('SIGINT',  sigintHandler);
      process.removeListener('SIGTERM', sigtermHandler);
      resolve();
    };
    process.once('exit', finish);
  });
}
