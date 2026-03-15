BINARY   = clawterm-client
WIN_BIN  = clawterm-client.exe
MODULE   = github.com/lonestar62/clawterm-client

GO      ?= go
LDFLAGS  = -s -w

.PHONY: build windows linux mac clean

## build — native binary (Linux amd64 on typical dev box)
build:
	$(GO) build -ldflags "$(LDFLAGS)" -o $(BINARY) .

## linux — explicit Linux amd64
linux:
	GOOS=linux GOARCH=amd64 $(GO) build -ldflags "$(LDFLAGS)" -o $(BINARY) .

## windows — cross-compile Windows amd64 .exe
windows:
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
		$(GO) build -ldflags "$(LDFLAGS)" -o $(WIN_BIN) .

## mac — cross-compile macOS arm64
mac:
	GOOS=darwin GOARCH=arm64 $(GO) build -ldflags "$(LDFLAGS)" -o $(BINARY)-mac .

## all — build all three targets
all: build windows mac

clean:
	rm -f $(BINARY) $(WIN_BIN) $(BINARY)-mac
