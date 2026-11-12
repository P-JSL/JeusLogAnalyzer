# JeusLogAnalyzer — Codex 작업용 개선 계획서

> **기준 소스:** [`346986b8bf41`](https://github.com/P-JSL/JeusLogAnalyzer/tree/346986b8bf411f9364ce4ef40187f2b94d8d3dd7) · **한국어 재정리:** 2026-11-12(KST)  
> **상태:** 분석·개선안 작성. 현재 실제 코드 수정/테스트/릴리스가 완료된 것은 아닙니다.  
> **제품:** JEUS Lens — Go/Rust 로그 분석 및 SFTP 조회

## 1. Codex 수행 규칙

1. 한 번에 **작업 ID 하나만** 선택합니다. 반드시 현 시점 브랜치의 실제 소스·호출자·테스트를 먼저 읽어, 아래 소스 링크(분석 당시 커밋)와 차이가 있는지 확인합니다.
2. 인터페이스·파일 형식·상태 전이·오류·로그·보안 정책·데이터 정합성 등 기존 계약을 유지하며 필요 최소 범위만 수정합니다. 존재 확인되지 않은 API/테이블/옵션/의존성을 만들어내지 않습니다.
3. '기존 구현', '재현된 불일치', '추가 검증', '성능 조건부'를 구분합니다. 이미 구현된 보호를 중복 개발하지 않습니다.
4. 수정 전 실패를 재현하는 테스트/프로파일을 먼저 준비합니다. 테스트/스모크/벤치마크를 실제 실행하지 않았으면 **미검증**으로 표시합니다. Windows/네이티브/외부 서버는 안전한 환경에서만 테스트합니다.
5. 완료 시 변경 파일, 이전 동작, 수정 이유·내용, 실제 테스트 명령/결과, 미검증 상황, 잔존 위험, 커밋 SHA를 남깁니다. 별도 요청 없이 릴리스·배포·운영 데이터 변경을 진행하지 않습니다.

## 2. 제품 구조와 절대 보존할 계약

Go·Rust는 동일 웹 UI와 바이너리 인덱스(이벤트당 24바이트)를 사용합니다. 로컬 로그는 최대 1GiB를 메타데이터 기반으로 분석하고, 원격 SFTP는 최대 512KiB 범위의 읽기 전용 미리보기입니다.

- 원본 로그를 백엔드에 영구 저장하지 않고 인덱스·메타데이터를 저장합니다. 재선택한 원본은 SHA-256으로 검증합니다.
- Go와 Rust의 API·24바이트 이벤트 인덱스·정렬 순서·오프셋·인코딩 해석을 임의로 변경하지 않습니다.
- SFTP는 SHA256 호스트키 지문 검사 후 읽기 전용 접근만 허용합니다. 원격 파일 수정·명령 실행을 추가하지 않습니다.
- 정렬·검색·필터 변경 시 이전 작업이 현재 UI를 덮어쓰지 않도록 세대/취소 동작을 유지합니다.
- 로그 및 연결 진단에 비밀번호·토큰·SQL 바인드값 등 민감정보를 임의 출력하지 않습니다.

## 3. 소스와 과거 보고서 교차 확인 사항

- 확인됨: `engine.go`에서 `maxLogBytes = 1 << 30`, `api.go`에서 로컬 분석 1B~1GiB를 허용합니다.
- 확인됨: `remote_sftp.go`의 512KiB 한도는 별도 SFTP 미리보기 기능입니다. 로컬 로그 용량 제한과 모순되지 않습니다.
- 기존 보호: 원본 SHA 재검증과 Go/Rust parity 테스트가 있으며, 1GiB 테스트 성공은 처리 속도의 실측 배수를 뜻하지 않습니다.

## 4. Codex 작업 순서

| ID | 우선순위 | 실행 주제 |
|---|---|---|
| J-01 | P0 | Go/Rust 파서·API의 정확한 동등성 |
| J-02 | P0 | 원본 재연결·변조 방지 |
| J-03 | P0 | SFTP 지문·권한·읽기 범위 검증 |
| J-04 | P1 | 로컬 API와 진단 로그의 보안 경계 |
| J-05 | P1 | 브라우저 전역 정렬 비용 절감 |
| J-06 | P1 | 검색 디코딩 및 다국어 문자 경계 |
| J-07 | P2 | 필터 재사용과 임시 파일 복구 |
| J-08 | P1 | 최신 UI 세대와 라이브 로그 교체 |
| J-09 | P1 | 릴리스 자산·업데이트 출처 |
| J-10 | P2 | 로컬 처리·SFTP 처리 성능 분리 |

P0는 사용자의 데이터·정합성에 영향을 줄 수 있는 경계 우선 검증, P1은 품질/운영, P2는 실측 후 결정할 최적화입니다. **P0가 곧 현재 장애·취약점의 확정 판정을 뜻하지는 않습니다.**

## 5. 상세 작업 지시서

### J-01 · Go/Rust 파서·API의 정확한 동등성 (P0)

- **확인·수정 파일:** [`engine.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/engine.go), [`rust/src/engine.rs`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/rust/src/engine.rs), [`tests/rust_parity.py`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/tests/rust_parity.py)
- **Codex 실행 지침:** 같은 로그 fixture를 Go/Rust 두 실행 파일에서 분석해 24바이트 index, offset, CP949/UTF-16/CRLF, severity, 시간 정렬, 페이지 100행, 원본 SHA가 같은지 검증합니다. 누락된 실패 사례를 회귀 테스트로 추가하고 구조 변경은 별도 승인합니다.
- **근거 및 관찰 사실:** `engine.go`는 이벤트 인덱스 포맷을, `rust/src/engine.rs`는 Rust 파서를 구현합니다. `tests/rust_parity.py`가 같은 원본에 대한 두 엔진 출력 비교용 기초입니다.
- **적용 원리·수식 또는 불변식:** 인덱스 길이 `index_bytes = 24 × event_count`. 동등성은 `bytes(index_go)==bytes(index_rust)` 및 동일 요청에 대한 정규화 JSON 값·페이지 순서 비교로 확인합니다. 인코딩별 byte offset은 문자 인덱스와 다릅니다.
- **공식 문서·논문 출처:** [Go encoding/binary](https://pkg.go.dev/encoding/binary), [Rust std::io](https://doc.rust-lang.org/std/io/index.html) — 바이너리 레이아웃은 저장소 자체의 24바이트 계약을 우선합니다.
- **검증:** Go/Rust 테스트와 `tests/rust_parity.py`
- **완료 기준:** 동일 입력에서 레코드·API/페이지 결과가 일치하고 24바이트 계약이 유지됨
- **기존 항목 매핑:** IMP-J04, Q-J01, Q-J07
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### J-02 · 원본 재연결·변조 방지 (P0)

- **확인·수정 파일:** [`api.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/api.go), [`tests/rust_parity.py`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/tests/rust_parity.py)
- **Codex 실행 지침:** 기존 인덱스 생성 후 원본 파일을 같은 크기로 수정·교체·이동·삭제·재선택해 저장된 SHA와 비교합니다. 다른 원본은 재분석 안내로 종료하고, 원본 파일 자체를 서버에 자동 복사하지 않습니다.
- **근거 및 관찰 사실:** `api.go`의 로컬 원본 SHA 검증을 사용하는 재연결 경계입니다. 같은 크기 파일 교체는 크기 비교만으로 잡을 수 없으므로 실제 해시가 필요합니다.
- **적용 원리·수식 또는 불변식:** `can_rebind ⇒ size_now==size_saved ∧ SHA256(now)==SHA256(saved)`; 이 검사는 **원본 신원 검증**이지 SHA의 불변성을 주장하지 않습니다. 해시 불일치 시 저장된 offset으로 다른 파일을 조회하지 않습니다.
- **공식 문서·논문 출처:** [NIST FIPS 180-4](https://csrc.nist.gov/pubs/fips/180-4/upd1/final) — 크기/경로가 같아도 내용 변화를 감지하는 데 암호학적 다이제스트를 사용합니다.
- **검증:** `go test ./...` 및 parity fixture
- **완료 기준:** SHA가 다른 원본을 기존 index에 잘못 연결하지 않음
- **기존 항목 매핑:** IMP-J07, Q-J02
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### J-03 · SFTP 지문·권한·읽기 범위 검증 (P0)

- **확인·수정 파일:** [`remote_sftp.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/remote_sftp.go), [`rust/src/remote.rs`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/rust/src/remote.rs), [`tests/rust_sftp_smoke.py`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/tests/rust_sftp_smoke.py)
- **Codex 실행 지침:** 지문 불일치/인증 실패/경로 위반/연결 단절/512KiB 초과 요청을 읽기 전용 로컬 SFTP 서버로 시험합니다. Go와 Rust의 실패 코드를 대조합니다.
- **근거 및 관찰 사실:** `remote_sftp.go`는 한 번의 미리보기 요청 최대 `512*1024` 바이트를 검사합니다(기준 59·107행). 반면 로컬 원본 1GiB는 `engine.go`의 독립 상한입니다.
- **적용 원리·수식 또는 불변식:** 원격 조회 성공 조건 `0 ≤ requested_bytes ≤ 524288 ∧ host_key_fingerprint_verified ∧ read_only_path_authorized`. 로컬 `maxLogBytes = 1<<30`과 미리보기 상한을 합쳐 계산하지 않습니다.
- **공식 문서·논문 출처:** [SSH 연결 프로토콜 RFC 4253](https://www.rfc-editor.org/rfc/rfc4253.html), [OpenSSH SFTP 설계](https://www.openssh.com/manual.html) — 서버 지문 검증·원격 접근 정책은 프로젝트 신뢰 규칙에 따릅니다.
- **검증:** `go test ./...`, CI SFTP 통합 시험
- **완료 기준:** 원격 쓰기·삭제·명령 실행 0건, 지문 실패 거부, 조회 크기 상한 준수
- **기존 항목 매핑:** IMP-J08, Q-J03, Q-J04
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### J-04 · 로컬 API와 진단 로그의 보안 경계 (P1)

- **확인·수정 파일:** [`main.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/main.go), [`api.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/api.go), [`web/remote-profiles.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/web/remote-profiles.js)
- **Codex 실행 지침:** 바인딩 주소·Origin/CORS·원격 프로필에 자격증명 저장 여부·오류 진단 문자열을 확인합니다. 외부 사이트에서 로컬 API 호출/민감 로그 유출의 재현 테스트를 먼저 만들고 필요한 최소 수정만 적용합니다.
- **근거 및 관찰 사실:** `main.go`와 `api.go`의 loopback 바인딩·Origin/CSRF 정책, `web/remote-profiles.js`의 인증정보 보관을 감사하는 **추가 검증**입니다. 현재 취약점이라고 확정할 수 없습니다.
- **적용 원리·수식 또는 불변식:** 접근 허용 조건 `authorize(request) ⇒ 신뢰된 출처 ∧ 허용된 API 경로 ∧ 올바른 권한`. 로그에 `secret`·토큰·비밀번호의 원문 출력 횟수는 `0`이어야 합니다.
- **공식 문서·논문 출처:** [OWASP CSRF 예방](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), [OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) — localhost 서비스도 외부 웹사이트 요청을 고려합니다.
- **검증:** `go test ./...`
- **완료 기준:** 접근 허용 경계와 오류 정보 노출이 명시되고 기존 사용자 흐름 유지
- **기존 항목 매핑:** Q-J05, Q-J06
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### J-05 · 브라우저 전역 정렬 비용 절감 (P1)

- **확인·수정 파일:** [`web/global-sort-worker.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/web/global-sort-worker.js), [`tests/global-sort.test.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/tests/global-sort.test.js)
- **Codex 실행 지침:** 100k/1m 이벤트의 JS heap·GC·정렬 p95를 계측합니다. `TypedArray` 또는 숫자 정렬의 프로토타입을 기존 object comparator 결과와 비교하고 내림차순·동점·마지막 페이지까지 검증합니다.
- **근거 및 관찰 사실:** `web/global-sort-worker.js`의 정렬 비용은 JS 객체·문자열 key 처리량으로 나타날 수 있으나 GC가 병목인지 측정하지 않았습니다. `tests/global-sort.test.js`의 결과 계약을 유지합니다.
- **적용 원리·수식 또는 불변식:** 비교 정렬은 일반적으로 `O(N log N)`; 정수 키 조건이 충족되는 경우 radix 후보는 `O(wN)`(자리수 w)이나 원본 오름·내림·동점 순서와 메모리 `M_peak`를 함께 비교합니다.
- **공식 문서·논문 출처:** [TypedArray MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/TypedArray), [Array.sort MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/sort) — 키 변환은 원래 비교 의미를 보존해야 합니다.
- **검증:** `node --test tests/global-sort.test.js`
- **완료 기준:** 정렬 ID·페이지 동일, 실제 peak heap/시간 개선
- **기존 항목 매핑:** IMP-J01
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### J-06 · 검색 디코딩 및 다국어 문자 경계 (P1)

- **확인·수정 파일:** [`web/search-worker.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/web/search-worker.js), [`web/parser.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/web/parser.js), [`tests/search-worker.test.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/tests/search-worker.test.js)
- **Codex 실행 지침:** 메타 필터 후 텍스트가 필요한 항목만 복호화하는 경로를 확인합니다. 대체 문자열 검색 알고리즘은 한글/CP949/UTF16/긴 줄/chunk 경계를 포함한 기존 검색 결과와 완전 비교합니다.
- **근거 및 관찰 사실:** `web/search-worker.js`는 텍스트 검색, `web/parser.js`는 원문 인코딩 경계를 처리합니다. 검색 속도 변경은 byte offset과 문자 범위의 관계를 확인해야 합니다.
- **적용 원리·수식 또는 불변식:** 정확성 조건 `match_original(query, decoded_row) == match_candidate(query, decoded_row)`; 전체 텍스트 검색에서 필요한 경우 byte 읽기 하한을 피할 수 없습니다. 메타 필터 결과 수 `k≤N`일 때 필요 text decode를 `N→k`로 제한할 여지는 있습니다.
- **공식 문서·논문 출처:** [Boyer–Moore 논문](https://doi.org/10.1145/359842.359859), [TextDecoder MDN](https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder) — 변경 전후 한국어·UTF-16 동등성 필수.
- **검증:** `node --test tests/search-worker.test.js tests/parser.test.js`
- **완료 기준:** 매칭·하이라이트·순서 불변, 복호화 메모리/시간 측정
- **기존 항목 매핑:** IMP-J02
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### J-07 · 필터 재사용과 임시 파일 복구 (P2)

- **확인·수정 파일:** [`api.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/api.go), [`web/app.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/web/app.js)
- **Codex 실행 지침:** 동일 조건 반복 조회의 재스캔 비용을 계측합니다. 필터 생성 도중 취소·재시작/원본 소스 변경의 임시 결과가 유효한 결과처럼 선택되지 않게 테스트합니다. bitmap 적용은 실제 밀집도에 따라 판단합니다.
- **근거 및 관찰 사실:** `api.go`의 저장된 필터/색인 경로에서 반복 조회와 중도 실패 상태를 구분하는 작업입니다. 현재 캐시 결함을 확인한 것은 아닙니다.
- **적용 원리·수식 또는 불변식:** 캐시 유효 조건 `cache_key == (source_sha, filter_predicate, sort_policy, format_version)`. 취소된 생성 작업은 `valid_index=false`; 비트맵 교집합은 결과 집합 `A∩B`가 원래 순차 필터와 같아야 합니다.
- **공식 문서·논문 출처:** [Roaring bitmap 논문](https://doi.org/10.1002/spe.2402), [NIST SSDF](https://csrc.nist.gov/pubs/sp/800/218/final) — 비트맵은 모든 데이터 분포에서 이득이라는 보장이 없습니다.
- **검증:** `go test ./...`
- **완료 기준:** 중단된 결과 재사용 0건, 기존 필터·정렬 반환 값 동일
- **기존 항목 매핑:** IMP-J03, Q-J08
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### J-08 · 최신 UI 세대와 라이브 로그 교체 (P1)

- **확인·수정 파일:** [`web/app.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/web/app.js), [`web/local-live.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/web/local-live.js), [`tests/ui-smoke.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/tests/ui-smoke.js)
- **Codex 실행 지침:** 정렬→검색→필터→소스 교체와 로컬 파일 rename/truncate/rotation을 순차 실행합니다. 이전 worker 응답과 오래된 파일 행이 최신 화면으로 돌아오지 않는지 확인합니다.
- **근거 및 관찰 사실:** `web/app.js`는 sort worker 세대 처리, `web/local-live.js`는 실시간 로그 누적 및 새 파일 전환을 담당합니다. 두 동작의 중첩이 테스트 대상입니다.
- **적용 원리·수식 또는 불변식:** 정렬/검색 반영 불변식 `response.epoch == current_epoch`; 회전된 로그는 `source_identity`가 달라야 하며 `current_rows ⊆ active_file_rows`. 취소된 Promise가 새 화면에 남지 않도록 합니다.
- **공식 문서·논문 출처:** [Web Workers MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers), [Rust 동기화 원칙](https://doc.rust-lang.org/book/ch16-04-extensible-concurrency-sync-and-send.html) — Rust 원칙은 브라우저 동작의 직접 규범이 아닌 비교 참고입니다.
- **검증:** `node --test tests/global-sort.test.js tests/search-worker.test.js`
- **완료 기준:** 최신 요청만 표시, 작업 누수·이전 로그 혼입 없음
- **기존 항목 매핑:** IMP-J05, IMP-J06, Q-J10
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### J-09 · 릴리스 자산·업데이트 출처 (P1)

- **확인·수정 파일:** [`updater.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/updater.go), [`rust/src/updater.rs`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/rust/src/updater.rs), [`.github/workflows/rust.yml`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/.github/workflows/rust.yml)
- **Codex 실행 지침:** 동일 커밋의 Go/Rust EXE·ZIP·SHA256SUMS의 일치와 손상·네트워크 중단 시 이전 실행 파일 보존을 검증합니다. Linux parity와 Windows native 검증 결과를 개별로 보고합니다.
- **근거 및 관찰 사실:** `updater.go`와 Rust 업데이터의 최신 자산 선택·교체 방식, `.github/workflows/rust.yml`의 플랫폼 검증 경로를 확인한 뒤 변경합니다.
- **적용 원리·수식 또는 불변식:** 업데이트 게시 조건 `hash(downloaded_artifact) == trusted_release_hash ∧ platform_match ∧ version_policy_ok`. 업데이트 실패는 `current_executable`을 변경하지 않는 것이 목표입니다.
- **공식 문서·논문 출처:** [SLSA Provenance](https://slsa.dev/spec/v1.2/provenance), [GitHub Releases REST API](https://docs.github.com/en/rest/releases/releases) — 체크섬과 게시자 인증은 별도 근거가 필요합니다.
- **검증:** `cargo test --locked --all-targets --manifest-path rust/Cargo.toml`
- **완료 기준:** 출처가 불명확한 파일 교체 거부, 양쪽 배포 검증 근거 존재
- **기존 항목 매핑:** Q-J09
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### J-10 · 로컬 처리·SFTP 처리 성능 분리 (P2)

- **확인·수정 파일:** [`tests/rust_perf_compare.py`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/tests/rust_perf_compare.py), [`tests/rust_large_stream.py`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/tests/rust_large_stream.py)
- **Codex 실행 지침:** 로컬 import MiB/s, 메타 필터·정렬 p95, 원격 네트워크 RTT/SFTP 처리량을 구분해 같은 입력·소스 SHA의 기준선을 만듭니다. 큰 파일 무결성 테스트를 성능 개선 성공으로 기록하지 않습니다.
- **근거 및 관찰 사실:** `tests/rust_perf_compare.py`는 기준/최적화 바이너리 비교, `tests/rust_large_stream.py`는 대형 원본 무결성 시험입니다. 목적이 달라 동일한 성능 증거로 취급하지 않습니다.
- **적용 원리·수식 또는 불변식:** 로컬 처리량 `MB/s = 원본 읽기 바이트 / 실제 elapsed 초 / 2²⁰`(정확한 표기는 MiB/s). SFTP 응답시간은 `T ≈ RTT + B/R_network + server_delay`로 별도 계측하며 직렬·병렬 경로 여부에 따라 실측식을 재검토합니다.
- **공식 문서·논문 출처:** [Google Benchmark 반복 통계](https://google.github.io/benchmark/user_guide.html), [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) — 무결성 테스트를 속도 테스트 통과로 오해하지 않습니다.
- **검증:** `python3 tests/rust_perf_compare.py --help`(인자 확인 후 실행)
- **완료 기준:** 각 단계의 실제 측정값과 회귀 기준이 분리됨
- **기존 항목 매핑:** IMP-J08
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

## 6. 기존 저장소에서 확인한 검증 명령

```bash
go test ./...
go test -race ./...
node --test tests/global-sort.test.js tests/search-worker.test.js tests/parser.test.js
cargo test --locked --all-targets --manifest-path rust/Cargo.toml
cargo clippy --locked --all-targets --manifest-path rust/Cargo.toml -- -D warnings
go build -o /tmp/jeus-go .
cargo build --release --locked --manifest-path rust/Cargo.toml
python3 tests/rust_parity.py /tmp/jeus-go rust/target/release/jeus-lens-rust
```

서로 다른 OS·작업 루트에서 실행하는 명령은 각각 준비한 후 실행합니다. 마지막 Go/Rust parity는 두 바이너리를 빌드한 뒤, Windows 네이티브/실 서버·백신 테스트는 전용 환경에서 실행합니다. 문서에 명령을 적었다고 테스트가 완료된 것은 아닙니다.

## 7. 과거 이력 정리 및 완료 보고 양식

- 초기 `IMP-*` 과제는 위 작업별 번호로 연결하고 중복·이미 구현된 제안을 합쳤습니다. 비성능 `Q-*` 보호·품질 과제도 필요한 검증/수정 안으로 통합했습니다.
- 과거의 100회/1,000회 검토는 **합성 모델의 시나리오 교차 검산**으로, 실제 프로그램 1,000회 실행 또는 전문가 검토 1,000회가 아닙니다. 중복된 영어 보고·복잡한 통계표 대신 코드 작업 가능성·완료 조건만 남겼습니다.
- 성능 향상 배수는 이 저장소에서 측정된 실제 기준선·변경 전후 비교만을 사용해야 합니다. 다른 시스템·논문의 배수는 적용 불가합니다.
- **Codex 완료 보고:** 작업 ID / 변경 파일 / 재현 조건 / 구현 내용 / 기존 동작 보존 근거 / 테스트 명령·결과 / 미검증 항목 / 원복 방법 / 커밋 SHA. 미통과 작업은 `완료`로 표기하지 않습니다.

## 8. 추가 보안·위험·복구 보완 사항 — 소스 재검증 (2026-11-12)

기존 10개 작업을 보존하고 추가로 관측한 운영·보안 위험 경계입니다. **현재 확인한 것은 소스 동작 및 시험 필요 조건이며, 실제 악용·사고·기능 손상은 별도 실행 없이는 확정하지 않습니다.**

### 8.1 신규 교차 검토 결과

1. Go/Rust 모두 원본 로그 본문을 장기 보존하지는 않지만, 저장된 메타데이터에는 파일명·오류 코드·시간·해시 등의 업무상 민감정보가 남을 수 있습니다.
2. SFTP 조회에서 원격 파일의 Lstat→Open→ReadAt 사이에 파일 회전/교체가 발생할 수 있습니다. 기존 호스트키 검증과 별개로 결과의 일관성을 검증해야 합니다.
3. Rust API의 일부 필터 생성 실패 분기는 생성된 임시 인덱스에 대한 명시적 정리 없이 반환하며, 종료 후 재시작 시 일괄 청소 루틴과는 수명주기가 다릅니다.

### 8.2 Codex 신규 작업 인덱스

| ID | 우선 | 내용 | 판정 |
|---|---|---|---|
| J-11 | P1 | 메타데이터 보관 기간·로컬 권한·개인정보 최소화 | 저장 데이터 항목 확인, 정보유출 사고 확인 아님 |
| J-12 | P2 | SFTP 로그 회전 시 stat/open/read 스냅샷 불일치 | Lstat→Open→ReadAt 순서 확인, 실제 교체 사고 미검증 |
| J-13 | P1 | Rust 필터 생성 오류의 임시 파일 정리·디스크 상한 | 일부 조기 반환 경로 확인, 반복 오류 시 실제 용량 초과 미재현 |

### 8.3 상세 구현·검증 지시

### J-11 · 메타데이터 보관 기간·로컬 권한·개인정보 최소화 (P1)

- **현재 확인·미확인:** 저장 데이터 항목 확인, 정보유출 사고 확인 아님
- **소스 위치:** [`api.go` 46-102행](https://github.com/P-JSL/JeusLogAnalyzer/blob/a9078b4960a98604bdc580d9c5ec0dd4b2b53cc4/api.go#L46-L102)
- **추가 근거:** 백엔드는 원본 바이트 대신 `summary.json`, `index.bin`, `issues.bin`과 파일 이름·SHA·오류 코드 등의 메타데이터를 남깁니다. `SECURITY.md`도 이 정보가 조직에서 민감할 수 있음을 인정합니다.
- **Codex 구현·시험:** 새 프로필/기본 경로 권한/다른 OS 계정 접근/오래된 인덱스 삭제/재시작 후 잔여 필터 파일을 합성 데이터로 시험합니다. 자동 보관 기간이 필요하면 사용자 설정·조직 정책과 호환되는 방식으로 설계합니다.
- **적용 원리/안전 불변식:** `보관된 정보 ⊆ 사용자가 승인한 분석 메타데이터`; 계정 간 불필요한 열람 금지, 삭제 시 해당 세션의 정식·임시 메타데이터를 추적 가능하게 정리
- **검증 명령:** `go test ./...` 및 Rust 기존 archive/삭제 회귀, 권한 분리 환경 테스트
- **합격 기준:** 다른 계정의 메타데이터 무단 열람을 방지하는 경계와 사용자 삭제·기간 정책이 명시됨
- **원복·금지 사항:** 개별 파일명·문제 코드가 민감한 조직에서는 외부 로그 출력·원본 자동 업로드 금지
- **기존 작업 연결:** J-02 / J-04
- **기술 규격·논문 출처:** [원문](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)

### J-12 · SFTP 로그 회전 시 stat/open/read 스냅샷 불일치 (P2)

- **현재 확인·미확인:** Lstat→Open→ReadAt 순서 확인, 실제 교체 사고 미검증
- **소스 위치:** [`remote_sftp.go` 94-119행](https://github.com/P-JSL/JeusLogAnalyzer/blob/a9078b4960a98604bdc580d9c5ec0dd4b2b53cc4/remote_sftp.go#L94-L119)
- **추가 근거:** 호스트키를 검증한 뒤 원격 경로를 `Lstat`하고 `Open`, `ReadAt`합니다. 파일이 그 사이 회전할 수 있으므로 처음 보고한 크기와 실제 읽은 파일이 같은 버전인지 확인해야 합니다.
- **Codex 구현·시험:** 테스트용 SFTP 서버에서 Lstat 직후 rename/reopen, 파일 크기 감소·증가, 오프셋 초과, 동일 크기 다른 내용 변경을 재현합니다. 가능한 범위에서 열린 핸들 재확인과 reset 플래그를 사용하되 SFTP가 모든 파일 신원 특성을 제공한다고 가정하지 않습니다.
- **적용 원리/안전 불변식:** `성공 응답의 offset+len(data) ≤ 보고된 동일 파일 크기`; 파일 교체 불확실 시 `reset/재조회 필요`를 명시. 검증되지 않은 재연결에서 이전 로그와 현재 로그를 섞지 않음.
- **검증 명령:** `go test ./...`; `tests/rust_sftp_smoke.py`의 로테이션 fixture 확장
- **합격 기준:** 파일 회전 경계에서 중복/누락·혼합이 발생한 경우 감지하고 UI가 재조회 가능함
- **원복·금지 사항:** SFTP 읽기 전용·호스트키 확인·512KiB 제한은 유지
- **기존 작업 연결:** J-03 / J-08
- **기술 규격·논문 출처:** [원문](https://www.rfc-editor.org/rfc/rfc4253.html)

### J-13 · Rust 필터 생성 오류의 임시 파일 정리·디스크 상한 (P1)

- **현재 확인·미확인:** 일부 조기 반환 경로 확인, 반복 오류 시 실제 용량 초과 미재현
- **소스 위치:** [`rust/src/api.rs` 138-171행](https://github.com/P-JSL/JeusLogAnalyzer/blob/a9078b4960a98604bdc580d9c5ec0dd4b2b53cc4/rust/src/api.rs#L138-L171)
- **추가 근거:** Rust `filter()`는 `filter-{id}.tmp`를 만들고 인덱스 파싱/읽기/쓰기 오류 때 일부 분기에서 명시적 `remove_file` 없이 반환합니다. 시작 시 임시 파일 청소는 별도로 있으므로 프로세스를 재시작하기 전 누적 여부를 테스트합니다.
- **Codex 구현·시험:** 손상된 `index.bin`/`issues.bin`, 꽉 찬 디스크, 짧은 쓰기, 동시 필터 요청을 샌드박스에서 반복하며 생성 전후 `filter-*.tmp` 목록·용량·세션 상태를 비교합니다. RAII 정리 guard 또는 모든 실패 분기 통합이 가능하면 최소 구현으로 적용합니다.
- **적용 원리/안전 불변식:** `필터 실패 ⇒ 게시되지 않은 임시 파일의 누수량 = 0`; 성공 필터는 완전한 ID 목록과 세션 소유권이 일치해야 함.
- **검증 명령:** `cargo test --locked --all-targets --manifest-path rust/Cargo.toml` + 신규 오류 주입 회귀
- **합격 기준:** 반복 중단 후 새 시작 없이도 임시 파일이 누적되지 않고 기존 필터/원본 기록이 변하지 않음
- **원복·금지 사항:** 정상 유효 필터 파일이나 다른 세션 캐시는 삭제하지 않음
- **기존 작업 연결:** J-07 / J-01
- **기술 규격·논문 출처:** [원문](https://doc.rust-lang.org/std/ops/trait.Drop.html)

### 8.4 공통 실행 게이트

1. 현재 `main`의 실제 코드·테스트·의존성을 재검토하고 기존 동작을 고정하는 실패 fixture를 먼저 만듭니다.
2. 실사용 데이터는 다루지 않고 임시 디렉터리·테스트 서버·독립 Windows 계정으로 위험 상황을 재현합니다.
3. 기존 보안 조치를 약화하지 않고 원인에 필요한 최소 범위를 수정한 뒤 정상/오류/취소/재시작 경로를 검증합니다.
4. 변경 파일·재현 결과·실제 수행 명령·미검증 조건·원복 방법·커밋 SHA를 남깁니다. **문서 커밋은 코드 개선 완료를 뜻하지 않습니다.**
