'use strict';
/**
 * TUI stream assembler — identical logic to the OpenClaw TuiStreamAssembler.
 * Combines incremental delta messages into full display text,
 * separating thinking blocks from text content.
 */

const { sanitize } = require('./markdown');

// ── block extraction helpers ──────────────────────────────────────────────────

function extractThinking(message) {
  const content = message?.content;
  if (!content || typeof content === 'string') return '';
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'thinking' && typeof b.thinking === 'string')
    .map((b)  => sanitize(b.thinking))
    .join('\n')
    .trim();
}

function extractContent(message) {
  const content = message?.content;
  if (typeof content === 'string') return sanitize(content).trim();
  if (!Array.isArray(content)) return '';
  const parts = content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b)  => sanitize(b.text));
  if (parts.length > 0) return parts.join('\n').trim();
  // error stop reason fallback
  if (message?.stopReason === 'error' && message?.errorMessage) {
    return `[error] ${message.errorMessage}`;
  }
  return '';
}

function extractTextBlocks(message) {
  const content = message?.content;
  if (typeof content === 'string') return [sanitize(content).trim()].filter(Boolean);
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b)  => sanitize(b.text).trim())
    .filter(Boolean);
}

function sawNonText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b?.type && b.type !== 'text' && b.type !== 'thinking');
}

function compose(thinkingText, contentText, showThinking) {
  const parts = [];
  if (showThinking && thinkingText?.trim()) parts.push(`[thinking]\n${thinkingText}`);
  if (contentText?.trim()) parts.push(contentText);
  return parts.join('\n\n').trim();
}

function resolveFinal(finalText, streamedText, errorMessage) {
  if (finalText?.trim()) return finalText;
  if (streamedText?.trim()) return streamedText;
  if (errorMessage?.trim()) return `[error] ${errorMessage}`;
  return '(no output)';
}

// ── StreamAssembler ───────────────────────────────────────────────────────────

class StreamAssembler {
  constructor() {
    this._runs = new Map();
  }

  _getOrCreate(runId) {
    let s = this._runs.get(runId);
    if (!s) {
      s = { thinkingText: '', contentText: '', contentBlocks: [], sawNonText: false, displayText: '' };
      this._runs.set(runId, s);
    }
    return s;
  }

  _update(state, message, showThinking) {
    const think   = extractThinking(message);
    const content = extractContent(message);
    const blocks  = extractTextBlocks(message);
    const nonText = sawNonText(message);

    if (think)   state.thinkingText = think;
    if (content) {
      state.contentText   = content;
      state.contentBlocks = blocks.length > 0 ? blocks : [content];
    }
    if (nonText) state.sawNonText = true;

    state.displayText = compose(state.thinkingText, state.contentText, showThinking);
  }

  ingestDelta(runId, message, showThinking) {
    const state = this._getOrCreate(runId);
    const prev  = state.displayText;
    this._update(state, message, showThinking);
    if (!state.displayText || state.displayText === prev) return null;
    return { displayText: state.displayText, thinkingText: state.thinkingText, contentText: state.contentText };
  }

  finalize(runId, message, showThinking, errorMessage) {
    const state = this._getOrCreate(runId);
    this._update(state, message, showThinking);
    const finalText = resolveFinal(state.displayText, state.displayText, errorMessage);
    this._runs.delete(runId);
    return {
      displayText:  finalText,
      thinkingText: state.thinkingText,
      contentText:  state.contentText,
    };
  }

  drop(runId) {
    this._runs.delete(runId);
  }
}

module.exports = { StreamAssembler };
