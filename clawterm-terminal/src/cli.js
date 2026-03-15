#!/usr/bin/env node
/**
 * ClawTerm CLI entry point.
 * Parses --host, --port flags and CT_HOST / CT_PORT env vars, then launches the TUI.
 */

import { runClawTerm } from './index.js';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--host' || arg === '-host') && argv[i + 1]) {
      opts.host = argv[++i];
    } else if ((arg === '--port' || arg === '-port') && argv[i + 1]) {
      opts.port = Number(argv[++i]);
    } else if (arg === '--no-resume') {
      opts.noResume = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'clawterm — terminal client for clawtermd',
        '',
        'Usage: clawterm [options]',
        '',
        'Options:',
        '  --host <host>   Server hostname (default: localhost, env: CT_HOST)',
        '  --port <port>   Server port     (default: 7220,      env: CT_PORT)',
        '  --no-resume     Start a new session (ignore persisted session id)',
        '  --help, -h      Show this help',
        '',
        'Session persistence:',
        '  Session IDs are stored in ~/.clawterm/session.json and',
        '  automatically resumed on reconnect.',
      ].join('\n'));
      process.exit(0);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

runClawTerm(opts).catch((err) => {
  console.error(err);
  process.exit(1);
});
