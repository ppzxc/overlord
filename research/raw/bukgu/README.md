# 울산 북구 강동오토캠핑장(`siteKindCode=010100`) 기록 (#81)

2026-10-12 23:56 ~ 10-13 00:06 KST(월요일 밤~화요일 새벽), ADR 0002 원칙으로 한 번 기록했다. UA `overlord-availability-poller/0.1 (ADR0002 one-time recording)`.
요청마다 앞에서 5초 + 0~3초를 쉬었다(앞 요청이 끝난 시각 기준). 예약처 `camping.ubimc.or.kr` 하나에 HTTP 요청 31건이다.
TLS는 검증을 끄지 않고 Node 기본 루트에 `certs/`의 Sectigo 중간 인증서를 더한 신뢰 목록(undici `connect.ca`, `src/transport.ts`와 같은 방식)으로 받았다. curl `-k`는 쓰지 않았다.
로그인·captcha·봇 탐지 호출 없음. 접근 금지 경로 호출 없음. 쿠키는 서버가 준 `JSESSIONID`를 쓰되(쿠키 없는 비교 요청 제외) 값을 저장하지 않았다. 응답 헤더 파일도 두지 않았다.

요청 순서(시각은 요청이 끝난 KST, `00`시대는 10-13):
1. GET `/robots.txt` -> 200 (23:56:31) -> `robots.txt`. `Googlebot`에만 `/BBS_`, `/camping/BBS_`, `/cop/bbs/`를 막고 `User-agent: *`는 `Allow: /`다.
2. GET `/Pmreservation.do` -> 200, 50,067자 (23:56:39) -> `Pmreservation.do.html`. `JSESSIONID`(Path, Secure, HttpOnly)를 준다. 달력·`addTable()`·`filterChange()`·`subIdx()` JS가 이 안에 있다.
3. POST `/ajax/reservationCntAjax.do` `resDate=2026-10-14&siteKindCode=010100&priceCode=` (23:57:09, 쿠키 실음) -> 200, 9,359자 -> `reservationCntAjax.do_010100_2026-10-14.html`. 25행, 예약가능 18.
   요청은 모두 페이지의 jQuery ajax처럼 `X-Requested-With: XMLHttpRequest`, `Referer: https://camping.ubimc.or.kr/Pmreservation.do`, `Origin`을 실었다(안내 화면 GET은 Referer만 실었다).
4. 같은 밤에 `priceCode`만 바꿔 셋 -> `reservationCntAjax.do_010100_040100_2026-10-14.html`(일반데크 13행, 23:57:27), `_040200_`(필로티 3행, 23:57:34), `_040300_`(카라반 9행, 23:57:40). 선택된 `<option>`이 요청한 값이다.
5. 쿠키 없이 3번과 같은 요청을 두 번(23:57:4x 한 번은 기록 파일 쓰기 오류로 본문을 버렸고 23:57:57에 다시) -> 본문이 3번과 바이트까지 같았다(`cmp`). 이 두 건은 저장하지 않았다.
6. 다른 밤, `priceCode` 빈 값: 10/17(토) 모두 예약종료(23:58:09), 10/31(토) 모두 예약종료(23:58:16, 10/17과 바이트까지 같다), 10/20(화) 22행 예약가능(23:58:22), 10/22(목) 21행(23:58:30)
   -> `reservationCntAjax.do_010100_2026-10-17.html`, `_10-31`, `_10-20`, `_10-22`.
7. 공개 안내 화면 GET(Referer `/Pmreservation.do`) 11건, 모두 200 (23:58:45 ~ 23:59:48): `/Pgcontent010201.do`, `/Pgcontent010301.do`(강동 안내), `/Pgcontent020201.do`, `/Pgcontent020301.do`(당사 안내), `/Pgc030301.do`(사용자준수사항),
   `/Pgrefundpolicy.do`, `/Pgrefundpolicy2.do`(취소/환불규정), `/Pgordinance.do`(운영조례), `/html/front/contents/210820.html`(당사 예약 주의사항 팝업), `/js/common.js`, `/js/nav.js`. 저장하지 않았다. 최대 박수·선착순 시각은 이 화면들에 없었다(조례 제5조 2항: "사용일이 속한 월의 전월부터 예약", 시각은 공지로).
8. GET `/Pgc030201.do`(이용요금) -> 200 (00:00:11). 저장하지 않았다. 요금 단위가 "1개소/1박"이다.
9. GET `/BBS_000List.do`(공지사항 목록) -> 200 (00:00:24). 저장하지 않았다. 시설 필터 `BID`(1 강동오토캠핑장, 2 당사현대오션캠프)가 여기 있다. 이 사이트 어디에도 조회용 `bid`는 없다.
10. POST `/BBS_000Article.do`(공지 읽기, 게시판 목록 화면의 `fn_egov_inqire_notice()`가 보내는 폼) 셋: nttId 3301 `2026년 11월 강동오토캠핑장 추첨 일정 안내`(00:00:39) -> `BBS_000Article_3301.html`,
    nttId 3272(강동 10/3~10/5 이용 제한 안내, 00:00:55, 저장하지 않음), nttId 3271 `2026년 10월 당사현대차오션캠프 추첨 일정 안내`(00:01:04) -> `BBS_000Article_3271.html`.
    3301이 11월분 일정(북구구민 접수 10/5 9시~10/7 18시, 일반 접수 10/12 9시~10/14 18시, 선착순 10/19 10시부터)이고 3271은 10월분 당사 일정(선착순 9/21 10시부터)이다.
11. 추첨 접수 기간의 표(페이지 달력이 누를 수 있는 마지막 날, `d2` = 2026-11-01 00:00:00.072 KST): POST 같은 요청 `resDate=2026-11-01` (00:05:36) -> `reservationCntAjax.do_010100_2026-11-01.html`. 25행이 **모두 예약가능**이다.
    같은 때 일요일 10/18(11행 예약가능, 00:05:53), 10/25(15행, 00:06:00)와 견주려고 받았다 -> `_2026-10-18`, `_2026-10-25`. 11/02 이후는 페이지 달력이 누르지 못하게 하는 날짜라 보내지 않았다.

값을 가린 곳: 없음. 응답 본문에 세션 값·토큰이 없다(`jsessionid`·`csrf`·`token` 검색 결과 없음). `Pmreservation.do.html`의 `<form name="subscription">`은 빈 `resDate`·`idx`만 갖는다.
표는 로그아웃 상태의 공개 화면이라 개인정보가 없다. 공지는 당첨자 목록이 아닌 일정 안내만 저장했다.

봇 탐지: `Pmreservation.do`, `common.js`, `nav.js`, 안내 화면과 조회 응답에 `crawlingCheck`, `dynapath`, `botmanager`, `captcha`가 없다(대소문자 무시 검색).

보내지 않은 것: `/ajax/preReservationAjax2.do`(`subIdx()`가 로그인 안 한 방문자를 `/login.do`로 보낸 뒤에야 부른다), 예약 제출 폼 action `/Pmreservation2.do`, 로그인 `/login.do`와 외부 `https://www.ulsan.go.kr/logins`,
예약확인 `/PmmySubscription.do`, 추첨 신청 `/Pmbukgusubscription.do`·`/Pmsubscription.do`, 결제(`doPay()`의 LGD 폼). `subIdx` 버튼은 누르지 않았다. 당사현대차오션캠프(`siteKindCode=010200`)는 이 기록에서 조회하지 않았다(#82).
