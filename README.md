# overlord

캠핑장 빈자리를 감시해서, 새 빈자리가 생기면 Telegram으로 알려 주는 폴러.

## 실행

```sh
cp config.example.yaml config.yaml   # 감시 조건을 고친다
cp .env.example .env                 # TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID를 채운다
docker compose up -d --build
```

- `config.yaml`은 컨테이너에 읽기 전용으로 마운트된다. 고친 뒤에는 `docker compose restart`로 다시 읽힌다.
- 시간은 호스트 설정과 무관하게 KST 기준이다.
- 로그는 JSON 줄 단위로 stdout에 남고, 봇 토큰과 dead-man URL은 가려진다.

## 설정

`config.example.yaml`에 예시가 있다. 주요 항목은 다음과 같다.

- `providers.<id>.pollIntervalSeconds`: 바퀴 사이 간격(60초 이상, 기본 150).
- `providers.<id>.openingRush`: 오픈 경쟁 시간 `{ from, to }`(HH:MM). 이 구간에는 조회하지 않고 끝까지 쉰다. 생략하면 예약처 기본값을 쓴다.
- `quietHours`: 알림을 무음으로 보내고 바퀴 간격을 3배로 늘리는 시간대.
- `dailySummary`: 일일 요약 시각. 예약처별 마지막 성공 시각과 프로세스 가동 시작 시각도 적는다.
- `hourlySummary`: 시간별 요약(기본 꺼짐). `everyHours`는 24의 약수이고 KST 정각에 맞춰 보낸다.
- `deadManPingUrl`: 바퀴가 끝날 때마다 GET을 보낼 URL.
- `watches`: 감시 조건. 시설, 구역, 날짜 범위, 박수, 알림 대상을 정한다.

## 상태 확인과 복구

- `/healthz`(기본 `127.0.0.1:8080`)는 루프가 살아 있으면 200, 다음 바퀴 예정 시각에서 15분 넘게 멈췄으면 503이다.
- 루프가 멈추면 watchdog이 프로세스를 종료하고 Docker가 다시 띄운다.
- 차단이나 구조 변경으로 멈춘 예약처는 Telegram 알림이 오며, 원인을 해결한 뒤 `docker compose restart`로 재개한다.

## 개발

`npm run typecheck`, `npm run lint`, `npm test`.

예약처 카탈로그: `node dist/main.js catalog <예약처> [--live] [--config config.yaml]`
