package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"embed"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
)

const maxLogBytes int64 = 1 << 30 // Maximum size of one source log. Source bytes are never retained.
const indexBytes int64 = 24
const pageSize int64 = 100

//go:embed assets/cp949.bin.gz
var cp949Assets embed.FS
var cp949Once sync.Once
var cp949Table []uint32

func initCP949() {
	cp949Once.Do(func() {
		b, err := cp949Assets.ReadFile("assets/cp949.bin.gz")
		if err != nil {
			panic(err)
		}
		gz, err := gzip.NewReader(bytes.NewReader(b))
		if err != nil {
			panic(err)
		}
		buf, err := io.ReadAll(gz)
		if err != nil || len(buf) != 65536*4 {
			panic("invalid bundled CP949 table")
		}
		cp949Table = make([]uint32, 65536)
		for i := range cp949Table {
			cp949Table[i] = binary.LittleEndian.Uint32(buf[i*4:])
		}
	})
}
func decodeText(raw []byte, enc string) string {
	switch enc {
	case "euc-kr":
		initCP949()
		var b strings.Builder
		b.Grow(len(raw))
		for i := 0; i < len(raw); i++ {
			c := raw[i]
			if c < 128 {
				b.WriteByte(c)
				continue
			}
			if i+1 < len(raw) {
				r := cp949Table[int(c)<<8|int(raw[i+1])]
				if r != 0 {
					b.WriteRune(rune(r))
					i++
					continue
				}
			}
			b.WriteRune('\uFFFD')
		}
		return b.String()
	case "utf-16le", "utf-16be":
		start := 0
		if len(raw) >= 2 && ((raw[0] == 255 && raw[1] == 254) || (raw[0] == 254 && raw[1] == 255)) {
			start = 2
		}
		u := make([]uint16, 0, (len(raw)-start)/2)
		for i := start; i+1 < len(raw); i += 2 {
			if enc == "utf-16le" {
				u = append(u, binary.LittleEndian.Uint16(raw[i:]))
			} else {
				u = append(u, binary.BigEndian.Uint16(raw[i:]))
			}
		}
		return string(utf16.Decode(u))
	default:
		return string(bytes.ToValidUTF8(bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF}), []byte("\uFFFD")))
	}
}

var (
	jeusHeader        = regexp.MustCompile(`(?i)^\[(\d{4}[./-]\d\d?[./-]\d\d? \d\d:\d\d:\d\d(?:[.,:]\d{3})?)\]\s*\[([0-7]|SEVERE|WARNING|WARN|INFO|CONFIG|FINE|FINER|FINEST|ALL|ERROR|FATAL|DEBUG|TRACE)\]\s*(?:\[([^]\r\n]*)\])?\s*(?:\[([A-Za-z][\w.-]*-\d+)\])?\s*(.*)$`)
	datedHeader       = regexp.MustCompile(`(?i)^\[?(\d{4}[./-]\d\d?[./-]\d\d?[ T]\d\d:\d\d:\d\d(?:[.,:]\d{3})?)\]?\s*[-|:]?\s*(?:\[?(SEVERE|ERROR|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE|CONFIG|FINE(?:R|ST)?|ALL)\]?)?\s*(.*)$`)
	levelHeader       = regexp.MustCompile(`(?i)^\s*\[(SEVERE|ERROR|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE)\]\s*(.*)$`)
	sqlException      = regexp.MustCompile(`(?i)\b(?:java\.sql\.(?:[A-Za-z]*SQLException|[A-Za-z]+Exception)|(?:SQL|JDBC|PSQL)(?:[A-Za-z]*)Exception|org\.springframework\.(?:dao|jdbc)\.[\w.]*Exception|org\.apache\.ibatis\.[\w.]*Exception|org\.hibernate\.[\w.]*Exception|org\.postgresql\.util\.PSQLException|oracle\.jdbc\.[\w.]*Exception|com\.mysql\.[\w.]*Exception)\b`)
	oraCode           = regexp.MustCompile(`(?i)\b(?:ORA|PLS)-\d{4,5}\b`)
	sqlState          = regexp.MustCompile(`(?i)\bSQL\s*STATE\s*[:=]?\s*([A-Za-z0-9]{5})\b`)
	exceptionAny      = regexp.MustCompile(`(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:Exception|Error)\b`)
	timeHeader        = regexp.MustCompile(`^\[([^]]+)\]`)
	stackFrame        = regexp.MustCompile(`^\s*at\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\(`)
	stackContinuation = regexp.MustCompile(`(?i)^\s*(?:at\s+[\w.$<>/]+\(|Caused by\s*:|Suppressed\s*:|\.\.\.\s+\d+\s+more|<<__Exception__>>|\[STDERR\]|Exception in thread)`)
	failureWords      = regexp.MustCompile(`(?i)(?:^|[\s:[(])(?:ERROR|FATAL|SEVERE)(?:\b|\])`)
	warningWords      = regexp.MustCompile(`(?i)(?:^|[\s:[(])(?:WARN|WARNING)(?:\b|\])`)
)

var sqlTypeLabels = [...]string{"", "SQL 문법·객체", "제약조건", "연결", "타임아웃", "잠금·동시성", "자원", "권한", "기타 SQL"}

func sqlTypeName(t byte) string {
	if int(t) < len(sqlTypeLabels) && t > 0 {
		return sqlTypeLabels[t]
	}
	return "기타 SQL"
}

// detectSQLType is a transparent, rule-based triage hint; it is not a DB diagnosis.
// A generic SQLException is reported as other SQL until a vendor code or SQLState appears.
func detectSQLType(line string) byte {
	u := strings.ToUpper(line)
	for _, group := range []struct {
		n      byte
		tokens []string
	}{
		{2, []string{"ORA-00001", "ORA-01400", "ORA-02291", "ORA-02292", "CONSTRAINTVIOLATION", "DATAINTEGRITYVIOLATION", "SQLINTEGRITYCONSTRAINTVIOLATION"}},
		{5, []string{"ORA-00060", "ORA-08177", "DEADLOCK", "CANNOTACQUIRELOCK", "LOCKACQUISITION"}},
		{4, []string{"ORA-01013", "ORA-00054", "ORA-02049", "QUERYTIMEOUT", "SQLTIMEOUTEXCEPTION", "TIMEOUTEXCEPTION"}},
		{3, []string{"ORA-01012", "ORA-03113", "ORA-03114", "ORA-12154", "ORA-12514", "SQLNONTRANSIENTCONNECTION", "SQLTRANSIENTCONNECTION", "CANNOTGETJDBCCONNECTION", "COMMUNICATIONS LINK FAILURE"}},
		{6, []string{"ORA-01653", "ORA-01555", "ORA-01652", "ORA-04031", "OUT OF MEMORY", "RESOURCEEXCEPTION"}},
		{7, []string{"ORA-01031", "ORA-00942: TABLE OR VIEW DOES NOT EXIST (PERMISSION)"}},
		{1, []string{"ORA-00900", "ORA-00904", "ORA-00907", "ORA-00911", "ORA-00933", "ORA-00936", "ORA-00942", "BADSQLGRAMMAR", "SQLSYNTAXERROR", "SQLGRAMMAR"}},
	} {
		for _, token := range group.tokens {
			if strings.Contains(u, token) {
				return group.n
			}
		}
	}
	if st := sqlState.FindStringSubmatch(u); st != nil {
		switch st[1][:2] {
		case "08":
			return 3
		case "23":
			return 2
		case "42":
			return 1
		case "40":
			return 5
		case "53":
			return 6
		case "28":
			return 7
		}
		if st[1] == "HYT00" || st[1] == "HYT01" {
			return 4
		}
	}
	if sqlSignal(line) {
		return 8
	}
	return 0
}

func levelNumber(s string) byte {
	switch strings.ToUpper(s) {
	case "0", "SEVERE", "ERROR", "FATAL":
		return 1
	case "1", "WARN", "WARNING":
		return 2
	default:
		return 3
	}
}
func parseHeader(line string) (bool, byte, string) {
	if m := jeusHeader.FindStringSubmatch(line); m != nil {
		return true, levelNumber(m[2]), m[5]
	}
	if m := datedHeader.FindStringSubmatch(line); m != nil {
		if m[2] != "" {
			return true, levelNumber(m[2]), m[3]
		}
		return true, 0, m[3]
	}
	if m := levelHeader.FindStringSubmatch(line); m != nil {
		return true, levelNumber(m[1]), m[2]
	}
	return false, 0, ""
}

// Cheap token guards avoid running several regular expressions over every ordinary
// INFO message. The expensive path is reserved for plausible SQL/exception text.
func sqlSignal(s string) bool {
	if !strings.Contains(s, "Exception") && !strings.Contains(s, "exception") &&
		!strings.Contains(s, "SQL") && !strings.Contains(s, "sql") &&
		!strings.Contains(s, "ORA-") && !strings.Contains(s, "ora-") &&
		!strings.Contains(s, "PLS-") && !strings.Contains(s, "pls-") &&
		!strings.Contains(s, "Database") && !strings.Contains(s, "database") &&
		!strings.Contains(s, "JDBC") && !strings.Contains(s, "jdbc") {
		return false
	}
	return sqlException.MatchString(s) || oraCode.MatchString(s) || sqlState.MatchString(s) ||
		strings.Contains(strings.ToLower(s), "error querying database") || strings.Contains(strings.ToLower(s), "error updating database")
}
func likelyFailure(s string) bool {
	if !strings.Contains(s, "Exception") && !strings.Contains(s, "exception") &&
		!strings.Contains(s, "Error") && !strings.Contains(s, "ERROR") &&
		!strings.Contains(s, "FATAL") && !strings.Contains(s, "SEVERE") &&
		!strings.Contains(s, "Caused by:") {
		return false
	}
	return exceptionAny.MatchString(s) || failureWords.MatchString(s) || strings.Contains(s, "Caused by:")
}

type diskRecord struct {
	Offset   uint64
	Length   uint32
	Line     uint32
	EndLine  uint32
	Level    byte // 1=error,2=warning,3=info
	Category byte // 1=SQL exception; 0=other
	Subtype  byte // 0=none,1=syntax,2=constraint,3=connection,4=timeout,5=concurrency,6=resource,7=permission,8=other SQL
	Reserved byte
}

func writeRecord(w io.Writer, r diskRecord) error {
	var b [24]byte
	binary.LittleEndian.PutUint64(b[0:8], r.Offset)
	binary.LittleEndian.PutUint32(b[8:12], r.Length)
	binary.LittleEndian.PutUint32(b[12:16], r.Line)
	binary.LittleEndian.PutUint32(b[16:20], r.EndLine)
	b[20] = r.Level
	b[21] = r.Category
	b[22] = r.Subtype
	_, e := w.Write(b[:])
	return e
}
func (r diskRecord) JSON(index int64) map[string]any {
	return map[string]any{"index": index, "offset": r.Offset, "length": r.Length, "line": r.Line, "endLine": r.EndLine, "level": r.Level, "category": r.Category, "sqlType": sqlTypeName(r.Subtype)}
}

func readRecord(f *os.File, number int64) (diskRecord, error) {
	var b [24]byte
	_, err := f.ReadAt(b[:], number*indexBytes)
	if err != nil {
		return diskRecord{}, err
	}
	return diskRecord{Offset: binary.LittleEndian.Uint64(b[0:8]), Length: binary.LittleEndian.Uint32(b[8:12]), Line: binary.LittleEndian.Uint32(b[12:16]), EndLine: binary.LittleEndian.Uint32(b[16:20]), Level: b[20], Category: b[21], Subtype: b[22]}, nil
}

type Counts struct {
	All        int64 `json:"all"`
	Error      int64 `json:"error"`
	Warning    int64 `json:"warning"`
	Info       int64 `json:"info"`
	SQL        int64 `json:"sql"`
	OtherError int64 `json:"otherError"`
}
type Pair struct {
	Name  string `json:"name"`
	Count int64  `json:"count"`
}

// Issue contains only controlled error identifiers, never raw log messages.
// The opaque ID identifies a structured issue within a single source index.
type Issue struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Count      int64  `json:"count"`
	FirstEvent int64  `json:"firstEvent"`
	LastEvent  int64  `json:"lastEvent"`
}

// Hotspot summarizes a five-minute interval from timestamps embedded in log
// headers. All event references are original source index positions; no log
// bodies, SQL literals, or request identifiers are written to the summary.
type Hotspot struct {
	Start           string `json:"start"`
	All             int64  `json:"all"`
	Errors          int64  `json:"errors"`
	Warnings        int64  `json:"warnings"`
	SQLErrors       int64  `json:"sqlErrors"`
	FirstErrorEvent int64  `json:"firstErrorEvent"`
	LastErrorEvent  int64  `json:"lastErrorEvent"`
}

// fiveMinuteBucket treats the header's time as an unzoned wall-clock value.
// It never guesses a server timezone, and invalid timestamps are ignored.
func fiveMinuteBucket(stamp string) string {
	if len(stamp) < 16 {
		return ""
	}
	raw := strings.NewReplacer(".", "-", "/", "-").Replace(stamp[:16])
	if raw[10] == 'T' {
		raw = raw[:10] + " " + raw[11:]
	}
	parsed, err := time.Parse("2006-01-02 15:04", raw)
	if err != nil {
		return ""
	}
	return parsed.Add(-time.Duration(parsed.Minute()%5) * time.Minute).Format("2006-01-02 15:04")
}

type Summary struct {
	SourceHash     string    `json:"sourceHash"`
	StorageMode    string    `json:"storageMode"`
	MetadataBytes  int64     `json:"metadataBytes"`
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	Size           int64     `json:"size"`
	Encoding       string    `json:"encoding"`
	Imported       string    `json:"imported"`
	Counts         Counts    `json:"stats"`
	Lines          int64     `json:"lines"`
	Top            []Pair    `json:"top"`
	SQLTop         []Pair    `json:"sqlTop"`
	Hourly         []Pair    `json:"hourly"`
	SQLTypes       []Pair    `json:"sqlTypes"`
	Indexed        bool      `json:"indexed"`
	IssueVersion   int       `json:"issueVersion,omitempty"`
	Issues         []Issue   `json:"issues,omitempty"`
	Hotspots       []Hotspot `json:"hotspots,omitempty"`
	HotspotLimited bool      `json:"hotspotLimited,omitempty"`
}
type indexState struct {
	offset    uint64
	line      uint32
	end       uint32
	explicit  byte
	failure   bool
	sql       bool
	message   string
	signature string
	sqlClass  string
	code      string
	eventCode string
	sqlType   byte
	clock     string
	minute    string
	rootClass string
	frame     string
}

func extractSignature(text string, sql bool) string {
	if sql {
		if code := oraCode.FindString(text); code != "" {
			return strings.ToUpper(code)
		}
		if ex := sqlException.FindString(text); ex != "" {
			a := strings.Split(ex, ".")
			return a[len(a)-1]
		}
		if st := sqlState.FindStringSubmatch(text); st != nil {
			return "SQLSTATE " + strings.ToUpper(st[1])
		}
		return "Database error"
	}
	if m := exceptionAny.FindString(text); m != "" {
		a := strings.Split(m, ".")
		return a[len(a)-1]
	}
	// Never persist arbitrary log message text as a summary fingerprint.
	// Messages may embed passwords, session tokens, personal data or SQL literals.
	return "기타 오류"
}

// issueFingerprint uses structural fields only: an Oracle/SQLSTATE code or
// exception class, plus the first relevant Java stack frame for non-SQL issues.
// It does not hash arbitrary message bodies containing SQL literals or secrets.
func issueFingerprint(st *indexState, level byte) (uint64, string) {
	if level != 1 && !st.sql {
		return 0, ""
	}
	code := st.code
	class := st.rootClass
	if class == "" {
		class = st.sqlClass
	}
	if class == "" && st.signature != "" && st.signature != "기타 오류" {
		class = st.signature
	}
	if class == "" {
		class = "기타 오류"
	}
	label := class
	if code != "" {
		label = code + " · " + class
	}
	key := fmt.Sprintf("v1|sql=%t|code=%s|class=%s", st.sql, code, class)
	if !st.sql {
		key += "|frame=" + st.frame + "|jeus=" + st.eventCode
	}
	h := fnv.New64a()
	_, _ = h.Write([]byte(key))
	id := h.Sum64()
	if id == 0 {
		id = 1
	} // 0 is the sentinel for a non-issue event.
	return id, label
}

func getLine(reader *bufio.Reader, reuse []byte) (prefix []byte, consumed int, eof bool, err error) {
	prefix = reuse[:0]
	if cap(prefix) < 2048 {
		prefix = make([]byte, 0, 2048)
	}
	for {
		part, e := reader.ReadSlice('\n')
		consumed += len(part)
		if len(prefix) < 65536 {
			remain := 65536 - len(prefix)
			if remain > len(part) {
				remain = len(part)
			}
			prefix = append(prefix, part[:remain]...)
		}
		if e == nil {
			return prefix, consumed, false, nil
		}
		if errors.Is(e, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(e, io.EOF) {
			return prefix, consumed, true, nil
		}
		return prefix, consumed, false, e
	}
}

// getLineEncoded maintains original byte offsets, including UTF-16 code unit boundaries.
func getLineEncoded(reader *bufio.Reader, enc string, reuse []byte) ([]byte, int, bool, error) {
	if enc != "utf-16le" && enc != "utf-16be" {
		return getLine(reader, reuse)
	}
	var prefix []byte
	consumed := 0
	for {
		if reader.Buffered() < 2 {
			_, err := reader.Peek(2)
			if err != nil {
				if errors.Is(err, io.EOF) {
					if reader.Buffered() > 0 {
						b, _ := reader.Peek(reader.Buffered())
						consumed += len(b)
						if len(prefix) < 65536 {
							prefix = append(prefix, b[:min(len(b), 65536-len(prefix))]...)
						}
						_, _ = reader.Discard(len(b))
					}
					return prefix, consumed, true, nil
				}
				return prefix, consumed, false, err
			}
		}
		available := reader.Buffered() &^ 1
		data, err := reader.Peek(available)
		if err != nil {
			return prefix, consumed, false, err
		}
		toTake := available
		found := false
		for i := 0; i+1 < len(data); i += 2 {
			if (enc == "utf-16le" && data[i] == '\n' && data[i+1] == 0) || (enc == "utf-16be" && data[i] == 0 && data[i+1] == '\n') {
				toTake = i + 2
				found = true
				break
			}
		}
		if len(prefix) < 65536 {
			prefix = append(prefix, data[:min(toTake, 65536-len(prefix))]...)
		}
		consumed += toTake
		if _, err := reader.Discard(toTake); err != nil {
			return prefix, consumed, false, err
		}
		if found {
			return prefix, consumed, false, nil
		}
	}
}

// buildIndexStream preserves the test/library entry point while the HTTP path
// provides its cancellation context through buildIndexStreamContext.
func buildIndexStream(source io.Reader, dir, enc string, progress func(int64)) (Summary, error) {
	return buildIndexStreamContext(context.Background(), source, dir, enc, progress)
}

func buildIndexStreamContext(ctx context.Context, source io.Reader, dir, enc string, progress func(int64)) (Summary, error) {
	tmp, err := os.Create(filepath.Join(dir, "index.part"))
	if err != nil {
		return Summary{}, err
	}
	defer func() { tmp.Close(); os.Remove(dir + "/index.part") }()
	// A compact 8-byte per-event issue reference is separate from the unchanged
	// 24-byte offset index. Existing v5 metadata can still be opened.
	issueFile, err := os.Create(filepath.Join(dir, "issues.part"))
	if err != nil {
		return Summary{}, err
	}
	defer func() { issueFile.Close(); os.Remove(filepath.Join(dir, "issues.part")) }()
	issueWriter := bufio.NewWriterSize(issueFile, 256*1024)
	issues := make(map[uint64]*Issue)
	writer := bufio.NewWriterSize(tmp, 1024*1024)
	reader := bufio.NewReaderSize(source, 128*1024)
	var total int64
	var lineNo uint32
	var state *indexState
	counts := Counts{}
	top := map[string]int64{}
	sqlTop := map[string]int64{}
	hourly := map[string]int64{}
	hotspots := make(map[string]*Hotspot)
	hotspotsLimited := false
	sqlTypes := map[string]int64{}
	flush := func(endOffset uint64) error {
		if state == nil {
			return nil
		}
		length := endOffset - state.offset
		if length > uint64(^uint32(0)) {
			return errors.New("4GiB를 초과하는 단일 이벤트는 지원하지 않습니다")
		}
		level := state.explicit
		if level == 0 {
			level = 3
			if state.failure {
				level = 1
			} else if warningWords.MatchString(state.message) {
				level = 2
			}
		}
		cat := byte(0)
		if state.sql {
			cat = 1
			counts.SQL++
			sqlTypes[sqlTypeName(state.sqlType)]++
		}
		if counts.All >= (512<<20)/indexBytes {
			return errors.New("이벤트가 너무 짧아 인덱스가 512MiB를 초과합니다. 로그 분할 또는 필터링 후 다시 시도해 주세요")
		}
		counts.All++
		switch level {
		case 1:
			counts.Error++
			if cat == 0 {
				counts.OtherError++
			}
		default:
			if level == 2 {
				counts.Warning++
			} else {
				counts.Info++
			}
		}
		if level == 1 {
			key := state.signature
			if (key == "" || key == "기타 오류") && state.eventCode != "" {
				key = state.eventCode
			}
			if key == "" {
				key = "기타 오류"
			}
			if len(top) < 5000 || top[key] > 0 {
				top[key]++
			}
		}
		if cat == 1 {
			key := state.code
			if key == "" {
				key = state.sqlClass
				if key == "" {
					key = "SQL 관련 오류"
				}
			}
			if len(sqlTop) < 5000 || sqlTop[key] > 0 {
				sqlTop[key]++
			}
		}
		if state.clock != "" {
			hourly[state.clock]++
		}
		if state.minute != "" {
			bucket := hotspots[state.minute]
			if bucket == nil && len(hotspots) < 50000 {
				bucket = &Hotspot{Start: state.minute, FirstErrorEvent: -1, LastErrorEvent: -1}
				hotspots[state.minute] = bucket
			} else if bucket == nil {
				hotspotsLimited = true
			}
			if bucket != nil {
				bucket.All++
				if level == 1 {
					bucket.Errors++
					if cat == 1 {
						bucket.SQLErrors++
					}
					if bucket.FirstErrorEvent < 0 {
						bucket.FirstErrorEvent = counts.All - 1
					}
					bucket.LastErrorEvent = counts.All - 1
				} else if level == 2 {
					bucket.Warnings++
				}
			}
		}
		rec := diskRecord{Offset: state.offset, Length: uint32(length), Line: state.line, EndLine: state.end, Level: level, Category: cat, Subtype: state.sqlType}
		issueID, issueName := issueFingerprint(state, level)
		if issueID != 0 {
			if entry, ok := issues[issueID]; ok {
				entry.Count++
				entry.LastEvent = counts.All - 1
			} else if len(issues) < 5000 {
				issues[issueID] = &Issue{ID: fmt.Sprintf("%016x", issueID), Name: issueName, Count: 1, FirstEvent: counts.All - 1, LastEvent: counts.All - 1}
			} else {
				// The aggregate overflow group cannot leak arbitrary input strings.
				issueID = 1
				if entry, ok := issues[issueID]; ok {
					entry.Count++
					entry.LastEvent = counts.All - 1
				} else {
					issues[issueID] = &Issue{ID: "0000000000000001", Name: "기타 오류 그룹 (그룹 수 제한)", Count: 1, FirstEvent: counts.All - 1, LastEvent: counts.All - 1}
				}
			}
		}
		var ref [8]byte
		binary.LittleEndian.PutUint64(ref[:], issueID)
		if _, err := issueWriter.Write(ref[:]); err != nil {
			return err
		}
		state = nil
		return writeRecord(writer, rec)
	}
	var offset uint64
	var scratch []byte
	for {
		// A canceled browser upload must not finish publishing an incomplete index.
		// Checking every 2,048 lines keeps cancellation responsive without a
		// per-line context check on the hottest parsing path.
		if lineNo&2047 == 0 {
			if err := ctx.Err(); err != nil {
				return Summary{}, err
			}
		}
		fragment, n, eof, e := getLineEncoded(reader, enc, scratch)
		scratch = fragment
		if e != nil {
			return Summary{}, e
		}
		if n == 0 && eof {
			break
		}
		lineNo++
		clean := strings.TrimRight(decodeText(fragment, enc), "\r\n")
		headerSample := clean
		if len(headerSample) > 1024 {
			headerSample = headerSample[:1024]
		}
		hdr, lev, msg := parseHeader(headerSample)
		// For undated logs, preserve indented trace lines under the current event.
		newEvent := hdr || state == nil || (state != nil && state.explicit == 0 && !strings.HasPrefix(clean, " ") && !strings.HasPrefix(clean, "\t") && strings.TrimSpace(clean) != "" && !stackContinuation.MatchString(clean))
		if newEvent {
			if err := flush(offset); err != nil {
				return Summary{}, err
			}
			if msg == "" {
				msg = clean
			}
			st := &indexState{offset: offset, line: lineNo, end: lineNo, explicit: lev, message: msg}
			if hdr {
				// Trust only the JEUS header code field, never code-looking strings in arbitrary bodies.
				if m := jeusHeader.FindStringSubmatch(headerSample); m != nil {
					st.eventCode = m[4]
				}

				clock := ""
				if match := timeHeader.FindStringSubmatch(clean); match != nil {
					clock = match[1]
				}
				if clock == "" {
					if match := datedHeader.FindStringSubmatch(clean); match != nil {
						clock = match[1]
					}
				}
				if len(clock) >= 13 {
					st.clock = strings.NewReplacer("/", "-", ".", "-").Replace(clock[:13])
					st.minute = fiveMinuteBucket(clock)
				}
			}
			state = st
		} else {
			state.end = lineNo
		}
		// Detect SQL and root errors even if they appear inside a nested Caused by chain.
		if sqlSignal(clean) {
			state.sql = true
			if t := detectSQLType(clean); t != 0 && (state.sqlType == 0 || state.sqlType == 8) {
				state.sqlType = t
			}
			if state.sqlClass == "" {
				if cls := sqlException.FindString(clean); cls != "" {
					a := strings.Split(cls, ".")
					state.sqlClass = a[len(a)-1]
				}
			}
			if state.code == "" {
				if c := oraCode.FindString(clean); c != "" {
					state.code = strings.ToUpper(c)
				} else if m := sqlState.FindStringSubmatch(clean); m != nil {
					state.code = "SQLSTATE " + strings.ToUpper(m[1])
				}
			}
		}
		// An explicit level is authoritative; failure inference matters only for unlevelled records.
		if state.explicit == 0 && likelyFailure(clean) {
			state.failure = true
		}
		// An exception's root cause and first relevant frame produce a stable
		// issue identity even when timestamps, IDs and messages change.
		if strings.Contains(clean, "Caused by:") {
			if m := exceptionAny.FindString(clean); m != "" {
				parts := strings.Split(m, ".")
				state.rootClass = parts[len(parts)-1]
				state.frame = "" // Capture the first frame of this deeper cause.
			}
		}
		if state.frame == "" {
			if m := stackFrame.FindStringSubmatch(clean); m != nil {
				state.frame = m[1]
			}
		}
		if (state.explicit == 1 || state.failure || state.sql) && (state.signature == "" || (state.sql && state.code != "")) {
			state.signature = extractSignature(clean, state.sql)
		}
		offset += uint64(n)
		if int64(offset)-total > 8<<20 {
			total = int64(offset)
			progress(total)
		}
		if eof {
			break
		}
	}
	if err := ctx.Err(); err != nil {
		return Summary{}, err
	}
	if err := flush(offset); err != nil {
		return Summary{}, err
	}
	if err := issueWriter.Flush(); err != nil {
		return Summary{}, err
	}
	if err := issueFile.Sync(); err != nil {
		return Summary{}, err
	}
	if err := issueFile.Close(); err != nil {
		return Summary{}, err
	}
	if err := writer.Flush(); err != nil {
		return Summary{}, err
	}
	if err := tmp.Sync(); err != nil {
		return Summary{}, err
	}
	if err := tmp.Close(); err != nil {
		return Summary{}, err
	}
	if err := ctx.Err(); err != nil {
		return Summary{}, err
	}
	if err := os.Rename(dir+"/index.part", dir+"/index.bin"); err != nil {
		return Summary{}, err
	}
	if err := os.Rename(filepath.Join(dir, "issues.part"), filepath.Join(dir, "issues.bin")); err != nil {
		return Summary{}, err
	}
	issueList := make([]Issue, 0, len(issues))
	for _, entry := range issues {
		issueList = append(issueList, *entry)
	}
	sort.Slice(issueList, func(i, j int) bool {
		if issueList[i].Count == issueList[j].Count {
			return issueList[i].ID < issueList[j].ID
		}
		return issueList[i].Count > issueList[j].Count
	})
	if len(issueList) > 100 {
		issueList = issueList[:100]
	}
	sorted := func(m map[string]int64, limit int) []Pair {
		out := make([]Pair, 0, len(m))
		for k, v := range m {
			out = append(out, Pair{k, v})
		}
		sort.Slice(out, func(i, j int) bool {
			if out[i].Count == out[j].Count {
				return out[i].Name < out[j].Name
			}
			return out[i].Count > out[j].Count
		})
		if len(out) > limit {
			out = out[:limit]
		}
		return out
	}
	h := make([]Pair, 0, len(hourly))
	for k, v := range hourly {
		h = append(h, Pair{k, v})
	}
	sort.Slice(h, func(i, j int) bool { return h[i].Name < h[j].Name })
	// Rank only intervals containing errors. A high count is a triage signal,
	// not statistical evidence of a change point or a causal relationship.
	groups := make([]Hotspot, 0, len(hotspots))
	for _, item := range hotspots {
		if item.Errors > 0 {
			groups = append(groups, *item)
		}
	}
	sort.Slice(groups, func(i, j int) bool {
		if groups[i].Errors != groups[j].Errors {
			return groups[i].Errors > groups[j].Errors
		}
		if groups[i].SQLErrors != groups[j].SQLErrors {
			return groups[i].SQLErrors > groups[j].SQLErrors
		}
		return groups[i].Start < groups[j].Start
	})
	if len(groups) > 12 {
		groups = groups[:12]
	}
	return Summary{Counts: counts, Lines: int64(lineNo), Top: sorted(top, 8), SQLTop: sorted(sqlTop, 8), Hourly: h, SQLTypes: sorted(sqlTypes, 10), Encoding: enc, Indexed: true, IssueVersion: 1, Issues: issueList, Hotspots: groups, HotspotLimited: hotspotsLimited}, nil
}
