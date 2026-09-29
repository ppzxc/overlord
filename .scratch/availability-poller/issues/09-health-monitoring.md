# 감시 불능 판정과 heartbeat

Type: grilling
Label: wayfinder:grilling
Status: resolved
Assignee: claude (session 2026-09-29f)
Blocked by: 05, 08

## Question

(전제: 실패 분류와 기본 동작은 [예약처 어댑터 인터페이스](05-provider-adapter-interface.md)에서 정했다. transient는 백오프하고, blocked와 unrecognized는 즉시 멈춘 뒤 사람이 재개하며, unavailable은 간격을 늘려 계속 조회한다. 여기서는 임계값, 알림 문구, 재개 절차, heartbeat를 정한다.)

"감시 불능"을 어떤 기준으로 판정하고, 어떻게 알리고 복구할 것인가?

- 연속 실패를 몇 번까지 허용하는가? 응답 구조가 바뀐 것은 어떻게 감지하는가?
- 복구되면 알리는가? 같은 장애 알림을 반복해서 보내는 걸 어떻게 막는가?
- 알림 채널 자체가 계속 전송에 실패하면 어떻게 알리는가? 그 채널로는 알릴 수 없다. [알림 플러그인](08-notifier-plugin.md) 참고.
- 앞으로 쓸 health 이벤트 status 값: blocked, unrecognized, unavailable, recovered, degraded.
- heartbeat는 주기적으로 "살아 있음" 메시지를 보내는 방식인가, 봇 `/status` 명령인가, 외부 uptime 체크인가?

## Answer (2026-09-29, 사용자 확정)

1. **`transient` 알림 임계값**: 연속 실패가 **5바퀴 이상이고 첫 실패 뒤 15분 이상** 지나면 `degraded`를 한 번 알린다. 그 뒤 한 바퀴라도 성공하면 `recovered`를 한 번 알린다.
2. **예약처별 헬스 상태 머신**: 상태는 `ok`, `degraded`, `unavailable`, `stopped(blocked|unrecognized)` 넷이다.
   - 상태가 **바뀔 때만** 알린다.
   - 같은 상태가 이어지면 **24시간마다** 리마인드한다. 예: "고래불 감시 중단 3일째".
   - `stopped`는 자동으로 풀리지 않는다. 재시작하면 "재시작 직후 현황" 알림이 가고, 이것이 복구 알림 역할을 한다.
3. **응답 구조 변경 감지**: 어댑터마다 구조 검증 규칙을 둔다. 고래불 기준은 다음과 같다.
   - 캘린더에 날짜 셀이 기대한 개수만큼 있다.
   - `div.select_room` 컨테이너가 있다.
   - 자리 수가 `describe()` 고정값과 크게 다르지 않다.

   검증에 **연속 2바퀴** 실패하면 `unrecognized`로 판정하고 멈춘다. `blocked`(차단 페이지)는 1회만 나와도 즉시 멈춘다.
4. **dead-man 체크** (선택): 설정의 `deadManPingUrl`에 healthchecks.io 같은 서비스 주소를 넣는다.
   - 한 바퀴가 끝나고 **알림 채널이 정상일 때만** ping을 보낸다. 그래서 프로세스가 죽었거나 알림 채널이 죽으면 ping이 끊긴다.
   - ping에는 URL 요청만 보내고 다른 내용은 담지 않는다.
   - 설정하지 않으면 로그로만 남는다.
   - 서비스에 가입할지는 사용자가 운영할 때 정한다.
5. **heartbeat**
   - **일일 요약** (선택, 기본값은 켬): 매일 정해진 시각(기본 09:00)에 무음으로 한 건 보낸다. 내용은 예약처별 헬스 상태, 전날 바퀴 수와 실패 수, 활성 감시 조건 수, 곧 만료될 감시 조건이다.
   - **`GET /healthz`**: 기본은 localhost에만 바인드한다. 마지막으로 성공한 바퀴의 시각과 상태를 JSON으로 돌려준다. Docker `HEALTHCHECK`에서 이 엔드포인트를 쓴다.
6. **재개 방법**: 프로세스를 재시작한다. 멈출 때 보내는 알림에는 원인과 조치 방법을 적는다. 멈춘 예약처가 있어도 다른 예약처는 계속 돈다. 차단된 경우 자동으로 재시도하지 않는다.
