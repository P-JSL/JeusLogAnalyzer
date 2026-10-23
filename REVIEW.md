# JEUS Lens v6.0.0 검증 보고

작성일: 2026-10-23

## 실행한 검사

| 영역 | 실행 방법 | 결과 |
|---|---|---|
| Go 핵심 로직 | `go test ./... -count=1` | PASS |
| JavaScript 파서/원문 검색 | `node --test tests/parser.test.js tests/search-worker.test.js` | PASS — 총 13개 JS 테스트 |
| 서버 API | Linux 바이너리 + `node tests/api-smoke.js` | PASS — import, SHA-256 verify, SQL filter, pagination, history |
| UI | Chromium `node tests/ui-smoke.js` | PASS — 드롭 자동 분석, SQL 그룹/유형, 상세보기, 타임라인, 진단 요약 생성 |
| 1GiB 스트리밍 | `JEUS_LENS_STRESS_1GB=1 go test -run '^TestOneGiBStreaming$' -v -timeout 180s` | PASS — 262,144개 이벤트, 기본 인덱스 6,291,456 bytes + 오류 참조 인덱스 2,097,152 bytes, 약 8.12초 (v6 테스트 실행 환경) |
| Windows EXE | Go cross-compile `GOOS=windows GOARCH=amd64 CGO_ENABLED=0` | PASS — PE32+ 생성 |

## 검증 조건

- 부하 파일은 4KiB 고정 정상 이벤트 262,144개를 **메모리에서 반복 생성**하는 합성 스트림입니다. 실제 서버 로그 처리 속도를 대표하지 않습니다.
- 스트리밍 테스트 `GoHeapAlloc`은 약 2.65 MiB였습니다. 이는 관측 시점 힙 할당량이며 프로세스 전체 최대 RSS나 브라우저 메모리 상한이 아닙니다.
- Chromium UI는 로컬 HTTP 서버를 실제 방문하지 않고 코드/DOM과 모의 API를 이용했으며, 독립 API 통합 테스트는 로컬 HTTP 서버로 실행했습니다.
- 실제 JEUS 운영 데이터, Windows 10/11 실기, 다양한 커스텀 포맷, 독립적인 외부 AI 에이전트/사람의 승인은 아직 검증하지 못했습니다.

## 개선 내용

1. 원문 오류 메시지가 TOP 집계로 저장되는 경로 제거, 코드/예외 클래스/안정 지문만 저장.
2. 빠른 페이지 이동 시 오래된 요청이 화면을 덮어쓰는 충돌 방지.
3. CSV/JSON 추출 실측 상한 5,000건과 사용자 안내 일치, 제한 경고 조건 개선.
4. 원문 비포함 진단 요약 TXT 버튼 및 테스트 추가.
5. UTF-16LE 오프셋, 민감 문자열 요약 누출 방지 테스트 추가.
6. GitHub Actions 코드 테스트/Windows 자동 빌드 파일, `.gitignore` 및 보안/논문 적용 범위 문서화.

## 검토 및 승인 상태

개발자 관점(안정성), 보안(원문 저장 여부), 데이터 정합성(인덱스 오프셋/SQL 유형), UI(드롭·상세)으로 분리하여 코드 및 자동 테스트를 수행했습니다. **독립 에이전트들의 실제 상호 승인이나 인간 감사 승인을 받지는 않았습니다.** 

## v6.0.0 유사 오류 그룹 확장

- `go test -race ./... -count=1` PASS, JavaScript 13 tests PASS, Node.js API smoke PASS, Chromium UI smoke PASS, Windows x64 cross-compile PASS.
- 기존 v5의 단순 오류 서명 목록과 달리 v6에서는 동일한 구조적 그룹을 클릭하여 별도 필터링할 수 있습니다.

- SQL 코드와 예외 클래스의 안정적 지문, 비SQL의 첫 유의미한 스택 프레임 포함 구조적 지문 추가.
- 메타데이터 `issues.bin`(8 bytes/이벤트) 생성. 기본 `index.bin`(24 bytes/이벤트)은 변경하지 않음.
- 유사 오류 그룹 100개까지 요약 UI에 표시하고 클릭하여 해당 이벤트만 추출.
- 소스 또는 SQL 메시지 본문을 지문 문자열에 저장하지 않음.
- 단위 테스트: 동일/상이한 SQL 오류 코드, 스택 메서드·행 번호 차이, 정상 이벤트=0, 취소 시 인덱스 잔여물 삭제 추가.
- API 스모크 테스트: 그룹 인덱스 길이, 그룹별 필터 조회, Chromium UI: 그룹 클릭/해제 테스트.
- 실제 운영 데이터 분류 정확도와 Windows 네이티브 실행은 검증하지 못함. GitHub Actions는 게시 후 실행 상태 재확인 필요.
