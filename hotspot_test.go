package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFiveMinuteBucketValidation(t *testing.T) {
	checks := map[string]string{
		"2026.10.23 09:01:59": "2026-10-23 09:00",
		"2026/10/23 09:09:00": "2026-10-23 09:05",
		"2026-10-23T09:59:00": "2026-10-23 09:55",
		"2026.10.23 10:00:00": "2026-10-23 10:00",
		"2026-02-30 10:00:00": "",
		"2026-10-23 24:00:00": "",
		"not a date":          "",
	}
	for input, want := range checks {
		if got := fiveMinuteBucket(input); got != want {
			t.Errorf("%q: got %q, want %q", input, got, want)
		}
	}
}

func TestHotspotCountsAndSourcePointers(t *testing.T) {
	lines := []string{
		"[2026.10.23 10:01:00][2] [ms1-1] [APP-1] begin",
		"[2026.10.23 10:01:30][0] [ms1-1] [APP-2] error",
		"Caused by: java.sql.SQLException: ORA-00001: failed LOT_ID=SECRET-9",
		"[2026.10.23 10:02:00][1] [ms1-1] [APP-3] warning",
		"[2026.10.23 10:04:50][0] [ms1-1] [APP-4] error again",
		"[2026.10.23 10:06:00][0] [ms1-1] [APP-5] other error",
		"[2026.10.23 10:07:00][2] [ms1-1] [APP-6] ok",
		"[2026.10.23 10:08:00][0] [ms1-1] [APP-7] error",
	}
	dir := t.TempDir()
	log := strings.Join(lines, "\n") + "\n"
	m, err := buildIndexStream(strings.NewReader(log), dir, "utf-8", func(int64) {})
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Hotspots) != 2 {
		t.Fatalf("hotspots=%+v", m.Hotspots)
	}
	a, b := m.Hotspots[0], m.Hotspots[1]
	if a.Start != "2026-10-23 10:00" || a.Errors != 2 || a.SQLErrors != 1 || a.Warnings != 1 || a.All != 4 || a.FirstErrorEvent != 1 || a.LastErrorEvent != 3 {
		t.Fatalf("first bucket wrong: %+v", a)
	}
	if b.Start != "2026-10-23 10:05" || b.Errors != 2 || b.SQLErrors != 0 || b.All != 3 || b.FirstErrorEvent != 4 || b.LastErrorEvent != 6 {
		t.Fatalf("second bucket wrong: %+v", b)
	}
	if m.HotspotLimited {
		t.Fatal("unexpected partial summary")
	}
	for _, filename := range []string{"index.bin", "issues.bin"} {
		if _, err := os.Stat(filepath.Join(dir, filename)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "hotspots.bin")); !os.IsNotExist(err) {
		t.Fatal("unexpected new per-event index")
	}
	data, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte("SECRET-9")) {
		t.Fatal("input data persisted in hotspots")
	}
}

func TestHotspotWithoutTimeOrError(t *testing.T) {
	m, err := buildIndexStream(strings.NewReader("ERROR no timestamp\n[2026.10.23 11:12:00][2] ready\n"), t.TempDir(), "utf-8", func(int64) {})
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Hotspots) != 0 {
		t.Fatalf("unexpected hotspots %+v", m.Hotspots)
	}
}
