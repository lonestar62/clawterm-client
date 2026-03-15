/**
 * Session persistence for ClawTerm.
 * Stores session_id in ~/.clawterm/session.json so that clawtermd
 * keeps the session alive across reconnects.
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

const SESSION_DIR  = path.join(os.homedir(), '.clawterm');
const SESSION_FILE = path.join(SESSION_DIR, 'session.json');

/**
 * Load the persisted session ID (0 if none / invalid).
 */
export function loadSessionId() {
  try {
    const data = fs.readFileSync(SESSION_FILE, 'utf8');
    const obj  = JSON.parse(data);
    const id   = obj?.sessionId;
    if (typeof id === 'number' && id > 0) return id;
  } catch {
    // file missing or invalid — start fresh
  }
  return 0;
}

/**
 * Persist a session ID.  Creates ~/.clawterm if it doesn't exist.
 */
export function saveSessionId(sessionId) {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionId }, null, 2) + '\n', 'utf8');
  } catch {
    // non-fatal
  }
}

/**
 * Clear the persisted session ID (after clean disconnect).
 */
export function clearSessionId() {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionId: 0 }, null, 2) + '\n', 'utf8');
  } catch {
    // non-fatal
  }
}
