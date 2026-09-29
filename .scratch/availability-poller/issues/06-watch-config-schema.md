# 감시 조건 설정 파일 스키마

Type: grilling
Label: wayfinder:grilling
Status: resolved
Assignee: claude (session 2026-09-29c)
Blocked by: 05

## Question

(전제: [예약처 어댑터 인터페이스](05-provider-adapter-interface.md)에서 코어가 감시 조건을 조회 단위로 쪼개고, 어댑터의 `describe()` 정보로 설정을 검증하기로 했다.)

감시 조건을 적는 설정 파일의 형식(YAML/JSON 등)과 스키마는 무엇인가?

- 예약처·시설 지정, 자리 필터(구역 코드, 자리 번호 목록이나 범위), 날짜 범위, 최소 연박 수.
- 예약처의 제약(최대 2박, 30일 롤링)을 넘는 감시 조건은 어떻게 검증하고 처리하는가?
- 알림 대상(채널, 수신자)을 감시 조건마다 지정하는가, 전역으로 지정하는가?
- UA에 덧붙일 문구와 예약처별 최소 요청 간격을 설정에 둔다.
- 비밀값(Telegram 토큰)은 어디에 두는가?

## Answer (2026-09-29, 사용자 확정)

1. **형식과 검증**: 설정은 YAML 파일 하나(`overlord.yaml`)로 둔다. 시작할 때 zod로 두 단계 검증을 한다. 먼저 구조를 검사하고, 다음으로 어댑터의 `describe()`와 대조한다. 오류가 있으면 시작하지 않는다. 오류 메시지에는 문제가 된 위치와 **고를 수 있는 값 목록**을 함께 보여 준다.
2. **날짜 범위**: `checkIn: {from, to}`는 **입실일** 범위다. 퇴실일은 이 범위를 넘어가도 된다.
3. **요일 필터**: `weekdays`는 입실일의 요일로 거른다. 생략하면 모든 요일이다.
4. **박수**: `nights`는 최소 박수이고, 조회도 N박으로만 한다. 예약처의 최대 박수를 넘으면 설정 오류다.
5. **예약 창 밖의 날짜**
   - 아직 열리지 않은 날짜는 열릴 때까지 조회를 미룬다.
   - 이미 지난 날짜는 제외한다.
   - 범위 전체가 지난 감시 조건은 **만료**로 처리하고 알림을 한 번 보낸다. 오류로 보지 않는다.
6. **자리 필터**: 사람이 읽는 번호(`A02`)나 범위(`"A10-A15"`)로 적는다. 예약처의 실제 식별자로 바꾸는 일은 어댑터가 한다. `describe()`에는 구역마다 자리 번호 목록이 들어 있다. `sites`를 생략하면 구역 안의 모든 자리가 대상이다.
7. **알림 대상**: `notifiers`에 이름을 붙여 정의하고, 감시 조건에서는 `notify: [이름…]`으로 고른다. 생략하면 `default`로 보낸다.
8. **비밀값**: 환경 변수에 두고 설정에서는 `${VAR}`로 참조한다. 값이 없으면 시작하지 않는다. 설정 파일은 git에 올려도 되게 유지한다.
9. **설정 변경 반영**: 재시작해야 반영된다. 핫 리로드는 하지 않는다. 재시작하면 "재시작 직후 현황" 알림이 한 번 간다.
10. **카탈로그 CLI**: `overlord catalog <provider>`는 `describe()`에 있는 구역(코드, 이름, 유형, 정원)과 구역별 자리 번호를 표로 보여 준다. `--live`를 붙이면 사이트를 한 번 조회해서 고정값과 실제 자리 목록이 다른지 점검한다.

### 스키마 예시

```yaml
userAgentSuffix: ""
providers:
  goraebul:
    minRequestGapSeconds: 5
    pollIntervalSeconds: 150
notifiers:
  default:
    type: telegram
    botToken: ${TELEGRAM_BOT_TOKEN}
    chatId: ${TELEGRAM_CHAT_ID}
watches:
  - name: 10월 주말 숲속야영장
    provider: goraebul
    facility: goraebul          # 예약처에 시설이 하나뿐이면 생략해도 된다
    zones: [DKA, DKB]
    sites: [A01, A02, "A10-A15"] # 생략하면 구역 안의 모든 자리
    checkIn: { from: 2026-10-01, to: 2026-10-31 }
    weekdays: [fri, sat]
    nights: 1
    notify: [default]
```

참고: 고래불은 자리 번호가 사이트 내부 id(`dka_2`)의 숫자와 표시 이름("텐트사이트 A02호")으로 나뉘어 있다. 설정 표기(`A02`)를 어느 쪽에 맞출지는 구현하면서 어댑터가 정한다. 펜션형 구역 코드와 인원이 어떻게 대응하는지는 확인되지 않았다([고래불 세부 조사](../research/goraebul-adapter-details.md)).

## 후속 변경

- [감시 불능 판정과 heartbeat](09-health-monitoring.md)에서 설정 항목 세 가지를 추가했다: `deadManPingUrl`(선택), `dailySummary`(시각, 켜기/끄기), `healthz` 바인드 주소. [폴링 스케줄 정책](07-polling-schedule-policy.md)에서는 `quietHours`를 추가했다.
