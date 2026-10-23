package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A one-hour, adequately sampled baseline followed by a severe increase in
// error *rate* qualifies; merely increasing event volume does not.
func TestErrorSurgeRatesAndMinimumEvidence(t *testing.T) {
	buckets := make(map[string]*Hotspot)
	for i := 0; i < 12; i++ {
		key := fmt.Sprintf("2026-10-23 %02d:%02d", 10+i/12, (i%12)*5)
		buckets[key] = &Hotspot{Start: key, All: 25, Errors: 1, FirstErrorEvent: int64(i * 25), LastErrorEvent: int64(i * 25)}
	}
	buckets["2026-10-23 11:00"] = &Hotspot{Start: "2026-10-23 11:00", All: 30, Errors: 15, FirstErrorEvent: 301, LastErrorEvent: 325}
	surges := findErrorSurges(buckets)
	if len(surges) != 1 || surges[0].Start != "2026-10-23 11:00" || surges[0].BaselineAll != 300 || surges[0].BaselineErrors != 12 {
		t.Fatalf("expected rate spike with preceding baseline, got %+v", surges)
	}
	// More total errors at a lower rate must not be mistaken for a surge.
	buckets["2026-10-23 11:00"] = &Hotspot{Start: "2026-10-23 11:00", All: 500, Errors: 15, FirstErrorEvent: 301, LastErrorEvent: 325}
	if got := findErrorSurges(buckets); len(got) != 0 {
		t.Fatalf("count-only false alarm: %+v", got)
	}
	// A sparse baseline is not sufficient for rate comparison.
	for i := 0; i < 12; i++ {
		key := fmt.Sprintf("2026-10-23 %02d:%02d", 10+i/12, (i%12)*5)
		buckets[key].All = 2
		buckets[key].Errors = 0
	}
	buckets["2026-10-23 11:00"] = &Hotspot{Start: "2026-10-23 11:00", All: 30, Errors: 15, FirstErrorEvent: 301, LastErrorEvent: 325}
	if got := findErrorSurges(buckets); len(got) != 0 {
		t.Fatalf("sparse false alarm: %+v", got)
	}
}

func TestErrorSurgeNoMissingTimeExtrapolation(t *testing.T) {
	b := map[string]*Hotspot{}
	for i := 0; i < 6; i++ {
		key := fmt.Sprintf("2026-10-23 09:%02d", i*5)
		b[key] = &Hotspot{Start: key, All: 40, Errors: 0}
	}
	// Gap exceeds the hour immediately before 11:00.
	b["2026-10-23 11:00"] = &Hotspot{Start: "2026-10-23 11:00", All: 30, Errors: 20, FirstErrorEvent: 0}
	if got := findErrorSurges(b); len(got) != 0 {
		t.Fatalf("historical gap should suppress detection: %+v", got)
	}
}

func TestErrorSurgeMetadataAndSourceLocations(t *testing.T) {
	var source strings.Builder
	for i := 0; i < 12; i++ {
		for j := 0; j < 25; j++ {
			level := "2"
			if j == 0 {
				level = "0"
			}
			fmt.Fprintf(&source, "[2026.10.23 %02d:%02d:%02d][%s] event secret=TOP-SECRET-LOT-001\n", 10, i*5, j%60, level)
		}
	}
	for j := 0; j < 30; j++ {
		level := "2"
		if j < 15 {
			level = "0"
		}
		fmt.Fprintf(&source, "[2026.10.23 11:00:%02d][%s] event secret=TOP-SECRET-LOT-001\n", j, level)
	}
	dir := t.TempDir()
	summary, err := buildIndexStream(strings.NewReader(source.String()), dir, "utf-8", func(int64) {})
	if err != nil {
		t.Fatal(err)
	}
	if summary.Counts.All != 330 || len(summary.ErrorSurges) != 1 {
		t.Fatalf("unexpected summary: %+v", summary.ErrorSurges)
	}
	alert := summary.ErrorSurges[0]
	if alert.Start != "2026-10-23 11:00" || alert.FirstErrorEvent != 300 || alert.LastErrorEvent != 314 {
		t.Fatalf("wrong event pointers %+v", alert)
	}
	raw, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("TOP-SECRET-LOT")) {
		t.Fatal("log contents leaked into summary")
	}
	if _, err := os.Stat(filepath.Join(dir, "surges.bin")); !os.IsNotExist(err) {
		t.Fatal("surge must not create an event index")
	}
	for name, size := range map[string]int64{"index.bin": 24 * 330, "issues.bin": 8 * 330} {
		fi, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if fi.Size() != size {
			t.Fatalf("%s size got %d want %d", name, fi.Size(), size)
		}
	}
}

// JEUS logs are typically one day or less. A one-day input should not
// introduce a fabricated daily or weekly baseline; only the preceding hour
// may influence a five-minute surge classification, even across midnight.
func TestErrorSurgeOneDayLogAndMidnightBoundary(t *testing.T) {
	b := make(map[string]*Hotspot)
	begin := time.Date(2026, 10, 22, 0, 5, 0, 0, time.UTC)
	for i := 0; i < 24*12; i++ {
		stamp := begin.Add(time.Duration(i*5) * time.Minute).Format("2006-01-02 15:04")
		b[stamp] = &Hotspot{Start: stamp, All: 25, Errors: 1}
	}
	// A sharp last-five-minute increase crosses the date boundary.
	stamp := begin.Add(24*time.Hour - 5*time.Minute).Format("2006-01-02 15:04")
	b[stamp] = &Hotspot{Start: stamp, All: 30, Errors: 15, FirstErrorEvent: 100, LastErrorEvent: 114}
	got := findErrorSurges(b)
	if len(got) != 1 || got[0].Start != stamp || got[0].BaselineAll != 300 {
		t.Fatalf("one-day boundary surge mismatch: %+v", got)
	}
}

// A burst following a logging blackout is only a triage fact, not evidence
// of a rate increase over the directly prior interval.
func TestErrorSurgeRejectsInactiveImmediatelyPriorBin(t *testing.T) {
	b := make(map[string]*Hotspot)
	begin := time.Date(2026, 10, 22, 20, 0, 0, 0, time.UTC)
	for i := 0; i < 11; i++ {
		stamp := begin.Add(time.Duration(i*5) * time.Minute).Format("2006-01-02 15:04")
		b[stamp] = &Hotspot{Start: stamp, All: 25, Errors: 1}
	}
	stamp := begin.Add(time.Hour).Format("2006-01-02 15:04")
	b[stamp] = &Hotspot{Start: stamp, All: 30, Errors: 20, FirstErrorEvent: 200, LastErrorEvent: 219}
	if got := findErrorSurges(b); len(got) != 0 {
		t.Fatalf("gap immediately before surge should suppress claims: %+v", got)
	}
}
