// ClawTerm VT220 — session-persistent AI agent terminal client.
//
// Usage:
//
//	clawterm-client -host localhost -port 7220 -tenant 1 -agent 1 -token <hex32>
package main

import (
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/lonestar62/clawterm-client/client"
	"github.com/lonestar62/clawterm-client/ui"
)

func main() {
	host := flag.String("host", "localhost", "ClawTerm server host")
	port := flag.Int("port", 7220, "ClawTerm server port")
	tenantID := flag.Uint("tenant", 0, "Tenant ID (uint32)")
	agentID := flag.Uint("agent", 0, "Agent ID (uint32)")
	tokenHex := flag.String("token", "", "Auth token (32 bytes, hex-encoded = 64 hex chars)")
	flag.Parse()

	var token [32]byte
	if *tokenHex != "" {
		b, err := hex.DecodeString(*tokenHex)
		if err != nil || len(b) != 32 {
			fmt.Fprintf(os.Stderr, "error: -token must be 64 hex characters (32 bytes)\n")
			os.Exit(1)
		}
		copy(token[:], b)
	}

	cfg := client.Config{
		Host:     *host,
		Port:     *port,
		TenantID: uint32(*tenantID),
		AgentID:  uint32(*agentID),
		Token:    token,
	}

	terminal, err := ui.New()
	if err != nil {
		log.Fatalf("UI init: %v", err)
	}

	// Show welcome banner
	for _, line := range ui.Banner() {
		terminal.AppendText([]byte(line + "\n"))
	}
	terminal.AppendStatus(fmt.Sprintf("Connecting to %s:%d  tenant=%d  agent=%d",
		cfg.Host, cfg.Port, cfg.TenantID, cfg.AgentID))

	cl := client.New(cfg)

	// Wire up UI ↔ client
	terminal.OnInput = func(data []byte) {
		cl.Send(data)
	}
	terminal.OnQuit = func() {
		cl.Stop()
		terminal.Stop()
	}

	// Forward received data to UI
	go func() {
		for {
			select {
			case data := <-cl.RecvCh:
				terminal.AppendText(data)
			case status := <-cl.StatusCh:
				terminal.AppendStatus(status)
				terminal.SetStatus(status)
			}
		}
	}()

	cl.Start()
	terminal.SetStatus(fmt.Sprintf("%s:%d — connecting…", cfg.Host, cfg.Port))

	// Run UI (blocks until quit)
	terminal.Run()
}
