# 8. JeusLogAnalyzer — JEUS Lens (Go·Rust)

**저장소:** [P-JSL/JeusLogAnalyzer](https://github.com/P-JSL/JeusLogAnalyzer)  
**소스 분석 기준:** `main` / [`d57e9570026e39f556c6b0709fb2048363960228`](https://github.com/P-JSL/JeusLogAnalyzer/commit/d57e9570026e39f556c6b0709fb2048363960228)  
**보고서 초판:** 2026-11-11 (KST) · **교차 검증 갱신:** 2026-11-12 (KST)  
**대상:** 개발자 · 운영자 · 릴리스 담당자  
**누적 기존 IMP 개선 과제:** 8개 (초판 5개 포함, 별도 비성능 Q 제어/검토 항목 10개)  
**상태:** 분석·구현 제안만 작성. 실제 소스 최적화·동적 성능 측정·프로그램 배포는 수행하지 않음.  
> 문서 내 장·절 번호는 원래 6개 저장소 통합 보고서의 번호를 보존한 것입니다. 코드 근거 링크는 작성 시점의 커밋으로 고정했습니다.

## 8.1 아키텍처와 실행 경계

Windows 실행 파일은 Go판과 Rust판으로 따로 배포합니다. 공통 브라우저 UI를 사용하지만, **분석 서버·API를 Go 또는 Rust로 각각 구현**합니다. 운영자는 어느 버전으로 분석했는지 기록해야 합니다.

```text
Go JEUS_Lens_Windows_x64.exe
  → main.go (127.0.0.1:임의 포트, 브라우저 열기)
  → api.go (가져오기·검색·필터·페이지·이력 API)
  → engine.go (로그 파싱·오류 분류·인덱스)
  → remote_sftp*.go (원격 텍스트 로그 끝부분 읽기)
  → updater.go (릴리스 검증·프로그램 교체)

Rust JEUS_Lens_Rust_Windows_x64.exe
  → rust/src/main.rs / api.rs / engine.rs / remote.rs / updater.rs

공통 web/app.js
  → /api/import (로그 바이트 스트리밍)
  → /api/status → /api/page · /api/filter... (분석 결과)
  → web/search-worker.js · global-sort-worker.js (원본 File 기반 검색/정렬)
  → /api/remote... (SSH/SFTP), /api/update... (업데이트)
```

[main.go](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/main.go#L23)은 **`127.0.0.1:0`**에 리스너를 열어 가용 로컬 포트를 선택합니다. 원격 서버에 직접 공개하는 서비스가 아닙니다. [web/app.js](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/web/app.js#L19)는 사용자가 선택한 파일을 `/api/import`에 스트리밍하고, [api.go](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/api.go#L169)에서 **원문 파일을 서버 디스크에 복사하지 않고** SHA-256과 이벤트별 메타데이터 인덱스를 만듭니다.

[engine.go](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/engine.go#L26)의 인덱스 레코드는 **이벤트당 24바이트**입니다. 프로그램은 `summary.json`, `index.bin` 등의 메타데이터를 보관합니다. 원문 검색과 상세보기는 브라우저가 여전히 가지고 있는 **원본 File 객체**를 기준으로 필요한 부분을 읽습니다. 인덱스만 남아 있으면 실제 SQL 원문·로그 본문을 재현할 수 없으므로 원본 로그를 반드시 별도 보존해야 합니다.

## 8.2 개발자가 따라갈 처리 흐름

| 기능 | Go | Rust/브라우저 | 주요 계약 |
|---|---|---|---|
| 서버 시작 | [main.go](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/main.go#L23) | [rust/src/main.rs](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/rust/src/main.rs) | 루프백만 바인딩, 별도 인증 서버 아님 |
| 로그 입력 | [api.go](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/api.go#L171) | [web/app.js](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/web/app.js#L19) | 원문 스트리밍, 인덱스만 저장, 1GiB 제한 |
| 오류 분석 | [engine.go](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/engine.go#L100) | [rust/src/engine.rs](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/rust/src/engine.rs) | multiline Java 예외·SQL 코드·레벨 분리 |
| 결과 필터·페이지 | [api.go](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/api.go#L311) | [rust/src/api.rs](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/rust/src/api.rs) | 인덱스·검색 결과 ID 범위·페이지 100건 |
| 전체 열 정렬 | 서버 필터 인덱스 지원 | [web/global-sort-worker.js](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/web/global-sort-worker.js) | 전체 후보를 정렬한 후 페이징, 원격 버퍼 제외 |
| 원격 조회 | [remote_sftp.go](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/remote_sftp.go#L64) | [rust/src/remote.rs](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/rust/src/remote.rs) | **호스트키 SHA256 고정**, SFTP 읽기 전용, 최대 512KiB |
| 연결 상세 진단 | [remote_sftp_trace.go](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/remote_sftp_trace.go#L19) | Rust remote trace 및 [web/remote-sftp.js](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/web/remote-sftp.js) | 단계별 NDJSON/진단 사유, 비밀정보 미영속화 |
| 자동 갱신 | [updater.go](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/updater.go#L46) | [rust/src/updater.rs](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/rust/src/updater.rs#L37) | Release SHA-256/파일 크기 확인 후 Windows 교체 |

**SQL 오류 인식:** `SQLException`, Spring DAO/JDBC 예외, MyBatis, Hibernate, Oracle의 `ORA-...`/`PLS-...` 및 SQLSTATE 단서로 유형을 나눕니다. 레벨(`ERROR`, `WARN`, `INFO`)과 SQL 관련 여부는 **서로 독립적인 분류**이므로 'WARN이면서 SQL 관련' 같은 중복 속성은 정상입니다. 코드가 원인을 판정했다는 뜻이 아니라 **조사 후보를 좁혀주는 분류**입니다.

### SFTP 보안 계약

[remote_sftp.go](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/remote_sftp.go#L22)에는 SFTP의 `Stat/Lstat/Open/ReadAt`만 사용한다는 정책이 명시되어 있고, 구현도 SSH **원격 명령 실행·파일 쓰기·삭제** 없이 끝부분을 읽는 경로입니다. [remote_sftp.go](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/remote_sftp.go#L79)의 `HostKeyCallback`은 사용자가 제공한 서버 공개키 SHA256 지문을 검증합니다. [remote_sftp_trace.go](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/remote_sftp_trace.go#L55)의 실시간 접속 진단은 호스트키 불일치와 인증 오류를 구분합니다.

하지만 **운영 계정의 파일 권한 자체는 도구가 제한하지 못합니다.** 관리자 측에서 읽기 전용 계정과 지정 로그 경로를 구성해야 하며, 보안 게이트웨이별 OTP·중계 사용자명·제품 프로토콜 호환성은 이 코드가 자동 해결하지 않습니다. 원격 조회는 전체 서버 로그를 인덱싱하는 기능이 아니라 최대 최근 512KiB의 제한된 미리보기입니다.

## 8.3 운영자 기본 조사 절차

1. **입력 전:** 원본 로그를 운영 서버 정책에 따라 보존합니다. 운영 로그에는 업무 ID, 계정, SQL 바인드값, 접속 토큰이 있을 수 있으므로 공개 채널에 파일을 올리지 않습니다.
2. **실행:** Go 또는 Rust 배포 자산을 선택하여 EXE를 실행합니다. 브라우저 주소가 `http://127.0.0.1:<포트>/`인지 확인합니다.
3. **가져오기:** TXT/LOG/OUT/TRACE 로그를 선택(최대 1GiB)하고 인코딩을 자동·UTF-8·CP949 등으로 지정합니다. ZIP은 풀어서 원문 파일을 선택합니다.
4. **정상 판정:** 전체 이벤트 수·ERROR/WARN/INFO·SQL 관련 이벤트 수가 표시되고, 원문 샘플·시간대별 분포가 실제 로그와 맞는지 확인합니다.
5. **오류 상세:** 오류 탭 또는 `ORA-00904`, `ORA-00054`, `Caused by` 등을 검색 → 이벤트 상세 → 스택 원인 체인 → SQL/바인드값·요청 ID·주변 이벤트를 연속 확인합니다.
6. **원격 서버:** SSH 서버 IP/포트·파일 절대경로·읽기 전용 SFTP 계정·**별도로 검증한 호스트키 지문**을 입력합니다. 연결 진단의 단계별 결과에서 TCP/인증/SFTP/파일 권한을 구분합니다.
7. **증거 보존:** 내보낸 요약·CSV/JSON은 선택한 필터 기준이며 일부 항목은 5,000건 상한이 있습니다. 관련 오류의 원문 전체 보존이 필요하면 **원본 로그도 따로 보관**합니다.
8. **이력 재연결:** `원본 연결`에서 같은 파일을 다시 선택하고 SHA-256 일치 여부를 확인합니다. 불일치 시 과거 인덱스 재사용을 강행하지 않고 새 분석을 수행합니다.

## 8.4 장애 대응 표

| 증상 | 원인 분류 | 점검 위치 |
|---|---|---|
| EXE는 실행됐는데 브라우저가 접속하지 못함 | 포트·백신·로컬 보안 정책 | [main.go](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/main.go#L23), 루프백 리스너·실행 로그 |
| 1GiB 이상/인코딩 오류 | 입력 계약 | [api.go](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/api.go#L171), 원문 크기·인코딩 |
| SQL 오류 분류 불일치 | 로그 포맷·패턴·경계 | [engine.go](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/engine.go#L100), 원본 이벤트/정규식 |
| 원격 TCP 접속 실패 | 네트워크·SSH 포트 | 연결 진단 `TCP_TIMEOUT`·`TCP_REFUSED` |
| 서버 지문 불일치 | 서버 신원·중간자 위험 | `HOSTKEY_MISMATCH` 시 **계속 진행하지 않음** |
| SFTP 인증/경로 실패 | 계정·서브시스템·권한 | `AUTH_FAILED`, `SFTP_UNAVAILABLE`, `FILE_STAT_FAILED` 등 |
| 자동 업데이트 실패 | 릴리스·SHA·크기·폴더 권한 | [updater.go](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/updater.go#L46) 또는 Rust updater |
| 이전 이력 원문이 없음 | 메타데이터만 저장됨 | 원본 보존본 재선택 및 SHA-256 검증 |

## 8.5 개발 검증 및 버전 일관성

```sh
# Go 엔진
go test ./...
go test -race ./...
go vet ./...

# Rust 엔진
cargo test --manifest-path rust/Cargo.toml --locked
cargo clippy --manifest-path rust/Cargo.toml --locked --all-targets -- -D warnings

# 브라우저 측 계약 (Node가 준비된 개발 환경)
node tests/parser.test.js
node tests/global-sort.test.js
node tests/ui-smoke.js
```

실제 프로젝트/테스트 버전에 따라 실행 인자가 다를 수 있으므로 CI를 우선합니다. [RELEASE_NOTES_v1.0.5.md](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/RELEASE_NOTES_v1.0.5.md)는 **Go/Rust API 정합성, Windows x64 바이너리, 서로 같은 커밋으로 빌드된 릴리스, SHA-256 확인**을 릴리스 기준으로 문서화합니다. **한 엔진에서만 패치를 적용**하면 동일 UI라도 결과가 달라질 수 있으므로 다음에 대해 두 엔진의 결과를 비교해야 합니다: multiline 스택, Oracle 코드, 한글 인코딩, 검색/필터 ID, 100건 경계·정렬, SFTP 파일 끝부분, 업데이트 검증.

---

## 8.6 대용량 로그 분석·검색·정렬 최적화 심층 검토 (추가)

**성능 성격:** 최대 1GiB 원본 스트리밍 파싱, 디스크 24바이트/이벤트 인덱스, 브라우저 원본 파일 재검색, 전역 정렬, SFTP 지연. **LLM 분석이나 자연어 추론 모델은 없습니다.** 현재 SQL 오류 분류는 정규식·규칙 기반이며 'LLM 모델 속도 최적화'는 적용 대상이 아닙니다.

### 8.6.1 이미 구현된 가속/제약

- Go [engine.go L25-L27](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/engine.go#L25)는 원본 최대 1GiB, 인덱스 레코드 **24바이트**, 페이지 **100건**을 사용합니다. [api.go L169-L240](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/api.go#L169)은 원본을 다시 디스크에 보관하지 않고 스트리밍으로 인덱스만 생성합니다.
- Rust [engine.rs L234-L264](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/rust/src/engine.rs#L234)은 일반 인코딩 입력에서 바이트 단위 매회 분기 대신 **슬라이스 단위 개행 위치 탐색**을 구현했습니다. 최대 **64KiB**의 한 줄 접두만 보관하여 1GiB짜리 단일 행에서도 무제한 버퍼가 커지지 않도록 했습니다. 이는 이미 존재하는 개선입니다.
- 브라우저 [search-worker.js](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/web/search-worker.js#L5)는 16,000개 디스크 인덱스를 묶어 가져오고 원본 파일을 최대 **8MiB 슬라이스**로 읽습니다. 검색 반환 이벤트 ID는 최대 100,000개 보관합니다.
- [global-sort-worker.js L25-L103](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/web/global-sort-worker.js#L25)는 현재 페이지가 아닌 **전체 선택 이벤트**를 정렬하고, worker에서 정렬한 ID로 UI 페이지를 만듭니다. 전체 정렬의 기능적 정확성이 우선입니다.
- [tests/rust_perf_compare.py](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/tests/rust_perf_compare.py#L50)는 Rust 기존/최적화 바이너리의 **HTTP import, 필터, 30페이지 읽기 시간과 인덱스 해시** 비교를 자동화할 수 있게 되어 있습니다. 별도 현재 환경에서 측정한 결과는 없습니다.

### 8.6.2 추가 후보

| ID/우선 | 코드 관찰 | 최적화 제안 및 안전 계약 |
|---|---|---|
| **J-P1** | [global-sort-worker.js L25-L94](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/web/global-sort-worker.js#L25)는 모든 선택 이벤트에 `{id,key}` 객체를 만들고 전체 배열을 `sort()`한 뒤 또 ID 배열을 만듭니다. 메시지 열은 **최대 1,000문자** 정렬 키를 보관합니다. 수백만 이벤트에서 메모리·GC·비교 비용이 크게 늘 수 있습니다. | **numeric column: typed array/정수 인덱스 sort**, **문자 열: 조건부 짧은 키·지연 문자열 처리 또는 일정 크기 단위 병합 정렬**을 프로토타입으로 비교. 그러나 **정렬 순서가 모든 이벤트에 대해 전역적이어야 하고** 현재 `Intl.Collator('ko',{numeric:true,sensitivity:'base'})`, 원본 이벤트 ID tie-breaker를 유지해야 합니다. 무단으로 100건 페이지만 정렬하거나 키를 절단하면 기존 의미 변경입니다. |
| **J-P1** | 전체 원문 검색은 [search-worker.js L9-L19](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/web/search-worker.js#L9)에서 모든 후보 이벤트를 디코딩하고, 대소문자 무시 시 `toLocaleLowerCase()` 문자열을 생성합니다. 중복 검색 시 원문 파일이 다시 읽힙니다. | 검색 시간 breakdown(인덱스 전송/원본 slice/디코드/문자열 검색)을 먼저 기록. 최신 쿼리 취소·이전 결과 캐시·같은 파일과 쿼리의 중복 요청 억제 고려. **원문 비보관 정책** 때문에 서버측 영구 Full Text DB 신설은 현 운영 계약을 벗어납니다. |
| **J-P2** | Go [api.go L407-L555](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/api.go#L407) 및 Rust [api.rs L148-L172](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/rust/src/api.rs#L148)는 필터 변경마다 전체 인덱스를 순차 순회하고 임시 8바이트/이벤트 ID 파일을 만듭니다. | 동일 세션/동일 필터의 재사용이 잦은지 측정. **임시 인덱스 캐시** 또는 다중 비트맵 인덱스를 검토하되 총 메타데이터 상한과 세션 삭제·재시작 정합성을 유지. |
| **J-P2** | Rust [engine.rs L236-L246](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/rust/src/engine.rs#L236)의 UTF-16 처리 경로는 여전히 매 바이트를 순회하며 두 바이트 조합으로 줄바꿈을 판단합니다. | UTF-16LE/BE에서 2바이트 정렬된 개행 탐색/청크 경계 carry 로직을 재설계하고 SIMD·slice 접근 비용을 비교. **한 글자 2바이트 경계와 offset/line 정확성**이 깨지면 사용 불가. |
| **J-P2** | [web/local-live.js L18-L25](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/web/local-live.js#L18)는 5,000개 최신 버퍼를 `[...events].sort()`하고 200개를 DOM에 표시합니다. | 변경이 없는 주기마다 재정렬하는지 실제 이벤트/프레임 타이밍 계측. 신규 이벤트만 추가·정렬 위치를 제한해 DOM 변경량을 줄이는 방안은 가능하지만 **최근 버퍼 정렬 정확성** 유지. |
| **J-P3** | Go와 Rust 두 엔진의 분류 코드가 서로 존재합니다([Go engine.go](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/engine.go#L97), [Rust engine.rs](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/rust/src/engine.rs#L12)). | 파서 규칙의 공통 테스트 fixture와 출력 비교를 강화하면 **변경·검증 효율**이 개선됩니다. 이것이 실제 파싱 속도 향상의 증거는 아닙니다. |

### 8.6.3 운영자/개발자 계측 및 가드레일

```sh
# Go 백엔드
 go test ./... -count=1
 go test -race ./... -count=1
# Rust 백엔드 (저장소 루트)
 cargo test --locked --manifest-path rust/Cargo.toml
# 브라우저 전역 정렬·파서·검색 회귀
 node --test tests/global-sort.test.js tests/search-worker.test.js tests/parser.test.js
```

고정 로그 데이터셋을 마련하고 `100MiB`, `500MiB`, `1GiB`, 긴 단일 이벤트, 멀티라인 Oracle 예외, UTF-8/CP949/UTF-16, 10만~수백만 레코드를 나눠 시험합니다. `import MB/s`, peak backend RSS, 메타데이터 바이트/원본 바이트, 필터 `p50/p95`, 페이지 `p95`, 검색·전체 정렬 시간/브라우저 메모리, 원격 SFTP 평균·p95 왕복 및 파일 변경 감지 결과를 기록합니다. Go/Rust 비교는 **같은 입력·같은 OS·같은 빌드 옵션·같은 원본 SHA-256**에서만 의미가 있습니다.

**필수 회귀:** 24바이트 이진 인덱스 호환성, 원본 위치·줄 번호·오류 분류/Oracle 코드·원본 SHA 재연결, 검색 `100,000` 반환 상한 표시, 전역 정렬 100행 페이지 모두 일치, 원본 미보관 정책, 원격 SFTP 읽기 전용·호스트키 지문 검증 유지. **실측 결과 없이 Rust가 Go보다 몇 배 빠르다고 단정하지 않습니다.**

## 8.7 JEUS Lens: 대용량 로그 처리 개선 구현안 (추가)

**조건:** Go와 Rust는 동일한 `24바이트/이벤트` 인덱스와 JSON API, 분류 의미를 유지해야 합니다. 브라우저는 로그 원본을 직접 보유하고 백엔드는 메타데이터만 보관합니다. 속도 때문에 **로그 원문을 디스크에 남기거나 원격 SSH 쓰기 권한을 추가하지 않습니다**.

### IMP-J01 · 전역 정렬의 JS 객체·문자열 메모리 줄이기 (P1)

- **위치:** `web/global-sort-worker.js`의 `result.push({id, key})`와 `result.sort()` [근거 L25-L97](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/web/global-sort-worker.js#L25).
- **비용:** 모든 정렬 대상에 `{id,key}` 객체가 만들어지며, `time/message/code`는 원본 이벤트 일부를 디코드해 문자열 키로 보관합니다. 이벤트 수 10만~100만에서 JS heap/GC 비용을 측정해야 합니다.
- **구현 1단계(낮은 위험):** `level/line`처럼 **숫자 키**만 필요한 분기는 `Uint32Array` 또는 안전한 범위의 `Float64Array`로 `(id,key)`를 표현하는 경로를 별도로 만듭니다. 기존 100건씩 반환, `asc` 역순, 동률에서 **원래 이벤트 ID 오름차순** tie-break를 유지합니다. `line`이 32비트 범위를 넘는 경우에는 타입을 보수적으로 선택합니다.
- **구현 2단계:** 문자열 키는 우선 **동일 표현으로 보관한 채** 디코드에 따른 heap 비용을 계측합니다. 메모리가 병목일 때만 정렬용 key pool/offset array + 캐시된 `Intl.Collator('ko',{numeric:true,sensitivity:'base'})`를 검토합니다. 메시지 1000자·이벤트 최대 128KiB 미리보기 규칙 및 코드 추출 우선순위를 변경하지 않습니다.
- **검증:** 240개 기존 [전역 정렬 테스트](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/tests/global-sort.test.js#L59), 10만/100만/100만+ 이벤트 fixture, 동일 값·한글·숫자 포함 코드·동률·필터·검색 결과의 **전체 인덱스 순서 SHA**를 비교합니다. 속도가 빨라도 전체 정렬 아닌 **현재 페이지 정렬**로 바꾸는 것은 금지합니다.

### IMP-J02 · 검색 디코딩·메모리 할당의 1회 비용 줄이기 (P1)

- **위치:** `web/search-worker.js`는 **16,000개 × 24바이트** 인덱스를 받아 원본 File에서 최대 **8MiB**를 읽으며, 이벤트마다 `TextDecoder.decode()`·소문자 변환 후 검색합니다. [근거 L5-L20](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/web/search-worker.js#L5).
- **방법:** ① 원본 읽기 시간, `decode_ms`, `toLocaleLowerCase_ms`, `includes_ms`, peak worker heap을 별도 타이머로 측정합니다. ② 검색 단어가 짧고 ASCII만 있을 때 제한적인 **원본 바이트 빠른 필터**를 고려할 수 있으나 `UTF-8/CP949/UTF-16` 모든 인코딩에서 원래 문자열 검색과 **같은 결과가 증명된 경우**에만 활성화합니다. ③ 실제 디코딩 비용이 크다면 동일 이벤트를 여러 쿼리로 검색할 때 사용자 소유 원본 File에 대한 제한된 **일회성 메모리 캐시(시간/크기 상한)**를 프로토타입으로 비교합니다. 캐시를 백엔드 디스크나 새 IndexedDB에 저장하지 않습니다.
- **취소·검증:** 검색 요청 교체 시 옛 worker 작업을 종료하고, **100,000개 반환 상한과 실제 전체 일치 건수 표기**를 유지합니다. 긴 이벤트를 256KiB 단위로 읽는 `TextDecoder` 스트림·overlap 경계, surrogate/한글·대소문자 변환·인코딩별 검색을 회귀합니다. A/B 결과가 동일하지 않으면 빠른 필터 비활성화.

### IMP-J03 · 반복 필터의 전체 인덱스 재스캔 비용 줄이기 (P2)

- **위치:** Go `api.go`의 `filter()` [L407-L555](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/api.go#L407) 및 Rust `rust/src/api.rs`의 `filter()` [L148-L172](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/rust/src/api.rs#L148).
- **방법:** ① `all/error/warning/sql/review` 필터별 `scan_ms`, 임시 `filter-*.tmp` 쓰기 바이트, 반복 호출 횟수를 측정합니다. ② 같은 **세션·같은 인덱스 SHA·같은 필터 조건**에서만 임시 결과를 재사용하는 작은 메모리 캐시를 검토합니다. ③ 사용자가 새 로그를 import, 인덱스 삭제, 세션 변경, 원본 재연결 실패 시 캐시를 즉시 무효화합니다. ④ 인덱스 포맷과 API 응답 필드 및 8바이트 필터 인덱스 표현은 그대로 유지합니다.
- **주의:** 현재 필터가 같은 세션의 이전 임시 인덱스를 삭제하는 정책을 갖습니다. 재사용 시 TTL·파일 생명주기를 혼동하면 오래된 `filterId`가 살아 남을 수 있어, **필터 생성/삭제/실패 후 정리**를 함께 설계해야 합니다.

### IMP-J04 · Rust UTF-16·Go/Rust parser 처리량 비교 (P2)

- **위치:** Rust `rust/src/engine.rs`의 `feed()` [L234-L264](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/rust/src/engine.rs#L234). 일반 1바이트 인코딩은 `position('\n')`으로 슬라이스 단위 스캔하지만 **UTF-16 경로는 바이트마다 루프**를 돕니다.
- **방법:** ① UTF-16LE/BE 100MiB·1GiB 로그를 기준으로 현재 `MB/s`, 디코딩 시간, line count, original byte offset을 기록합니다. ② 엔디언별 2바이트 개행 패턴의 **벡터화/청크 스캔**을 실험하되 청크 경계에서 코드 유닛 반쪽과 CRLF를 넘기는 state를 유지합니다. ③ Go와 Rust 각각에서 동일 fixture로 결과 `summary.json`을 정규화 비교하고 `index.bin`의 24바이트 레코드·issue ID를 전체 대조합니다.
- **기각 조건:** BOM, 잘못된 UTF-16, 거대한 단일행, 청크 중간 종료, 멀티라인 스택 trace의 **바이트 offset 하나라도 달라지면** 최적화 반려. `Go→Rust` 포팅 사실만으로 속도가 빨라졌다고 보고하지 않습니다.

### IMP-J05 · 로컬 실시간 감시의 UI 재정렬 비용 제어 (P2)

- **위치:** `web/local-live.js`의 `events` 정렬·상위 200개 화면 갱신. [근거 L18-L24](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/web/local-live.js#L18).
- **방법:** ① 추가 이벤트가 없는 감시 주기에서 render/sort가 호출되는지 확인합니다. ② 신규 이벤트가 있을 때만 render를 스케줄하고 5천개 최근 버퍼는 유지합니다. ③ 정렬 열/오름내림 전환에서는 전체 5천개 정렬이 필요하므로 최적화하지 않은 경로를 유지합니다. ④ 화면 노드 변경을 최소화하되 상태 표시·실시간 이벤트 누락 및 200개 표시 제한을 보존합니다.

### JEUS Lens 벤치마크 및 원복

```sh
go test ./... -count=1
go test -race ./... -count=1
cargo test --locked --manifest-path rust/Cargo.toml
node --test tests/global-sort.test.js tests/search-worker.test.js tests/parser.test.js

```

별도 성능 비교는 `tests/rust_perf_compare.py`의 입력 인자 규약을 읽고 고정된 baseline/optimized Rust 실행 파일 경로로 수행합니다. 사용하지 않는 옵션을 임의로 만들지 않습니다. **판정 지표:** import MB/s, Go/Rust Peak RSS, global sort p50/p95·heap, search decode ms/byte, 30페이지 조회 ms, 필터 반복 비용. **즉시 원복:** 원본 로그 보관/전송이 늘어남, SQL 분류·라인·offset·원본 SHA 검증이 달라짐, 원격 읽기 전용/호스트키 검사 우회, 필터 ID 충돌.


## 8.8 추가 보완 과제 — 요청 경합·원본 재검증·원격 운영 계약 (2026-11-11)

기존 IMP-J01~J05는 스트리밍 파싱·검색·정렬 처리량을 다룹니다. 추가로 대용량 분석 중 사용자 조작의 **최신 요청 보존**과 **원본 로그 신원 재검증**, **원격 읽기 전용 계약**을 실무 테스트 항목으로 편입합니다.

### IMP-J06 · 정렬·검색 조건 급변 시 최신 작업만 유효하도록 회귀 시험 (P1 UI 안정성)

- **확인 근거:** [web/app.js L148-L201](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/web/app.js#L148-L201)은 정렬 변경 시 기존 worker terminate, sortEpoch 대조, pending 요청 정리를 수행합니다. [web/global-sort-worker.js L104-L108](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/web/global-sort-worker.js#L104-L108)의 Worker 자체는 비동기이므로 UI의 세대 보호를 그대로 유지해야 합니다. **현 코드에 경합 결함이 확인되었다는 뜻은 아닙니다.**
- **개선 절차:** 실제 10만/100만 이벤트 fixture에서 전체정렬 시작 → 필터 변경 → 검색 → 정렬 방향 연속 변경 → 원본 재선택/삭제 순서로 자동 UI 테스트를 확장합니다. 구 worker의 진행·완료·페이지 응답이 이후 화면에 반영되지 않는지, 화면의 정렬 아이콘·총 건수·검색 결과가 같은 세대인지 검증합니다.
- **합격/원복:** 최신 사용자 요청 외의 결과 표시는 0건, 취소 후 미완료 Promise·Worker 누수 없음, 전체 100행 페이징 규칙 유지. Worker 재사용 최적화로 epoch/terminate 가드를 없애지 않습니다.

### IMP-J07 · 저장된 메타데이터와 원본 로그 재연결의 진단 절차·테스트 (P1 운영)

- **확인 근거:** [api.go L169-L171, L310-L335](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/api.go#L310-L335)는 원본 로그 전체를 보관하지 않고, 재선택 시 원본 크기와 SHA-256을 다시 확인합니다. [tests/rust_parity.py L83-L146](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/tests/rust_parity.py#L83-L146)은 Go/Rust API와 24바이트 인덱스·정렬 결과 비교를 지원합니다.
- **개선 절차:** 재시작 전·후 같은 로그 재선택, 내용 변경·인코딩 변경·파일 크기 동일하지만 본문 변경·원본 분실 케이스를 분리한 read-only 테스트를 작성합니다. 원본 SHA가 다르면 이전 인덱스를 끼워 맞추지 않고 재분석 필요를 안내해야 합니다. 운영 절차에 인덱스 경로와 원본 로그를 별도 보관해야 하는 이유를 명시합니다.
- **합격/원복:** 재연결 실패가 원본 파일 보관/업로드의 확대나 임의 원본 복구로 이어져서는 안 됩니다. 24바이트 레코드와 이벤트 offset/라인 정보 및 API 반환 의미가 Go/Rust 양쪽에서 같아야 합니다.

### IMP-J08 · 로컬/원격 로그 처리의 성능과 SFTP 신뢰 경계를 따로 측정 (P2)

- **확인 근거:** [.github/workflows/rust.yml L68-L106](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/.github/workflows/rust.yml#L68-L106)은 Go/Rust parity, 1 GiB 스트리밍, 로컬 SSH 서버 SFTP 읽기 전용 통합을 시험합니다. [.github/workflows/rust-performance.yml L34-L40](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/.github/workflows/rust-performance.yml#L34-L40)은 PR 기준 커밋에 대한 별도 성능 비교를 수행합니다.
- **개선 절차:** 전체 로컬 인덱스 import MB/s와 원격 SFTP 읽기 throughput/재연결/호스트키 검사 시간, 갱신 폴링/증분 처리량을 따로 측정합니다. 네트워크 왕복 지연은 파서 속도로 오인하지 않습니다. 특정 호스트 인증 실패/연결 끊김/권한 거부를 빈 로그 성공으로 표시하지 않고 명시적 실패 상태로 남깁니다.
- **합격/원복:** 기본 신뢰 호스트키 검증, 조회 전용 원격 파일 접근, 로컬 원본 비보관/메타데이터 보관 정책 유지. 자동 reconnect 추가 시 비밀번호·키를 평문 로그에 기록하지 않고 재시도 상한을 검증합니다.

## 8.9 1GiB 스트리밍·정렬·검색의 추가 속도 개선 여력 — 2단계 반복 검토 (2026-11-11)

### 기존 경량화·시험 범위

[api.go L169-L171, L225-L266](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/api.go#L169-L171)의 스트리밍 인덱스는 **원본 로그를 로컬 서버에 저장하지 않고** 메타데이터를 생성합니다. [tests/rust_large_stream.py](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/tests/rust_large_stream.py)는 1 GiB Go/Rust 인덱스·SHA 일치 시험을 구현합니다. 이것은 1 GiB **처리량이나 실행시간 수치가 아니라 기능·무결성 검증**입니다. [tests/rust_perf_compare.py](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/tests/rust_perf_compare.py)는 기준 커밋과 후보 커밋의 성능을 따로 계측하는 스크립트지만 본 보고서에서 실측 실행하지 않았습니다.

| 우선 | 실제 코드 | 개선 방법 | 상한 |
|---|---|---|---|
| 1 | [rust/src/engine.rs](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/rust/src/engine.rs), [engine.go](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/engine.go) | 매우 긴 줄/CP949/UTF-16 import 경로의 allocation·UTF 변환·buffer 크기 계측 후 branch/메모리 복사 수 축소 | 전체 1GiB를 읽는 데 T≥1GiB/R_stream; 변환 최적화로 원본 byte reading 자체는 소거 불가 |
| 2 | [web/global-sort-worker.js L25-L95](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/web/global-sort-worker.js#L25-L95) | 정렬 key를 JS 객체/문자열로 보관하기보다 키별 TypedArray·ID index로 구성하고 동일 comparator 사용 | 일반 sort O(NlogN); timestamp/정수 key가 bounded라면 특화 정렬 검토 가능. 객체 메모리 절감과 wall-time은 별개 |
| 3 | [web/search-worker.js](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/web/search-worker.js) | 필터링 순서: 24-byte metadata bit 비교 → 필요할 때 원본 slice·decode; 큰 행의 256KiB 경계와 한국어 검색 유지 | 키워드 없는 단순 메타 필터는 원본 재읽기 감소 가능; 텍스트 검색은 매칭 여부 판단에 필요한 bytes 하한 |
| 4 | [api.go L407-L495](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/api.go#L407-L495) | 반복 필터는 같은 로그 ID/조건을 위한 bounded index cache 실험, 인덱스 부분 읽기와 page 요청 p95 분리 | 원본 변경/필터 ID 충돌 시 cache invalidate. 캐시 메모리·임시 파일 수명 증가 주의 |
| 5 | [web/local-live.js](https://github.com/P-JSL/JeusLogAnalyzer/blob/d57e9570026e39f556c6b0709fb2048363960228/web/local-live.js) | 신규 이벤트가 있을 때만 화면 재정렬/갱신; 최근 5,000개 버퍼/200개 표시 계약 보존 | 대기 중 UI CPU 절감; 대용량 최초 import throughput에는 영향 없음 |

**메모리 수학:** 24-byte 메타데이터 레코드가 N개면 index만 최소 **24N bytes**(예: N=1,000,000개면 24,000,000B ≈22.9MiB)이고, 브라우저 정렬 key·검색 ID 배열은 별도 사용합니다. 비용을 줄이기 위해 파일 본문을 임의 폐기하거나 Go/Rust 인덱스 호환성을 바꾸면 동일 기능 유지 실패입니다.

**재현:** 동일 compiled Go/Rust 기준 binary로 python3 tests/rust_perf_compare.py baseline-binary optimized-binary 실행. import MB/s, filter/s, 전역 정렬 p95/heap, 30페이지 조회 시간, 원본 SHA 및 Go/Rust API 결과를 비교합니다. 작업 종료 후 원본 로그 보관량은 증가하지 않아야 합니다. **현행 대비 추가 시간 단축: 미측정**.

### 논문·수학 모델에 따른 추가 개선 상한

**Amdahl:** 전체 기존 시간 중 최적화할 단계 비율 f, 해당 단계 가속 r이면 전체 S=1/(1−f+f/r). 가령 f=0.10/r=4 → S=1.081배(전체 시간 7.5% 단축), f=0.50/r=4 → 1.600배(37.5% 단축), f=0.80/r=4 → 2.500배(60% 단축). **위 수치는 측정 결과도 개선 약속도 아닌 계산 예시**입니다. 실측 f가 없으면 저장소 전체의 추가 가능 배수는 제시할 수 없습니다. 여러 단계 국소 개선 배수를 곱하면 안 됩니다.

**Roofline:** CPU 작업량뿐 아니라 메모리/디스크/네트워크 트래픽이 병목일 수 있습니다. **Little:** 안정된 작업계에서 동시 작업수 L=요청 도착률 λ×평균 체류시간 W이며, 작업자 수의 무조건적인 증가는 RAM·대기열과 p95를 악화시킬 수 있습니다. 최소 5회 동일 입력·동일 장비에서 E2E wall time·단계별 CPU·peak RSS·읽기/쓰기 bytes·처리량·p50/p95를 모두 관측합니다. 벤치마크 기록이 없는 개선률은 **미측정**입니다.

검증된 1차 문헌: [Amdahl (1967)](https://doi.org/10.1145/1465482.1465560), [Roofline (2009)](https://zenodo.org/records/1236156), [Little (1961)](https://doi.org/10.1287/opre.9.3.383), [Dean & Barroso (2013), The Tail at Scale](https://research.google/pubs/the-tail-at-scale/), [Google Benchmark Guide](https://google.github.io/benchmark/user_guide.html). 논문에 기재된 **다른 시스템의 가속 배수**는 이 프로그램에서 실현 가능한 개선치로 옮겨 적지 않습니다.

### 재검토 방법과 수행 범위

**1차 100회**는 기존 코드/벤치마크 기반 후보·명령·향상률 주장·복잡도 경계를 다른 입력 크기·작업자 수·병목 구성 조건으로 반복 검산한 **정적·수치 검토**입니다. **2차 100회**는 1차 문헌을 반영해 Amdahl, Roofline, Little 및 동일 성능 단위 기준을 서로 다른 모형 파라미터로 교차 검산한 **학술·수학적 정합성 검토**입니다. 이는 각 문서에 별도로 시행한 100+100 반복 라운드입니다. **200번의 독립적인 전 코드 정독, 실기 벤치마크 200회, 논문 전체 실험 재현을 의미하지 않습니다.** 실제 추가 개선율은 코드 수정 전후의 재현 가능한 성능 시험 없이는 확정할 수 없습니다.

## 8.10 성능·속도 모델 1,000회 + 논문·수학 검산 1,000회 실행 기록 (2026-11-12)

**정확한 실행 횟수:** 2026-11-12(KST), 로컬 Python 3.13.5에서 결정적 시드 합성 입력으로 실행한 **1차 검토 라운드 1,000회 + 2차 학술·수학 검토 라운드 1,000회 = 저장소별 2,000회**입니다. 각 1회에는 서로 다른 **5개 검산 항목**을 모두 실행했습니다. 따라서 **1차 5,000건 + 2차 5,000건 = 저장소당 10,000건**, 6개 저장소 총 **12,000라운드·60,000건, 실패 0건**입니다. 1,000개 개선 과제 목록이 아닙니다.

**검증의 한계:** 1,000회는 독립 소프트웨어 실행/실제 장비 벤치마크 1,000회가 아닌 **파라미터화된 정적·수학·합성 데이터 자동 검산**입니다. CPU 프로파일러 실행, 원 논문의 대규모 실험 재현, 전 프로젝트 소스를 1,000번 읽어내는 인력 코드 리뷰는 진행하지 않았습니다. 코드 4개는 GitHub에서 실제 텍스트와 Git blob SHA를 별도 검증했습니다. 속도 향상 후보의 실증에는 실제 프로그램 변경 전후의 벤치마크가 별도로 필요합니다.

**재현 증거(분석 산출물, 저장소에 커밋하지 않음):** `performance_review_1000x2_2026-11-12.py` SHA-256 `6e272f565e2bb0741487baf11c19a7b02d1df3158a70926819eb3aeb6c5dbaa8`, `performance_review_1000x2_results_2026-11-12.json` SHA-256 `1bc85836fca3c8c74c2855d81d12dd4e6412732dc1de49484b9a63803afaf09d`. JSON에는 각 항목의 **1,000개 실실행 사례 시드·입출력 요약의 검산 지문**과 첫/마지막 사례가 포함됩니다.

**1차 검산 지문:** `a3d96c94700645e9727f87e08677c61f3b72dec947ccd0d09edc505e27ff02c7`  
**2차 검산 지문:** `78a37806cc6a00530e8f65cf23f84db581d52985cb37d8fb5a84f994cc6cfbd1`  
(각 항목에 해당하는 1,000개 사례 JSON Lines SHA-256 다섯 개를 **항목명 사전순**으로 `|` 연결해 SHA-256 계산한 값입니다.)

### 2차 논문·수학 모델: 각 1,000회 전 항목 실행

| 항목 | 각 라운드에서 수행한 검산 | 통과 |
|---|---|---|
| Amdahl 상한 | 전체 시간에서 대상 단계 비율 f와 단독 가속 r을 변화시키며 S=1/(1−f+f/r)의 상한 검산 | **1,000/1,000** |
| Roofline 상한 | FLOP/s ≤ min(CPU 연산 피크, 산술집약도×메모리 대역폭)의 부하별 상한 | **1,000/1,000** |
| Little의 법칙 | 안정 상태 λ<μ에서 도착률·체류시간·동시 작업량 L=λW의 일관성 | **1,000/1,000** |
| 꼬리 지연 | 각 부하의 p50/p95/최대값 구분, 중앙값 최적화를 p95 향상으로 오인 방지 | **1,000/1,000** |
| 저장소 특화 학술 모델 | 바이트 읽기 하한, 스트리밍 정렬/인덱스/HTTP strong validator별 제약 | **1,000/1,000** |

검토 근거: [Amdahl](https://doi.org/10.1145/1465482.1465560), [Roofline](https://doi.org/10.1145/1498765.1498785), [Little](https://doi.org/10.1287/opre.9.3.383), [The Tail at Scale](https://research.google/pubs/the-tail-at-scale/), [Google Benchmark](https://github.com/google/benchmark/blob/main/docs/user_guide.md). 문헌의 속도 향상 사례와 본 저장소의 성능 실측은 다른 데이터입니다.

### 얼마나 더 빨라질 수 있는가: 검산된 가정의 범위

전체 실행시간에서 최적화 단계 비중을 f, 해당 단계의 추가 단독 가속을 r로 측정해야 전체 가속 `S=1/(1−f+f/r)`이 계산됩니다. 예: f=10%·r=4라면 1.081배(시간 7.5% 절감), f=50%·r=4라면 1.600배(37.5% 절감), f=80%·r=4라면 2.500배(60% 절감). 이는 **임의의 설명용 시나리오**이지 JeusLogAnalyzer의 실측·실현 가능한 목표치를 의미하지 않습니다. hot path의 f가 미측정이므로 **현재 코드 대비 추가 가속 가능한 배수는 산정할 수 없습니다.** 여러 단계의 국소 배수를 단순 곱하거나 과거 측정 결과를 신규 기대치에 더하지 않습니다. 실측은 동일 입력·동일 장비에서 최소 5회, cold/warm, end-to-end 시간 및 단계별 CPU/RSS/I/O와 p50/p95를 구분하고 결과 정합성을 선행 검증해야 합니다.

### 1차 성능·코드 모델 검산: 각 1,000회 전 항목 실행

| 검산 항목 | 개별 라운드의 검산 내용 | 통과 |
|---|---|---|
| `index_record_count` | 메타데이터 record당 24 bytes × N의 공간 하한 | **1,000/1,000** |
| `global_sort_and_paging` | 전체 정렬 후 100행 페이지 슬라이스와 ID tie-break 결과 일치 | **1,000/1,000** |
| `filter_index_equivalence` | 메타 조건 필터링 결과의 원본 index 순서와 정확성 | **1,000/1,000** |
| `streaming_line_boundaries` | 임의 chunk 경계가 newline byte-offset을 손상하지 않음 | **1,000/1,000** |
| `source_rebind_sha256` | 원본 파일 크기가 같아도 본문 1바이트 변경을 SHA-256으로 검출 | **1,000/1,000** |

### GitHub 원본 소스 4개에 대한 SHA·식별자 교차 확인

| 파일 (기준 시점의 커밋 고정) | 실제 Git blob SHA-1 |
|---|---|
| [`web/global-sort-worker.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/dba08045b6af6b3a390cbb9caf40d85d1f3fdd17/web/global-sort-worker.js) | `af32e0897b5aebb005f6ef10d1d2625010971b8a` |
| [`web/search-worker.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/dba08045b6af6b3a390cbb9caf40d85d1f3fdd17/web/search-worker.js) | `abdc5cc405b223b93dcb417466d0e6a2ea2eac69` |
| [`api.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/dba08045b6af6b3a390cbb9caf40d85d1f3fdd17/api.go) | `a80048a9458973def464ad716315b95f2171f2dd` |
| [`tests/rust_perf_compare.py`](https://github.com/P-JSL/JeusLogAnalyzer/blob/dba08045b6af6b3a390cbb9caf40d85d1f3fdd17/tests/rust_perf_compare.py) | `922559d5bd65216a6be055506dc236af75ed7153` |

### 남은 속도 최적화 여력의 평가·우선순위

**속도 최적화의 실제 우선순위:** (1) `web/global-sort-worker.js`에서 N개 JS key-object의 heap·GC 비용과 TypedArray 대체 후보를 측정합니다. (2) `web/search-worker.js`에서 24-byte metadata-only filter와 text decode+slice를 구분하고 매우 긴 줄/CP949/UTF-16 경계의 복사 횟수를 프로파일링합니다. (3) Go/Rust 파서 간 1 GiB 입력 및 원본 SHA 동등성은 그대로 유지합니다. **검토상 확정된 사실:** 100만 이벤트의 24-byte index만 24,000,000B ≈22.89MiB이며, Browser key/ID 배열은 추가 메모리가 필요합니다. 비교 기반 전체 정렬은 O(N log N) 비용이 남으며, 원본 로그 1 GiB를 검사하는 데 필요한 streaming 읽기 비용을 0으로 만들 수 없습니다. 현재 CPU/브라우저 기준 추가 전체 속도 개선 배수는 미측정입니다.

관련 근거: [Aggarwal–Vitter 외부 정렬 I/O 복잡도](https://research.ibm.com/publications/the-inputoutput-complexity-of-sorting-and-related-problems). 해당 논문의 외부 정렬 수치를 메모리 상주 JS sort의 실측 개선률로 전이하지 않습니다.

---

## 8.11 DIVERSE PERFORMANCE REVIEW — 1,000 feasibility + 1,000 cross-disciplinary evaluations (2026-11-12)

### 1,000 rounds mean **1,000 combinations**, not 1,000 new features

Actual deterministic Python screening performed: **10 existing-code-anchored approaches × 10 workloads × 10 distinct feasibility constraints = 1,000 tuples**, plus **10 approaches × 10 workloads × 10 distinct research lenses = 1,000 tuples**. Every combination is unique within its phase; 2,000 evaluated tuples per repository, 12,000 across all six. A second execution reproduced the summary digest. `run_diverse_1000.py` SHA-256 `caecadb0696142bca8de43e1ae440152015459e8e90e8c418e9909c8a1b82de9`, summary `summary_6repos.json` SHA-256 `23e3ab0a3a456c954dc7f42a0df115dd9ad26fb81b6aa73c4b74850121fd98d0`. Workload axes: short cold, small warm, standard, high count, repeated, long RTT, memory pressure, UI churn, slow disk, 16-worker contention. Constraint axes: exact outputs, new dependencies, portability, memory headroom, tail latency, cold path, cancellation, crash recovery, throughput, additional I/O.

**Validation boundaries:** These are **synthetic design-feasibility calculations and mathematical-relevance checks**, not 2,000 actual executable/CPU benchmarks, 2,000 source diff manual reviews, or 2,000 novel papers read. Status labels are screening outcomes **not verification of implementation or achieved speed**. The rows and hashes can be reproduced with the separately provided evidence ZIP; audit source is not committed to this code repository.

### Ten new viewpoints beyond the older Amdahl / Roofline / Little-only treatment

1. [Parallel work/span and work stealing](https://doi.org/10.1145/324133.324234)
2. [Cache-oblivious locality](https://www.fftw.org/~athena/abstracts/abstract12.html)
3. [Amortization of repeated work](https://en.wikipedia.org/wiki/Amortized_analysis)
4. [Bloom false-positive negative-filter](https://doi.org/10.1145/362686.362692)
5. [Roaring bitmap intersection](https://doi.org/10.1002/spe.2402)
6. [Boyer–Moore pattern matching](https://doi.org/10.1145/359842.359859)
7. [Paired common-random-number experiments](https://doi.org/10.1287/mnsc.41.12.1935)
8. [Bandwidth-delay product and strong Range](https://www.rfc-editor.org/rfc/rfc9110.html)
9. [Top-Down microarchitecture bottlenecks](https://doi.org/10.1109/ISPASS.2014.6844459)
10. [Browser INP interaction latency](https://web.dev/articles/inp)

A lens can be **useful**, **indirect**, or **not-relevant**. Inapplicable ideas are explicitly rejected for an approach: e.g., Roaring is not a proof of benefit for tiny ephemeral filters; Bloom can reject absent keys but positive results require exact verification; CRN affects *experiment variance*, not application throughput; the bandwidth-delay product is only relevant to transport; INP is not a video encoding speed measurement. Additional math conditions: work/span lower bound T_P ≥ max(T₁/P, T∞), precompute amortization only when repeats × saved-query-work > setup, Bloom false positive probability approximately (1−e^(−kn/m))^k under ideal assumptions, and HTTP pipeline BDP = RTT × goodput.

### Review matrix result (not a measured performance success rate)

| Phase | Model classifications (sum 1,000) |
|---|---|
| Engineering constraints | prototype-after-profiling 159; conditional-prototype 504; guard-required 46; low-priority 185; measure-first 6; reject-contract-change 100; existing-not-additional 0 |
| Research relevance | useful 300; indirect 320; not-relevant 380 |

**Engineering evidence SHA-256:** `e705673211e97bda81eac0f6bd1b4856575a8681590f9299b6ce1d5f4c3413a3`. **Theory-relevance evidence SHA-256:** `c58cb44148954c3bad0bc1f3cc435a02a99f0ad0772aba42461960c0e1526230`. Hashes are for each 1,000-row canonical JSON list of method/workload/lens outcomes.

### Different solution approaches: does the code permit a safe experiment?

| ID | Technique | Checked source anchor | Feasibility | Necessary workload | What can invalidate this approach |
|---|---|---|---|---|---|
| J-ALT-01 | TypedArray numeric sort representation | [`web/global-sort-worker.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/333d770de68b160891b9dfbe931358e9037ff416/web/global-sort-worker.js) | **Prototype after profiling** | Many events retained as JS key objects | Tie ID, string and descending sort parity required |
| J-ALT-02 | Stable radix for numeric keys | [`web/global-sort-worker.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/333d770de68b160891b9dfbe931358e9037ff416/web/global-sort-worker.js) | **Conditional** | Large N and integer key semantics validated | Cannot silently convert string/timestamp sorting to lossy keys |
| J-ALT-03 | Compressed bitmap filter postings | [`api.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/333d770de68b160891b9dfbe931358e9037ff416/api.go) | **Conditional** | Repeated high-selectivity filter intersections | Preserve 24-byte exported metadata and file format |
| J-ALT-04 | Boyer–Moore/Two-Way string matching | [`web/search-worker.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/333d770de68b160891b9dfbe931358e9037ff416/web/search-worker.js) | **Prototype after profiling** | Long decoded lines, repeated fixed text queries | UTF8/CP949/UTF16 chunk-boundary behavior must match |
| J-ALT-05 | Vectorized newline scanning | [`rust/src/engine.rs`](https://github.com/P-JSL/JeusLogAnalyzer/blob/333d770de68b160891b9dfbe931358e9037ff416/rust/src/engine.rs) | **Conditional** | Large input, CPU byte scanning proven dominant | Exact byte offset/CRLF/encoding parity Go vs Rust |
| J-ALT-06 | Metadata-first lazy content slicing | [`web/search-worker.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/333d770de68b160891b9dfbe931358e9037ff416/web/search-worker.js) | **Conditional** | Highly selective metadata filter before text query | Full text predicates still read original bytes |
| J-ALT-07 | Bounded repeated-filter cache | [`api.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/333d770de68b160891b9dfbe931358e9037ff416/api.go) | **Conditional** | Repeated filter ID and validated immutable source hash | No stale offsets when original file changes |
| J-ALT-08 | SFTP bounded read-ahead | [`remote_sftp.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/333d770de68b160891b9dfbe931358e9037ff416/remote_sftp.go) | **Conditional** | High RTT and small sequential read windows | Host-key pinning and read-only operation not changed |
| J-ALT-09 | Incremental live-view updates | [`web/local-live.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/333d770de68b160891b9dfbe931358e9037ff416/web/local-live.js) | **Prototype after profiling** | Frequent small append with existing UI capped rows | Limit and sort ordering preserved |
| J-ALT-10 | Store original source bytes for speed | [`api.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/333d770de68b160891b9dfbe931358e9037ff416/api.go) | ****Reject** under metadata-only contract** | Would require explicit product/privacy change | Original log persistence contradicts current architecture |

### Recommended order and decision gates

**Ranked experiments:** first sort N=100k/1m using TypedArray vs object keys with identical global order and page 100; then compare bitmap postings against current filter file for dense/sparse intersections; finally benchmark substring search across chunk boundaries and 1GiB UTF variants. **Complexity is not a speed guarantee**: radix can be O(wN) only after safe fixed-width key reduction, and Roaring may use *more* memory for sparse/short-lived filters. 24N bytes metadata (for 1m events, ~22.9MiB) remains an explicit format cost.

Additional original references: [Roaring bitmap evaluation](https://doi.org/10.1002/spe.2402), [Boyer–Moore 1977](https://doi.org/10.1145/359842.359859), [Top-Down CPU counters](https://doi.org/10.1109/ISPASS.2014.6844459).

**Mandatory adoption protocol:** compare baseline and prototype with the exact same input/source hashes, OS, CPU, build flags and dataset, alternating baseline/candidate at least five complete runs each; report cold/warm end-to-end time, p50/p95, bytes read/written, peak RSS/JS heap, and output equivalence. Numerical asymptotic improvements and reference papers do **not** establish achievable speedups before full execution. **No whole-program prospective speedup is quantified** because the cost share of the relevant hot path has not been profiled.

## 8.12 NON-PERFORMANCE QUALITY / SECURITY / RELIABILITY REVIEW — 1,000 + 1,000 scenario screenings (2026-11-12)

### Method and evidence boundary

On 2026-11-12, a deterministic Python model actually generated **1,000 Phase-I rows** (10 repo-specific controls × 10 failure types × 10 operating environments) and **1,000 Phase-II rows** (10 controls × 10 different assurance methods × 10 quality attributes) for **each repository**. Across six repositories: **12,000 separate screening combinations**. A second script execution reproduced the same summary SHA-256. This **does not** mean 12,000 program runs, 12,000 independent code reviews, 12,000 demonstrated vulnerabilities or 12,000 passing security tests. Synthetic scenario classifications prioritize design/test work only.

Phase I failures: invalid input, corruption, denied permissions, concurrent changes, interrupted operation, stale version, authentication/transport error, untrusted content, platform incompatibility and partial write/restore. Phase II techniques: QuickCheck-style property testing, metamorphic tests, state-machine checks, fault injection, STRIDE, NIST SSDF, OWASP ASVS 5.0, SLSA provenance, WCAG 2.2, and differential engine/output parity. Inapplicable methods are marked **not relevant**, not forcibly applied.

Evidence package, produced separately from GitHub: `review_nonperformance_1000x2.py` SHA-256 `3168cd9f7c938c391ff057280fab9a88fd61b86d42b5fba732d564627d22c5da`; summary `summary_6repos_nonperformance.json` SHA-256 `e823ec751b255943238598c3a4289f67482d3d8019d5b8bb3e443425a157131b`. Each stored JSONL contains 1,000 canonical decision rows. No application code was changed or executed by these document-only commits. 'Existing' describes a targeted code safeguard; it does not certify the wider threat.

Quality references, **not project certifications**: [ISO/IEC 25010:2023](https://www.iso.org/standard/78176.html), [NIST SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final), [OWASP ASVS 5.0](https://asvs.owasp.org/), [SLSA v1.2](https://slsa.dev/spec/v1.2/provenance), [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [Claessen & Hughes 2000](https://doi.org/10.1145/351240.351266).

### 2,000 evaluated matrix cells, not a defect count

- Phase I: 820 lower-priority, 80 existing-guard exercises, 100 new test proposals. Every category total is **1,000**.
- Phase II: 54 recommended, 462 context-dependent, 484 not relevant. Every category total is **1,000**. A **not relevant** standard was not applied to an unrelated feature.
- Screening counts **do not measure completeness, live security, or feature quality**. Repeat appearances of an existing issue across 100 input environments represent **one issue × 100 test situations**, not 100 defects.

| ID | Quality contract | Current source assessment | Checked file | Scenario for a real test | Acceptance gate |
|---|---|---|---|---|---|
| Q-J01 | Go/Rust index parity | **existing** | [`tests/rust_parity.py`](https://github.com/P-JSL/JeusLogAnalyzer/blob/d2af7499501c2dc44950b1b861ed61a2f50b3ce5/tests/rust_parity.py) | CP949, UTF16 and mixed severity logs | Exact 24-byte records and API parity |
| Q-J02 | Reselected source verification | **existing** | [`api.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/d2af7499501c2dc44950b1b861ed61a2f50b3ce5/api.go) | Same-size changed source log | SHA-256 mismatch rejects previous index/source binding |
| Q-J03 | SFTP read-only preview boundary | **existing** | [`remote_sftp.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/d2af7499501c2dc44950b1b861ed61a2f50b3ce5/remote_sftp.go) | Remote path, limit, stat, read-only permission | Single remote preview max 512KiB, no remote command/write |
| Q-J04 | Host-key trust pin | **existing** | [`rust/src/remote.rs`](https://github.com/P-JSL/JeusLogAnalyzer/blob/d2af7499501c2dc44950b1b861ed61a2f50b3ce5/rust/src/remote.rs) | MITM host key mismatch or untrusted host | Terminate before authentication and show safe error |
| Q-J05 | Local API trust and loopback binding | **proposal** | [`main.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/d2af7499501c2dc44950b1b861ed61a2f50b3ce5/main.go) | Untrusted browser origin/remote bind | No dangerous cross-origin control surface |
| Q-J06 | Sensitive log text disclosures | **proposal** | [`api.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/d2af7499501c2dc44950b1b861ed61a2f50b3ce5/api.go) | SQL bind tokens, personal identifiers, export | No automatic public upload or secret display in diagnostics |
| Q-J07 | Encoding/offset equivalence | **proposal** | [`rust/src/engine.rs`](https://github.com/P-JSL/JeusLogAnalyzer/blob/d2af7499501c2dc44950b1b861ed61a2f50b3ce5/rust/src/engine.rs) | Huge line, CRLF, UTF16 surrogate boundary | Go/Rust offsets, sorting, severity results match |
| Q-J08 | Interrupted filter temp index | **proposal** | [`api.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/d2af7499501c2dc44950b1b861ed61a2f50b3ce5/api.go) | Cancel midway, restart during filter write | No stale filter path selected or silent partial index |
| Q-J09 | Release asset provenance | **proposal** | [`updater.go`](https://github.com/P-JSL/JeusLogAnalyzer/blob/d2af7499501c2dc44950b1b861ed61a2f50b3ce5/updater.go) | Forged ZIP or mismatched checksum manifest | Installer selects source-matching, verified artifact |
| Q-J10 | Live log rotation | **proposal** | [`web/local-live.js`](https://github.com/P-JSL/JeusLogAnalyzer/blob/d2af7499501c2dc44950b1b861ed61a2f50b3ce5/web/local-live.js) | Truncation, rename, append, reconnect | Old rows not merged as if they were current file |

### Contradiction reconciliation — report versus source and related repositories

1. **Scope alignment:** local log import allows **1 byte–1 GiB** (`engine.go` `maxLogBytes=1<<30` and `api.go:189-190`); **remote SFTP** is only a bounded **512KiB read-only preview** (`remote_sftp.go:59`). These are not contradictory file-size limits for one operation.
2. The metadata-only backend **does store indexes and summaries**, but **does not persist original log bodies**. Browser rendering can still expose log text from the locally selected source, so privacy handling remains relevant.
3. Existing Go and Rust parity checks include 24-byte index and JSON. This is **not** a blanket certification for all encodings, large lines, crash/rotation and remote transport.
4. The old '5 proposals' front-matter count is replaced with **8 accumulated IMP-J items**; 10 Q-J controls are distinct quality checks.

### What to implement or verify next

- **P0:** no false-success result, no unauthenticated destructive mutation, no silent corruption, unsafe archive publication or source-index mix-up. Treat confirmed mismatches as open until a source fix passes CI.
- **P1:** state-machine and fault-injection tests for cancel/restart/concurrency, source hash, update/provenance, permission denial and recovery. Separate existing guards from uncovered edge cases.
- **P2:** accessibility and support diagnostics, parity, maintainability and release documentation. For Windows and Chrome UI, verify the real interaction, not only DOM presence.
- Code changes, deployment and real fault-injection tests **have not been performed** in this report-only update. Preserve existing interface, journal and fail-closed contracts before approval.

