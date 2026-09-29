# overlord

고래불 야영장 빈자리 폴러. 새 빈자리가 생기면 Telegram으로 알린다.

## 실행

```sh
cp config.example.yaml config.yaml   # 감시 조건을 고친다
cp .env.example .env                 # TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID를 채운다
docker compose up -d --build
```

- `config.yaml`은 컨테이너에 읽기 전용으로 마운트된다. 고친 뒤에는 `docker compose restart`로 다시 읽힌다.
- `TZ=Asia/Seoul`로 고정되고, 시간 계산은 호스트 설정과 무관하게 KST 기준이다.
- 로그는 JSON 줄 단위로 stdout에 남고 json-file로 10MB×3개 로테이션된다. 봇 토큰과 dead-man URL은 가려진다.
- 이미지는 `docker buildx build --platform linux/amd64,linux/arm64 .`로 두 아키텍처 모두 빌드할 수 있다.

## 상태 확인과 복구

- `/healthz`(기본 `127.0.0.1:8080`)는 예약처 루프가 살아 있으면 200, 정해진 시간(다음 바퀴 예정 + 15분) 넘게 멈췄으면 503이다. 예약처가 차단 등으로 `stopped`여도 200이다.
- 루프가 멈추면 watchdog이 프로세스를 종료하고 `restart: unless-stopped`가 다시 띄운다. `docker compose ps`에서 `healthy`를 확인한다.
- `stopped` 예약처(차단, 인식 불가)는 Telegram 알림이 오며, 원인을 해결한 뒤 `docker compose restart`로 재개한다.
- `HEALTHCHECK`는 `node dist/main.js healthcheck <설정>`으로 설정한 `healthz.bind`를 찌르므로 바인드를 바꿔도 따로 맞출 것이 없다.

## 개발

`npm run typecheck`, `npm run lint`, `npm test`. 예약처 카탈로그는 `node dist/main.js catalog goraebul [--live]`.
