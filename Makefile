BINARY   = clawterm-client
WIN_BIN  = clawterm-client.exe
MODULE   = github.com/lonestar62/clawterm-client

GO      ?= go
LDFLAGS  = -s -w

DIST_DIR = dist

.PHONY: build windows linux mac clean \
        node-deps node-build node-windows node-install install help

# ── Go targets ───────────────────────────────────────────────────────────────

## build — native Go binary (Linux amd64 on typical dev box)
build:
	$(GO) build -ldflags "$(LDFLAGS)" -o $(BINARY) .

## linux — explicit Linux amd64
linux:
	GOOS=linux GOARCH=amd64 $(GO) build -ldflags "$(LDFLAGS)" -o $(BINARY) .

## windows — cross-compile Windows amd64 .exe (Go VT220 client)
windows:
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
		$(GO) build -ldflags "$(LDFLAGS)" -o $(WIN_BIN) .

## mac — cross-compile macOS arm64
mac:
	GOOS=darwin GOARCH=arm64 $(GO) build -ldflags "$(LDFLAGS)" -o $(BINARY)-mac .

## all — build all Go targets
all: build windows mac

# ── Node.js TUI targets ───────────────────────────────────────────────────────

## node-deps — install Node.js dependencies
node-deps:
	npm install

## node-build — build all platform Node.js binaries via pkg
node-build: node-deps
	mkdir -p $(DIST_DIR)
	npx pkg . --targets node18-linux-x64,node18-win-x64,node18-macos-x64 \
	          --output $(DIST_DIR)/clawterm

## node-windows — build Windows .exe Node.js binary
node-windows: node-deps
	mkdir -p $(DIST_DIR)
	npx pkg . --targets node18-win-x64 --output $(DIST_DIR)/clawterm.exe

## install — install Node.js TUI to /usr/local/bin (requires node-build first)
install: node-build
	install -m 755 $(DIST_DIR)/clawterm-linux /usr/local/bin/clawterm
	@echo "Installed clawterm -> /usr/local/bin/clawterm"

# ── misc ──────────────────────────────────────────────────────────────────────

clean:
	rm -f $(BINARY) $(WIN_BIN) $(BINARY)-mac
	rm -rf $(DIST_DIR) node_modules

help:
	@echo "ClawTerm build targets:"
	@echo ""
	@echo "  Go VT220 client:"
	@echo "    make build        — native Go binary (Linux)"
	@echo "    make windows      — Go Windows .exe"
	@echo "    make mac          — Go macOS arm64"
	@echo "    make all          — all Go targets"
	@echo ""
	@echo "  Node.js OpenClaw-TUI client:"
	@echo "    make node-deps    — npm install"
	@echo "    make node-build   — pkg: linux + windows + mac binaries"
	@echo "    make node-windows — pkg: Windows .exe only"
	@echo "    make install      — install Node.js TUI to /usr/local/bin"
	@echo ""
	@echo "  make clean          — remove all build artifacts"
