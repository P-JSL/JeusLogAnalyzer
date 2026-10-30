# JEUS Lens — Rust edition v1.0.3

기존 Go 실행 파일에 의존하지 않는 독립적인 Rust 백엔드입니다. 기존 웹 화면을 Rust 실행 파일에 임베드하므로 HTML/CSS/JavaScript 화면 자체는 재사용합니다. **프런트엔드까지 Rust/WASM으로 재작성한 제품은 아닙니다.**

정식 배포는 원본 Go판과 Rust판의 실제 동작 비교, Windows EXE 실행, SFTP 실서버 테스트 및 1GiB 스트리밍 검증이 모두 통과한 커밋으로만 진행합니다.

## Rust로 구현한 서버 측 기능

- 127.0.0.1 전용 서버, Host/Origin 검사, CSP, 브라우저 실행 및 유휴 상태 3분 후 종료
- 1GiB 이하 로그 스트리밍 가져오기, SHA-256 검증, 원본 로그 사본 미보관
- 최대 24바이트 고정 길이 인덱스, 별도 8바이트 오류 그룹 참조, 분석 이력·삭제
- 기존 Go 브라우저 API: import, verify, archives, status, delete, filter, page, index, page-by-ids
- UTF-8/CP949/UTF-16, 멀티라인 로그, SQL·Oracle 오류·Java 예외·스택 프레임 검토
- 5분 오류 집중 구간, 60분 오류율 급증, 유사 오류 그룹·SQL 하위 유형, INFO 검토 후보
- russh/russh-sftp 기반 SFTP 최근 512KiB 조회, 서버 호스트키 SHA-256 지문 확인, 쓰기·삭제·원격 명령 호출 불가
- 실시간 NDJSON 진단: TCP/SSH 접속·서버 신원 검증·사용자 인증·SFTP 채널 개설·파일 검사·읽기·종료 단계와 오류 코드 스트리밍. 조회 종료 시 SSH 연결 닫음
- GitHub 릴리즈 최신 버전 자동 검사(30분) 및 Windows 실행 파일의 SHA-256 검증·교체·재시작. Private 저장소는 현재 세션에서 Contents: Read 토큰 필요, 토큰 미보관

## 빌드 및 검증

Rust stable toolchain이 필요합니다.

~~~bash
cd rust
cargo fmt
cargo test --all-targets --locked
cargo clippy --all-targets --locked -- -D warnings
cargo build --release --locked
~~~

Windows x64의 경우 Windows에서 네이티브 빌드합니다. 실행 파일은 target/release/jeus-lens-rust.exe 입니다.

Go/Rust API 및 인덱스 비교:

~~~bash
go build -o /tmp/jeus-go .
cd rust && cargo build --release --locked && cd ..
python3 tests/rust_parity.py /tmp/jeus-go rust/target/release/jeus-lens-rust
~~~

검증은 각 프로세스가 서로 다른 임시 데이터 폴더에서 동일한 합성 로그를 처리해 SHA-256, SQL 분류, 오류 통계, 그룹 식별자, 24바이트 인덱스 원문, 필터/페이지, UTF-16 및 CP949를 비교합니다. 실제 운영 로그와 SSH 비밀번호는 저장소나 빌드 아티팩트에 포함하지 않습니다.

## v1.0.3 배포 검증 항목

1. Rust 단위 테스트·정적 분석·Linux 기반 Go 차등 테스트 통과
2. Windows x64 네이티브 빌드 및 단위 테스트 통과
3. 브라우저 UI 전체 기능과 HTTP API 동작 검증
4. 실제 원격 SFTP 환경에서 호스트키 고정·읽기 전용·회전 로그 동작 검증
5. 1GiB급 대용량 로그, 개인정보 보호 및 Go판과의 동작·성능 차이 확인

각 항목은 정식 배포 빌드에 연결된 CI가 동일한 소스 커밋에서 통과한 경우에만 릴리즈됩니다. 기존 v1.0.0 릴리즈 자산은 변경하지 않습니다.
