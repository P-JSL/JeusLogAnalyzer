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
- **검증:** Go/Rust 테스트와 `tests/rust_parity.py`
- **완료 기준:** 동일 입력에서 레코드·API/페이지 결과가 일치하고 24바이트 계약이 유지됨
- **기존 항목 매핑:** IMP-J04, Q-J01, Q-J07
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### J-02 · 원본 재연결·변조 방지 (P0)

- **확인·수정 파일:** [`api.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/api.go), [`tests/rust_parity.py`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/tests/rust_parity.py)
- **Codex 실행 지침:** 기존 인덱스 생성 후 원본 파일을 같은 크기로 수정·교체·이동·삭제·재선택해 저장된 SHA와 비교합니다. 다른 원본은 재분석 안내로 종료하고, 원본 파일 자체를 서버에 자동 복사하지 않습니다.
- **검증:** `go test ./...` 및 parity fixture
- **완료 기준:** SHA가 다른 원본을 기존 index에 잘못 연결하지 않음
- **기존 항목 매핑:** IMP-J07, Q-J02
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### J-03 · SFTP 지문·권한·읽기 범위 검증 (P0)

- **확인·수정 파일:** [`remote_sftp.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/remote_sftp.go), [`rust/src/remote.rs`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/rust/src/remote.rs), [`tests/rust_sftp_smoke.py`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/tests/rust_sftp_smoke.py)
- **Codex 실행 지침:** 지문 불일치/인증 실패/경로 위반/연결 단절/512KiB 초과 요청을 읽기 전용 로컬 SFTP 서버로 시험합니다. Go와 Rust의 실패 코드를 대조합니다.
- **검증:** `go test ./...`, CI SFTP 통합 시험
- **완료 기준:** 원격 쓰기·삭제·명령 실행 0건, 지문 실패 거부, 조회 크기 상한 준수
- **기존 항목 매핑:** IMP-J08, Q-J03, Q-J04
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### J-04 · 로컬 API와 진단 로그의 보안 경계 (P1)

- **확인·수정 파일:** [`main.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/main.go), [`api.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/api.go), [`web/remote-profiles.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/web/remote-profiles.js)
- **Codex 실행 지침:** 바인딩 주소·Origin/CORS·원격 프로필에 자격증명 저장 여부·오류 진단 문자열을 확인합니다. 외부 사이트에서 로컬 API 호출/민감 로그 유출의 재현 테스트를 먼저 만들고 필요한 최소 수정만 적용합니다.
- **검증:** `go test ./...`
- **완료 기준:** 접근 허용 경계와 오류 정보 노출이 명시되고 기존 사용자 흐름 유지
- **기존 항목 매핑:** Q-J05, Q-J06
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### J-05 · 브라우저 전역 정렬 비용 절감 (P1)

- **확인·수정 파일:** [`web/global-sort-worker.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/web/global-sort-worker.js), [`tests/global-sort.test.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/tests/global-sort.test.js)
- **Codex 실행 지침:** 100k/1m 이벤트의 JS heap·GC·정렬 p95를 계측합니다. `TypedArray` 또는 숫자 정렬의 프로토타입을 기존 object comparator 결과와 비교하고 내림차순·동점·마지막 페이지까지 검증합니다.
- **검증:** `node --test tests/global-sort.test.js`
- **완료 기준:** 정렬 ID·페이지 동일, 실제 peak heap/시간 개선
- **기존 항목 매핑:** IMP-J01
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### J-06 · 검색 디코딩 및 다국어 문자 경계 (P1)

- **확인·수정 파일:** [`web/search-worker.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/web/search-worker.js), [`web/parser.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/web/parser.js), [`tests/search-worker.test.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/tests/search-worker.test.js)
- **Codex 실행 지침:** 메타 필터 후 텍스트가 필요한 항목만 복호화하는 경로를 확인합니다. 대체 문자열 검색 알고리즘은 한글/CP949/UTF16/긴 줄/chunk 경계를 포함한 기존 검색 결과와 완전 비교합니다.
- **검증:** `node --test tests/search-worker.test.js tests/parser.test.js`
- **완료 기준:** 매칭·하이라이트·순서 불변, 복호화 메모리/시간 측정
- **기존 항목 매핑:** IMP-J02
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### J-07 · 필터 재사용과 임시 파일 복구 (P2)

- **확인·수정 파일:** [`api.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/api.go), [`web/app.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/web/app.js)
- **Codex 실행 지침:** 동일 조건 반복 조회의 재스캔 비용을 계측합니다. 필터 생성 도중 취소·재시작/원본 소스 변경의 임시 결과가 유효한 결과처럼 선택되지 않게 테스트합니다. bitmap 적용은 실제 밀집도에 따라 판단합니다.
- **검증:** `go test ./...`
- **완료 기준:** 중단된 결과 재사용 0건, 기존 필터·정렬 반환 값 동일
- **기존 항목 매핑:** IMP-J03, Q-J08
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### J-08 · 최신 UI 세대와 라이브 로그 교체 (P1)

- **확인·수정 파일:** [`web/app.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/web/app.js), [`web/local-live.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/web/local-live.js), [`tests/ui-smoke.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/tests/ui-smoke.js)
- **Codex 실행 지침:** 정렬→검색→필터→소스 교체와 로컬 파일 rename/truncate/rotation을 순차 실행합니다. 이전 worker 응답과 오래된 파일 행이 최신 화면으로 돌아오지 않는지 확인합니다.
- **검증:** `node --test tests/global-sort.test.js tests/search-worker.test.js`
- **완료 기준:** 최신 요청만 표시, 작업 누수·이전 로그 혼입 없음
- **기존 항목 매핑:** IMP-J05, IMP-J06, Q-J10
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### J-09 · 릴리스 자산·업데이트 출처 (P1)

- **확인·수정 파일:** [`updater.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/updater.go), [`rust/src/updater.rs`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/rust/src/updater.rs), [`.github/workflows/rust.yml`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/.github/workflows/rust.yml)
- **Codex 실행 지침:** 동일 커밋의 Go/Rust EXE·ZIP·SHA256SUMS의 일치와 손상·네트워크 중단 시 이전 실행 파일 보존을 검증합니다. Linux parity와 Windows native 검증 결과를 개별로 보고합니다.
- **검증:** `cargo test --locked --all-targets --manifest-path rust/Cargo.toml`
- **완료 기준:** 출처가 불명확한 파일 교체 거부, 양쪽 배포 검증 근거 존재
- **기존 항목 매핑:** Q-J09
- **원복 기준:** 출력 계약·동시성·안전 경계가 변경되거나 성능/정확성 검증이 실패하면 해당 수정만 원복합니다.

### J-10 · 로컬 처리·SFTP 처리 성능 분리 (P2)

- **확인·수정 파일:** [`tests/rust_perf_compare.py`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/tests/rust_perf_compare.py), [`tests/rust_large_stream.py`](https://github.com/P-JSL/JeusLogAnalyzer/blob/346986b8bf411f9364ce4ef40187f2b94d8d3dd7/tests/rust_large_stream.py)
- **Codex 실행 지침:** 로컬 import MiB/s, 메타 필터·정렬 p95, 원격 네트워크 RTT/SFTP 처리량을 구분해 같은 입력·소스 SHA의 기준선을 만듭니다. 큰 파일 무결성 테스트를 성능 개선 성공으로 기록하지 않습니다.
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
