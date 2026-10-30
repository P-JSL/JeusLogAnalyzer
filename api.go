package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type job struct {
	Read    int64  `json:"received"`
	Indexed int64  `json:"indexed"`
	Size    int64  `json:"size"`
	Stage   string `json:"stage"`
	Error   string `json:"error,omitempty"`
}
type filterIndex struct {
	Session string
	Path    string
	Total   int64
}
type engine struct {
	root     string
	mu       sync.Mutex
	jobs     map[string]*job
	filters  map[string]filterIndex
	reserved int64
}

func newEngine() (*engine, error) {
	root := os.Getenv("JEUS_LENS_DATA_DIR")
	if root == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return nil, err
		}
		root = filepath.Join(base, "JEUS_Lens", "archive")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	// Temporary filtered page indexes are not durable metadata. Clear stale ones from previous runs.
	entries, _ := os.ReadDir(root)
	for _, d := range entries {
		if !d.IsDir() || !validID(d.Name()) {
			continue
		}
		paths, _ := filepath.Glob(filepath.Join(root, d.Name(), "filter-*.tmp"))
		for _, path := range paths {
			_ = os.Remove(path)
		}
	}
	return &engine{root: root, jobs: make(map[string]*job), filters: make(map[string]filterIndex)}, nil
}
func (s *engine) folder(id string) string { return filepath.Join(s.root, id) }

var idValid = regexp.MustCompile(`^[a-zA-Z0-9-]{16,48}$`)

func validID(id string) bool { return idValid.MatchString(id) }
func createToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func (s *engine) diskUsed() int64 {
	list, _ := os.ReadDir(s.root)
	var n int64
	for _, d := range list {
		if !d.IsDir() || !validID(d.Name()) {
			continue
		}
		for _, filename := range []string{"index.bin", "issues.bin", "summary.json"} {
			fi, err := os.Stat(filepath.Join(s.folder(d.Name()), filename))
			if err == nil {
				n += fi.Size()
			}
		}
	}
	return n
}

func (s *engine) list() []Summary {
	ds, err := os.ReadDir(s.root)
	if err != nil {
		return nil
	}
	out := make([]Summary, 0, len(ds))
	for _, d := range ds {
		if !d.IsDir() || !validID(d.Name()) {
			continue
		}
		item, e := s.load(d.Name())
		if e == nil {
			out = append(out, item)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Imported > out[j].Imported })
	return out
}
func (s *engine) load(id string) (Summary, error) {
	var m Summary
	if !validID(id) {
		return m, errors.New("invalid id")
	}
	data, e := os.ReadFile(filepath.Join(s.folder(id), "summary.json"))
	if e != nil {
		return m, e
	}
	if e = json.Unmarshal(data, &m); e != nil {
		return m, e
	}
	if m.ID != id || !m.Indexed {
		return m, errors.New("invalid session")
	}
	return m, nil
}
func jsonReply(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}
func apiError(w http.ResponseWriter, msg string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
func (s *engine) update(id string, fn func(*job)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v := s.jobs[id]; v != nil {
		fn(v)
	}
}

type readProgress struct {
	src    io.Reader
	read   int64
	update func(int64)
}

func (p *readProgress) Read(buf []byte) (int, error) {
	n, e := p.src.Read(buf)
	p.read += int64(n)
	if n > 0 {
		p.update(p.read)
	}
	return n, e
}

// importFile streams the user's File into the parser; it never writes source bytes to disk.
// The browser must retain its File handle for later full-text searches and detail views.
func (s *engine) importFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		apiError(w, "POST only", 405)
		return
	}
	id := r.URL.Query().Get("id")
	if !validID(id) {
		apiError(w, "invalid id", 400)
		return
	}
	name := filepath.Base(r.URL.Query().Get("name"))
	if name == "" || name == "." {
		name = "log.txt"
	}
	if chars := []rune(name); len(chars) > 150 {
		name = string(chars[:150])
	}
	size := r.ContentLength
	if size < 1 || size > maxLogBytes {
		apiError(w, "원본 파일은 1B~1GiB만 허용합니다", 413)
		return
	}
	enc := r.URL.Query().Get("encoding")
	s.mu.Lock()
	if _, exists := s.jobs[id]; exists {
		s.mu.Unlock()
		apiError(w, "duplicate id", 409)
		return
	}
	if _, err := os.Stat(s.folder(id)); err == nil {
		s.mu.Unlock()
		apiError(w, "duplicate archive id", 409)
		return
	}
	s.jobs[id] = &job{Size: size, Stage: "indexing"}
	s.mu.Unlock()
	// Status is needed only while parsing. Retaining every completed/failed
	// upload indefinitely would leak memory during long-running sessions.
	defer func() {
		s.mu.Lock()
		delete(s.jobs, id)
		s.mu.Unlock()
	}()
	dir := s.folder(id)
	if err := os.Mkdir(dir, 0700); err != nil {
		apiError(w, "메타데이터 폴더 생성 실패", 500)
		return
	}
	success := false
	defer func() {
		if !success {
			os.RemoveAll(dir)
		}
	}()
	limited := http.MaxBytesReader(w, r.Body, size)
	sample, err := io.ReadAll(io.LimitReader(limited, 128<<10))
	if err != nil {
		apiError(w, "로그 읽기 실패", 400)
		return
	}
	determined, err := detectEncodingSample(sample, enc)
	if err != nil {
		apiError(w, err.Error(), 400)
		return
	}
	hash := sha256.New()
	source := &readProgress{src: io.MultiReader(bytes.NewReader(sample), limited), update: func(n int64) {
		s.update(id, func(j *job) { j.Read = n; j.Indexed = n })
	}}
	summary, err := buildIndexStreamContext(r.Context(), io.TeeReader(source, hash), dir, determined, func(n int64) {
		s.update(id, func(j *job) { j.Indexed = n })
	})
	if err == nil {
		err = r.Context().Err()
	}
	if err == nil && source.read != size {
		err = fmt.Errorf("원본 크기 불일치: %d / %d bytes", source.read, size)
	}
	if err != nil {
		s.update(id, func(j *job) { j.Stage = "failed"; j.Error = err.Error() })
		apiError(w, "분석 실패: "+err.Error(), 400)
		return
	}
	summary.ID = id
	summary.Name = name
	summary.Size = size
	summary.Imported = time.Now().Format(time.RFC3339)
	summary.SourceHash = hex.EncodeToString(hash.Sum(nil))
	summary.StorageMode = "metadata-only"
	for _, name := range []string{"index.bin", "issues.bin"} {
		if fi, err := os.Stat(filepath.Join(dir, name)); err == nil {
			summary.MetadataBytes += fi.Size()
		}
	}
	payload, err := json.MarshalIndent(summary, "", "  ")
	if err == nil {
		err = os.WriteFile(filepath.Join(dir, "summary.part"), payload, 0600)
	}
	if err == nil {
		err = os.Rename(filepath.Join(dir, "summary.part"), filepath.Join(dir, "summary.json"))
	}
	if err != nil {
		apiError(w, "요약 메타데이터 저장 실패", 500)
		return
	}
	success = true
	s.update(id, func(j *job) { j.Stage = "complete"; j.Indexed = size })
	jsonReply(w, summary)
}
func detectEncodingSample(sample []byte, requested string) (string, error) {
	if len(sample) >= 2 {
		if sample[0] == 0xff && sample[1] == 0xfe {
			return "utf-16le", nil
		}
		if sample[0] == 0xfe && sample[1] == 0xff {
			return "utf-16be", nil
		}
	}
	if requested != "" && requested != "auto" {
		if requested != "utf-8" && requested != "euc-kr" {
			return "", errors.New("지원하지 않는 인코딩입니다")
		}
	}
	if bytes.IndexByte(sample, 0) >= 0 {
		return "", errors.New("바이너리 파일은 지원하지 않습니다")
	}
	if requested != "" && requested != "auto" {
		return requested, nil
	}
	test := sample
	if len(test) > 4 {
		test = test[:len(test)-4]
	}
	if utf8.Valid(test) {
		return "utf-8", nil
	}
	return "euc-kr", nil
}

// verifySource validates a reselected original by streaming SHA-256 over the complete
// input, without copying it to local storage or re-creating the index.
func (s *engine) verifySource(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		apiError(w, "POST only", 405)
		return
	}
	m, err := s.load(r.URL.Query().Get("id"))
	if err != nil {
		apiError(w, "분석 메타데이터가 없습니다", 404)
		return
	}
	if r.ContentLength != m.Size {
		apiError(w, "원본 크기가 저장된 메타데이터와 다릅니다", 409)
		return
	}
	hash := sha256.New()
	n, err := io.Copy(hash, http.MaxBytesReader(w, r.Body, m.Size))
	if err != nil || n != m.Size {
		apiError(w, "원본 검증 실패", 400)
		return
	}
	if !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), m.SourceHash) {
		apiError(w, "파일의 SHA-256이 이전 원본과 다릅니다. 새 분석을 수행해야 합니다", 409)
		return
	}
	jsonReply(w, m)
}

func (s *engine) status(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	s.mu.Lock()
	j := s.jobs[id]
	var v job
	if j != nil {
		v = *j
	}
	s.mu.Unlock()
	if j == nil {
		apiError(w, "job not found", 404)
		return
	}
	jsonReply(w, v)
}
func (s *engine) delete(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		apiError(w, "POST only", 405)
		return
	}
	var d struct {
		ID string `json:"id"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&d) != nil || !validID(d.ID) {
		apiError(w, "invalid id", 400)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, e := s.load(d.ID); e != nil {
		apiError(w, "archive not found", 404)
		return
	}
	if e := os.RemoveAll(s.folder(d.ID)); e != nil {
		apiError(w, "delete failed", 500)
		return
	}
	for id, idx := range s.filters {
		if idx.Session == d.ID {
			os.Remove(idx.Path)
			delete(s.filters, id)
		}
	}
	jsonReply(w, map[string]bool{"deleted": true})
}
func matchesGroup(rec diskRecord, group string) bool {
	switch group {
	case "sql":
		return rec.Category == 1
	case "otherError":
		return rec.Category == 0 && rec.Level == 1
	case "error":
		return rec.Level == 1
	case "review":
		return rec.Reserved&1 != 0
	case "warning":
		return rec.Level == 2
	case "info":
		return rec.Level == 3
	default:
		if strings.HasPrefix(group, "sql:") {
			subtype, err := strconv.Atoi(strings.TrimPrefix(group, "sql:"))
			return err == nil && subtype >= 1 && subtype <= 8 && rec.Category == 1 && int(rec.Subtype) == subtype
		}
		return true
	}
}

func (s *engine) filter(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		apiError(w, "POST only", 405)
		return
	}
	var req struct {
		ID    string `json:"id"`
		Group string `json:"group"`
		Query string `json:"query"`
		Regex bool   `json:"regex"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&req) != nil || !validID(req.ID) {
		apiError(w, "invalid request", 400)
		return
	}
	meta, e := s.load(req.ID)
	if e != nil {
		apiError(w, "not found", 404)
		return
	}
	if len(req.Query) > 256 {
		apiError(w, "검색어는 256자 이하로 입력해 주세요", 400)
		return
	}
	switch req.Group {
	case "all", "sql", "otherError", "error", "review", "warning", "info":
	default:
		if strings.HasPrefix(req.Group, "issue:") && meta.IssueVersion == 1 {
			id := strings.TrimPrefix(req.Group, "issue:")
			valid := false
			for _, item := range meta.Issues {
				if item.ID == id {
					valid = true
					break
				}
			}
			if valid {
				break
			}
			apiError(w, "invalid issue", 400)
			return
		}
		if !strings.HasPrefix(req.Group, "sql:") {
			apiError(w, "invalid group", 400)
			return
		}
		n, err := strconv.Atoi(strings.TrimPrefix(req.Group, "sql:"))
		if err != nil || n < 1 || n > 8 {
			apiError(w, "invalid group", 400)
			return
		}
	}
	query := strings.TrimSpace(req.Query)

	if query != "" {
		apiError(w, "원본은 저장되지 않습니다. 내용 검색은 브라우저의 원본 파일에서 수행해야 합니다.", 422)
		return
	}
	if req.Group == "all" {
		jsonReply(w, map[string]any{"filterId": "all", "total": meta.Counts.All})
		return
	}
	id := createToken()
	outPath := filepath.Join(s.folder(req.ID), "filter-"+id+".tmp")
	out, e := os.OpenFile(outPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		apiError(w, "필터 인덱스 생성 실패", 500)
		return
	}
	keep := false
	defer func() {
		out.Close()
		if !keep {
			os.Remove(outPath)
		}
	}()
	buf := bufio.NewWriterSize(out, 256*1024)
	idx, e := os.Open(filepath.Join(s.folder(req.ID), "index.bin"))
	if e != nil {
		apiError(w, "index unavailable", 500)
		return
	}
	defer idx.Close()

	var total int64
	reader := bufio.NewReaderSize(idx, 256*1024)
	var issueReader *bufio.Reader
	var issueFile *os.File
	var selectedIssue uint64
	if strings.HasPrefix(req.Group, "issue:") {
		selectedIssue, _ = strconv.ParseUint(strings.TrimPrefix(req.Group, "issue:"), 16, 64)
		issueFile, e = os.Open(filepath.Join(s.folder(req.ID), "issues.bin"))
		if e != nil {
			apiError(w, "issue index unavailable", 500)
			return
		}
		defer issueFile.Close()
		issueReader = bufio.NewReaderSize(issueFile, 256*1024)
	}
	var recordBytes [24]byte
	for number := int64(0); number < meta.Counts.All; number++ {
		if _, e := io.ReadFull(reader, recordBytes[:]); e != nil {
			apiError(w, "damaged index", 500)
			return
		}
		rec := diskRecord{Offset: binary.LittleEndian.Uint64(recordBytes[:8]), Length: binary.LittleEndian.Uint32(recordBytes[8:12]), Level: recordBytes[20], Category: recordBytes[21], Subtype: recordBytes[22], Reserved: recordBytes[23]}
		if selectedIssue != 0 {
			var ref [8]byte
			if _, err := io.ReadFull(issueReader, ref[:]); err != nil {
				apiError(w, "damaged issue index", 500)
				return
			}
			if binary.LittleEndian.Uint64(ref[:]) != selectedIssue {
				continue
			}
		} else if !matchesGroup(rec, req.Group) {
			continue
		}

		var position [8]byte
		binary.LittleEndian.PutUint64(position[:], uint64(number))
		if _, e = buf.Write(position[:]); e != nil {
			apiError(w, "filter write failed", 500)
			return
		}
		total++
		if number%65536 == 0 && r.Context().Err() != nil {
			return
		}
	}
	if e = buf.Flush(); e != nil {
		apiError(w, "filter flush failed", 500)
		return
	}
	if e = out.Close(); e != nil {
		apiError(w, "filter close failed", 500)
		return
	}
	keep = true
	s.mu.Lock()
	for fid, entry := range s.filters {
		if entry.Session == req.ID {
			os.Remove(entry.Path)
			delete(s.filters, fid)
		}
	}
	s.filters[id] = filterIndex{Session: req.ID, Path: outPath, Total: total}
	s.mu.Unlock()
	jsonReply(w, map[string]any{"filterId": id, "total": total})
}
func (s *engine) resolveFilter(id, fid string, meta Summary) (int64, *os.File, error) {
	if fid == "all" {
		return meta.Counts.All, nil, nil
	}
	s.mu.Lock()
	entry, ok := s.filters[fid]
	s.mu.Unlock()
	if !ok || entry.Session != id {
		return 0, nil, errors.New("필터가 만료되었습니다. 검색을 다시 실행하세요")
	}
	f, e := os.Open(entry.Path)
	return entry.Total, f, e
}
func filterRecord(idx *os.File, filterFile *os.File, index int64) (diskRecord, int64, error) {
	if filterFile != nil {
		var b [8]byte
		if _, e := filterFile.ReadAt(b[:], index*8); e != nil {
			return diskRecord{}, 0, e
		}
		index = int64(binary.LittleEndian.Uint64(b[:]))
	}
	rec, err := readRecord(idx, index)
	return rec, index, err
}
func (s *engine) page(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	meta, e := s.load(id)
	if e != nil {
		apiError(w, "archive not found", 404)
		return
	}
	fid := r.URL.Query().Get("filterId")
	total, filterFile, e := s.resolveFilter(id, fid, meta)
	if e != nil {
		apiError(w, e.Error(), 400)
		return
	}
	if filterFile != nil {
		defer filterFile.Close()
	}
	page, _ := strconv.ParseInt(r.URL.Query().Get("page"), 10, 64)
	maxPages := (total + pageSize - 1) / pageSize
	if maxPages == 0 {
		maxPages = 1
	}
	if page < 1 {
		page = 1
	}
	if page > maxPages {
		page = maxPages
	}
	idx, e := os.Open(filepath.Join(s.folder(id), "index.bin"))
	if e != nil {
		apiError(w, "index unavailable", 500)
		return
	}
	defer idx.Close()
	rows := make([]map[string]any, 0, pageSize)
	for i := (page - 1) * pageSize; i < page*pageSize && i < total; i++ {
		rec, originalIndex, e := filterRecord(idx, filterFile, i)
		if e != nil {
			apiError(w, "invalid index", 500)
			return
		}
		rows = append(rows, rec.JSON(originalIndex))
	}
	jsonReply(w, map[string]any{"page": page, "pages": maxPages, "total": total, "rows": rows})
}
func csvSafe(s string) string {
	trim := strings.TrimLeft(s, " \t\r\n")
	if len(trim) > 0 && strings.ContainsRune("=+-@", rune(trim[0])) {
		return "'" + s
	}
	return s
}

// indexChunk sends fixed 24-byte records. Clients can scan millions of records
// without JSON expansion or resident event arrays.
func (s *engine) indexChunk(w http.ResponseWriter, r *http.Request) {
	meta, err := s.load(r.URL.Query().Get("id"))
	if err != nil {
		apiError(w, "archive not found", 404)
		return
	}
	start, err1 := strconv.ParseInt(r.URL.Query().Get("start"), 10, 64)
	count, err2 := strconv.ParseInt(r.URL.Query().Get("count"), 10, 64)
	if err1 != nil || err2 != nil || start < 0 || start > meta.Counts.All || count < 1 || count > 50000 {
		apiError(w, "invalid range", 400)
		return
	}
	if count > meta.Counts.All-start {
		count = meta.Counts.All - start
	}
	f, err := os.Open(filepath.Join(s.folder(meta.ID), "index.bin"))
	if err != nil {
		apiError(w, "index unavailable", 500)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = io.Copy(w, io.NewSectionReader(f, start*indexBytes, count*indexBytes))
}
func (s *engine) pageByIDs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		apiError(w, "POST only", 405)
		return
	}
	var req struct {
		ID      string  `json:"id"`
		Indices []int64 `json:"indices"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 16000)).Decode(&req) != nil || len(req.Indices) > 1000 {
		apiError(w, "invalid request", 400)
		return
	}
	meta, err := s.load(req.ID)
	if err != nil {
		apiError(w, "archive not found", 404)
		return
	}
	f, err := os.Open(filepath.Join(s.folder(req.ID), "index.bin"))
	if err != nil {
		apiError(w, "index unavailable", 500)
		return
	}
	defer f.Close()
	rows := make([]map[string]any, 0, len(req.Indices))
	for _, i := range req.Indices {
		if i < 0 || i >= meta.Counts.All {
			apiError(w, "invalid record index", 400)
			return
		}
		rec, err := readRecord(f, i)
		if err != nil {
			apiError(w, "damaged index", 500)
			return
		}
		rows = append(rows, rec.JSON(i))
	}
	jsonReply(w, map[string]any{"rows": rows})
}

func (s *engine) register(mux *http.ServeMux, host string) {
	secured := func(h http.HandlerFunc, mutate bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Host != host {
				apiError(w, "host not allowed", 403)
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+host {
				apiError(w, "origin not allowed", 403)
				return
			}
			if mutate && r.Header.Get("Origin") != "http://"+host {
				apiError(w, "origin required", 403)
				return
			}
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("Referrer-Policy", "same-origin")
			h(w, r)
		}
	}
	mux.HandleFunc("/api/import", secured(s.importFile, true))
	mux.HandleFunc("/api/verify", secured(s.verifySource, true))
	mux.HandleFunc("/api/status", secured(s.status, false))
	mux.HandleFunc("/api/archives", secured(func(w http.ResponseWriter, r *http.Request) {
		jsonReply(w, map[string]any{"items": s.list(), "maxSourceBytes": maxLogBytes, "metadataUsed": s.diskUsed()})
	}, false))
	mux.HandleFunc("/api/delete", secured(s.delete, true))
	mux.HandleFunc("/api/filter", secured(s.filter, true))
	mux.HandleFunc("/api/page", secured(s.page, false))
	mux.HandleFunc("/api/index", secured(s.indexChunk, false))
	mux.HandleFunc("/api/page-by-ids", secured(s.pageByIDs, true))
	mux.HandleFunc("/api/remote-tail", secured(remoteTail, true))
 mux.HandleFunc("/api/remote-trace", secured(remoteTrace, true))
 mux.HandleFunc("/api/update/check", secured(updateCheck, true))
 mux.HandleFunc("/api/update/apply", secured(updateApply, true))
}
