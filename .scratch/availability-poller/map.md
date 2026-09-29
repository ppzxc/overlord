# Map: 예약 가능 자리 폴러

Status: **complete** (2026-09-29). 모든 티켓을 해결했다. spec: [spec.md](spec.md) (ready-for-agent).

Label: wayfinder:map

## Destination

바로 구현 티켓으로 쪼갤 수 있는 **폴러 spec**. 여러 예약처에 공통으로 쓰는 감시 조건 규격, 예약처 어댑터 구조, 알림 플러그인, 폴링 정책, 실행 환경이 모두 정해져 있어야 한다. 첫 구현 대상은 영덕 고래불 국민야영장(stay.yd.go.kr)이다. 이 spec을 `/to-spec`, `/to-tickets`에 넘기면 끝난다.

## Notes

- 용어는 `CONTEXT.md`를 따른다: 예약처 / 시설 / 구역 / 자리 / 감시 조건 / 빈자리. 맨 단어 "사이트"는 쓰지 않는다.
- grilling 티켓을 풀 때는 `grilling`과 `domain-modeling` skill을 함께 호출한다.
- 이 지도는 계획만 한다. 구현은 spec을 넘긴 다음에 한다.
- 사람이 정상적으로 쓰는 흐름만 자동화한다. 대기열(NetFunnel), captcha, 봇 탐지는 우회하지 않는다. 고래불 robots.txt가 막는 `/bbs/` 경로는 호출하지 않는다.
- **User-Agent**: 도구 이름을 밝히는 정직한 값을 쓴다. 브라우저 UA로 위장하지 않는다. 헤더에 개인정보를 넣지 않는다.
- 사용자 규모: 본인과 지인 몇 명. 계정이나 웹 UI는 두지 않는다.
- 고래불 사이트를 처음 조사한 결과는 [research/goraebul-recon.md](research/goraebul-recon.md)에 있다.

### 차팅 중에 정한 것 (별도 티켓 없음)

- 감시 조건 = 시설 + 자리 필터(구역/번호) + 날짜 범위 + 최소 연박 수 N. N의 기본값은 1이다.
- 예약처 원문에서 "시설"이라 부르는 DKA, CAA 같은 단위는 **구역**이라 한다. 구역 코드는 예약처가 쓰는 값을 그대로 쓰고, 유형은 구역의 속성으로 둔다.
- 알림: 채널을 플러그인으로 붙이는 구조로 하고, 첫 구현은 Telegram이다.
- 실행 환경: 계속 떠 있는 프로세스 하나를 Docker로 배포한다. 운영 장소는 「운영 환경 확정」에서 정했다.
- 중복 알림: **새로 생긴** 빈자리만 알린다. 상태는 메모리에만 두고 영속 저장소는 쓰지 않는다. 재시작 직후 첫 폴링 결과는 "재시작 직후 현황"이라고 표시해서 한 번 알린다.
- 알림 내용: 시설, 구역, 자리 번호, 숙박 구간, 걸린 감시 조건, 예약 페이지 딥링크. 한 번 폴링한 결과는 알림 한 건으로 묶는다.
- 감시 조건은 설정 파일로 관리한다.
- **기본 폴링 간격은 시설 하나당 2분 30초(150초)로 운영해 본다** (2026-09-29, 사용자 결정). 조사가 권한 60초와 국내 사례의 5분 사이 중간값이다. 지터와 백오프 같은 세부는 「폴링 스케줄 정책」에서 정한다.
- 영덕군 전산팀에는 문의하지 않는다 (사용자 결정). 그러니 정직한 UA를 쓰고, 차단을 감지하면 멈추는 원칙을 더 엄격하게 지킨다.
- 헬스 알림: 연속으로 실패하거나 응답 구조가 달라지면 "감시 불능" 알림을 보낸다. 상태를 확인할 heartbeat 수단도 둔다.

## Decisions so far

<!-- 닫힌 티켓마다 한 줄: [제목](링크): 요지 -->

- [운영 환경 확정](issues/10-deployment-environment.md): 처음에는 WSL/개인 PC의 Docker(국내 가정용 IP)에서 운영하고, 옮길지는 운영해 보고 정한다. Node slim multi-arch 이미지(브라우저 없음)에 compose, `restart: unless-stopped`, HEALTHCHECK를 쓴다. healthz는 루프가 살아 있는지만 보고 watchdog이 스스로 종료시킨다. 로그는 pino JSON으로 stdout에 쓰고, 시간대는 KST로 고정한다.
- [감시 불능 판정과 heartbeat](issues/09-health-monitoring.md): 예약처별 헬스 상태 머신을 두고, 상태가 바뀔 때만 알리며 같은 상태면 24시간마다 리마인드한다. transient는 5바퀴와 15분이 지나면 degraded로 본다. 구조 검증에 연속 2회 실패하면 멈추고, blocked는 즉시 멈춘다. 선택 기능으로 dead-man ping(채널이 정상일 때만)을 둔다. 일일 무음 요약과 `/healthz`를 둔다. 재개는 재시작으로 한다.
- [알림 플러그인 인터페이스와 Telegram 메시지](issues/08-notifier-plugin.md): 코어는 구조화된 이벤트(openings/health/watchExpired/heartbeat)를 넘기고 렌더링은 플러그인이 한다. 알림은 대상별로 한 바퀴에 한 건이다. Telegram은 HTML에 (구역, 날짜)별 딥링크 버튼을 붙인다. 봇은 하나이고 chatId는 대상마다 둔다. quietHours에는 무음으로 보낸다. "알렸음"은 전송에 성공했을 때만 기록해서 자연스럽게 재전송되게 한다. 소멸 알림은 없다.
- [폴링 스케줄 정책](issues/07-polling-schedule-policy.md): 바퀴 단위로 몰아서 조회한다. 고래불은 캘린더 선필터(`queryAvailabilityBatch`)로 평소 1~2회 요청이면 된다. 바퀴가 끝난 뒤 150초 ±20%를 쉬고 하한은 60초다. transient는 두 배씩 백오프(상한 30분)하고 blocked는 정지한다. quietHours는 선택이고, 당일 마감 뒤에는 제외한다.
- [감시 조건 설정 파일 스키마](issues/06-watch-config-schema.md): YAML에 zod와 `describe()` 대조 검증을 두고, 오류가 있으면 시작하지 않는다. 입실일 범위, 요일 필터, 최소 N박, 사람이 읽는 자리 번호를 쓰고, 알림 대상은 이름으로 고른다. 비밀값은 환경 변수로 받는다. 설정 변경은 재시작으로 반영한다. 구역과 자리 목록은 `overlord catalog` CLI로 보여 준다.
- [예약처 어댑터 인터페이스](issues/05-provider-adapter-interface.md): 어댑터는 조회 단위 `(시설, 구역, 입실일, 박수)`로 N박 연속 빈 자리만 돌려주고, 매칭과 중복 판정은 코어가 한다. `describe()`로 구역, 최대 박수, 오픈 규칙, 딥링크를 알린다. 실패는 transient / blocked / unrecognized / unavailable 넷이고, blocked는 즉시 멈춘다. 요청은 `ctx.http`로만 보낸다(정직한 UA는 고정). 패키지는 하나이고 어댑터는 dynamic import한다.
- [언어·스택 결정](issues/04-language-stack.md): TypeScript/Node, 내장 `fetch`와 `cheerio`, 직접 만든 스케줄 루프를 쓴다. 크롤링 프레임워크는 쓰지 않는다. Playwright는 필요한 어댑터 안에서만 쓰고, 첫 이미지에는 브라우저를 넣지 않는다.
- [크롤링 프레임워크 표준 조사](issues/11-crawling-framework-survey.md): Scrapy와 Crawlee는 링크를 따라가는 크롤러용이라 상주 폴러에는 맞지 않는다. Crawlee는 브라우저 헤더 생성, TLS 모방, 세션 로테이션이 기본이라 윤리 원칙과 충돌한다. `fetch` + `cheerio` + 직접 만든 루프를 권장한다.
- [고래불 예약처 세부 동작 조사](issues/03-goraebul-adapter-details.md): 감시 조건 하나는 `zoneAreaAjax.htm?res_Day&room_Code&site_date(=박수)` GET 한 번으로 평가된다. 빈 자리는 `class="num"`이고 `zone_area_select` onclick이 붙어 있다. 날짜 D는 D−30일 10시에 열린다. 딥링크는 step01 URL로 한다.
- [폴링 간격과 매너·법적 한계 조사](issues/02-polling-etiquette.md): 시설 하나당 60초에 지터 ±25%를 권장한다. `max-age` 헤더는 효과가 없다. 고래불은 브라우저가 아닌 User-Agent를 200 응답의 차단 페이지로 막는다. 우회하지 말고, 본문을 보고 차단을 감지하면 폴링을 멈춘다. 실제로 돌리기 전에 영덕군 전산팀에 문의하는 것을 권장한다. (이후 사용자 결정: 운영 간격은 150초로 하고, 전산팀에는 문의하지 않는다. Notes 참고)
- [브라우저 자동화·스크래핑 표준 조사](issues/01-browser-automation-standards.md): 고래불은 HTTP GET과 HTML 파서면 충분하고 브라우저는 필요 없다. 숲나들e는 세션과 CSRF를 HTTP로 처리하고, 로그인이 필요할 때만 Playwright를 쓴다. 추천 스택은 TS/Node 또는 Python이다. 숲나들e는 해외·클라우드 IP를 차단한다는 보고가 있다.

## Not yet specified

(없음. 남아 있던 항목은 2026-09-29에 Out of scope로 옮겼다.)

## Out of scope

- 자동 예약(예약 매크로). 이번 목적지는 감지와 알림까지다. 매크로는 나중에 별도 지도로 다룬다.
- 대기열, captcha, 봇 탐지 우회.
- 여러 사용자를 받는 서비스, 계정, 웹 UI.
- 영속 저장소. 사용자가 "저장소가 필요 없는 방향"을 택했다.
- **숲나들e(칠곡송정자연휴양림) 어댑터**: 이후 별도 지도에서 다룬다. 고래불 spec에는 필요 없다. 어댑터 확장 지점(`init`/`dispose`, 선택 의존성)은 이미 마련돼 있다. 다음 지도에서는 두 가지부터 조사해야 한다. 로그인 없이 가용 현황을 볼 수 있는가, 그리고 조회에 NetFunnel 키가 필요한가다. 키가 필요하다면 대기열 우회에 해당하는지 판단해야 한다. 또 해외·클라우드 IP가 차단된다는 보고가 있다.
- **예약 오픈 시각(매일 10시) 대응**: 이후 별도 지도에서 다룬다. 새로 열리는 날짜를 두고 경쟁하는 문제라, 예약 매크로 쪽에 더 가깝다.
- **Telegram 봇 명령어로 감시 조건 관리**: 이후 확장으로 미룬다. 이번에는 설정 파일과 재시작 방식으로 충분하다.
