# 적용 기술 및 연구 검토

## 출처 (원문)

1. [JEUS 9 Server Guide: Logging](https://docs.tmaxsoft.com/ko/jeus/9/server-guide/chapter-jeus-logging.html) — 기본 formatter와 0~7 숫자 로깅 레벨.
2. Pinjia He 외, [Drain: An Online Log Parsing Approach with Fixed Depth Tree](https://doi.org/10.1109/ICWS.2017.13), ICWS 2017 — 온라인 스트리밍 템플릿 파싱과 고정 깊이 탐색 트리.
3. Du & Li, [Spell: Streaming Parsing of System Event Logs](https://doi.org/10.1109/ICDM.2016.0103), ICDM 2016 — LCS 기반 온라인 템플릿 추출.
4. [Loghub: A Large Collection of System Log Datasets](https://github.com/logpai/loghub), ISSRE 2023 — 다양한 로그 데이터셋/파서 평가를 위한 공개 벤치마크.

## 실제 적용 여부

| 아이디어 | 적용 | 근거 / 범위 |
|---|---|---|
| 온라인 처리 | **적용** | Go `buildIndexStream`의 순차 입력·메타데이터 출력 |
| 메시지 헤더 구조화 | **적용** | JEUS/Java 날짜·레벨 파서 정규식, 스택 연결 |
| 고정 길이 인덱스 | **적용** | 24-byte 이진 이벤트 메타데이터, random-access 페이지 조회 |
| 선택적 원문 조회 | **적용** | 브라우저 `File.slice` 기반 상세보기·검색 |
| JSON/CSV 보고 | **적용** | 검색/필터 적용 결과를 별도 다운로드 (최대 5,000건) |
| Spell의 LCS 템플릿 추출 | **미적용** | 구현하지 않았으며 인용은 연구 배경 목적 |
| Drain 트리 기반 템플릿 학습 | **미적용** | 해당 논문의 고정 깊이 트리/유사도 군집 알고리즘을 구현한 상태가 아님 |
| Loghub 벤치마크 학습/평가 | **미적용** | 실제 JEUS 로그와 Loghub 전체 데이터셋 정밀 실험 수행하지 않음 |
| AI 기반 근본 원인 추론 | **미적용** | 규칙 기반 오류 단서 제공이며 모델 진단이 아님 |

논문의 접근법을 참고했다고 해서 논문 전체 알고리즘이 구현되었다는 뜻은 아닙니다. 구현 확인 가능한 범위와 미구현 범위를 엄격히 구분합니다.

## 대용량 안정성 설계

- 전체 파일을 메모리로 로드하는 방식 대신, 작은 버퍼로 순차 읽고 이벤트 메타데이터만 기록합니다.
- 개별 라인의 분석용 접두부는 64KiB로 제한하여 과도하게 긴 한 줄로 인한 메모리 증가를 억제합니다. 64KiB 이후의 해당 라인에만 존재하는 예외 코드는 누락될 수 있습니다.
- 전체 텍스트 검색은 UI가 필요한 경우에만 시작하며, 파일 슬라이스들을 일정 크기로 읽습니다.
- 로그 템플릿 머신러닝 모델을 추가하지 않아 별도 모델 다운로드, 비공개 데이터의 원격 호출, 대규모 GPU 메모리 요구가 없습니다.

## 2026-10-23: 주요 로그 플랫폼 기술 비교 및 v6 반영

| 제품/연구 | 문서 기반 핵심 접근 | 단독 실행형 JEUS Lens 적합성 | 실제 적용 |
|---|---|---|---|
| Datadog Error Tracking | `error.type`, `error.message`, 유의미한 `error.stack` 상단 프레임 등을 사용해 유사 오류 그룹화. 서비스 간 오류를 분리 | 로컬 로그에서 서비스 식별자가 확정적으로 없으므로 유형·코드·스택 프레임을 선별해 적용 | **부분 적용:** FNV-1a 64-bit 구조적 식별자, 오류 그룹별 건수, 첫/마지막 이벤트, 클릭 탐색. Datadog의 자체 알고리즘은 복제하지 않음 |
| Grafana Loki | 인덱스는 제한된 저카디널리티 레이블 중심. 원문 텍스트 전체 색인을 기본적으로 만들지 않음 | 원본 중복 저장을 피하고 작은 수치 메타데이터만 보관할 수 있음 | **설계 원칙 적용:** 24B/이벤트 원본 오프셋과 8B/이벤트 오류 그룹 참조, 코드 및 레벨 집계 |
| Elastic Observability Log Categorization | ML 기반 메시지 패턴 분류 및 발생량 이상 탐지 | 모델 비용, 분석 상태 유지와 개인정보 누출 위험이 있고 1GB 로컬 분석 목적에 과함 | **미적용:** 모델 기반 템플릿 유사도·이상 탐지 제외 |
| Drain (2017) | 고정 깊이 트리 기반의 온라인 메시지 템플릿 파싱 | 비정형 메시지 템플릿 확장에 유용하나 추가 정확도 검증이 필요 | **미적용:** 현재 구조적 지문/패턴 규칙만 구현 |

### 참고 자료 (원문)

- Datadog, [Error Grouping](https://docs.datadoghq.com/logs/error_tracking/error_grouping/).
- Grafana Labs, [Understand labels](https://grafana.com/docs/loki/latest/get-started/labels/).
- Grafana Labs, [Label best practices](https://grafana.com/docs/loki/latest/get-started/labels/bp-labels/).
- Elastic, [Categorize log entries](https://www.elastic.co/guide/en/observability/current/categorize-logs.html).

### 구조적 오류 식별자 설계

- SQL 이벤트: `SQL 여부 + ORA/PLS/SQLSTATE 코드 + 원인 예외 클래스`를 정규화하여 지문을 생성합니다.
- 비SQL 오류: `SQL 여부 + 예외 클래스 + 첫 유의미한 스택 프레임 + JEUS 이벤트 코드`를 사용합니다. Java 소스 행 번호가 변경되어도 클래스·메서드가 같으면 같은 그룹입니다.
- FNV-1a 64-bit는 **비암호학적** 해시입니다. 동일한 지문에 64-bit 해시 충돌이 발생할 가능성이 있으며, 안전한 원문 비식별화 보증이 아닙니다. 원문 문자열 자체를 키에 포함하지 않으므로 요약 JSON에 로그 본문이 저장되지 않습니다.
- 오류 그룹 수는 최대 5,000개로 제한하고, 요약 화면에는 빈도 기준 100개까지만 기록합니다. 초과 그룹은 단일 '기타 오류 그룹'으로 합칩니다. 따라서 낮은 빈도의 그룹은 선택할 수 없으며, 총 오류 이벤트 수와 상위 그룹 합계는 다를 수 있습니다.
- `issues.bin`은 이벤트당 8바이트 그룹 ID(정상/비오류는 0)만 저장합니다. 기존 `index.bin` 24바이트 레이아웃은 유지하여 v5 아카이브가 읽히도록 했습니다.
- 집계 시 로그 메시지/쿼리/스택 원문은 인덱스에 저장되지 않습니다. 원본 전체 텍스트 검색에는 다시 원본 파일이 필요합니다.

### 정확성·한계

- 동일한 ORA 코드/예외 클래스라도 서로 다른 원인일 수 있습니다. 표시되는 그룹은 **유사 패턴**이지 실제 근본 원인 확정이 아닙니다.
- 서비스/배포 버전 등의 신뢰할 수 있는 식별자가 없으므로 Datadog처럼 서비스 단위로 그룹을 분리하지 않습니다. 둘 이상의 서비스가 합쳐진 로그에서는 서로 다른 사건을 같은 그룹으로 볼 수 있습니다.
- `Caused by`와 스택 프레임을 읽어 오류 위치를 가려낼 때 JEUS 설정마다 스택 출력 순서가 다르면 지문이 달라질 수 있습니다.
- 합성 로그 자동 테스트를 수행했지만 실제 운영 JEUS 로그 데이터셋에서 정밀도/재현율을 측정하지 않았습니다.

## v6.2.0 상용 제품 검토 및 적용 선택 (2026-10-23)

| 제품 | 공식 문서에 나온 기술 | JEUS Lens 적용 |
|---|---|---|
| Splunk SPL2 | 5분 등 `span` 기반 `timechart`와 시간별 이벤트 집계 | **적용**: 로그 헤더 시각을 5분 그룹으로 집계, 오류 많은 구간과 실제 첫/마지막 사건 탐색 |
| Elastic Observability | 텍스트 패턴의 분포/범주화, 기계학습 기반 로그량 이상 탐지 | **부분 참고**: 오류 집중 구간 표시는 구현. ML 이상 탐지·학습 기반 범주화는 비용과 자료 검증 부재로 **미구현** |
| Datadog | 예외/스택 프레임 기반 Error Tracking, before/after context | **기존 기능 유지**: 예외 그룹·전후 이벤트 원본 참조. 서비스/호스트 기반 정확한 사건 연관은 신뢰 가능한 식별자 부재로 **미구현** |
| Grafana Loki | 동적·고카디널리티 레이블 인덱스 회피, 수집 시 인덱스 경량화 | **설계 유지**: 동적 LOT_ID/SQL 텍스트를 색인·요약 파일에 저장하지 않음 |
| OpenSearch | 동적 토큰 치환을 이용한 비정형 로그 패턴 분석 | **검토만**: 정규화 오류/입력값 혼합 시 충돌 가능. 독립 성능·정확도 시험 전 미구현 |

원문:
- https://help.splunk.com/en/splunk-enterprise/search/spl2-search-reference/timechart-command/timechart-command-usage
- https://www.elastic.co/docs/explore-analyze/discover/run-pattern-analysis-discover
- https://docs.datadoghq.com/logs/error_tracking/error_grouping/
- https://docs.datadoghq.com/logs/explorer/side_panel/
- https://grafana.com/docs/loki/latest/get-started/labels/bp-labels/
- https://observability.opensearch.org/docs/ppl/commands/patterns/

### 알고리즘·자원 비용

- 입력 이벤트 수를 N, 인식된 고유 5분 구간 수를 K라고 할 때 집계는 해시 테이블 평균 O(N), 우선순위 정렬은 O(K log K)입니다. K는 50,000으로 제한합니다.
- 로그 헤더 시각을 신뢰할 수 없는 경우 구간을 만들지 않습니다. 오류 건수 순으로 상위 12개만 저장하며 유효 시간대가 부족하더라도 임의로 보충하지 않습니다.
- 기존 32 bytes/이벤트 인덱스에 추가 바이트가 없으며, 요약 JSON만 고정 상한의 소규모 항목이 추가됩니다. 원본 저장·로그 메시지 전수 인덱싱·외부 호출·ML은 없습니다.
- SQL 오류 수량은 명시적인 `ERROR/SEVERE` 등 **오류 레벨이면서 SQL 패턴인 이벤트**만 집계합니다. INFO 레벨 내 SQL 패턴은 SQL 오류로 올리지 않습니다.


## v6.3.0 — 24시간 내 단일 파일 중심 오류율 급증 후보

**실제 운영 맥락:** 사용자가 직접 검사하는 JEUS 로그는 일반적으로 최대 24시간치. 따라서 7/30일 평균·동일 요일 기준선·자동 트레이스 연관·학습형 이상 감지는 데이터가 부족해 적용하지 않음. 시간대별 5분 집계와 직전 60분의 오류 이벤트 비율만 비교.

| 후보 | 공식 문서/원리 | 결정 |
|---|---|---|
| Splunk `timechart` / `streamstats` | 짧은 시간 구간 집계와 시간 흐름 비교 | **부분 적용:** 자체 5분 bucket·과거 60분 비율 및 첫/마지막 오류 원본 이동 (SPL 엔진 사용 안 함) |
| Datadog Error Tracking | 구조적 오류 그룹과 첫/마지막 발생·최근 급증에 따른 우선순위 | **기존 유사 오류 그룹 유지, 급증 조사 후보 추가:** 원문/트레이스·사용자 영향 추론은 하지 않음 |
| Elastic Logs Anomalies | ML 로그량 변화 및 학습 결과 기반 후보 | **미적용:** 학습 기준선 부족, 단일 파일에 과도한 복잡도·오탐 우려 |
| Google SRE Error Budgets | 서비스 요청 실패율을 SLI로 사용 | **미적용:** JEUS 로그 오류 이벤트 비율은 서비스 요청 실패율을 대체하지 못함 |

검토한 원문:
- https://help.splunk.com/en/splunk-enterprise/search/spl2-search-reference/timechart-command/timechart-command-usage
- https://docs.datadoghq.com/logs/error_tracking/explorer/
- https://www.elastic.co/guide/en/logs/guide/current/detect-log-anomalies.html
- https://sre.google/workbook/alerting-on-slos/

최대 1GiB 입력 스트리밍과 32B/이벤트 인덱스는 유지합니다. 급증 판단은 요약 수치만 추가 저장하며, 근본 원인 분석·임의 데이터베이스 조회·미확인 과거 데이터 보정은 하지 않습니다.
