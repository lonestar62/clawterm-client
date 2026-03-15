// Package ui implements the VT220-style terminal UI using tcell.
// Green-on-black monospace aesthetic with a status bar and scrollback buffer.
package ui

import (
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/gdamore/tcell/v2"
)

const (
	scrollbackMax = 5000
	tabWidth      = 8
)

// UI manages the tcell screen and terminal emulation.
type UI struct {
	screen tcell.Screen

	// VT220 colour scheme
	fgColor  tcell.Color
	bgColor  tcell.Color
	dimColor tcell.Color

	// Scrollback buffer: each entry is a line of runes
	lines [][]rune
	mu    sync.Mutex

	// Current input line
	inputBuf []rune
	inputPos int // cursor position within inputBuf

	// Scroll offset (0 = bottom)
	scrollOff int

	// Callbacks
	OnInput    func([]byte) // called with UTF-8 when user submits input
	OnQuit     func()       // called on Ctrl-Q or Ctrl-C
	StatusText string       // shown in status bar

	// Internal channels
	redrawCh chan struct{}
	stopCh   chan struct{}
	wg       sync.WaitGroup
}

// New creates a UI but does not start it.
func New() (*UI, error) {
	screen, err := tcell.NewScreen()
	if err != nil {
		return nil, fmt.Errorf("create screen: %w", err)
	}
	if err := screen.Init(); err != nil {
		return nil, fmt.Errorf("init screen: %w", err)
	}
	screen.EnableMouse()
	screen.Clear()

	u := &UI{
		screen:   screen,
		fgColor:  tcell.NewRGBColor(0, 255, 70),    // phosphor green
		bgColor:  tcell.ColorBlack,
		dimColor: tcell.NewRGBColor(0, 160, 40),     // dim green for borders
		lines:    [][]rune{},
		redrawCh: make(chan struct{}, 4),
		stopCh:   make(chan struct{}),
	}
	return u, nil
}

// AppendText appends received server text to the scrollback buffer.
// Handles \r\n, \n, \r line endings and basic control characters.
func (u *UI) AppendText(data []byte) {
	u.mu.Lock()
	defer u.mu.Unlock()

	// Parse into lines
	var current []rune
	if len(u.lines) > 0 {
		// Continue the last line if it's not yet terminated
		current = u.lines[len(u.lines)-1]
		u.lines = u.lines[:len(u.lines)-1]
	}

	i := 0
	runes := []rune(string(data))
	for i < len(runes) {
		r := runes[i]
		switch r {
		case '\r':
			// carriage return — handled with following \n or alone
			if i+1 < len(runes) && runes[i+1] == '\n' {
				i++ // skip \n below
			}
			u.lines = append(u.lines, current)
			current = []rune{}
		case '\n':
			u.lines = append(u.lines, current)
			current = []rune{}
		case '\t':
			// expand tab
			spaces := tabWidth - (len(current) % tabWidth)
			for s := 0; s < spaces; s++ {
				current = append(current, ' ')
			}
		case '\b':
			if len(current) > 0 {
				current = current[:len(current)-1]
			}
		case 0x07: // BEL — ignore
		default:
			if r >= 0x20 || r == 0x1B {
				// Include printable and ESC (rudimentary — strip ANSI sequences)
				if r == 0x1B {
					// Skip ANSI escape: ESC [ ... final
					i++ // skip ESC
					if i < len(runes) && runes[i] == '[' {
						i++ // skip [
						for i < len(runes) && !isAnsiTerminator(runes[i]) {
							i++
						}
						// i now on terminator, will be incremented at loop bottom
					}
				} else if unicode.IsPrint(r) || r > 0x7E {
					current = append(current, r)
				}
			}
		}
		i++
	}
	u.lines = append(u.lines, current)

	// Trim scrollback
	if len(u.lines) > scrollbackMax {
		u.lines = u.lines[len(u.lines)-scrollbackMax:]
	}

	u.requestRedraw()
}

func isAnsiTerminator(r rune) bool {
	return r >= 0x40 && r <= 0x7E
}

// AppendStatus adds a status/info line in dim colour.
func (u *UI) AppendStatus(text string) {
	u.mu.Lock()
	u.lines = append(u.lines, []rune("["+text+"]"))
	u.mu.Unlock()
	u.requestRedraw()
}

// SetStatus updates the status bar text.
func (u *UI) SetStatus(text string) {
	u.StatusText = text
	u.requestRedraw()
}

// Run starts the event loop; blocks until stopped.
func (u *UI) Run() {
	defer u.screen.Fini()

	// tcell event channel — PollEvent is blocking so run it in a goroutine.
	evCh := make(chan tcell.Event, 64)
	go func() {
		for {
			ev := u.screen.PollEvent()
			if ev == nil {
				close(evCh)
				return
			}
			select {
			case evCh <- ev:
			case <-u.stopCh:
				return
			}
		}
	}()

	// Periodic redraw ticker (for status bar clock, etc.)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	u.draw()

	for {
		select {
		case <-u.stopCh:
			return

		case ev, ok := <-evCh:
			if !ok {
				return
			}
			if done := u.handleEvent(ev); done {
				return
			}
			u.draw()

		case <-u.redrawCh:
			u.draw()

		case <-ticker.C:
			u.draw()
		}
	}
}

// Stop signals the UI event loop to exit.
func (u *UI) Stop() {
	select {
	case <-u.stopCh:
	default:
		close(u.stopCh)
	}
}

func (u *UI) requestRedraw() {
	select {
	case u.redrawCh <- struct{}{}:
	default:
	}
}

// handleEvent processes a tcell event; returns true if UI should quit.
func (u *UI) handleEvent(ev tcell.Event) bool {
	switch ev := ev.(type) {
	case *tcell.EventResize:
		u.screen.Sync()
		u.draw()

	case *tcell.EventKey:
		return u.handleKey(ev)

	case *tcell.EventMouse:
		btn := ev.Buttons()
		if btn == tcell.WheelUp {
			u.mu.Lock()
			u.scrollOff += 3
			u.mu.Unlock()
			u.draw()
		} else if btn == tcell.WheelDown {
			u.mu.Lock()
			if u.scrollOff > 0 {
				u.scrollOff -= 3
				if u.scrollOff < 0 {
					u.scrollOff = 0
				}
			}
			u.mu.Unlock()
			u.draw()
		}
	}
	return false
}

func (u *UI) handleKey(ev *tcell.EventKey) bool {
	switch ev.Key() {
	case tcell.KeyCtrlC, tcell.KeyCtrlQ:
		if u.OnQuit != nil {
			u.OnQuit()
		}
		return true

	case tcell.KeyEnter:
		if len(u.inputBuf) > 0 {
			line := string(u.inputBuf) + "\n"
			u.inputBuf = nil
			u.inputPos = 0
			u.scrollOff = 0
			if u.OnInput != nil {
				u.OnInput([]byte(line))
			}
			u.draw()
		}

	case tcell.KeyBackspace, tcell.KeyBackspace2:
		if u.inputPos > 0 {
			u.inputBuf = append(u.inputBuf[:u.inputPos-1], u.inputBuf[u.inputPos:]...)
			u.inputPos--
			u.draw()
		}

	case tcell.KeyDelete:
		if u.inputPos < len(u.inputBuf) {
			u.inputBuf = append(u.inputBuf[:u.inputPos], u.inputBuf[u.inputPos+1:]...)
			u.draw()
		}

	case tcell.KeyLeft:
		if u.inputPos > 0 {
			u.inputPos--
			u.draw()
		}

	case tcell.KeyRight:
		if u.inputPos < len(u.inputBuf) {
			u.inputPos++
			u.draw()
		}

	case tcell.KeyHome, tcell.KeyCtrlA:
		u.inputPos = 0
		u.draw()

	case tcell.KeyEnd, tcell.KeyCtrlE:
		u.inputPos = len(u.inputBuf)
		u.draw()

	case tcell.KeyPgUp:
		u.mu.Lock()
		u.scrollOff += 10
		u.mu.Unlock()
		u.draw()

	case tcell.KeyPgDn:
		u.mu.Lock()
		if u.scrollOff > 0 {
			u.scrollOff -= 10
			if u.scrollOff < 0 {
				u.scrollOff = 0
			}
		}
		u.mu.Unlock()
		u.draw()

	case tcell.KeyRune:
		r := ev.Rune()
		u.inputBuf = append(u.inputBuf[:u.inputPos], append([]rune{r}, u.inputBuf[u.inputPos:]...)...)
		u.inputPos++
		u.draw()
	}
	return false
}

// draw renders the entire screen.
func (u *UI) draw() {
	u.screen.Clear()
	width, height := u.screen.Size()
	if width < 10 || height < 4 {
		return
	}

	normal := tcell.StyleDefault.Foreground(u.fgColor).Background(u.bgColor)
	dim := tcell.StyleDefault.Foreground(u.dimColor).Background(u.bgColor)
	reverse := tcell.StyleDefault.Foreground(u.bgColor).Background(u.fgColor)

	// Header bar (row 0)
	u.fillRow(0, reverse, width)
	title := " ClawTerm VT220  [Ctrl-Q: quit]  [PgUp/PgDn: scroll] "
	u.drawText(0, 0, reverse, title)

	// Status bar (last row)
	u.fillRow(height-1, dim, width)
	statusText := fmt.Sprintf(" %s ", u.StatusText)
	if len(statusText) > width {
		statusText = statusText[:width]
	}
	u.drawText(0, height-1, dim, statusText)

	// Input line (second to last row)
	u.fillRow(height-2, normal, width)
	prompt := "> "
	u.drawText(0, height-2, dim, prompt)
	inputStr := string(u.inputBuf)
	maxInput := width - len(prompt) - 1
	if maxInput < 0 {
		maxInput = 0
	}
	displayInput := inputStr
	if len([]rune(displayInput)) > maxInput {
		// Scroll input view to keep cursor visible
		runes := []rune(displayInput)
		start := u.inputPos - maxInput
		if start < 0 {
			start = 0
		}
		if u.inputPos-start < maxInput {
			displayInput = string(runes[start:])
		} else {
			end := start + maxInput
			if end > len(runes) {
				end = len(runes)
			}
			displayInput = string(runes[start:end])
		}
	}
	u.drawText(len(prompt), height-2, normal, displayInput)

	// Place cursor in input line
	cursorX := len(prompt) + u.inputPos
	if cursorX >= width {
		cursorX = width - 1
	}
	u.screen.ShowCursor(cursorX, height-2)

	// Horizontal divider above input
	divRow := height - 3
	if divRow > 0 {
		for x := 0; x < width; x++ {
			u.screen.SetContent(x, divRow, '─', nil, dim)
		}
	}

	// Terminal output area: rows 1..divRow-1
	outputHeight := divRow - 1
	if outputHeight <= 0 {
		u.screen.Show()
		return
	}

	u.mu.Lock()
	lines := u.lines
	scrollOff := u.scrollOff
	u.mu.Unlock()

	// Word-wrap lines to screen width
	wrapped := u.wrapLines(lines, width)

	// Clamp scroll offset
	maxScroll := len(wrapped) - outputHeight
	if maxScroll < 0 {
		maxScroll = 0
	}
	if scrollOff > maxScroll {
		scrollOff = maxScroll
		u.mu.Lock()
		u.scrollOff = scrollOff
		u.mu.Unlock()
	}

	// Which wrapped lines to display (bottom-anchored)
	startLine := len(wrapped) - outputHeight - scrollOff
	if startLine < 0 {
		startLine = 0
	}
	endLine := startLine + outputHeight
	if endLine > len(wrapped) {
		endLine = len(wrapped)
	}

	for i, wl := range wrapped[startLine:endLine] {
		row := 1 + i
		col := 0
		for _, r := range wl {
			if col >= width {
				break
			}
			style := normal
			// Dim bracket-enclosed status messages
			if len(wl) > 0 && wl[0] == '[' {
				style = dim
			}
			u.screen.SetContent(col, row, r, nil, style)
			col++
		}
	}

	// Scroll indicator
	if scrollOff > 0 {
		indicator := fmt.Sprintf("↑ %d lines", scrollOff)
		u.drawText(width-len(indicator)-1, 1, dim, indicator)
	}

	u.screen.Show()
}

// wrapLines wraps a slice of rune-lines to the given width.
func (u *UI) wrapLines(lines [][]rune, width int) [][]rune {
	var result [][]rune
	for _, line := range lines {
		if len(line) == 0 {
			result = append(result, []rune{})
			continue
		}
		for len(line) > 0 {
			if len(line) <= width {
				result = append(result, line)
				break
			}
			result = append(result, line[:width])
			line = line[width:]
		}
	}
	return result
}

func (u *UI) fillRow(row int, style tcell.Style, width int) {
	for x := 0; x < width; x++ {
		u.screen.SetContent(x, row, ' ', nil, style)
	}
}

func (u *UI) drawText(col, row int, style tcell.Style, text string) {
	for _, r := range text {
		u.screen.SetContent(col, row, r, nil, style)
		col++
	}
}

// Banner returns ASCII art banner lines for the welcome screen.
func Banner() []string {
	return []string{
		"",
		"  ╔═══════════════════════════════════════╗",
		"  ║         C L A W T E R M               ║",
		"  ║      VT220 Session Client v1.0         ║",
		"  ╚═══════════════════════════════════════╝",
		"",
		"  Type your input and press Enter to send.",
		"  Ctrl-Q or Ctrl-C to quit.",
		"  PgUp / PgDn or scroll wheel to navigate.",
		"",
	}
}

// PadRight pads a string with spaces to the given width.
func PadRight(s string, w int) string {
	if len(s) >= w {
		return s
	}
	return s + strings.Repeat(" ", w-len(s))
}
