// Package client manages the TCP connection, ClawTerm session lifecycle,
// keepalives, and auto-reconnect with session resume.
package client

import (
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lonestar62/clawterm-client/protocol"
)

const (
	keepaliveInterval = 30 * time.Second
	reconnectDelay    = 3 * time.Second
	maxReconnectDelay = 60 * time.Second
	protocolVersion   = 0x01
	clientCapabilities = 0x01
)

// Config holds connection parameters.
type Config struct {
	Host     string
	Port     int
	TenantID uint32
	AgentID  uint32
	Token    [32]byte
}

// Client manages the ClawTerm connection.
type Client struct {
	cfg       Config
	conn      net.Conn
	sessionID uint32
	seq       atomic.Uint32
	mu        sync.Mutex

	// Channels for passing data between network goroutine and UI
	RecvCh chan []byte // incoming CT_DATA payload
	SendCh chan []byte // outgoing text to send as CT_DATA

	// Status updates for the UI
	StatusCh chan string

	// Signal to stop
	stopCh chan struct{}
	wg     sync.WaitGroup

	connected bool
}

// New creates a new Client.
func New(cfg Config) *Client {
	return &Client{
		cfg:      cfg,
		RecvCh:   make(chan []byte, 256),
		SendCh:   make(chan []byte, 256),
		StatusCh: make(chan string, 64),
		stopCh:   make(chan struct{}),
	}
}

// Start begins the connect-loop in a background goroutine.
func (c *Client) Start() {
	c.wg.Add(1)
	go c.connectLoop()
}

// Stop signals the client to disconnect and stop.
func (c *Client) Stop() {
	close(c.stopCh)
	c.mu.Lock()
	if c.conn != nil {
		// Send SUSPEND before closing
		_ = c.sendFrame(protocol.CT_SUSPEND, nil)
		c.conn.Close()
	}
	c.mu.Unlock()
	c.wg.Wait()
}

// connectLoop keeps trying to connect/reconnect until stopped.
func (c *Client) connectLoop() {
	defer c.wg.Done()
	delay := reconnectDelay
	for {
		select {
		case <-c.stopCh:
			return
		default:
		}

		c.status("Connecting to %s:%d…", c.cfg.Host, c.cfg.Port)
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", c.cfg.Host, c.cfg.Port), 10*time.Second)
		if err != nil {
			c.status("Connection failed: %v — retrying in %s", err, delay)
			select {
			case <-c.stopCh:
				return
			case <-time.After(delay):
			}
			if delay < maxReconnectDelay {
				delay *= 2
			}
			continue
		}
		delay = reconnectDelay // reset backoff on success

		c.mu.Lock()
		c.conn = conn
		c.mu.Unlock()

		if err := c.handshake(conn); err != nil {
			c.status("Handshake failed: %v", err)
			conn.Close()
			c.mu.Lock()
			c.conn = nil
			c.mu.Unlock()
			select {
			case <-c.stopCh:
				return
			case <-time.After(delay):
			}
			continue
		}

		c.status("Connected — session 0x%08X", c.sessionID)
		c.connected = true
		c.runSession(conn)
		c.connected = false

		c.mu.Lock()
		c.conn = nil
		c.mu.Unlock()

		select {
		case <-c.stopCh:
			return
		case <-time.After(delay):
		}
	}
}

// handshake performs CONNECT→ACCEPT or RESUME→RESUMED.
func (c *Client) handshake(conn net.Conn) error {
	var payload []byte
	var frameType byte

	if c.sessionID != 0 {
		// Resume existing session
		frameType = protocol.CT_RESUME
		payload = protocol.BuildResume(c.sessionID)
		c.status("Resuming session 0x%08X…", c.sessionID)
	} else {
		// New connection
		frameType = protocol.CT_CONNECT
		var nonce [16]byte
		if _, err := rand.Read(nonce[:]); err != nil {
			return fmt.Errorf("generate nonce: %w", err)
		}
		payload = protocol.BuildConnect(protocolVersion, clientCapabilities,
			c.cfg.TenantID, c.cfg.AgentID, c.cfg.Token, nonce)
	}

	frame := &protocol.Frame{
		SessionID: c.sessionID,
		Seq:       c.seq.Add(1),
		Type:      frameType,
		Payload:   payload,
	}
	if _, err := conn.Write(frame.Encode()); err != nil {
		return fmt.Errorf("send %02X: %w", frameType, err)
	}

	// Read response
	resp, err := protocol.DecodeFrame(conn)
	if err != nil {
		return fmt.Errorf("read handshake response: %w", err)
	}

	switch resp.Type {
	case protocol.CT_ACCEPT:
		sid, _, _, err := protocol.ParseAccept(resp.Payload)
		if err != nil {
			return err
		}
		c.sessionID = sid

	case protocol.CT_RESUMED:
		// Session successfully resumed; session_id unchanged

	case protocol.CT_ERROR:
		return fmt.Errorf("server error during handshake: %v", resp.Payload)

	default:
		return fmt.Errorf("unexpected handshake response type: 0x%02X", resp.Type)
	}

	return nil
}

// runSession handles bidirectional data and keepalives until disconnect.
func (c *Client) runSession(conn net.Conn) {
	recvDone := make(chan struct{})

	// Receiver goroutine
	go func() {
		defer close(recvDone)
		for {
			frame, err := protocol.DecodeFrame(conn)
			if err != nil {
				if err != io.EOF {
					c.status("Receive error: %v", err)
				}
				return
			}
			switch frame.Type {
			case protocol.CT_DATA:
				select {
				case c.RecvCh <- frame.Payload:
				default:
				}
				// Send ACK
				ack := &protocol.Frame{
					SessionID: c.sessionID,
					Seq:       c.seq.Add(1),
					Type:      protocol.CT_ACK,
				}
				c.mu.Lock()
				_, _ = conn.Write(ack.Encode())
				c.mu.Unlock()

			case protocol.CT_KEEPALIVE:
				// Echo keepalive back
				c.mu.Lock()
				_ = c.sendFrameLocked(conn, protocol.CT_KEEPALIVE, nil)
				c.mu.Unlock()

			case protocol.CT_DISCONNECT:
				c.status("Server requested disconnect")
				c.sessionID = 0 // don't try to resume
				return

			case protocol.CT_ERROR:
				c.status("Server error: %v", string(frame.Payload))
				return

			case protocol.CT_ACK, protocol.CT_NACK:
				// ignore for now

			default:
				c.status("Unknown frame type: 0x%02X", frame.Type)
			}
		}
	}()

	keepalive := time.NewTicker(keepaliveInterval)
	defer keepalive.Stop()

	for {
		select {
		case <-c.stopCh:
			return

		case data := <-c.SendCh:
			c.mu.Lock()
			err := c.sendFrameLocked(conn, protocol.CT_DATA, data)
			c.mu.Unlock()
			if err != nil {
				c.status("Send error: %v", err)
				return
			}

		case <-keepalive.C:
			c.mu.Lock()
			err := c.sendFrameLocked(conn, protocol.CT_KEEPALIVE, nil)
			c.mu.Unlock()
			if err != nil {
				c.status("Keepalive error: %v", err)
				return
			}

		case <-recvDone:
			return
		}
	}
}

// sendFrame is safe to call externally (acquires lock).
func (c *Client) sendFrame(frameType byte, payload []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return fmt.Errorf("not connected")
	}
	return c.sendFrameLocked(c.conn, frameType, payload)
}

// sendFrameLocked sends a frame; caller must hold c.mu.
func (c *Client) sendFrameLocked(conn net.Conn, frameType byte, payload []byte) error {
	frame := &protocol.Frame{
		SessionID: c.sessionID,
		Seq:       c.seq.Add(1),
		Type:      frameType,
		Payload:   payload,
	}
	_, err := conn.Write(frame.Encode())
	return err
}

// Send enqueues data to be sent as CT_DATA.
func (c *Client) Send(data []byte) {
	select {
	case c.SendCh <- data:
	default:
	}
}

// IsConnected returns whether the session is currently active.
func (c *Client) IsConnected() bool {
	return c.connected
}

func (c *Client) status(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	select {
	case c.StatusCh <- msg:
	default:
	}
}
