package main

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Run explicitly via JEUS_LENS_STRESS_1GB=1 go test -run TestOneGiBStreaming -timeout 3m.
// The source is generated from a small repeated pattern; it is never stored in memory/disk.
func TestOneGiBStreaming(t *testing.T) {
	if os.Getenv("JEUS_LENS_STRESS_1GB") != "1" {
		t.Skip("explicit 1 GiB stress test only")
	}
	size := int64(1 << 30)
	if v := os.Getenv("JEUS_LENS_STRESS_SIZE_MIB"); v != "" {
		if x, err := strconv.ParseInt(v, 10, 64); err == nil && x > 0 && x <= 1024 {
			size = x << 20
		}
	}
	const length = 4096
	header := "[2026.10.23 12:00:00][2] [ms1-1] [APP-0100] periodic normal event "
	record := []byte(header + strings.Repeat("x", length-len(header)-1) + "\n")
	if len(record) != length {
		t.Fatal("bad record length")
	}
	source := io.LimitReader(bytes.NewReader(record), 0) // replaced by io.MultiReader streaming repeat below
	_ = source
	dir := t.TempDir()
	start := time.Now()
	result, err := buildIndexStream(&repeatReader{pattern: record, remaining: size}, dir, "utf-8", func(int64) {})
	if err != nil {
		t.Fatal(err)
	}
	expected := size / length
	if result.Counts.All != expected || result.Counts.Error != 0 || result.Counts.SQL != 0 {
		t.Fatalf("bad result %+v", result.Counts)
	}
	stat, err := os.Stat(filepath.Join(dir, "index.bin"))
	if err != nil {
		t.Fatal(err)
	}
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	t.Logf("Streaming scan: duration=%s, events=%d, index=%d bytes (%.2f%% of raw), GoHeapAlloc=%d bytes", time.Since(start), result.Counts.All, stat.Size(), float64(stat.Size())*100/float64(size), mem.Alloc)
}

type repeatReader struct {
	pattern   []byte
	pos       int
	remaining int64
}

func (r *repeatReader) Read(p []byte) (int, error) {
	if r.remaining <= 0 {
		return 0, io.EOF
	}
	if int64(len(p)) > r.remaining {
		p = p[:r.remaining]
	}
	n := 0
	for n < len(p) {
		c := copy(p[n:], r.pattern[r.pos:])
		n += c
		r.pos = (r.pos + c) % len(r.pattern)
	}
	r.remaining -= int64(n)
	return n, nil
}
