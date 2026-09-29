# 08: quietHours, 일일 요약, dead-man ping

**What to build:** 새벽에 알림이 사람을 깨우지 않게 한다. 조용한 날에도 폴러가 살아 있음을 알 수 있게 한다. 프로세스나 알림 채널이 죽으면 외부 서비스가 알려 주게 한다. 근거: [spec](../../availability-poller/spec.md)

**Blocked by:** 06 (Telegram 알림 완성), 07 (헬스 상태 머신과 실패 처리)

**Status:** ready-for-agent

- [x] `quietHours`를 설정하면 그 시간대에는 바퀴 간격이 3배로 늘어난다. 모든 이벤트는 무음(`disable_notification`)으로 나간다. 설정하지 않으면 이 동작은 없다.
- [x] 일일 요약은 설정한 시각(기본 09:00)에 무음으로 한 건 나간다. 내용은 예약처별 상태, 전날 바퀴 수와 실패 수, 활성 감시 조건 수, 곧 만료되는 감시 조건이다. 설정으로 끌 수 있다.
- [x] `deadManPingUrl`을 설정하면 바퀴가 끝나고 알림 채널이 정상일 때만 해당 URL로 GET을 보낸다. 요청에는 다른 내용을 싣지 않는다.
- [x] 알림 채널이 계속 실패하면 ping을 보내지 않는다.
