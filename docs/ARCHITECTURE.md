# 설계 및 데이터 흐름

## 시스템 구성

```
Local Windows EXE (Go stdlib / 127.0.0.1 only)
  ├─ Browser UI: drag/drop, File object, filter, search, export
  ├─ POST /api/import: HTTP body streaming -> SHA256 + JEUS parser
  ├─ Local metadata archive (no source copy)
  │    ├─ summary.json: filename, size, SHA256, counts, sanitized signatures
  │    └─ index.bin: 24-byte offset, length, line, endLine, level, SQL group/type
  ├─ GET /api/index: batched index descriptors for browser-side full text search
  └─ Browser File.slice(offset, length) -> show original snippet on demand
```

## 주요 제약

- 메모리와 분석 시간은 파일 크기 및 로그 분포에 따라 달라집니다. 이벤트 메타데이터는 디스크에 순차 생성하며 일반 분석 경로는 전체 원문을 메모리에 적재하지 않습니다.
- 전수 원문 검색은 브라우저 내 File 객체에서 검색을 수행하므로 열린 브라우저에서 원본을 계속 참조할 수 있어야 합니다.
- 파일을 다시 연결할 때 SHA-256 전체 재검증합니다. 원본 크기만 일치하는 변경된 파일은 거부합니다.
- `index.bin`은 리틀 엔디언 고정 길이 포맷으로 **파일에 종속**됩니다. `summary.json` 및 `index.bin`이 변경될 수 있는 신뢰되지 않는 환경에서 무결성 보장은 SHA-256 원본 검증에 국한됩니다. 인덱스 메타파일 자체의 서명·암호화는 구현되지 않았습니다.
- 최대 1GiB 원본의 파일 업로드는 파일 스트리밍이지만 localhost loopback I/O에 따른 네트워크 스택 복사는 피할 수 없습니다. **디스크 복사본이 없다는 의미**입니다.

## 24바이트 이벤트 인덱스

| 바이트(오프셋) | 내용 |
|---|---|
| 0-7 | 원본 시작 오프셋 uint64 |
| 8-11 | 원본 길이 uint32 |
| 12-15 | 시작 라인 uint32 |
| 16-19 | 종료 라인 uint32 |
| 20 | 레벨 1=error, 2=warning, 3=info |
| 21 | SQL 관련 여부 0/1 |
| 22 | SQL 세부 분류 코드 0~8 |
| 23 | 예약 |

Go HTTP 프로세스만 파일 인덱스를 작성합니다. 브라우저는 `index.bin`을 직접 수정하지 않습니다.

## 오류 판정

1. 명시적 로그 레벨을 우선합니다.
2. 일반 Java 스택·SQL Exception·ORA/PLS 코드를 이벤트 내부에서 찾습니다.
3. SQL 관련 여부(별도 분류)와 오류 심각도(직교 분류)를 기록합니다. 따라서 경고 이벤트가 동시에 SQL 이벤트로 집계될 수 있습니다.
4. 포맷/소스에 따라 false-positive, false-negative가 발생할 수 있습니다.

## 성능

- 단일 선형 스트리밍 인덱스 생성: 입력 바이트의 총량 `N`에 대하여 대략 O(N). 각 라인의 최대 분석 접두부는 65,536 바이트이고, 데이터 종류에 따라 정규식 비용이 변합니다.
- 저장량: 대략 `24 × 이벤트 수` bytes + 요약 데이터. 반복되는 4KiB 로그의 경우 원본 대비 약 0.59%.
- 카테고리 필터: 인덱스 전체를 O(이벤트 수)에 스캔하고 8bytes/매칭 이벤트로 임시 색인을 만듭니다.
- 페이지 조회: `ReadAt`을 이용하여 선택 페이지 레코드만 읽습니다.
- 원문 검색: 인덱스와 원본 File 슬라이스를 순회하므로 최악 경우 O(원본 크기) 시간이 필요합니다.
