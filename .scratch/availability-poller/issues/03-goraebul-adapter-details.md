# 고래불 예약처 세부 동작 조사

Type: research
Label: wayfinder:research
Status: resolved
Blocked by:

## Question

고래불 어댑터를 spec으로 쓸 수 있을 만큼 조회 경로의 정확한 동작을 확인한다. 읽기 전용 GET만 쓰고 `/bbs/`는 호출하지 않는다.

- **월 캘린더 페이지**: 날짜 × 구역별 잔여 수량의 정확한 마크업. 다음 달을 조회하는 방법. 30일 롤링 경계가 어떻게 표시되는지.
- **`zoneAreaAjax.htm`**: 파라미터 `res_Day`, `room_Code`, `site_date`의 의미. `site_date=2`를 주면 "그 날짜부터 2박 연속으로 빈 자리"를 돌려주는가? 선점 상태("예약진행중")는 어떻게 표시되는가?
- **구역별 자리 식별자**: idx, DOM id, 이름 가운데 어느 값이 안정적인가? 구역 목록(CAA, CAB, DKA 등)과 유형·정원 정보. 폐쇄된 자리는 어떻게 표시되는가?
- **딥링크**: 알림에서 특정 날짜와 구역의 예약 화면으로 바로 들어가는 URL 형식.
- **예외 상황**: 당일 예약 마감(18시), 점검이나 휴장 표시, 마크업이 바뀌었을 때 알아챌 수 있는 단서.

결론: 감시 조건 하나를 평가하는 데 필요한 요청 순서와 파싱 규칙, 그리고 예약처 고유 제약(최대 2박 등)을 정리한다.

## Answer

감시 조건 하나는 `GET /pages/zoneAreaAjax.htm?res_Day=D&room_Code=R&site_date=N`을 한 번 보내면 판정할 수 있다. `site_date`는 박수이고(step01 JS의 `res_For` 값, 2박 결과로 확인), 결과는 N박 연속으로 비어 있는 자리만 `class="num "`와 `zone_area_select(...)`로 표시된다. 쿠키, 토큰, NetFunnel은 필요 없다. 입실일 D는 D−30일 10:00에 열리고, 캘린더에서는 `td.not` 칸의 "예약안내" alert로 표시된다. 캘린더의 `(N)`은 1박 기준 빈자리 수와 같다. 딥링크는 step01 URL(`mode=step01&type=R&today=D&col=<요일>`)이고 NetFunnel을 거치지 않는다. 임시점유와 취소대기는 CSS에 `num ing`/`num wait`로 정의되어 있지만 실제 응답에서는 보지 못했다(미검증). 도구 이름을 밝힌 UA(`overlord-availability-poller/0.1 (research)`)로도 차단 없이 응답이 왔다.

자세한 내용: [research/goraebul-adapter-details.md](../research/goraebul-adapter-details.md)
