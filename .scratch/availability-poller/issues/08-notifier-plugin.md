# 알림 플러그인 인터페이스와 Telegram 메시지

Type: grilling
Label: wayfinder:grilling
Status: resolved
Assignee: claude (session 2026-09-29e)
Blocked by:

## Question

알림 채널 플러그인의 인터페이스는 어떤 모양이고, 첫 구현인 Telegram 메시지는 어떻게 생겼는가?

- 플러그인이 받는 입력: 빈자리를 묶은 한 건, 헬스 이벤트, 재시작 직후 현황 표시.
- Telegram: 봇 한 개에 채팅방이나 채널 한 곳인가? 메시지 포맷(텍스트, 인라인 링크 버튼)은?
- quietHours 동안 보내는 무음 알림(Telegram `disable_notification`)을 어떻게 처리할지. [폴링 스케줄 정책](07-polling-schedule-policy.md) 참고.
- 알림 전송이 실패하면 재시도하는가, 버리는가?

## Answer (2026-09-29, 사용자 확정)

1. **입력**: 코어는 구조화된 이벤트를 넘기고, 메시지 렌더링은 플러그인이 맡는다. 공통 문구 헬퍼는 코어가 제공한다.
   ```ts
   type NotificationEvent =
     | { kind: 'openings'; cycleId: string; startupSnapshot: boolean;
         groups: { watch: WatchRef; openings: Opening[] }[] }   // Opening에 딥링크 포함
     | { kind: 'health'; provider: string; status: 'blocked'|'unrecognized'|'unavailable'|'recovered'|'degraded'; detail: string }
     | { kind: 'watchExpired'; watch: WatchRef }
     | { kind: 'heartbeat'; summary: StatusSummary };            // 쓸지는 「감시 불능 판정과 heartbeat」에서 정한다

   interface Notifier {
     readonly type: string;
     send(event: NotificationEvent, opts: { silent: boolean }): Promise<void>;
   }
   ```
2. **묶음 단위**: 알림 대상 하나에 한 바퀴당 한 건이다. 한 건 안에서 감시 조건별로 구역을 나눈다. 예약처가 다르면 메시지도 따로 간다. 4096자를 넘으면 플러그인이 나눠 보낸다.
3. **Telegram 포맷**: `parse_mode: HTML`로 보낸다.
   - 헤더에는 🏕 빈자리 발견과 시설명을 쓴다. 재시작 직후면 🔄 재시작 직후 현황을 쓴다.
   - 감시 조건별로 `날짜(요일) N박 · 구역명 · 자리 번호들`을 적는다.
   - (구역, 입실일)마다 인라인 URL 버튼을 하나씩 붙이고 최대 8개까지 둔다. 넘치는 것은 본문 링크로 넣는다.
4. **봇 구성**: 봇은 하나이고 토큰은 환경 변수 하나로 받는다. 알림 대상마다 `chatId`만 다르다. 1:1 채팅이든 그룹 채팅이든 된다. chatId는 `overlord telegram chats` CLI로 확인한다(최근 업데이트의 chat 목록). 봇은 전송만 하고, 명령어는 map의 Not yet specified에 남겨 둔다.
5. **quietHours**: 이 시간대에는 모든 이벤트를 `silent`로 보낸다. Telegram에서는 `disable_notification: true`다. 플래그는 코어가 정한다.
6. **전송 실패**: 한 번 보낼 때 안에서만 재시도한다. `429`면 `retry_after`를 지키고, 5xx나 네트워크 오류면 최대 3회까지 다시 보낸다. 그래도 실패하면 로그만 남긴다. "알렸음" 상태는 **알림 대상별로** 두고, 전송에 성공했을 때만 기록한다. 그러면 실패한 빈자리는 다음 바퀴에 다시 새 빈자리로 잡혀 재전송된다. 전송이 계속 실패할 때 어떻게 알릴지는 「감시 불능 판정과 heartbeat」로 넘긴다.
7. **빈자리 소멸**: 알리지 않는다. 메시지 수정이나 "마감됨" 알림은 나중에 필요하면 확장한다.
