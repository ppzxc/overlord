# 09: 운영 패키징

**What to build:** `docker compose up` 한 번으로 폴러가 운영 가능한 상태로 뜨게 한다. 루프가 멈추면 스스로 복구하고, 로그를 안전하게 남긴다. 근거: [spec](../../availability-poller/spec.md)

**Blocked by:** 01 (워킹 스켈레톤)

**Status:** ready-for-agent

- [ ] `/healthz`는 기본으로 localhost에 바인드한다. 메인 루프의 마지막 틱이 기준 시간 안에 있으면 200을 돌려준다. 예약처가 `stopped`여도 200이다.
- [ ] 틱이 오래 멈추면 watchdog이 프로세스를 종료한다.
- [ ] 로그는 pino JSON으로 한 줄씩 stdout에 쓴다. 비밀값은 마스킹한다.
- [ ] 모든 시간 계산은 `TZ=Asia/Seoul`, KST 기준이다. 호스트 시간대를 바꿔도 동작이 같다.
- [ ] Node LTS slim multi-stage 이미지에는 브라우저가 들어 있지 않다. amd64와 arm64로 빌드된다. `WITH_BROWSER` 빌드 인자는 자리만 둔다.
- [ ] compose 파일에 설정 파일 마운트, `env_file`, `restart: unless-stopped`, `/healthz` 기반 HEALTHCHECK, json-file 로그 로테이션(10m×3)이 들어 있다.
- [ ] README 또는 운영 문서에 설정, 실행, 재개(재시작) 방법이 적혀 있다.
