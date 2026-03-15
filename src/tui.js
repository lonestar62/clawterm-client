'use strict';
/**
 * ClawTerm TUI — blessed-based terminal UI matching the OpenClaw TUI layout.
 *
 * Layout (top→bottom):
 *   header    (1 line)  — bold gold, host/session info
 *   chatLog   (fills)   — scrollable message history
 *   status    (1 line)  — dim, activity/connection state
 *   footer    (1 line)  — dim, session/model/token info
 *   separator (1 line)  — border
 *   input     (1 line)  — editor with history + slash autocomplete
 */

const blessed   = require('blessed');
const chalk     = require('chalk');
const { P, renderMarkdown, renderThinking, sanitize } = require('./markdown');

// ── palette helpers ──────────────────────────────────────────────────────────
const fg = (hex) => (t) => chalk.hex(hex)(t);
const T  = {
  header:   (t) => chalk.bold(chalk.hex(P.accent)(t)),
  dim:      fg(P.dim),
  user:     (t) => chalk.bgHex('#2B2F36')(chalk.hex('#F3EEE0')(t)),
  system:   fg('#9BA3B2'),
  error:    fg(P.error),
  success:  fg(P.success),
  thinking: fg(P.thinking),
  accent:   fg(P.accent),
  muted:    fg(P.dim),
};

// ── ANSI-tag helpers for blessed ─────────────────────────────────────────────
function tag(color, text) {
  return `{${color}-fg}${escapeTags(text)}{/}`;
}
function escapeTags(s) {
  return String(s).replace(/[{}]/g, (c) => (c === '{' ? '\\{' : '\\}'));
}
function blessedAnsiLine(ansiLine) {
  // blessed's `tags:false` + content set directly — we convert chalk ANSI to
  // blessed's {bold}, etc.  For simplicity we strip SGR and render with plain
  // blessed content using chalk output piped through blessed's `tags: false`.
  return ansiLine;
}

// Spinner frames for busy animation
const SPINNER = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

const WAITING_PHRASES = [
  'flibbertigibbeting', 'kerfuffling', 'dillydallying',
  'twiddling thumbs',  'noodling',    'bamboozling',
  'moseying',          'hobnobbing',  'pondering', 'conjuring',
];

function pickPhrase(tick) {
  return WAITING_PHRASES[Math.floor(tick / 10) % WAITING_PHRASES.length];
}

function shimmerText(text, tick) {
  const w   = 6;
  const pos = tick % (text.length + w);
  const s   = Math.max(0, pos - w);
  const e   = Math.min(text.length - 1, pos);
  let out   = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    out += (i >= s && i <= e)
      ? chalk.bold(chalk.hex(P.accentSoft)(ch))
      : chalk.hex(P.dim)(ch);
  }
  return out;
}

// ── ChatEntry — one rendered item in the log ─────────────────────────────────
class ChatEntry {
  constructor(type, lines) {
    this.type  = type;  // 'user' | 'assistant' | 'system'
    this.lines = lines; // string[] of chalk-colored lines
    this.id    = null;  // for streaming runs
  }
}

// ── ClawTermTUI ───────────────────────────────────────────────────────────────
class ClawTermTUI {
  constructor() {
    this._screen   = null;
    this._header   = null;
    this._log      = null;
    this._status   = null;
    this._footer   = null;
    this._inputBox = null;
    this._entries  = [];          // ChatEntry[]
    this._inputHistory = [];
    this._historyIdx   = -1;
    this._inputBuf     = '';
    this._cursorPos    = 0;

    this._spinnerTick  = 0;
    this._spinnerTimer = null;
    this._statusText   = '';
    this._footerText   = '';
    this._headerText   = '';

    // callbacks
    this.onSubmit   = null; // (text: string) => void
    this.onCtrlC    = null;
    this.onCtrlD    = null;
    this.onCtrlT    = null;
    this.onCtrlO    = null;
    this.onEscape   = null;
    this.onAltEnter = null;
  }

  // ── init ──────────────────────────────────────────────────────────────────

  start() {
    const screen = blessed.screen({
      smartCSR:    true,
      title:       'ClawTerm',
      fullUnicode: true,
      dockBorders: false,
      cursor: {
        artificial: true,
        shape:      'line',
        blink:      true,
        color:      P.accent,
      },
    });
    this._screen = screen;

    // Header
    this._header = blessed.box({
      parent: screen,
      top:    0, left: 0, right: 0,
      height: 1,
      tags:   false,
      style:  { fg: P.accent, bold: true },
      content: 'clawterm - connecting...',
    });

    // Chat log (scrollable)
    this._log = blessed.log({
      parent:      screen,
      top:         1, left: 0, right: 0,
      bottom:      4,  // status + footer + input border + input
      tags:        false,
      scrollable:  true,
      alwaysScroll:true,
      mouse:       true,
      scrollbar: {
        ch:    '│',
        style: { fg: P.dim },
      },
      style: { fg: P.text },
    });

    // Status bar
    this._status = blessed.box({
      parent:  screen,
      bottom:  3, left: 0, right: 0,
      height:  1,
      tags:    false,
      style:   { fg: P.dim },
      content: 'connecting | idle',
    });

    // Footer
    this._footer = blessed.box({
      parent:  screen,
      bottom:  2, left: 0, right: 0,
      height:  1,
      tags:    false,
      style:   { fg: P.dim },
      content: 'session main | unknown | tokens ?',
    });

    // Input border line
    blessed.line({
      parent:      screen,
      bottom:      1, left: 0, right: 0,
      height:      1,
      orientation: 'horizontal',
      style:       { fg: '#3C414B' },
    });

    // Input box
    this._inputBox = blessed.textbox({
      parent: screen,
      bottom: 0, left: 2, right: 0,
      height: 1,
      inputOnFocus: true,
      mouse:        true,
      style: {
        fg:     P.text,
        cursor: { fg: P.accent },
      },
    });

    // Prompt label
    blessed.box({
      parent:  screen,
      bottom:  0, left: 0,
      width:   2, height: 1,
      content: chalk.hex(P.accentSoft)('>'),
      tags:    false,
    });

    this._inputBox.focus();
    this._setupKeys();
    screen.render();
  }

  stop() {
    this._stopSpinner();
    try { this._screen?.destroy(); } catch {}
  }

  // ── key handling ──────────────────────────────────────────────────────────

  _setupKeys() {
    const screen   = this._screen;
    const inputBox = this._inputBox;

    // delegate all keystrokes
    screen.key(['C-c'], () => { this.onCtrlC?.(); });
    screen.key(['C-d'], () => {
      if (inputBox.getValue().length === 0) this.onCtrlD?.();
    });
    screen.key(['C-t'], () => { this.onCtrlT?.(); });
    screen.key(['C-o'], () => { this.onCtrlO?.(); });
    screen.key(['escape'], () => { this.onEscape?.(); });
    screen.key(['M-enter'], () => {
      const v = inputBox.getValue();
      inputBox.setValue(v + '\n');
      screen.render();
    });

    // History navigation
    screen.key(['up'], () => {
      if (this._inputHistory.length === 0) return;
      if (this._historyIdx < 0) {
        this._inputBuf  = inputBox.getValue();
        this._historyIdx = this._inputHistory.length - 1;
      } else if (this._historyIdx > 0) {
        this._historyIdx--;
      }
      inputBox.setValue(this._inputHistory[this._historyIdx] || '');
      screen.render();
    });

    screen.key(['down'], () => {
      if (this._historyIdx < 0) return;
      if (this._historyIdx < this._inputHistory.length - 1) {
        this._historyIdx++;
        inputBox.setValue(this._inputHistory[this._historyIdx] || '');
      } else {
        this._historyIdx = -1;
        inputBox.setValue(this._inputBuf || '');
      }
      screen.render();
    });

    // Submit on Enter
    inputBox.key(['enter'], () => {
      const text = inputBox.getValue().trim();
      inputBox.clearValue();
      this._historyIdx = -1;
      this._inputBuf   = '';
      screen.render();
      if (text) {
        if (this._inputHistory[this._inputHistory.length - 1] !== text) {
          this._inputHistory.push(text);
          if (this._inputHistory.length > 200) this._inputHistory.shift();
        }
        this.onSubmit?.(text);
      }
    });

    // Re-focus input if screen clicked
    screen.on('click', () => { inputBox.focus(); });

    inputBox.focus();
  }

  render() {
    this._screen?.render();
  }

  // ── header / status / footer ──────────────────────────────────────────────

  setHeader(text) {
    this._headerText = text;
    if (this._header) {
      this._header.setContent(chalk.bold(chalk.hex(P.accent)(text)));
      this._screen?.render();
    }
  }

  setStatus(text, busy = false) {
    this._statusText = text;
    if (!busy) {
      this._stopSpinner();
      if (this._status) {
        this._status.setContent(chalk.hex(P.dim)(text));
        this._screen?.render();
      }
    } else {
      this._startSpinner(text);
    }
  }

  setFooter(text) {
    this._footerText = text;
    if (this._footer) {
      this._footer.setContent(chalk.hex(P.dim)(text));
      this._screen?.render();
    }
  }

  // ── spinner ───────────────────────────────────────────────────────────────

  _startSpinner(label) {
    this._stopSpinner();
    this._spinnerTick  = 0;
    this._spinnerLabel = label;
    this._spinnerTimer = setInterval(() => {
      this._spinnerTick++;
      this._renderSpinner();
    }, 120);
    this._renderSpinner();
  }

  _stopSpinner() {
    if (this._spinnerTimer) {
      clearInterval(this._spinnerTimer);
      this._spinnerTimer = null;
    }
  }

  _renderSpinner() {
    const frame = SPINNER[this._spinnerTick % SPINNER.length];
    const label = this._spinnerLabel || '';
    const isWaiting = label.includes('waiting') || label.includes('pondering');
    let msg;
    if (isWaiting) {
      const phrase  = pickPhrase(this._spinnerTick);
      const elapsed = this._formatElapsed();
      msg = shimmerText(`${phrase}…`, this._spinnerTick) + chalk.hex(P.dim)(` • ${elapsed} | ${this._connStatus || 'connecting'}`);
    } else {
      const elapsed = this._formatElapsed();
      msg = chalk.hex(P.accent)(frame) + ' ' + chalk.bold(chalk.hex(P.accentSoft)(label)) +
            chalk.hex(P.dim)(` • ${elapsed} | ${this._connStatus || 'connecting'}`);
    }
    if (this._status) {
      this._status.setContent(msg);
      this._screen?.render();
    }
  }

  _busyStartedAt = null;
  _connStatus    = 'connecting';

  setBusyStart() { this._busyStartedAt = Date.now(); }
  setConnStatus(s) { this._connStatus = s; }

  _formatElapsed() {
    if (!this._busyStartedAt) return '0s';
    const total = Math.max(0, Math.floor((Date.now() - this._busyStartedAt) / 1000));
    return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
  }

  // ── chat log ──────────────────────────────────────────────────────────────

  _appendLines(lines) {
    for (const line of lines) {
      this._log?.log(line);
    }
    this._screen?.render();
  }

  addSystem(text) {
    const line = chalk.hex(P.systemText || '#9BA3B2')(' ' + sanitize(text));
    this._appendLines([line]);
  }

  addUser(text) {
    const raw     = sanitize(text);
    const padded  = chalk.bgHex('#2B2F36')(chalk.hex('#F3EEE0')(' ' + raw + ' '));
    this._appendLines(['', padded, '']);
  }

  // Start a streaming assistant entry, returns { id, update, finalize }
  startAssistant(runId) {
    const entry = {
      id:          runId,
      thinkText:   '',
      contentText: '',
    };
    return {
      id: runId,
      update: (thinkText, contentText, showThinking) => {
        entry.thinkText   = thinkText   || entry.thinkText;
        entry.contentText = contentText || entry.contentText;
        // In blessed log we can't edit in-place easily, so we just re-render
        // when finalized. During streaming we append delta lines.
      },
      finalize: (thinkText, contentText, showThinking) => {
        entry.thinkText   = thinkText;
        entry.contentText = contentText;
        this._renderAssistantEntry(thinkText, contentText, showThinking);
      },
    };
  }

  addAssistant(thinkText, contentText, showThinking) {
    this._renderAssistantEntry(thinkText, contentText, showThinking);
  }

  _renderAssistantEntry(thinkText, contentText, showThinking) {
    const lines = [];
    lines.push(''); // top margin

    if (showThinking && thinkText && thinkText.trim()) {
      lines.push(...renderThinking(thinkText));
    }

    if (contentText && contentText.trim()) {
      lines.push(...renderMarkdown(contentText));
    } else {
      lines.push(chalk.hex(P.dim)(' (no output)'));
    }

    this._appendLines(lines);
  }

  // Append a delta (partial streaming chunk) — shown live
  appendDelta(text, showThinking) {
    if (!text) return;
    // During streaming, just dump the text as it comes
    // We do a simpler line-by-line render
    const isThinking = showThinking && text.startsWith('[thinking]');
    if (isThinking) {
      const content = text.replace(/^\[thinking\]\n?/, '');
      const tlines  = content.split('\n');
      for (const l of tlines) {
        this._log?.log(chalk.hex(P.thinking)('  ' + l));
      }
    } else {
      const rlines = renderMarkdown(text);
      for (const l of rlines) this._log?.log(l);
    }
    this._screen?.render();
  }

  clearLog() {
    this._log?.setContent('');
    this._log?.clearItems?.();
    this._screen?.render();
  }

  // ── overlay / select lists (simplified modal) ─────────────────────────────

  showSelect(items, onSelect, onCancel) {
    const screen = this._screen;
    const h      = Math.min(items.length + 4, 20);
    const w      = Math.min(60, screen.width - 4);
    const box    = blessed.list({
      parent:   screen,
      top:      'center',
      left:     'center',
      width:    w,
      height:   h,
      border:   { type: 'line', fg: P.accent },
      style: {
        selected: { fg: P.accent, bold: true },
        item:     { fg: P.text },
      },
      keys:     true,
      vi:       true,
      mouse:    true,
      items:    items.map((it) => (it.label || it.value)),
    });

    box.on('select', (el, idx) => {
      box.destroy();
      screen.render();
      this._inputBox?.focus();
      onSelect?.(items[idx]);
    });
    box.key(['escape', 'C-c'], () => {
      box.destroy();
      screen.render();
      this._inputBox?.focus();
      onCancel?.();
    });
    box.focus();
    screen.render();
    return { close: () => { try { box.destroy(); screen.render(); } catch {} } };
  }

  showSettings(items, onChange, onClose) {
    const labels = items.map((it) => `${it.label}: ${it.currentValue}`);
    const overlay = this.showSelect(
      items.map((it, i) => ({ value: it.id, label: `${it.label}: [${it.values.join('|')}]  (current: ${it.currentValue})` })),
      (sel) => {
        const found = items.find((it) => it.id === sel.value);
        if (!found) { onClose?.(); return; }
        const cur = found.values.indexOf(found.currentValue);
        const next = found.values[(cur + 1) % found.values.length];
        found.currentValue = next;
        onChange?.(found.id, next);
        onClose?.();
      },
      onClose,
    );
    return overlay;
  }
}

module.exports = { ClawTermTUI };
