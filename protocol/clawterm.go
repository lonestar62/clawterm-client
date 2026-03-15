// Package protocol implements the ClawTerm binary wire protocol.
//
// Wire format:
//   [FLAG:1][SESSION_ID:4BE][SEQ:4BE][TYPE:1][FLAGS:1][LEN:2BE][PAYLOAD:N][CRC16:2BE]
//   Total overhead: 15 bytes, FLAG always 0x7E
//
// CRC16: CRC-16/IBM (poly 0x8005, init 0x0000) over FLAG through PAYLOAD
package protocol

import (
	"encoding/binary"
	"fmt"
	"io"
)

// Frame type constants
const (
	FLAG byte = 0x7E

	CT_CONNECT    byte = 0x01
	CT_ACCEPT     byte = 0x02
	CT_RESUME     byte = 0x03
	CT_RESUMED    byte = 0x04
	CT_DATA       byte = 0x10
	CT_ACK        byte = 0x11
	CT_NACK       byte = 0x12
	CT_KEEPALIVE  byte = 0x20
	CT_SUSPEND    byte = 0x30
	CT_DISCONNECT byte = 0x40
	CT_ERROR      byte = 0xFF
)

// Frame represents a ClawTerm protocol frame.
type Frame struct {
	SessionID uint32
	Seq       uint32
	Type      byte
	Flags     byte
	Payload   []byte
}

// crc16 computes CRC-16/IBM (poly 0x8005, init 0x0000) over data.
func crc16(data []byte) uint16 {
	var crc uint16 = 0x0000
	for _, b := range data {
		crc ^= uint16(b) << 8
		for i := 0; i < 8; i++ {
			if crc&0x8000 != 0 {
				crc = (crc << 1) ^ 0x8005
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}

// Encode serialises a Frame to bytes ready to send over TCP.
func (f *Frame) Encode() []byte {
	payloadLen := len(f.Payload)
	// FLAG(1) + SESSION_ID(4) + SEQ(4) + TYPE(1) + FLAGS(1) + LEN(2) + PAYLOAD(N) + CRC(2)
	buf := make([]byte, 13+payloadLen+2)

	buf[0] = FLAG
	binary.BigEndian.PutUint32(buf[1:5], f.SessionID)
	binary.BigEndian.PutUint32(buf[5:9], f.Seq)
	buf[9] = f.Type
	buf[10] = f.Flags
	binary.BigEndian.PutUint16(buf[11:13], uint16(payloadLen))
	copy(buf[13:13+payloadLen], f.Payload)

	// CRC over FLAG through PAYLOAD
	crc := crc16(buf[:13+payloadLen])
	binary.BigEndian.PutUint16(buf[13+payloadLen:], crc)

	return buf
}

// DecodeFrame reads and decodes one frame from r.
func DecodeFrame(r io.Reader) (*Frame, error) {
	// Read fixed header: FLAG(1) + SESSION_ID(4) + SEQ(4) + TYPE(1) + FLAGS(1) + LEN(2)
	header := make([]byte, 13)
	if _, err := io.ReadFull(r, header); err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}
	if header[0] != FLAG {
		return nil, fmt.Errorf("invalid FLAG byte: 0x%02X", header[0])
	}

	sessionID := binary.BigEndian.Uint32(header[1:5])
	seq := binary.BigEndian.Uint32(header[5:9])
	frameType := header[9]
	flags := header[10]
	payloadLen := binary.BigEndian.Uint16(header[11:13])

	// Read payload + CRC
	rest := make([]byte, int(payloadLen)+2)
	if _, err := io.ReadFull(r, rest); err != nil {
		return nil, fmt.Errorf("read payload: %w", err)
	}

	payload := rest[:payloadLen]
	receivedCRC := binary.BigEndian.Uint16(rest[payloadLen:])

	// Verify CRC over FLAG through PAYLOAD
	crcData := make([]byte, 13+payloadLen)
	copy(crcData, header)
	copy(crcData[13:], payload)
	computedCRC := crc16(crcData)
	if computedCRC != receivedCRC {
		return nil, fmt.Errorf("CRC mismatch: computed 0x%04X, received 0x%04X", computedCRC, receivedCRC)
	}

	return &Frame{
		SessionID: sessionID,
		Seq:       seq,
		Type:      frameType,
		Flags:     flags,
		Payload:   payload,
	}, nil
}

// BuildConnect builds a CT_CONNECT payload.
// token must be exactly 32 bytes, nonce exactly 16 bytes.
func BuildConnect(version, capabilities byte, tenantID, agentID uint32, token [32]byte, nonce [16]byte) []byte {
	buf := make([]byte, 1+1+4+4+32+16)
	buf[0] = version
	buf[1] = capabilities
	binary.BigEndian.PutUint32(buf[2:6], tenantID)
	binary.BigEndian.PutUint32(buf[6:10], agentID)
	copy(buf[10:42], token[:])
	copy(buf[42:58], nonce[:])
	return buf
}

// ParseAccept parses a CT_ACCEPT payload.
func ParseAccept(payload []byte) (sessionID uint32, serverVersion, capabilities byte, err error) {
	if len(payload) < 6 {
		return 0, 0, 0, fmt.Errorf("CT_ACCEPT payload too short: %d bytes", len(payload))
	}
	sessionID = binary.BigEndian.Uint32(payload[0:4])
	serverVersion = payload[4]
	capabilities = payload[5]
	return
}

// BuildResume builds a CT_RESUME payload containing the session_id to resume.
func BuildResume(sessionID uint32) []byte {
	buf := make([]byte, 4)
	binary.BigEndian.PutUint32(buf, sessionID)
	return buf
}
