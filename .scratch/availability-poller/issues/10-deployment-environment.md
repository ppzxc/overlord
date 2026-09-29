# 운영 환경 확정

Type: grilling
Label: wayfinder:grilling
Status: resolved
Assignee: claude (session 2026-09-29g)
Blocked by: 02, 04

## Question

폴러를 어디서 운영할 것인가? 홈서버와 국내 리전 VPS 중에서 IP 차단 여부, 이미지 크기(브라우저 포함 여부), 비용, 운영 편의를 따져 고른다. 로그는 어디서 보는가? `/healthz`와 Docker `HEALTHCHECK`, 그리고 restart 정책을 어떻게 연결하는가? ([감시 불능 판정과 heartbeat](09-health-monitoring.md) 참고) 숲나들e는 해외·클라우드 IP를 차단한다는 보고가 있다([브라우저 자동화 표준 조사](01-browser-automation-standards.md)).

## Answer (2026-09-29, 사용자 확정)

1. **운영 장소**: 처음에는 지금 쓰는 **WSL/개인 PC**의 Docker에서 돌린다. 이 환경은 국내 가정용 IP라 조사할 때와 같은 조건이다. 다만 PC가 잠자기에 들어가거나 꺼지면 감시도 멈춘다. 멈춰 있는 동안에는 dead-man ping이 끊기고, 다시 켜지면 "재시작 직후 현황" 알림이 간다. 상시 가동 기기(홈서버/NAS)나 VPS로 옮길지는 운영해 보고 정한다. 옮길 때는 국내 IP를 우선하고, 데이터센터 IP로 조회가 되는지는 옮기는 시점에 확인한다.
2. **이미지와 빌드**
   - Node LTS slim 기반 multi-stage 빌드로 만들고 브라우저는 넣지 않는다. 브라우저가 필요하면 `WITH_BROWSER` 빌드 인자로 Playwright 변형을 만든다.
   - multi-arch(amd64, arm64)로 빌드한다.
   - `docker compose`로 설정 파일 마운트, `env_file`, `restart: unless-stopped`, `HEALTHCHECK`를 묶는다.
   - 레지스트리는 쓰지 않고 운영 기기에서 직접 빌드한다.
3. **헬스체크와 재시작**
   - `/healthz`는 메인 루프가 살아 있는지만 본다. 예약처가 `stopped` 상태여도 200을 돌려준다.
   - unhealthy는 표시만 하고, 컨테이너 재시작은 프로세스가 종료됐을 때만 일어난다.
   - 루프가 멈추면 내장 watchdog이 프로세스를 스스로 종료시키고, restart 정책이 다시 띄운다. 의도적으로 멈춘 예약처는 자동으로 재시도하지 않는다.
4. **로그**: pino로 JSON을 한 줄씩 stdout에 쓴다. Docker json-file 드라이버로 로테이션하고(`10m`×3), 비밀값은 로그에 남기지 않는다.
5. **시간대**: `TZ=Asia/Seoul`로 고정하고, 코드에서도 KST를 명시해서 계산한다.
