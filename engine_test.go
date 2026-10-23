package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSQLSubtypeRules(t *testing.T) {
	cases := []struct {
		input   string
		subtype byte
	}{
		{"java.sql.SQLSyntaxErrorException: ORA-00904: invalid identifier", 1},
		{"Caused by: java.sql.SQLIntegrityConstraintViolationException: ORA-00001", 2},
		{"java.sql.SQLRecoverableException: ORA-03113 end-of-file on communication channel", 3},
		{"SQLState: 08006", 3},
		{"org.springframework.jdbc.UncategorizedSQLException: ORA-01013", 4},
		{"java.sql.SQLException: ORA-00060 deadlock detected", 5},
		{"ORA-01653: unable to extend table", 6},
		{"ORA-01031: insufficient privileges", 7},
		{"java.sql.SQLException: unexpected SQL issue", 8},
		{"INFO SQL query finished normally", 0},
	}
	for _, tc := range cases {
		if got := detectSQLType(tc.input); got != tc.subtype {
			t.Errorf("%q: got=%d want=%d", tc.input, got, tc.subtype)
		}
	}
}
func TestStreamMetadataOnlyAndOffsets(t *testing.T) {
	dir := t.TempDir()
	log := strings.Join([]string{
		"[2026.10.23 09:01:01][2] [ms1-1] [SERVER-0001] ready",
		"[2026.10.23 09:01:02][0] [ms1-1] [APP-0002] transaction failed",
		"java.lang.RuntimeException: wrapped",
		"  at demo.Thing.execute(Thing.java:24)",
		"Caused by: org.springframework.jdbc.BadSqlGrammarException: SQL error",
		"Caused by: java.sql.SQLSyntaxErrorException: ORA-00904: INVALID_COLUMN",
		"  at oracle.jdbc.ThinDriver.getConnection(ThinDriver.java:1)",
		"[2026.10.23 09:01:03][1] [ms1-1] [APP-0003] slow response",
		"2026-10-23 10:00:02,500 ERROR java.lang.NullPointerException",
		""}, "\n")
	result, e := buildIndexStream(strings.NewReader(log), dir, "utf-8", func(int64) {})
	if e != nil {
		t.Fatal(e)
	}
	if result.Counts.All != 4 || result.Counts.Error != 2 || result.Counts.SQL != 1 || result.Counts.Warning != 1 {
		t.Fatalf("wrong summary: %+v", result)
	}
	if len(result.SQLTypes) != 1 || result.SQLTypes[0].Name != "SQL 문법·객체" {
		t.Fatalf("wrong types: %+v", result.SQLTypes)
	}
	if len(result.Hourly) != 2 {
		t.Fatalf("hourly=%+v", result.Hourly)
	}
	if _, err := os.Stat(filepath.Join(dir, "original.log")); !os.IsNotExist(err) {
		t.Fatal("source log must never be written")
	}
	if _, err := os.Stat(filepath.Join(dir, "index.bin")); err != nil {
		t.Fatal(err)
	}
	f, _ := os.Open(filepath.Join(dir, "index.bin"))
	defer f.Close()
	if st, _ := f.Stat(); st.Size() != 4*24 {
		t.Fatalf("index size %d", st.Size())
	}
	rr, e := readRecord(f, 1)
	if e != nil {
		t.Fatal(e)
	}
	if rr.Category != 1 || rr.Subtype != 1 || rr.Line != 2 || rr.EndLine != 7 {
		t.Errorf("SQL event %+v", rr)
	}
	got := log[rr.Offset : uint64(rr.Offset)+uint64(rr.Length)]
	if !strings.Contains(got, "ORA-00904") || !strings.Contains(got, "Caused by") {
		t.Errorf("unexpected slice %q", got)
	}
	if !matchesGroup(rr, "sql:1") || matchesGroup(rr, "sql:2") || matchesGroup(rr, "otherError") {
		t.Fatal("subtype filtering broken")
	}
	if got := fmt.Sprint(result.Counts.Info + result.Counts.Warning + result.Counts.Error); got != "4" {
		t.Fatal(got)
	}
}
func TestLongLineBoundedScan(t *testing.T) {
	dir := t.TempDir()
	data := "[2026.10.23 00:00:00][0] [a-1] [ERR-1111] " + strings.Repeat("X", 200000) + "\nCaused by: java.sql.SQLException: ORA-00001"
	got, e := buildIndexStream(strings.NewReader(data), dir, "utf-8", func(int64) {})
	if e != nil {
		t.Fatal(e)
	}
	if got.Counts.All != 1 || got.Counts.SQL != 1 {
		t.Fatalf("unexpected %+v", got)
	}
	f, _ := os.Open(filepath.Join(dir, "index.bin"))
	defer f.Close()
	rr, _ := readRecord(f, 0)
	if int(rr.Length) != len(data) {
		t.Errorf("offset/length mismatch: %+v", rr)
	}
}
func TestVerifySHA256AndArchiveAPI(t *testing.T) {
	root := t.TempDir()
	t.Setenv("JEUS_LENS_DATA_DIR", root)
	en, e := newEngine()
	if e != nil {
		t.Fatal(e)
	}
	id := "aabbccddeeff00112233445566778899"
	dir := en.folder(id)
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	original := []byte("[2026.10.23 12:00:00][0] [m-1] [SQL-1000] ORA-00942\n")
	h := sha256.Sum256(original)
	summary := Summary{ID: id, Name: "test.log", Size: int64(len(original)), SourceHash: hex.EncodeToString(h[:]), Indexed: true, StorageMode: "metadata-only"}
	payload, _ := json.Marshal(summary)
	_ = os.WriteFile(filepath.Join(dir, "summary.json"), payload, 0600)
	mux := http.NewServeMux()
	host := "127.0.0.1:42424"
	en.register(mux, host)
	req := func(b []byte) *http.Request {
		r := httptest.NewRequest("POST", "http://"+host+"/api/verify?id="+id, bytes.NewReader(b))
		r.Header.Set("Origin", "http://"+host)
		return r
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req(original))
	if recorder.Code != 200 {
		t.Fatalf("correct source rejected: %d %s", recorder.Code, recorder.Body.String())
	}
	altered := bytes.Replace(original, []byte("00942"), []byte("00943"), 1)
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, req(altered))
	if recorder.Code != 409 {
		t.Fatalf("altered file accepted: %d", recorder.Code)
	}
	r := req(original)
	r.Header.Set("Origin", "https://hostile.example")
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, r)
	if recorder.Code != 403 {
		t.Fatalf("foreign origin: %d", recorder.Code)
	}
	if _, e := io.ReadAll(recorder.Result().Body); e != nil {
		t.Fatal(e)
	}
}

func TestCP949Input(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("tests", "sample_cp949.log"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(decodeText(raw, "euc-kr"), "장비 연결 오류") {
		t.Fatalf("CP949 decoding failed")
	}
	sum, err := buildIndexStream(bytes.NewReader(raw), t.TempDir(), "euc-kr", func(int64) {})
	if err != nil {
		t.Fatal(err)
	}
	if sum.Counts.All != 2 || sum.Counts.Error != 1 {
		t.Fatalf("CP949 classification: %+v", sum.Counts)
	}
}

// Summaries contain stable, sanitized fingerprints rather than full log messages.
// Sensitive runtime data must stay exclusively in the user-selected source file.
func TestMetadataSummaryDoesNotPersistMessageBodies(t *testing.T) {
	dir := t.TempDir()
	secret := "SECRET_API_TOKEN_123456789_FOR_TEST"
	log := "[2026.10.23 14:30:00][0] [x-1] [APP-0001] authentication failed " + secret + "\n" +
		"[2026.10.23 14:30:01][0] [x-1] [APP-0002] javax.crypto.BadPaddingException: " + secret + "\n" +
		"[2026.10.23 14:30:02][0] [x-1] [APP-0003] ORA-00904: " + secret + "\n"
	summary, err := buildIndexStream(strings.NewReader(log), dir, "utf-8", func(int64) {})
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, []byte(secret)) {
		t.Fatal("summary leaked log content")
	}
	index, err := os.ReadFile(filepath.Join(dir, "index.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(index, []byte(secret)) {
		t.Fatal("index leaked log content")
	}
	if summary.Counts.Error != 3 || summary.Counts.SQL != 1 {
		t.Fatalf("unexpected counts: %+v", summary.Counts)
	}
}

func TestUTF16LEByteOffsetsAndLevel(t *testing.T) {
	dir := t.TempDir()
	lines := "[2026.10.23 10:00:00][2] [m-1] [APP-0001] 준비 완료\n" +
		"[2026.10.23 10:00:01][0] [m-1] [APP-0002] java.sql.SQLException: ORA-00001\n" +
		"Caused by: java.sql.SQLIntegrityConstraintViolationException: ORA-00001\n"
	utf16 := []byte{0xff, 0xfe}
	for _, r := range lines {
		if r > 0xffff {
			t.Fatalf("unexpected rune %U", r)
		}
		utf16 = append(utf16, byte(r), byte(r>>8))
	}
	result, err := buildIndexStream(bytes.NewReader(utf16), dir, "utf-16le", func(int64) {})
	if err != nil {
		t.Fatal(err)
	}
	if result.Counts.All != 2 || result.Counts.SQL != 1 || result.Counts.Error != 1 || result.Counts.Info != 1 {
		t.Fatalf("utf16 header/level parsing: %+v", result.Counts)
	}
	f, err := os.Open(filepath.Join(dir, "index.bin"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	first, err := readRecord(f, 0)
	if err != nil {
		t.Fatal(err)
	}
	second, err := readRecord(f, 1)
	if err != nil {
		t.Fatal(err)
	}
	if first.Offset != 0 || first.Level != 3 || second.Offset != uint64(first.Length) || second.Level != 1 || second.Category != 1 || second.EndLine != 3 {
		t.Fatalf("UTF16 offset/metadata: first=%+v second=%+v", first, second)
	}
	if uint64(first.Length)+uint64(second.Length) != uint64(len(utf16)) {
		t.Fatal("UTF16 byte count mismatch")
	}
}

// A canceled upload must never commit its partial random-access metadata.
func TestCancelledIndexDoesNotCommit(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	record := []byte("[2026.10.23 00:00:00][2] [ms-1] [APP-1000] " + strings.Repeat("A", 4000) + "\n")
	_, err := buildIndexStreamContext(ctx, &repeatReader{pattern: record, remaining: 32 << 20}, dir, "utf-8", func(n int64) {
		if n >= 8<<20 {
			cancel()
		}
	})
	if err != context.Canceled {
		t.Fatalf("expected cancellation, got %v", err)
	}
	for _, name := range []string{"index.part", "index.bin"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("%s left after cancel: %v", name, err)
		}
	}
}

// A failed HTTP import must release both its reservation and its partial files.
func TestCancelledImportReleasesReservation(t *testing.T) {
	root := t.TempDir()
	t.Setenv("JEUS_LENS_DATA_DIR", root)
	en, err := newEngine()
	if err != nil {
		t.Fatal(err)
	}
	id := "11112222333344445555666677778888"
	raw := []byte("[2026.10.23 00:00:00][2] [ms-1] [APP-1000] ready\n")
	r := httptest.NewRequest("POST", "/api/import?id="+id+"&name=log.txt&encoding=utf-8", bytes.NewReader(raw))
	ctx, cancel := context.WithCancel(r.Context())
	cancel()
	r = r.WithContext(ctx)
	out := httptest.NewRecorder()
	en.importFile(out, r)
	if out.Code != 400 {
		t.Fatalf("unexpected HTTP status: %d %s", out.Code, out.Body.String())
	}
	en.mu.Lock()
	_, stillReserved := en.jobs[id]
	en.mu.Unlock()
	if stillReserved {
		t.Fatal("canceled import reservation leaked")
	}
	if _, err := os.Stat(en.folder(id)); !os.IsNotExist(err) {
		t.Fatalf("partial folder persisted: %v", err)
	}
}

// Grouping follows SQL codes and non-SQL root exception type + Java origin frame,
// not varying IDs or user-defined message bodies. Only opaque 8-byte issue IDs
// are persisted beside the fixed-size event index.
func TestStructuralIssueGroupsAndPrivacy(t *testing.T) {
	dir := t.TempDir()
	secret := "PRIVATE_CUSTOMER_TOKEN_6789"
	log := strings.Join([]string{
		"[2026.10.23 14:00:00][0] [a-1] [APP-0001] java.lang.IllegalStateException: order 123 " + secret,
		"  at demo.OrderService.commit(OrderService.java:100)",
		"[2026.10.23 14:01:00][0] [b-1] [APP-0001] java.lang.IllegalStateException: order 987 " + secret,
		"  at demo.OrderService.commit(OrderService.java:120)",
		"[2026.10.23 14:01:30][0] [c-1] [APP-0002] java.lang.IllegalStateException: other operation " + secret,
		"  at demo.OtherService.commit(OtherService.java:100)",
		"[2026.10.23 14:02:00][0] [d-1] [SQL-1001] java.sql.SQLException: ORA-00904: " + secret,
		"[2026.10.23 14:03:00][0] [e-1] [SQL-1001] java.sql.SQLException: ORA-00904: another literal",
		"[2026.10.23 14:04:00][0] [f-1] [SQL-1001] java.sql.SQLException: ORA-00001: constraint",
		"[2026.10.23 14:05:00][2] [g-1] [APP-9999] expected INFO message",
	}, "\n") + "\n"
	summary, err := buildIndexStream(strings.NewReader(log), dir, "utf-8", func(int64) {})
	if err != nil {
		t.Fatal(err)
	}
	if summary.IssueVersion != 1 || summary.Counts.All != 7 || len(summary.Issues) != 4 {
		t.Fatalf("unexpected group cardinality: %+v", summary)
	}
	counts := []int64{}
	for _, issue := range summary.Issues {
		counts = append(counts, issue.Count)
	}
	if fmt.Sprint(counts) != "[2 2 1 1]" {
		t.Fatalf("expected stable grouping, got %v", counts)
	}
	encoded, _ := json.Marshal(summary)
	issueIndex, err := os.ReadFile(filepath.Join(dir, "issues.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if len(issueIndex) != 7*8 {
		t.Fatalf("issue index size = %d", len(issueIndex))
	}
	if bytes.Contains(encoded, []byte(secret)) || bytes.Contains(issueIndex, []byte(secret)) {
		t.Fatal("sensitive message text leaked into stored metadata")
	}
	if binary.LittleEndian.Uint64(issueIndex[0:8]) != binary.LittleEndian.Uint64(issueIndex[8:16]) ||
		binary.LittleEndian.Uint64(issueIndex[0:8]) == binary.LittleEndian.Uint64(issueIndex[16:24]) ||
		binary.LittleEndian.Uint64(issueIndex[24:32]) != binary.LittleEndian.Uint64(issueIndex[32:40]) ||
		binary.LittleEndian.Uint64(issueIndex[48:56]) != 0 {
		t.Fatal("unexpected issue grouping or INFO sentinel")
	}
}

func TestIssueFilterAndLegacySupport(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("JEUS_LENS_DATA_DIR", dir)
	engine, err := newEngine()
	if err != nil {
		t.Fatal(err)
	}
	id := "12341234123412341234123412341234"
	dst := engine.folder(id)
	if err := os.MkdirAll(dst, 0700); err != nil {
		t.Fatal(err)
	}
	source := "[2026.10.23 10:00:00][0] [a-1] [APP-1111] java.lang.IllegalStateException: first\n" +
		"  at demo.JobService.run(JobService.java:1)\n" +
		"[2026.10.23 10:01:00][0] [a-1] [APP-1111] java.lang.IllegalStateException: second\n" +
		"  at demo.JobService.run(JobService.java:2)\n" +
		"[2026.10.23 10:02:00][0] [a-1] [APP-2222] java.lang.NullPointerException: other\n"
	sum, err := buildIndexStream(strings.NewReader(source), dst, "utf-8", func(int64) {})
	if err != nil {
		t.Fatal(err)
	}
	sum.ID = id
	sum.Indexed = true
	b, _ := json.Marshal(sum)
	if err := os.WriteFile(filepath.Join(dst, "summary.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	host := "127.0.0.1:42024"
	engine.register(mux, host)
	request := func(group string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "http://"+host+"/api/filter", strings.NewReader(fmt.Sprintf(`{"id":%q,"group":%q}`, id, group)))
		r.Header.Set("Origin", "http://"+host)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	if len(sum.Issues) != 2 {
		t.Fatalf("issue list: %+v", sum.Issues)
	}
	w := request("issue:" + sum.Issues[0].ID)
	if w.Code != 200 {
		t.Fatalf("filter status %d %s", w.Code, w.Body.String())
	}
	var got struct {
		Total int64 `json:"total"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Total != 2 {
		t.Fatalf("issue filter returned %d, expected 2", got.Total)
	}
	if w = request("issue:ffffffffffffffff"); w.Code != 400 {
		t.Fatalf("unknown issue accepted: %d", w.Code)
	}
	// Old stored sessions have no issues.bin and can still use v5 filters.
	sum.IssueVersion = 0
	sum.Issues = nil
	b, _ = json.Marshal(sum)
	_ = os.WriteFile(filepath.Join(dst, "summary.json"), b, 0600)
	_ = os.Remove(filepath.Join(dst, "issues.bin"))
	if w = request("error"); w.Code != 200 {
		t.Fatalf("legacy filter failed: %d %s", w.Code, w.Body.String())
	}
}

// Datadog-style structural grouping: variable values and line numbers must not
// cause separate issues, while SQL error codes and non-SQL stack frames should.
func TestStructuralIssueGrouping(t *testing.T) {
	lines := []string{
		"[2026.10.23 10:00:01][0] [ms1] [APP-1111] SQLSyntaxErrorException ORA-00904: CUSTOMER_ID_123",
		"[2026.10.23 10:00:02][0] [ms1] [APP-1111] SQLSyntaxErrorException ORA-00904: CUSTOMER_ID_456",
		"[2026.10.23 10:00:03][0] [ms1] [APP-1111] ORA-00001: unique constraint violated",
		"[2026.10.23 10:00:04][0] [ms1] [APP-1111] java.lang.NullPointerException: id=111",
		"  at demo.Service.handle(Service.java:12)",
		"[2026.10.23 10:00:05][0] [ms1] [APP-1111] java.lang.NullPointerException: id=222",
		"  at demo.Service.handle(Service.java:99)",
		"[2026.10.23 10:00:06][0] [ms1] [APP-1111] java.lang.NullPointerException: id=333",
		"  at demo.Other.handle(Other.java:1)",
		"[2026.10.23 10:00:07][2] [ms1] [APP-1111] Normal operation",
	}
	root := t.TempDir()
	result, err := buildIndexStream(strings.NewReader(strings.Join(lines, "\n")+"\n"), root, "utf-8", func(int64) {})
	if err != nil {
		t.Fatal(err)
	}
	if result.IssueVersion != 1 || result.Counts.All != 7 || len(result.Issues) != 4 {
		t.Fatalf("unexpected issue summary: %+v", result)
	}
	b, err := os.ReadFile(filepath.Join(root, "issues.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if len(b) != 7*8 {
		t.Fatalf("issue index length = %d", len(b))
	}
	refs := make([]uint64, 7)
	for i := range refs {
		refs[i] = binary.LittleEndian.Uint64(b[i*8 : i*8+8])
	}
	if refs[0] == 0 || refs[0] != refs[1] || refs[0] == refs[2] {
		t.Fatalf("SQL grouping broken: %v", refs)
	}
	if refs[3] == 0 || refs[3] != refs[4] || refs[3] == refs[5] || refs[6] != 0 {
		t.Fatalf("non-SQL stack grouping broken: %v", refs)
	}
	for _, issue := range result.Issues {
		if strings.Contains(issue.Name, "CUSTOMER_ID") || strings.Contains(issue.Name, "id=111") {
			t.Fatal("unsanitized log message in issue name")
		}
	}
}

func TestIssueIndexNotWrittenOnCancellation(t *testing.T) {
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := buildIndexStreamContext(ctx, strings.NewReader("[2026.10.23 10:00:00][0] [ms] [APP-1234] ORA-00904\n"), root, "utf-8", func(int64) {})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context cancellation; got %v", err)
	}
	for _, file := range []string{"issues.bin", "issues.part", "index.bin", "index.part"} {
		if _, err := os.Stat(filepath.Join(root, file)); !os.IsNotExist(err) {
			t.Errorf("partial index file remained: %s", file)
		}
	}
}
