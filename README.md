# ClawTerm Client

Windows-compatible terminal clients for [clawtermd](https://github.com/lonestar62/clawterm-client) — two implementations in one repo:

| Client | Stack | Look & Feel |
|--------|-------|-------------|
| **Node.js TUI** (`bin/clawterm`) | Node.js + blessed + chalk | Identical to OpenClaw TUI — markdown, thinking mode, streaming |
| **Go VT220** (`clawterm-client`) | Go + tcell | Phosphor-green VT220 aesthetic |

---

## Node.js TUI (OpenClaw-Compatible)

Full-featured terminal client that **looks and behaves identically to the OpenClaw TUI** — same layout, same UX, same keyboard shortcuts — but connects via the ClawTerm binary protocol over TCP instead of WebSocket.

### Features

- **Identical layout** to OpenClaw TUI: header · chat log · status bar · footer · editor
- **Thinking mode** — real-time streaming AI reasoning blocks, toggle with `Ctrl+T`
- **Markdown rendering** — headings, bold, italic, code blocks, lists, blockquotes
- **Streaming responses** — live delta updates as the AI responds
- **Session persistence** — session ID stored in `~/.clawterm/session.json`, auto-resumed
- **Slash commands** — `/help`, `/think`, `/model`, `/session`, `/new`, `/reset`, `/abort`, etc.
- **Input history** — Up/Down arrows
- **Windows `.exe`** — packaged with `pkg`, zero Node.js runtime required
- **Configurable** — `CT_HOST`, `CT_PORT` env vars or `--host`/`--port` flags

### Quick Start

```bash
# Install dependencies
npm install

# Run (requires Node.js 16+)
npm start

# With options
node bin/clawterm --host 192.168.1.10 --port 7220 --session main

# Environment variables
CT_HOST=myserver CT_PORT=7220 node bin/clawterm
```

### Build Windows .exe

```bash
# Build all platforms
npm run build

# Windows only
npm run build:windows
# → dist/clawterm.exe

# Via Makefile
make node-windows
```

### CLI Options

| Flag | Default | Env | Description |
|------|---------|-----|-------------|
| `--host <host>` | `localhost` | `CT_HOST` | clawtermd host |
| `--port <port>` | `7220` | `CT_PORT` | TCP port |
| `--session <key>` | `main` | — | Session key |
| `--thinking <level>` | — | — | Thinking level override |
| `--message <text>` | — | — | Send initial message after connect |
| `--deliver` | `false` | — | Request server delivery |
| `--timeout-ms <ms>` | — | — | Agent timeout |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Up` / `Down` | Input history |
| `Ctrl+T` | Toggle thinking block display |
| `Ctrl+O` | Toggle tool output (expanded/collapsed) |
| `Ctrl+C` | Clear input / exit (press twice) |
| `Ctrl+D` | Exit |
| `Escape` | Abort active run |

### Slash Commands

```
/help                    — show this help
/status                  — server status
/session <key>           — switch session
/sessions                — session picker
/model <name>            — set model
/models                  — model picker
/think <level>           — set thinking level (off/low/medium/high)
/verbose <on|off>        — toggle verbose tool output
/usage <off|tokens|full> — token usage footer
/new                     — start new session
/reset                   — reset current session
/abort                   — abort active run
/settings                — open settings overlay
/exit  /quit             — exit ClawTerm
```

### Thinking Mode

When the AI uses extended thinking, ClawTerm renders reasoning blocks **above** the final response in a distinct dim style:

```
  [🤔 thinking]
  The user is asking about X. Let me think through this...
  First, I should consider...

 The answer is: ...
```

Toggle with `Ctrl+T` or `/settings`. The thinking blocks stream in real-time as the AI reasons.

---

## Go VT220 Client

A compact, zero-dependency VT220-style terminal client with phosphor-green aesthetics.

### Quick Start

```bash
# Linux / macOS
./clawterm-client -host localhost -port 7220

# Windows
clawterm-client.exe -host 192.168.1.10 -port 7220
```

### Build

```bash
make build      # Linux amd64
make windows    # Windows .exe
make mac        # macOS arm64
make all        # All targets
```

---

## ClawTerm Protocol

```
Wire format:
  [FLAG:1][SESSION_ID:4BE][SEQ:4BE][TYPE:1][FLAGS:1][LEN:2BE][PAYLOAD:N][CRC16:2BE]

Flag:      0x7E (always)
Overhead:  15 bytes
Server:    TCP port 7220 (default)
CRC16:     CRC-16/IBM (poly 0x8005, refIn=true, refOut=true)

Frame types:
  CT_CONNECT=0x01   establish session
  CT_ACCEPT=0x02    server grants session_id
  CT_RESUME=0x03    reconnect with stored session_id
  CT_DATA=0x10      bidirectional UTF-8 JSON (same envelope as OpenClaw WebSocket)
  CT_KEEPALIVE=0x20 heartbeat every 30s
  CT_SUSPEND=0x30   going away, keep session alive server-side
  CT_DISCONNECT=0x40 clean shutdown

CT_CONNECT payload (59 bytes):
  version(1) + capabilities(2BE) + tenant_id(4BE) + agent_id(4BE)
  + token(32 bytes, zero) + nonce(16 random bytes)

CT_DATA payload: UTF-8 JSON
  Request:  {"id":"req-1","method":"chat.send","params":{...}}
  Response: {"id":"req-1","result":{...}}
  Event:    {"event":"chat","payload":{...},"seq":42}
```

---

## Project Layout

```
.
├── bin/
│   └── clawterm          CLI entry point (Node.js TUI)
├── src/
│   ├── app.js            Main application logic
│   ├── client.js         ClawTerm JSON-RPC client
│   ├── protocol.js       Binary protocol (CRC16, frame encode/decode)
│   ├── tui.js            Blessed terminal UI
│   ├── assembler.js      Stream assembler (thinking + text blocks)
│   └── markdown.js       Markdown-to-ANSI renderer
├── package.json
├── Makefile
│
├── main.go               Go VT220 client entry point
├── protocol/
│   └── clawterm.go       Go frame encode/decode
├── client/
│   └── client.go         Go TCP client
├── ui/
│   └── ui.go             Go tcell UI
├── go.mod
└── go.sum
```

## License

MIT
