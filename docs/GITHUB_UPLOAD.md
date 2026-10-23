# GitHub 업로드 안내

요청된 repository 이름: `JeusLogAnalyzer`. 외부 공개 여부 지정이 없어 운영 로그/인덱스 오배포 위험을 고려해 **private 생성 권장**.

## GitHub UI

1. GitHub에서 New repository 생성 → Name `JeusLogAnalyzer`, Visibility **Private**, 빈 저장소로 생성(README 자동 생성 끄기).
2. GitHub 연결을 사용하는 경우 ChatGPT의 GitHub 앱이 해당 신규 저장소에 접근·쓰기 가능하도록 앱의 repository access를 허용.
3. 준비된 소스 ZIP을 로컬에 풀고 다음 명령으로 push하거나, GitHub 연결을 통한 업로드를 다시 요청.

## Git 명령

```bash
git init -b main
git add .
git commit -m "Initial JEUS Lens metadata-only log analyzer"
git remote add origin https://github.com/P-JSL/JeusLogAnalyzer.git
git push -u origin main
```

Git 사용자 인증과 repository 생성은 사용자의 GitHub 권한이 필요합니다. `git` 실행 전 `.gitignore`와 `git status`를 확인하여 운영 로그를 포함하지 않게 하세요.

## 대안: GitHub CLI

```bash
gh auth login
gh repo create P-JSL/JeusLogAnalyzer --private --source=. --remote=origin --push
```

위 명령은 사용자 계정에 실제 GitHub CLI를 설치하고 인증한 환경에서만 동작합니다. **GitHub 커넥터가 이 저장소를 조회할 수 있는지 확인된 다음에만 업로드 완료를 주장할 수 있습니다.**
