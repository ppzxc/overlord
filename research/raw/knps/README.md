# 국립공원 갓바위(B252001) 기록 (#63)

2026-10-12 17:2x KST(평일 오후, 대기 0), ADR 0002 원칙으로 한 번 기록했다. UA `overlord-availability-poller/0.1 (ADR0002 one-time recording)`,
`reservation.knps.or.kr` 요청 사이 6~8초(앞서 `robots.txt` 404 한 건 포함). 로그인·captcha·봇 탐지 호출 없음. 접근 금지 경로 호출 없음.

요청 순서(응답 시간):
1. GET reservation.knps.or.kr/robots.txt -> 404
2. GET /reservation/searchSimpleCampReservation.do -> 200, 149KB, 0.35s -> `searchSimpleCampReservation.do.html`
3. GET /assets/js/reservation/campsite.js?ver2026002, /assets/js/lib/knps_netfunnel.js, /assets/js/lib/netfunnel.js (페이지가 싣는 스크립트)
4. GET netfunnel.knps.or.kr/ts.wseq opcode=5101 aid=landingCamp -> 200, 0.10s (`5002:200:... nwait=0 ttl=0`)
5. GET netfunnel.knps.or.kr/ts.wseq opcode=5101 aid=reservation2 -> 200, 0.09s
6. POST /reservation/campsiteList.do (dept_id=B252001, isGreenpoint=N, `NetFunnel_ID` 쿠키 = escape(5101 결과 문자열 전체)) -> 200, 1,995,734바이트, 0.31s -> `campsiteList.do_B252001.html.gz`
7. GET netfunnel.knps.or.kr/ts.wseq opcode=5004 aid=reservation2 -> `5004:200:msg="Success"`

값을 가린 곳: `jsessionid`(페이지), 5101 응답의 `key=`(`MASKED`). 쿠키 단지와 Set-Cookie는 저장하지 않았다.
`campsiteList.do_B252001.html.gz`는 원문(약 2MB)을 gzip한 것이다(압축 풀면 원문 그대로, 가릴 값 없음).
테스트용 축소본은 `test/fixtures/knps-gatbawi-campsiteList.htm`(3자리 x 10일, 구조는 원문 그대로).

## 추첨제 화면 selectCampLottery.do (#66)

2026-10-12 KST, ADR 0002 원칙으로 GET 한 건(로그인·대기열 없음, 200, 112,694바이트). UA `overlord-availability-poller/0.1 (ADR0002 one-time recording)`.
`selectCampLottery.do.html`은 원문이고 `jsessionid`만 `MASKED`로 가렸다.
기록 시점의 6차: 추첨 대상 기간 2026.11.01~2026.12.31, 신청 2026.10.01 10:00~10.06 10:00, 빈자리 접수일 2026.10.08(10:00), "추첨제 대상 (야영장) 0 개소 / 0영지"다
(하단 시설 현황 표는 공원 클릭으로 따로 불러오는 동적 표라 비어 있다). 0개소이므로 이 화면대로면 제외할 날짜가 없다.
테스트용 축소본은 `test/fixtures/knps-selectCampLottery.htm`(본문 블록만 발췌)이고 개소 수·날짜가 다른 변형은 테스트에서 문자열 치환으로 만든다.

## 도학(B251001)·주왕산 상의(B071001) 기록과 시설 목록 (#67)

2026-10-12 17:36~17:37 KST(평일 오후), 어댑터 코드(`queryAvailability`)로 같은 흐름(추첨 화면 GET -> 예약 화면 -> `landingCamp` 5101 -> `reservation2` 5101 -> `campsiteList.do` -> 5004)을 시설마다 한 번씩 돌려 응답을 저장했다.
UA 접미 `ADR0002 one-time recording`, 요청 사이 5초+지터. 로그인·captcha·봇 탐지 호출 없음, 접근 금지 경로 호출 없음.
실수로 도학 기록을 한 번 더 시작했다가(추첨 화면과 예약 화면 GET 정도가 나갔을 수 있다) 곧바로 멈췄다. 저장된 도학 파일은 두 번째 시작 전에 끝난 첫 기록이다.
- `campsiteList.do_B251001.html.gz`: 도학 5,391,525바이트(1.7초). 구역 하나(자동차야영장 `0201100`), 자리 `1`~`29`.
- `campsiteList.do_B071001.html.gz`: 상의 10,126,443바이트(0.6초). 구역 셋(자동차야영장 `0201100` A1~A11·B1~B19·E1~E8, 카라반 `0203201` C1(4인)~C10(4인), 특화야영장 `0202101` D1~D6).
- 둘 다 가릴 값(jsessionid, 토큰)이 없어 원문 그대로 gzip했다. 응답 날짜는 10/13~12/31(80일)이다.
- 이어서 `catalog knps gatbawi|dohak|sangui --live`를 프로세스를 나눠 한 번씩 돌려 모두 `일치`였다.
- 테스트용 축소본은 `test/fixtures/knps-sangui-campsiteList.htm`(3구역 x 자리 2개 x 10일, 구역 머리 rowspan만 2로 줄임)이다.
- 화면의 `goCampProductDetail(공원, 야영장, dept_id, prodId)` 호출 48곳은 `searchSimpleCampReservation.do.html`에서 모았다.
