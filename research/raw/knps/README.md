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
