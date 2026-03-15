'use strict';
/**
 * Minimal markdown-to-ANSI renderer using chalk.
 * Handles the subset of markdown that appears in AI chat responses.
 */

const chalk = require('chalk');

// Palette (matches OpenClaw TUI)
const P = {
  text:        '#E8E3D5',
  dim:         '#7B7F87',
  accent:      '#F6C453',
  accentSoft:  '#F2A65A',
  code:        '#F0C987',
  codeBlock:   '#CE9178',
  quote:       '#8CC8FF',
  link:        '#7DD3A5',
  heading:     '#F6C453',
  listBullet:  '#F2A65A',
  success:     '#7DD3A5',
  error:       '#F97066',
  thinking:    '#7B7F87',
};

function esc(s) {
  return s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}

/** Apply inline markdown formatting to a single line */
function inlineFormat(line) {
  // Bold+italic: ***text*** or ___text___
  line = line.replace(/\*\*\*(.*?)\*\*\*/g, (_, m) => chalk.bold.italic(chalk.hex(P.text)(m)));
  // Bold: **text** or __text__
  line = line.replace(/\*\*(.*?)\*\*/g, (_, m) => chalk.bold(chalk.hex(P.text)(m)));
  line = line.replace(/__(.*?)__/g, (_, m) => chalk.bold(chalk.hex(P.text)(m)));
  // Italic: *text* or _text_
  line = line.replace(/\*((?!\s).*?(?!\s))\*/g, (_, m) => chalk.italic(chalk.hex(P.text)(m)));
  line = line.replace(/_((?!\s).*?(?!\s))_/g, (_, m) => chalk.italic(chalk.hex(P.text)(m)));
  // Inline code: `code`
  line = line.replace(/`([^`]+)`/g, (_, m) => chalk.hex(P.code)(m));
  // Strikethrough: ~~text~~
  line = line.replace(/~~(.*?)~~/g, (_, m) => chalk.strikethrough(m));
  // Links: [text](url)
  line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) =>
    chalk.hex(P.link)(text) + chalk.dim(` (${url})`));
  return line;
}

/**
 * Render markdown text to an array of chalk-colored lines.
 * Strips trailing whitespace from each line.
 */
function renderMarkdown(text) {
  if (!text) return [];
  const lines  = text.split('\n');
  const output = [];
  let inCode   = false;
  let codeLang = '';
  let codeBuf  = [];

  const flushCode = () => {
    const codeText = codeBuf.join('\n');
    let highlighted;
    try {
      const { highlight, supportsLanguage } = require('cli-highlight');
      const lang = codeLang && supportsLanguage(codeLang) ? codeLang : undefined;
      highlighted = highlight(codeText, { language: lang, ignoreIllegals: true });
    } catch {
      highlighted = chalk.hex(P.codeBlock)(codeText);
    }
    // box border
    const inner = highlighted.split('\n').map(l => '  ' + l);
    output.push(chalk.hex('#343A45')('  ' + '─'.repeat(60)));
    if (codeLang) output.push(chalk.hex(P.dim)(`  ${codeLang}`));
    output.push(...inner);
    output.push(chalk.hex('#343A45')('  ' + '─'.repeat(60)));
    codeBuf  = [];
    codeLang = '';
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    // fenced code block
    const fence = line.match(/^```(\w*)$/);
    if (fence) {
      if (!inCode) {
        inCode   = true;
        codeLang = fence[1] || '';
      } else {
        inCode = false;
        flushCode();
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    // ATX headings
    const h3 = line.match(/^### (.+)/);
    if (h3) { output.push(chalk.bold(chalk.hex(P.heading)('### ' + h3[1]))); continue; }
    const h2 = line.match(/^## (.+)/);
    if (h2) { output.push(chalk.bold(chalk.hex(P.heading)('## ' + h2[1]))); continue; }
    const h1 = line.match(/^# (.+)/);
    if (h1) { output.push(chalk.bold(chalk.hex(P.heading)('# ' + h1[1]))); continue; }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(line.replace(/\s/g, ''))) {
      output.push(chalk.hex(P.dim)('─'.repeat(60)));
      continue;
    }

    // Blockquote
    const bq = line.match(/^> ?(.*)/);
    if (bq) {
      output.push(chalk.hex('#3B4D6B')('│ ') + chalk.hex(P.quote)(inlineFormat(bq[1])));
      continue;
    }

    // Unordered list
    const ul = line.match(/^(\s*)[*\-+] (.+)/);
    if (ul) {
      const indent = ' '.repeat(ul[1].length);
      output.push(indent + chalk.hex(P.listBullet)('• ') + inlineFormat(ul[2]));
      continue;
    }

    // Ordered list
    const ol = line.match(/^(\s*)(\d+)\. (.+)/);
    if (ol) {
      const indent = ' '.repeat(ol[1].length);
      output.push(indent + chalk.hex(P.listBullet)(ol[2] + '. ') + inlineFormat(ol[3]));
      continue;
    }

    // Empty line
    if (!line) { output.push(''); continue; }

    // Normal paragraph
    output.push(' ' + inlineFormat(line));
  }

  // flush unclosed code block
  if (inCode && codeBuf.length) flushCode();

  return output;
}

/** Render a [thinking] block with dim styling */
function renderThinking(thinkingText) {
  if (!thinkingText) return [];
  const lines  = thinkingText.split('\n');
  const output = [chalk.hex(P.thinking)('  [🤔 thinking]')];
  for (const line of lines) {
    output.push(chalk.hex(P.thinking)('  ' + line));
  }
  output.push(''); // blank separator
  return output;
}

/** Sanitize text: remove binary, strip control chars, wrap long tokens */
function sanitize(text) {
  if (!text) return text;
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '') // control chars except \t\n\r
    .replace(/\uFFFD{12,}/g, '[binary data omitted]');
}

/** Compose thinking + content for display */
function compose(thinkingText, contentText, showThinking) {
  const parts = [];
  if (showThinking && thinkingText?.trim()) parts.push(`[thinking]\n${thinkingText}`);
  if (contentText?.trim()) parts.push(contentText);
  return parts.join('\n\n').trim();
}

module.exports = { renderMarkdown, renderThinking, sanitize, compose, P };
