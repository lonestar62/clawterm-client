# ClawTerm VT220 Client

A VT220-style terminal client for the [ClawTerm](https://github.com/lonestar62/clawterm-client) session-persistent binary protocol, built in Go with a green-on-black phosphor aesthetic.

## Features

- Full ClawTerm protocol: `CONNECT → ACCEPT → DATA` bidirectional stream
- Session persistence: `SUSPEND` on disconnect, `RESUME` on reconnect
- 30-second keepalives
- Scrollback buffer (5000 lines) with PgUp/PgDn and mouse-wheel scrolling
- VT220 aesthetic: phosphor green on black, monospace, box-drawing borders
- Single static binary, zero runtime dependencies
- Cross-compiles to Windows `.exe`, Linux, and macOS

## Quick Start

```bash
# Linux / macOS
./clawterm-client -host localhost -port 7220 -tenant 1 -agent 42 \
  -token 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f

# Windows
clawterm-client.exe -host 192.168.1.10 -port 7220 -tenant 1 -agent 42
```

## CLI Flags

| Flag | Default | Description |
|---|---|---|
| `-host` | `localhost` | ClawTerm server hostname / IP |
| `-port` | `7220` | TCP port |
| `-tenant` | `0` | Tenant ID (uint32) |
| `-agent` | `0` | Agent ID (uint32) |
| `-token` | `""` | Auth token — 64 hex chars (32 bytes) |

## Keyboard Shortcuts

| Key | Action |
|---|---|
| Enter | Send input line |
| Backspace / Delete | Edit input |
| ← / → | Move cursor in input |
| Home / Ctrl-A | Start of input |
| End / Ctrl-E | End of input |
| PgUp / PgDn | Scroll output |
| Mouse wheel | Scroll output |
| Ctrl-Q / Ctrl-C | Quit |

## Building

### Prerequisites

- Go 1.24+ (`go version`)
- For cross-compilation to Windows: no extra tools needed (`CGO_ENABLED=0`)

### Build Commands

```bash
# Clone
git clone https://github.com/lonestar62/clawterm-client.git
cd clawterm-client

# Linux (native)
make build

# Windows .exe (cross-compile from Linux/macOS)
make windows

# macOS arm64
make mac

# All targets
make all

# Clean
make clean
```

### Direct `go build`

```bash
# Linux
go build -ldflags "-s -w" -o clawterm-client .

# Windows .exe
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "-s -w" -o clawterm-client.exe .
```

## Protocol Reference

```
Wire format:
  [FLAG:1][SESSION_ID:4BE][SEQ:4BE][TYPE:1][FLAGS:1][LEN:2BE][PAYLOAD:N][CRC16:2BE]

Flag:      0x7E (always)
Overhead:  15 bytes
Server:    TCP port 7220
CRC16:     CRC-16/IBM (poly 0x8005, init 0x0000) over FLAG..PAYLOAD

Frame types:
  CT_CONNECT=0x01  CT_ACCEPT=0x02   CT_RESUME=0x03   CT_RESUMED=0x04
  CT_DATA=0x10     CT_ACK=0x11      CT_NACK=0x12
  CT_KEEPALIVE=0x20  CT_SUSPEND=0x30  CT_DISCONNECT=0x40  CT_ERROR=0xFF
```

## Project Layout

```
.
├── main.go              Entry point, CLI flags
├── protocol/
│   └── clawterm.go      Frame encode/decode, CRC16
├── client/
│   └── client.go        TCP connection, session management, reconnect
├── ui/
│   └── ui.go            tcell VT220 terminal UI
├── go.mod
├── go.sum
├── Makefile
└── README.md
```

## License

MIT

## Build Verification

Both targets confirmed compiling clean:
- `clawterm-client` (Linux amd64, 3.3 MB)
- `clawterm-client.exe` (Windows amd64, 3.1 MB, `CGO_ENABLED=0`)
