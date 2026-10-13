# 미리해(`mirihae.com`) 단양 천동 오토캠핑장(`/dytc/camping/V39628874`) 기록 (#84)

2026-10-13 09:24 ~ 09:31 KST(화요일 오전), ADR 0002 원칙으로 한 번 기록했다. UA `overlord-availability-poller/0.1 (ADR0002 one-time recording)`.
`mirihae.com`·`cdn.mirihae.com` 요청 사이는 5초 + 0~3초(앞 요청이 끝난 시각 기준), 대기 폴링은 10초로 정했는데 첫 폴링이 바로 200이라 쓰이지 않았다. 4초보다 짧은 간격은 없었다.
HTTP 요청 21건이다. 로그인·captcha·봇 탐지 호출 없음. 접근 금지 경로 호출 없음. 날짜·구역을 고른 뒤의 호출(`tokenCheck.do`, `initSelectReservation.do`, `nightCheck.do`, `selectItemList.do` 등)은 보내지 않았다.
TLS 검증은 Node 기본 루트 그대로이고 끈 곳이 없다. 리다이렉트는 따라가지 않고 `Location`만 읽었다(`redirect: manual`).

요청 순서(시각은 요청을 보낸 KST):
1. GET `mirihae.com/robots.txt` -> 302 `https://mirihae.com/login.do` (09:24:21, 따라가지 않았다, 저장하지 않았다). 파일이 없으니 금지가 없다고 본다(ADR 0002).
2. GET `mirihae.com/dytc/camping/V39628874` -> 302 `Location: https://cdn.mirihae.com:9443/entering.html?uri=https://mirihae.com/dytc/camping/V39628874` (09:24:55). 쿠키 없음, 본문 없음.
3. GET `cdn.mirihae.com:9443/entering.html?uri=…` -> 200 (09:25:01) -> `entering.html`. 정적 페이지이고 `constants.js`, `entering.js`를 싣는다.
4. GET `cdn.mirihae.com:9443/constants.js`, `entering.js`, `waiting.js` -> 200 (09:25:07 ~ 09:25:22) -> 같은 이름의 파일. 게이트 흐름의 근거다. (`/api/groups`는 `waiting.js`가 구글 추적 ID를 얻는 호출이라 조회에 필요 없어 부르지 않았다.)
5. GET `cdn.mirihae.com/api/entering?uri=<인코딩한 uri>` (헤더 `Content-Type: application/json`, 토큰 없음) -> **401** (09:26:03) -> `api_entering_401.json`.
   `{"timestamp":…,"requestId":null,"path":"GET /api/entering","status":401,"message":"400 BAD_REQUEST \"Required header 'X-Mirihae-Reservation-Token' is not present.\""}`
6. POST `cdn.mirihae.com/api/waiting?uri=…` (본문 없음) -> **200**, `text/plain`, 본문이 대기 토큰(JWT, 315자) (09:26:08) -> `api_waiting_POST_200.txt`(토큰은 가렸다).
7. GET `cdn.mirihae.com/api/waiting?uri=…` (헤더 `X-Mirihae-Waiting-Token`) -> **200** `{"enteringToken":"…","uri":"https://mirihae.com/dytc/camping/V39628874"}` (09:26:14) -> `api_waiting_GET_1_200.json`. 425는 받지 못했다(대기 0).
8. GET `cdn.mirihae.com/api/entering?uri=…` (헤더 `X-Mirihae-Reservation-Token: <enteringToken>`) -> **200** `{"enteringToken":"…","uri":"…"}` (09:26:20) -> `api_entering_200.json`. 받은 토큰 값은 7번의 것과 같았다(새로 발급하지 않는다).
9. GET `mirihae.com/dytc/camping/V39628874?gateToken=<enteringToken>` -> **200**, 114,695자, `text/html;charset=UTF-8`, `Set-Cookie: mirihae=…; Path=/; Secure; HttpOnly; SameSite=Lax` 두 개(이름이 같다) (09:26:28) -> `camping_V39628874.html`.
10. 같은 `gateToken`으로 9번을 한 번 더 -> 200, 같은 114,695자 (09:27:59, 토큰을 받은 지 약 100초 뒤). 저장하지 않았다.
11. POST `mirihae.com/camping/calendar.do` (페이지 `searchForm`을 직렬화한 form 본문, `selectMonth=2026-11`과 `2026-12`, 쿠키·`Referer`·`X-Requested-With`·`Origin` 실음) -> 200 (09:28:05, 09:28:13) -> `calendar.do_V39628874_2026-11.html`, `calendar.do_V39628874_2026-12.html`.
    다음 조각(#85)이 쓸 응답이다. 달력만 바꾸는 호출이고 날짜·구역을 고르는 호출이 아니다. 새 쿠키를 주지 않았다.
12. GET `mirihae.com/camping/js/v2/reservation.js?v=2`, `common.js?v=250806`, `sub.js?v=240313`, `mirihae.com/global/js/common/notice-layers.js?v=20260707-1` -> 200 (09:28:42 ~ 09:29:00) -> 같은 이름의 파일. 페이지가 싣는 스크립트다. 봇 탐지·captcha 표지를 찾으려고 읽었다.
13. GET `mirihae.com/common/getImage.do?atchFileId=…` 두 건 -> 200 (09:29:19, 09:29:26). 천동 화면의 안내 팝업 이미지(운영 안내)다. 저장하지 않았다. 내용은 아래 "오픈 규칙".
14. 9번과 같은 `gateToken`을 만료 20초 뒤에 한 번 더 -> **302** `Location: https://cdn.mirihae.com:9443/entering.html?uri=https://mirihae.com/dytc/camping/V39628874` (09:31:33) -> `camping_V39628874_expired_gateToken_302.txt`. 토큰을 바꾸거나 만들지 않았다.

값을 가린 곳: 대기 토큰과 입장 토큰(`<MASKED>`), 예약 화면의 `<input name="tocken">` 값의 UUID 부분(`20261013092627-<MASKED>`, 화면을 열 때마다 바뀌는 값이다), 쿠키 `mirihae` 값(저장하지 않았다).
`camping_V39628874.html` 77째 줄의 UUID는 챗봇 위젯(`cloudturing`) 식별자이지 토큰이 아니라 그대로 둔다.
`api_entering_200.json`·`api_waiting_GET_1_200.json`의 `enteringToken`은 `<MASKED>`다. 테스트의 가짜 서버가 이 자리를 시험용 토큰으로 바꿔 돌려준다.
`api_waiting_POST_200.txt`는 `<MASKED>` 한 단어다(본문이 대기 토큰 전부다).

## 확인한 것

- **`gateToken`(입장 토큰) 수명: 5분(300초)**. 토큰은 HS256 JWT이고 payload는 `{sub: ENTERING_TOKEN, exp, TOKEN_ID, GROUP_ID}`다(`iat` 없음). `exp`는 2026-10-13 09:31:13 KST이고 토큰을 받은 시각은 09:26:14 KST라 차이가 약 300초다.
  서버가 같은 토큰을 받아 줬다(09:27:59, 발급 약 100초 뒤 두 번째 요청 200). 만료 20초 뒤(09:31:33)에는 302로 게이트 화면(`entering.html`)에 되돌려 보냈다. 그래서 `exp`가 실제로 지켜진다.
  `/api/entering`을 다시 불러도 토큰은 새로 발급되지 않고 같은 값이 돌아왔다(수명이 늘지 않는다). 대기 토큰(`WAITING_TOKEN`)의 `exp`는 발급 시각(09:26:08)에서 정확히 1시간 뒤(10:26:07)였다.
  `gateToken` 재사용(#85)은 수명 300초보다 짧게 잡는다. 거절은 302로 게이트에 돌려보내는 것으로 나타난다(200이 아니고 `entering.html`).
- **시설(`uri`)마다 게이트를 따로 지나야 하는지**: 확인하지 못했다. 시설 하나만 기록했다. 토큰의 payload에 시설 값은 없고 `GROUP_ID`(66d17796…)만 있어, 같은 단양관광공사(`dytc`) 시설끼리는 공유할 가능성이 있지만 지어내지 않는다.
- **구역 이름**: `야영장A`, `야영장B`, `야영장C`. 달력 칸의 `dl.schedule color1/2/3`의 `dd`가 순서대로 이 이름이었다(10/14 ~ 10/31, 11/01 ~ 11/14 모든 칸이 세 구역). 자리 목록은 없다. 남은 수 범위는 `야영장A` 10~18, `B` 10~18, `C` 14~29(10/14 ~ 10/31, 11/01 ~ 11/14).
  알림 한 건이 `10-14(수) 1박 · 야영장A · 남은 18`로 나가는 값이 기록에 있다(10/14 A 18, B 18, C 29).
- **달력 모양**: 날짜 칸 `div.td.pignose-calendar-unit-date`(`id="YYYY-MM-DD"`, `onclick="fn_select('…')"`)에 예약 가능한 날이면 `click` 클래스가 붙고(클래스 속성이 두 줄에 걸쳐 있다), 안에 `<dl class="schedule colorN"><dt>남은 수</dt><dd>구역명</dd></dl>`가 구역마다 있다.
  이번 달 화면(10월)은 앞 달의 칸(9/27 ~ 9/30)까지 격자에 그린다. 그 칸과 지난 날짜(10/1 ~ 10/12)와 오늘(10/13, "당일예약 불가" 문구)에는 `click`도 `dl`도 없다. 이번 달 칸은 10/14 ~ 10/31이 모두 `click`이었다.
  달 표시는 `.pignose-calendar-top-month`("10월")와 `.pignose-calendar-top-year`("2026")이고 이전·다음 달 링크는 `fn_select_month('YYYY-MM')`다.
  `calendar.do`가 주는 달력은 `<div class="calendar-in">` 조각이고 11월 화면의 앞뒤 칸(12/1 ~ 12/5)과 12월 화면의 앞 칸(11/29, 11/30)은 `click`·`dl`이 없다. 다른 달의 칸을 읽으면 열린 날도 닫힌 날로 읽히므로 화면의 달에 속한 칸만 읽어야 한다.
- **봇 탐지·captcha**: 예약 화면, 달력, 게이트 JS(`entering.js`, `waiting.js`, `constants.js`), `reservation.js`, `common.js`, `sub.js`, `notice-layers.js` 어디에도 `captcha`·`botmanager`·`crawlingCheck`·`dynapath` 등이 없다(대소문자 무시 검색). 조회 흐름에 장치가 없었다.
  예약 화면 하단 챗봇 위젯(`app.cloudturing.com/widget/code.js`)은 봇 탐지가 아니라 상담 위젯이다.

## 확인하지 못한 것

- **최대 박수**: 확인하지 못했다. 화면 JS에 `최대예약일수는 4박5일입니다.` 경고가 두 군데 있다. 하나는 클라이언트 검사(`nights > 4`)인데 주석 처리돼 있고(`fn_endDateCheck`), 다른 하나는 퇴실일을 고른 뒤 서버 `nightCheck.do`의 응답 `resultCode`가 거짓일 때 띄운다.
  `nightCheck.do`는 날짜를 고른 뒤의 호출이라 부르지 않았다. 그래서 서버가 4박5일(= 4박)을 거절하는지는 보지 못했다. 입점 기관마다 다를 수 있다. 스켈레톤은 최대 박수 1로 시작한다.
- **오픈 규칙(며칠 전 몇 시)**: 확인하지 못했다. 기록 시점(10/13 09:28)에 입실일 10/14 ~ 10/31과 11/01 ~ 11/14가 모두 열려 있었고 11/15 이후는 `click`이 없었다(12월 화면도 전부 없다).
  그러나 이것은 개시 시각이 아니다. 천동 화면의 팝업 이미지가 "천동 캠핑장은 11월 14일부로 동계운영 불가 및 시설정비로 인해 휴장합니다"라고 알린다. 11/14까지가 운영 기간이라 11/15 이후가 닫힌 것은 아직 열리지 않아서가 아니라 휴장이라서이다.
  그래서 "오늘 + 32일까지 열려 있다"는 것만 말할 수 있고 그보다 먼 날짜가 언제 열리는지는 알 수 없다. 화면에 "단양군민 11월 우선예약 접수중" 문구도 있었다(우선예약이 따로 있고 일반 개시일은 쓰여 있지 않다).
  오늘(10/13)은 "당일예약 불가"였다(09:28 시점, 당일 입실 마감 시각은 모른다).
- **붐빌 때의 게이트**: 425 응답을 받지 못했다. 본문 모양(`message`에 `order`·`estimatedWaitSeconds`·`throughput`)은 `waiting.js`를 읽어 안 것이다.
- **기록한 날짜 표현**: 구역별 남은 수 0(품절)의 표현을 보지 못했다. 기록한 모든 구역이 1 이상이었다. 날짜 칸이 `click`을 잃는지 `dt`가 0이 되는지 모른다(어댑터는 둘 다 빈자리 없음으로 읽는다).

## 보내지 않은 것

`tokenCheck.do`, `initSelectReservation.do`, `nightCheck.do`, `selectItemList.do`, `selectItemForm.do`, `reservationForm.do`, `selectAjaxDatePinInfo.do`, `selectReservationCheck.do`, `selectTicketInfo.do`, `totalTicketPrice.do`,
`deSelectTicket.do`, `updateSelctItemticketCntChange.do`(날짜·구역을 고른 뒤의 호출), `paymentForm.do`, `/dytc/camping/reservation/`(예약확인/취소), `/dytc/login.do`·`/login.do`·`/logout.do`·`/mypage.do`(로그인·회원), 결제.
임의 UUID `gateToken`(`entering.js`가 실패 때 쓰는 값)은 쓰지 않았다.

---

# 카탈로그 채우기 기록 (#86, 2026-10-13 09:47 ~ 10:00 KST)

UA `overlord-availability-poller/0.1.0`(실제 `catalog mirihae <시설> --live` 경로, 응답 원문은 같은 transport를 감싸 저장). `mirihae.com` 요청 사이 5초 + 0~3초, 시설마다 게이트를 새로 지나고 시설 사이는 10초 이상 쉬었다. 접근 금지 경로·날짜 선택 뒤 호출 없음. 로그인·captcha·봇 탐지 표지 없음(대소문자 무시 검색).
토큰·쿠키는 가렸다(`gateToken`, 입장 토큰, 예약 화면의 `<input name="tocken">` 값).

## 넣은 시설(같은 게이트·같은 화면 구조, 단양관광공사 `dytc`)

모두 `mirihae.com/dytc/camping/<pageId>` -> 302 `cdn.mirihae.com:9443/entering.html?uri=…` -> 천동과 같은 게이트 -> 같은 달력(`div.td.pignose-calendar-unit-date`, `dl.schedule`의 `dt` 남은 수·`dd` 구역 이름).
구역 이름은 달력 칸의 `dd`이고 `--live`로 `구역 일치`를 확인했다(카탈로그를 채우기 전에 먼저 "새로 생긴 구역"으로 나온 이름을 그대로 옮기고 다시 돌렸다).

| 시설 | 경로 | 구역(`dd`) | 원문 |
|---|---|---|---|
| 다리안 | `/dytc/camping/G24526799` | `데크야영장C`, `데크야영장D`, `원두막` | `camping_G24526799_danyang-darian.html` |
| 소선암 | `/dytc/camping/Q49993865` | `야영장A`, `야영장B`, `야영장C`, `산` | `camping_Q49993865_danyang-soseonam.html` |
| 대강 | `/dytc/camping/Y88593737` | `파쇄석 사이트`, `데크 사이트` | `camping_Y88593737_danyang-daegang.html` |

- 소선암 화면의 범례는 `야영장 A`(공백)지만 달력 칸 `dd`는 `야영장A`다. `산`은 범례에도 그대로 `산`이다(시설현황에 산1~산4).
- 시설마다 게이트를 따로 지나야 하는지: 이 기록은 시설마다 새로 지났으므로 공유 여부를 시험하지 않았다. 여전히 모른다.
- **구역별 남은 수 0의 표현**(#84는 보지 못했다): 다리안 10/24·10/31 `데크야영장C`, 소선암 10/31 `야영장A`·`야영장B`에서 칸은 `click`을 유지한 채 `dt`가 `0`이다. 어댑터는 `dt` 0을 빈자리 없음으로 읽는다. 구역 전부가 안 열린 날은 `click`·`dl`이 없다(다리안 10/17).
- 기록 시점 열린 입실일은 10/14 ~ 10/31(이번 달 화면)이다. 최대 박수·오픈 규칙은 여전히 확인하지 못했다.

## 넣지 않은 시설과 이유

- **여주 대신 오토·웰빙(`epoc`), 금은모래(`gsmc`)**: 같은 게이트·화면이 아니다. `mirihae.com/epoc/camping/<id>`와 `/gsmc/camping/<id>`는 게이트로 보내지 않고 302로 **다른 도메인** `https://yeojuuc.or.kr/camping/epoc/camping/`(gsmc는 `/camping/gsmc/camping/`)으로 보낸다(`camping_epoc_*_302.txt`, `camping_gsmc_*_302.txt`). 그곳(`yeojuuc.or.kr/camping/<tenant>/camping/<pageId>`)은 301로 `https://cdn.mirihae.com/entering.html?uri=https://yeojuuc.or.kr/…`(포트 9443이 아닌 443, 예약 화면 호스트가 `yeojuuc.or.kr`)로 보낸다(`yeojuuc_*_301.txt`). 어댑터는 호스트를 `mirihae.com` 하나로 두고 `uri`가 그 호스트의 예약 화면일 때만 게이트를 지나므로 이 시설은 지원하지 못한다. 예약 화면·`calendar.do`가 `yeojuuc.or.kr`에서 나가므로 호스트별 허용·접근 금지 경로·화면 구조 확인이 새로 필요하다. 이 기록은 그 화면을 열지 않았다.
- **포천 비둘기낭**: 운영 주체는 포천시시설관리공단(공공)이고 공식 안내(`camp.pcfac.or.kr`의 `header.html`)의 예약 링크는 `https://mirihae.com/pccamp/campsite`다. 같은 게이트(9443)를 지나 `/pccamp/campsite/C27562955`가 열린다(`campsite_pccamp_302.txt`). 그러나 화면이 다르다: 달력 칸 `div.td.pignose-calendar-unit-date`가 없다(`campsite_C27562955_pccamp.html`). 경로 접두어도 `/camping/`이 아니라 `/campsite/`이고(`/campsite/calendar.do`, `/campsite/cal.do`, `/campsite/preOpenCheck.do`, `/campsite/selectAjaxDatePinInfo.do`) 달력은 모달로 따로 불러온다. 같은 구조가 아니라 넣지 않았다.
- **여주 강천섬**: 공식 안내(경기도 `gg.go.kr` 기사의 바로가기)가 `https://camp.yjcf.or.kr/`이고 예약 링크는 `https://camp.yjcf.or.kr/gangcheon/camping`이다. 미리해 경로지만 여주와 같은 **자체 도메인**(`camp.yjcf.or.kr`)이라 위 이유와 같다. 화면은 열지 않았다.
- **충주 목계솔밭, 이천 농업테마공원, 성남 율동공원**: 시설 공식 안내에서 예약 링크를 확인하지 못했다(검색에서 공식 안내를 찾지 못했고 추정한 주소는 열리지 않았다). 성남 율동공원은 보도로는 추첨제다. 지어내지 않고 넣지 않았다.
