# ClawTerm

Windows-compatible terminal client for **clawtermd** — the ClawTerm daemon.

ClawTerm provides the same look and feel as the OpenClaw TUI but connects via the
**ClawTerm binary protocol** over TCP (default port `7220`) instead of the OpenClaw
gateway WebSocket.

---

## Quick start

```sh
npm install
npm start                          # connect to localhost:7220
npm start -- --host myserver --port 7220
```

### Environment variables

| Variable   | Default     | Description              |
|------------|-------------|--------------------------|
| `CT_HOST`  | `localhost` | clawtermd hostname       |
| `CT_PORT`  | `7220`      | clawtermd TCP port       |

### CLI flags

```
--host <host>    Override CT_HOST
--port <port>    Override CT_PORT
--no-resume      Start a fresh session (ignore persisted session id)
--help, -h       Show help
```

---

## Session persistence

On first connect, clawtermd assigns a **session ID**. ClawTerm stores this in
`~/.clawterm/session.json` and automatically sends a `CT_RESUME` frame on the
next connection so the server keeps your session state.

Pass `--no-resume` to force a new session.

---

## Keyboard shortcuts

| Key        | Action                                    |
|------------|-------------------------------------------|
| `Enter`    | Send message                              |
| `Ctrl+C`   | Clear input / exit (press twice to exit)  |
| `Ctrl+D`   | Exit                                      |
| `!<cmd>`   | Run local shell command                   |

## Slash commands

| Command      | Description                              |
|--------------|------------------------------------------|
| `/help`      | Show help                                |
| `/status`    | Show connection & session info           |
| `/reconnect` | Reconnect to clawtermd                   |
| `/exit`      | Exit ClawTerm                            |

---

## Build

### Run with Node (no compilation)

```sh
make build
# or
npm start
```

### Windows `.exe` (single binary via pkg)

```sh
make windows
# → dist/clawterm.exe
```

### Linux / macOS binaries

```sh
make linux    # → dist/clawterm-linux
make all      # → dist/clawterm-win.exe + dist/clawterm-linux + dist/clawterm-macos
```

### Install globally

```sh
make install
# then: clawterm --host myserver
```

---

## Protocol

ClawTerm uses a lightweight binary framing protocol:

```
[FLAG:0x7E][SESSION_ID:4BE][SEQ:4BE][TYPE:1][FLAGS:1][LEN:2BE][PAYLOAD:N][CRC16:2BE]
```

| Type         | Value | Description                                    |
|--------------|-------|------------------------------------------------|
| `CT_CONNECT` | 0x01  | Establish a new session                        |
| `CT_ACCEPT`  | 0x02  | Server acknowledges, returns session_id        |
| `CT_DATA`    | 0x10  | Bidirectional UTF-8 text I/O                   |
| `CT_KEEPALIVE`| 0x20 | 30-second heartbeat (echoed back)              |
| `CT_SUSPEND` | 0x30  | Client going away; server keeps session alive  |
| `CT_RESUME`  | 0x03  | Reconnect with stored session_id               |
| `CT_DISCONNECT`| 0x40| Clean shutdown                                 |

**CRC-16/IBM** (poly `0x8005`, init `0x0000`, no reflection) covers the frame
from the `FLAG` byte through the end of the payload.

---

## Requirements

- Node.js ≥ 18
- clawtermd running on TCP port 7220 (or configured host/port)
