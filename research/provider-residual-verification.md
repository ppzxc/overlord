# 새 접근 원칙 아래에서 후보 예약처의 잔여가 실제로 읽히는가 (2026-10-12)

[#56](https://github.com/ppzxc/overlord/issues/56)을 풀려고 조사했다. 앞선 조사인 [`provider-access-conditions.md`](provider-access-conditions.md)([#52](https://github.com/ppzxc/overlord/issues/52))는 GET만 보냈고 대기열에 들어가지 않았다. 그래서 숲나들e, 국립공원, 미리해는 "대기열 뒤"로, xticket과 울산 세 곳은 "확인 못 함"으로 남았다. 그 뒤 ADR 0002가 정해졌다(이 조사 시점에는 아직 커밋되지 않았다). 내용은 이렇다. 로그아웃한 방문자의 브라우저가 조회 흐름에서 페이지 JS대로 보내는 요청은 보낸다. 대기열 참여(NetFunnel이든 자체 게이트든)와 조회용 POST도 여기에 든다. 이번에는 이 원칙대로 실제 잔여 응답까지 받아 봤다.

앞선 문서가 확인한 사실(robots, 호스트 구성, 캡차가 예약 단계에만 있다는 점 등)은 되풀이하지 않는다. 서울시(`yeyak.seoul.go.kr`, dynapath)와 땡큐캠핑(STCLab botmanager)은 봇 탐지 장치 뒤에 있다. 인터파크와 `gwgs.pubcamping.kr`은 robots가 금지한다. ADR 0002에 따라 이 네 곳에는 요청을 보내지 않았다.

## 핵심 결론

판정은 "잔여 읽힘 / 안 읽힘 / 확인 못 함" 중 하나다. "읽힘"은 로그인 없이 날짜별·사이트별 예약 가능 여부(또는 남은 수)가 담긴 응답을 이번에 실제로 받았다는 뜻이다.

| 예약처 | 판정 | 잔여를 준 요청 | 응답 모양 (필드·표식) |
|---|---|---|---|
| 숲나들e `www.foresttrip.go.kr` | **안 읽힘** (로그인 필요) | 없음. NetFunnel 키를 받아도 월별 현황과 시설 검색 결과가 401과 로그인 화면이다 | 401 본문의 `loginErrorCode = "-5"`("로그인이 필요한 페이지") |
| 국립공원공단 `reservation.knps.or.kr` | **잔여 읽힘** | NetFunnel `landingCamp`와 `reservation2` → `POST /reservation/campsiteList.do` | HTML. 사이트×날짜 칸마다 `<i class="icon-… YYYYMMDD_{N,W,C,R}">` |
| 미리해 `mirihae.com` | **잔여 읽힘** | 자체 게이트 `/api/waiting` → `/api/entering` → `GET /dytc/camping/<pageId>?gateToken=…` | 서버가 그린 달력 HTML. 날짜 칸의 `dl.schedule`에 `dt`=남은 수, `dd`=구역명 |
| xticket `camp.xticket.kr` | **잔여 읽힘** | `POST /Web/Book/GetBookPlayDate.json`, `GetBookProduct010001.json` | JSON `bookPlayDateList[].{play_date, book_remain_count}`, `bookProductList[].{product_code, status_code, select_yn}` |
| `www.huyang.go.kr` 12곳 | **안 읽힘** (도메인 없음. 실제 예약처는 숲나들e) | 없음 | DNS 실패. 12곳 모두 숲나들e 시설 목록에 있다 |
| 울산 울주 `camping.ulju.ulsan.kr` | **잔여 읽힘** | `POST /ujcamping/campsite/get_cal_day_data_list` (JSON 본문) | JSON `list[].{CAMP_ID, NAME, FACILITY_NAME, SDATE, EDATE, ISRESERVABLE}` |
| 울산 중구 `camping.junggu.ulsan.kr` | **잔여 읽힘** (주소 바뀜: `/camping/`. 응답 모양만 확인, 이날 11곳 모두 `CLOSED`라 열린 자리 값은 못 봄) | NetFunnel `main` → `POST /camping/ajaxGetSiteList.do` | JSON `siteList[].{ctId, ctName, ctState, ctIsBookable, ctPrice, lotteryCount}` |
| 울산 북구 → `camping.ubimc.or.kr` | **잔여 읽힘** (도메인 바뀜) | `POST /ajax/reservationCntAjax.do` | HTML 표. 사이트명마다 "예약가능 / 예약종료"와 `subIdx(…)` 버튼 |

요약하면 이렇다. 새 원칙 아래에서 여섯 예약처(국립공원, 미리해, xticket, 울주, 중구, 북구)는 로그인 없이 잔여를 읽을 수 있었다. 단, 중구는 응답 모양만 확인했고 열린 자리 값은 보지 못했다. 숲나들e는 대기열이 아니라 로그인이 막는다. 앞선 조사가 미결로 둔 "401의 원인"은 로그인 요구로 가려졌다. 대기열은 이번 시간대(평일 오후)에 모두 즉시 통과했다(`nwait=0`, `ttl=0`, 미리해는 첫 폴링에서 200).

## 조사 방법과 한계

- **시간과 횟수**: 2026-10-12 14:41:43~14:56:55 KST에 HTTP 요청 57건을 기록했다. 대기열 서버 요청과 JS·robots 요청이 모두 들어 있다. 이 가운데 3건(중구 대기열 첫 시도, `camping.ubimc.or.kr` 첫 두 건)은 TLS 검증 실패로 HTTP 교환 전에 끝났다. 이와 별도로 아래가 더 있었다.
  - `curl -L`이 따라간 서버 리다이렉트 약 5번(xticket 2, 중구 2, 북구청 첫 화면 1 안팎)
  - 인증서 중간 CA를 받으려고 `crt.sectigo.com`에 보낸 GET 1건(예약처가 아닌 인증기관)
  - DNS 조회만 한 경우 6건(`huyang.go.kr` 두 이름, 북구 다섯 이름)
- **UA와 쿠키**: UA는 `overlord-availability-poller/0.1 (research)` 하나다. 쿠키는 예약처마다 따로 쿠키 단지를 썼다. 서버가 준 세션 쿠키와, 페이지 JS가 쓰는 대로 만든 `NetFunnel_ID` 쿠키만 보냈다. 키·쿠키·토큰 값은 이 문서에 옮기지 않았다.
- **대기열**: NetFunnel은 `netfunnel.js`가 만드는 `ts.wseq?opcode=5101…&sid=service_1&aid=<action>&js=yes&<ms>` 형태를 그대로 보냈다. 받은 결과 문자열은 JS처럼 `escape()`로 인코딩해 `NetFunnel_ID` 쿠키(경로 `/`)에 담았다. 페이지가 키를 폼 필드로도 넘기는 곳(숲나들e 검색의 `netfunnel_key`)은 그것도 따랐다. 모든 5101이 첫 응답에서 200이어서 5002 폴링은 필요 없었다. setComplete(5004)는 페이지가 그 시점에 부르는 국립공원에서만 한 번 보냈다. 숲나들e는 키를 받은 뒤 닿는 화면이 로그인 화면이고, 이 화면은 `NetFunnel_Complete`를 부르지 않는다. 그래서 보내지 않았다. 키는 받은 세션 안에서 몇 초 안에 한 번씩만 썼다.
- **차단**: 403, 429, 봇 챌린지, NetFunnel 301/302(Block/IP Block)는 한 번도 받지 않았다.
- **보내지 않은 것**: 로그인, 캡차, 예약·결제·취소·회원 경로는 열지 않았다. 자리를 잡는 호출로 보이는 것도 부르지 않았다. 미리해 `initSelectReservation.do`·`updateSelctItemticketCntChange.do`·`deSelectTicket.do`, 중구 `ajaxSelecteSite.do`, 북구 `preReservationAjax2.do`, 울주 `booking_step1`이 여기에 든다.
- **제약 예외** (정직하게 적는다):
  - 4초 간격의 예외: 기록상 4초보다 짧았던 요청 간격은 하나다. 중구 NetFunnel 5101 직후 `pageCont.do`를 1초 뒤에 보냈다. 페이지 JS가 대기열 통과 콜백에서 곧바로 이동하는 요청이라 그 순서를 따랐다. 나머지 대기열 직후 요청은 기록상 6~12초 간격이었다. 숲나들e NF→화면 11~12초, 국립공원 NF→POST 8초, POST→5004 6초, 미리해 POST→첫 폴링 8초다.
  - 서버 리다이렉트는 `curl -L`로 간격 없이 따라갔다(위 횟수).
  - `camping.ubimc.or.kr`은 robots와 첫 화면을 4초 간격으로 보냈다. 첫 화면 요청은 robots 내용을 읽기 전에 나갔다. 나중에 확인한 robots는 `User-agent: *`에 `Allow: /`였다.
  - TLS: `campwait.junggu.ulsan.kr`와 `camping.ubimc.or.kr`은 서버가 중간 인증서(Sectigo DV R36)를 보내지 않는다. 브라우저는 인증서의 AIA 주소에서 중간 인증서를 받아 검증한다. 이번에도 같은 주소에서 받아 검증에 더했다. 검증을 끄지는(`-k`) 않았다. 실패한 첫 시도는 위 횟수에 들어 있다.
- **참고만 한 자료**: xticket 시설 코드와 울산 주소는 이전 세션이 받아 둔 고캠핑 API 응답(`resveUrl`)에서 읽었다. 이번에 그 API를 다시 부르지는 않았다. 웹 검색 두 번은 예약처에 닿지 않는다. 북구 새 주소는 이 검색이 아니라 북구청 첫 화면의 링크에서 찾았다.
- **한계**:
  - 시설마다 날짜 하나, 상품군 하나만 봤다.
  - 대기열은 붐비지 않는 시간에 봤다. 개시 시각에 줄이 얼마나 긴지는 모른다.
  - "읽힘"은 응답 모양을 본 것이다. 이 값이 실제 화면과 같은지 브라우저로 대조하지는 않았다.

## 1. 숲나들e (`www.foresttrip.go.kr`) — 안 읽힘 (로그인 필요)

- `netfunnel.js`는 STCLab 2.3.7이고 `TS_HOST='nf.foresttrip.go.kr'`, 기본 `service_1`이다. `TS_COOKIE_ID='NetFunnel_ID'`, 쿠키 유지 10분이다(직접).
- 첫 화면의 월별 현황 링크는 `movePageUsingNetFunnel('/rep/or/sssn/monthRsrvtStatus.do?hmpgId=FRIP&menuId=001004', 'action3')`이다. `common.js`에서 이 함수는 `NetFunnel_Action({action_id, service_id:"service_1"})` 성공 뒤 `location.href = url`을 한다(직접).
- `aid=action3`으로 5101을 보내자 곧바로 `200`(`nwait=0`, `ttl=0`)과 키가 왔다. JS처럼 `NetFunnel_ID` 쿠키를 심고 `Referer: /main.do`를 붙여 월별 현황을 GET했다. 결과는 여전히 **401**이었다. 본문의 제목은 "월별현황조회"지만 내용은 로그인 화면이다. 인라인 스크립트에 `var loginErrorCode = "-5";`가 있고, 같은 스크립트 주석이 `-5`를 "로그인이 필요한 페이지"로 설명한다(직접).
- 시설 검색도 같다. 첫 화면 `srch_frm`은 `NetFunnel_Action({action_id:"action2"})` 성공 콜백에서 `netfunnel_key` 필드에 `ret.data.key`를 넣는다. 그다음 `GET /rep/or/sssn/fcfsRsrvtPssblGoodsDetls.do`로 제출한다(지역 검색은 `action1`과 `fcfsRsrvtRcrfrDtlDetls.do`). `action2` 키로 유명산(`srchInsttId=0101`), 2026-10-20~21을 이 폼 그대로 보냈다. 결과는 **401**과 `loginErrorCode = "-5"`였다(직접).
- **401의 원인**: 키와 Referer를 갖춰도 같은 401이고, 본문이 로그인 요구 코드를 준다. 200을 준 `main.do`에는 `loginErrorCode` 값이 없고, 401을 준 두 화면(크기 약 105.4KB로 거의 같다)에만 `-5`가 있다. 그래서 키 부재는 원인에서 빠지고, 로그인 요구가 가장 직접적인 설명이다. 남는 틈도 있다. 실제 브라우저는 `main.do`를 열 때 `/com/crawlingCheck.do`(아래)를 먼저 POST하는데, 이번에는 이것을 보내지 않았다. 그래서 이 호출의 결과가 세션 상태에 영향을 주는지는 가리지 못했다. 어느 쪽이든 로그인이나 봇 판별 장치 뒤에 있어 ADR 0002의 대상이 아니라는 판정은 같다. 앞선 조사의 "200, 로그인 리다이렉트 없음" 기록과는 다르다. 지금은 비회원 조회를 막아 둔 것으로 보인다.
- 로그인 없이 열리는 조회 AJAX도 있다. 첫 화면에서 휴양림을 고르면 `GET /rep/or/selectFcFsRcfrsFcltInfo.do?insttId=…`가 200 JSON을 준다. 키는 `rcfrsFcltInfo[].{insttId, mxmmStngDayCnt}`, `hldtList[]`(공휴일), `useDtList[].schdlDt`(달력에서 고를 수 있는 날짜)다. 잔여 수나 시설별 상태는 없다(직접).
- 그 밖에 화면마다 `/com/crawlingCheck.do`가 `navigator.plugins` 목록을 POST한다. 응답이 거짓이면 `/com/error.do`로 보낸다(직접, JS 읽기). 이번에는 이 호출을 보내지 않았다. 브라우저가 아닌 클라이언트를 가려내는 장치로 보이며, 어댑터를 만든다면 ADR 0002의 "봇 탐지 장치" 조항에 걸릴 수 있다.

## 2. 국립공원공단 (`reservation.knps.or.kr`) — 잔여 읽힘

- `netfunnel.js`는 2.2.19이고 `TS_HOST='netfunnel.knps.or.kr'`, 기본 `action_id='reservation2'`다(직접).
- 흐름은 다음과 같다(모두 직접).
  1. `GET /reservation/searchSimpleCampReservation.do` → 200
  2. 페이지 `load`에서 `NetFunnel_Action({action_id:'landingCamp'})` → 5101 `200`
  3. 야영장을 고르면 `campsite.js`의 `goCampProductDetail(pname, name, id, prodId)`가 `NetFunnel_Action({action_id:'reservation2'})`를 부른다 → 5101 `200`
  4. 콜백 안에서 `POST /reservation/campsiteList.do`(`dept_id`, `dept_name`, `parent_dept_name`, `prd_ctg_id`, `isGreenpoint`)
  5. 성공하면 `NetFunnel_Complete()` → 5004 `200`
- 키는 폼 필드가 아니라 `NetFunnel_ID` 쿠키로만 간다. 시험한 곳은 계룡산 동학사(`dept_id=B161001`)다. 인자는 페이지에 박힌 `goCampProductDetail('계룡산','동학사','B161001', '')`에서 가져왔다.
- 응답은 HTML 약 3.2MB다. 로그인 문구가 없다. 내용은 다음과 같다.
  - 머리 표 "전체 영지수 / 예약가능 시설수 / 대기가능 시설수"(날짜별 칸 `id="RCCnt<MMDD>"`, 서버는 0으로 내보내고 JS가 채우는 것으로 보인다)
  - 사이트×날짜 칸마다 `<i title="<사이트> : YYYY-MM-DD" class="<상태> YYYYMMDD_<코드>" data-eco-ter-yn data-brfe-ter-yn data-pet-rsvt-psb-yn …>`
- 상태 범례는 화면에 있다(직접):

  | class | 접미 | 범례 |
  |---|---|---|
  | `icon-reservation` | `_N` | 예약가능 |
  | `icon-waiting` | `_W` | 대기가능 |
  | `icon-none-reservation` | `_C` | 예약만료 |
  | `icon-end` | `_R` | 예약불가 |

  이번 응답은 사이트 17곳 × 약 80일(10/13~12/31)이었다. 개수는 `_N` 565, `_C` 511, `_R` 265, `_W` 19였다.
- **추첨제와 선착순**: `GET /reservation/selectCampLottery.do`(로그인 없이 200)의 안내문을 정리하면 이렇다(직접).
  - 추첨은 회차 단위다. 6차의 대상 기간은 2026-11-01~12-31이었다. 신청은 10-01 10:00~10-06 10:00, 추첨·발표는 10-06, 결제는 10-07 22:00까지였다.
  - "추첨제 미 신청 건, 본인 취소 건, 시간 내 미 결제로 인하여 자동 취소 건 등으로 인한 빈자리는 … **선착순 방식**으로 접수"한다. 빈자리 접수일은 야영장 2026-10-08 10:00이다.
  - 같은 화면의 "추첨제 대상 (야영장) 0 개소 / 0영지"는 동절기 미운영 공지와 함께 나온다. 이번 회차에는 야영장 추첨 대상이 없는 것으로 읽힌다.
  - 정리하면 추첨 회차가 끝나 빈자리 접수가 열린 뒤에 위 달력이 선착순 잔여를 보여 준다. 추첨 신청 기간 중의 달력 상태는 이번에 보지 못했다.
- 캡차와 로그인은 앞선 조사대로 예약 확정 단계(`/reservation/auth.do`, `registerCampReservation.do`)에만 있다. 이번에 부르지 않았다.

## 3. 미리해 (`mirihae.com`) — 잔여 읽힘

- 게이트 흐름은 정적 JS 그대로다. `cdn.mirihae.com:9443`의 `entering.js`, `waiting.js`, `constants.js`이고, API 도메인은 `https://cdn.mirihae.com`이다(직접).
  1. `GET mirihae.com/dytc/camping` → 302 → `cdn.mirihae.com:9443/entering.html?uri=…/dytc/camping/V39628874`
  2. `entering.js`: `GET /api/entering?uri=…`에 쿠키 `X-Mirihae-Reservation-Token`이 있으면 같은 이름의 헤더로 보낸다. 새 방문자는 토큰이 없어 **401**이 온다(`message`: "Required header 'X-Mirihae-Reservation-Token' is not present."). JS는 이때 `waiting.html`로 보낸다.
  3. `waiting.js`: 대기 토큰이 없으면 `POST /api/waiting?uri=…` → 200, 본문이 대기 토큰(JWT 모양)이다. 이 토큰을 `sessionStorage`에 두고 다시 불러 `GET /api/waiting`(헤더 `X-Mirihae-Waiting-Token`)을 10초마다 보낸다. 425는 대기 중이고, 본문 `message`에 `order`·`estimatedWaitSeconds`·`throughput`가 온다. 200이면 `{enteringToken, uri}`가 온다.
  4. 그 토큰을 쿠키에 넣고 다시 `/api/entering` → 200 `{enteringToken, uri}` → 원래 주소에 `gateToken`을 붙여 이동한다.
- 이번에는 첫 폴링이 바로 **200**이었다(425 없음). 이어서 `/api/entering` 200, `GET /dytc/camping/V39628874?gateToken=…` **200**(단양 천동 오토캠핑장 예약 화면), 로그인 없음.
- **"평소에도 줄을 서는가"의 답**: 게이트는 항상 거친다. 새 방문자는 반드시 401 → 대기 토큰 발급 → 폴링을 지난다. 다만 평소에는 첫 폴링에서 곧바로 입장이 허락돼 실제로 기다리지는 않았다. 403은 "사전 대기"(예약 개시 1시간 전부터 막는 경우, JS 주석)다.
- 잔여는 첫 화면 HTML에 이미 있다. 이번 달 달력은 서버가 그리고, 날짜 칸 `div.td.pignose-calendar-unit-date`에 예약 가능한 날이면 `click` 클래스가 붙는다. 그 안에 구역마다 `<dl class="schedule colorN"><dt>남은 수</dt><dd>구역명</dd></dl>`가 있다. 예를 들어 10/13 칸은 `야영장A 18`, `야영장B 17`, …이었다. 다른 달은 `POST /camping/calendar.do`(`searchForm` 직렬화, `selectMonth=YYYY-MM`)로 바꾼다(JS 읽기, 이번에는 부르지 않았다).
- 주의할 점:
  - `entering.js`는 응답이 200/401/403/404가 아니면 `uuid.v4()`를 `gateToken`으로 붙여 이동한다(실패 시 열림). 이 값을 쓰는 것은 키 위조이므로 쓰지 않았다.
  - 날짜를 고르면 `tokenCheck.do`, `initSelectReservation.do`가 불린다. 구역을 고르면 "선택된 자리는 20분 이내에…"라는 확인과 함께 좌석을 잡는 호출이 간다. 조회 어댑터는 첫 화면(과 `calendar.do`)에서 멈춰야 한다.

## 4. xticket (`camp.xticket.kr`) — 잔여 읽힘

- 강동그린웨이 가족캠핑장의 `shopEncode`로 `GET /web/main?shopEncode=…`를 보냈다. 쿠키 단지와 `-L`로 `/Web/Reservation?shop_encode=…` → `/web/main…`의 302 두 번을 따라가 200을 받았다(직접). 시설은 세션이 정한다. 이후 POST에는 시설 코드가 없다.
- `/resources/accommodation/js/main.js?ver=20260518`(직접)를 읽은 결과는 이렇다.
  - 달을 정하면 `POST /Web/Book/GetBookPlayDate.json {play_month: YYYYMM}`를 보내고, 다음 달도 이어서 한 번 더 보낸다.
  - 날짜를 정하면 `GetBookProductGroup.json {start_date, end_date}`를 보낸다.
  - 상품군과 박수를 정하면 `GetBookProduct010001.json {product_group_code, start_date, end_date, book_days, two_stay_days}`를 보낸다.
  - 예약 확정은 `Book010001.json`(캡차 포함)이며 부르지 않았다.
- 응답(모두 로그인 없이 200 JSON)은 다음과 같다.
  - `GetBookPlayDate.json (202610)` → `data.bookPlayDateList[]` 19개. 키는 `play_date`, `book_remain_count`, `advance_yn`이다. 예를 들어 10/13은 42, 10/14는 32, 10/15는 17이다. **날짜별 남은 수가 그대로 나온다.**
  - `GetBookProductGroup.json` → `data.bookProductGroupList[]`. 키는 `product_group_code`, `product_group_name`, `product_fee` 등이다. 이 시설은 가족캠핑장, 오토캠핑장, 매화나무캠핑장 3개다.
  - `GetBookProduct010001.json (0001, 10/14, 1박)` → `data.bookProductList[]` 39개. 키는 `product_code`, `product_name`, `status_code`, `select_yn`, 좌표, 요금이다.
  - 코드의 뜻은 `main.js`의 `getProductAlt`·`getProductClass`·`getProductImageUrl`에 있다(직접). `status_code=="0" && select_yn=="1"`이면 "선택가능"이고, `status_code=="2"`면 "수리중"이며, 나머지는 "예약완료"다. `status_code=="4" && select_yn=="1"`이면 대기 그림으로 그린다.
  - 이번 응답의 `(status_code, select_yn)`은 `(0,1)` 16개, `(0,0)` 22개, `(3,1)` 1개였다. **사이트 단위로 선택 가능한 16곳이 바로 나온다.**
- `two_stay_days`는 `shopInfo`에서 오는 값인데 이번에는 0을 보냈다. 연박 규칙이 있는 시설에서는 값이 달라질 수 있다.

## 5. `www.huyang.go.kr` 12곳 — 안 읽힘 (실제 예약처는 숲나들e)

- 이 환경에서 `www.huyang.go.kr`과 `huyang.go.kr` 모두 DNS가 풀리지 않는다(`getent hosts` 종료 코드 2). 앞선 조사와 같다.
- 고캠핑 `resveUrl`이 `www.huyang.go.kr/main.action`인 시설은 12곳이다. 남해편백, 덕유산, 검마산, 청옥산, 황정산, 천관산, 청태산, 칠보산, 대관령, 통고산, 운장산, 용대다. 숲나들e 첫 화면의 시설 목록(`fn_goRsvrtTheme(지역, insttId, 이름, …)`)에 **12곳이 모두 있다**. 예를 들어 남해편백은 `0192`, 대관령은 `0111`, 용대는 `0102`다(직접).
- 그러므로 이 12곳은 지금 숲나들e로 예약받는다고 보는 것이 맞다. 고캠핑 주소는 예전 사이트의 흔적이다. 판정은 숲나들e를 따라 "로그인 필요"다.

## 6. 울산 세 곳

### 울주 (`camping.ulju.ulsan.kr`) — 잔여 읽힘

- `GET /ujcamping/campsite/booking` → 200, 로그인 없음(직접). 앞선 조사가 못 찾은 달력 데이터 경로는 인라인 스크립트에 있다. 둘 다 `mscommon.js`의 `getPostData`로 JSON 본문을 POST한다(`Content-Type: application/json`, `X-HTTP-Method-Override: POST`, `X-CSRF-TOKEN`은 페이지에 해당 요소가 없어 빈 값).
  - `POST /ujcamping/campsite/get_cal_month_data {sql_state:"GetData", year_val, month_val(0부터)}` → `{result:"ok", list:[{DAY, D, TDATE, SDATE, BDATE, WEEK, (DTYPE, DSTR)}]}`. 날짜 틀과 공휴일만 있고 잔여는 없다.
  - `POST /ujcamping/campsite/get_cal_day_data_list {sql_state:"GetData", select_date:"YYYY-MM-DD", classes, facility, use_only}` → `{result:"ok", list:[…]}`. 키는 `CAMP_ID`, `NAME`, `FACILITY_ID`, `FACILITY_NAME`, `TITLE`, `ITEM_KIND`, `SDATE`, `EDATE`, `ISRESERVABLE`다. 다른 결과값으로 `booking_ended`(17시 이후·과거)와 `no_list`가 있다.
- 2026-10-14, `classes=C0000001`(페이지 기본 선택), `facility=""`로 보냈다. 88행 가운데 `ISRESERVABLE` Y가 54, N이 34였다. 화면은 Y면 "접수중/신청", N이면 "예약완료/불가"로 그린다(JS 읽기).
- 앞선 조사가 본 대로 NetFunnel 호출은 주석 처리돼 있어 대기열이 없다. "울주군민추첨제", "일반추첨제" 버튼이 따로 있다. 추첨 기간과 선착순 기간이 어떻게 나뉘는지는 이번에 보지 않았다.

### 중구 (`camping.junggu.ulsan.kr`) — 잔여 읽힘 (주소 바뀜)

- 고캠핑 주소 `/05_menu/01.php`는 없어졌다. 지금은 `https://camping.junggu.ulsan.kr/` → `/camping/` → `/camping/index.jsp`(302 두 번)이다. 이 페이지는 `NetFunnel_Action({action_id:"main"})` 뒤 `/camping/index.do`로 보낸다. 대기열 서버는 `campwait.junggu.ulsan.kr`(2.2.19)이다(직접).
- 메뉴(`index.do`)에서 예약하기는 입화산 제2오토 `pageCont.do?menuNo=1010300`, 황방산 `1020300`, 태화연 `1030300`, 별뜨락 휴양림 `2010400`이다. 링크도 NetFunnel `main`을 거친다.
- 예약 화면(입화산 제2오토, 200, 로그인 없이 열림)의 조회 호출은 다음과 같다(직접).
  - `POST /camping/ajaxGetMonthlyMap.do {searchDate, cpId:"iphwa_auto2"}` → `{msg, monthlyMap:{calendarList:[{date, isAbleDate, isExclusive, isOtherMonth, …}], …}}`. 날짜를 고를 수 있는지와 중구민 전용일인지가 나온다.
  - `POST /camping/ajaxGetSiteList.do {searchDate, cpId, csId:"CP_SPEC_000000000031", isExclusive}` → `{csName, cpName, isPeek, isWeekend, currentAppVO, msg, siteList:[…]}`. `siteList[]`의 키는 `ctId`, `ctName`, `ctState`, `txtCtState`, `ctIsBookable`, `ctPrice`, `ctIsIng`, `lotteryCount`, `ctExclusive` 등이다.
- 2026-10-14로 받은 11개 사이트는 모두 `ctState: "CLOSED"`, `ctIsBookable: "N"`, `ctIsIng: "N"`, `lotteryCount: 0`이었다. 월별 응답에서는 이날이 `isAbleDate: true`였다. 따라서 이 응답으로 확인한 것은 **사이트별 상태가 로그인 없이 온다는 것(응답 모양)**까지다. 열린 자리가 어떤 값으로 오는지는 보지 못했다. 화면은 `RESERVED`면 "예약완료", 그 밖의 닫힌 상태는 "예약불가"로 그린다(JS 읽기).
- 같은 응답의 `currentAppVO`에는 접수 규칙이 있다: `appProcess: "C0L0P1"`, `appDateType: "ALWAYS"`, `appBgnDay: 1`~`appEndDay: 7`, `ableDateType: "FIXED"`, `ableEndDate: "2026-10-31"`. `ableEndDate`로 보면 이 구역의 이용 가능 기간이 10월 말에 끝난다. 그래서 `CLOSED`가 동절기 운영 종료와 관련 있을 수 있다(추정).
- 이 화면은 `NetFunnel_Complete`를 부르지 않는다(`index.do`, `pageCont.do` 모두). 그래서 5004는 보내지 않았다.
- 사이트 선택(`ajaxSelecteSite.do`)은 페이지에서 로그인을 먼저 요구한다. `appProcess == 'L0'`일 때 "선착순 예약"으로 다룬다. 알림마당에 "26년 11월 분 일반/중구민 추첨결과 안내"가 있다. 달 단위 추첨(중구민, 일반) 뒤 남은 자리를 선착순(`L0`)으로 받는 구조로 읽힌다(JS 읽기, 공지 제목).

### 북구 (`camping.ubimc.or.kr`) — 잔여 읽힘 (도메인 바뀜)

- `autocamping.bukgu.ulsan.kr`은 여전히 DNS가 없다(`camping.`과 `camp.bukgu.ulsan.kr`도 없다). 북구청 첫 화면(`www.bukgu.ulsan.kr`)의 "북구 캠핑장" 링크가 **`https://camping.ubimc.or.kr/`**다(직접). 이 사이트가 강동오토캠핑장(`main.do?bid=1`)과 당사현대차오션캠프(`bid=2`)를 함께 다룬다.
- robots는 `User-agent: *`에 `Allow: /`다. 구글봇에만 게시판 경로를 막는다(직접).
- 옛 주소의 경로가 그대로 남아 있다. `GET /Pmreservation.do` → 200, 로그인 없이 열린다. 대기열 스크립트는 없다(직접). 달력(fullcalendar)에서 날짜를 누르면 `addTable()`이 `POST /ajax/reservationCntAjax.do {resDate:"YYYY-MM-DD", siteKindCode:"010100"(강동)|"010200"(당사), priceCode}`를 보낸다.
- 응답은 HTML 표다. "시설종류" 필터(일반데크, 필로티, 카라반, 단독형·복층 데크 등)와 사이트명, 예약현황("예약가능" 또는 "예약종료")이 있고, 예약가능 행에만 `subIdx(…)` "예약신청" 버튼이 붙는다. 2026-10-14 강동은 25행 가운데 17행이 예약가능이었다(직접).
- 로그인은 "예약신청" 단계(`subIdx` → "로그인이 필요합니다.")에서만 요구한다.
- 추첨과 선착순이 섞여 있다. 페이지 변수(`ulotStartDay='5'`, `ulotEndDay='7'`, `lotStartDay='12'`, `lotEndDay='14'`, `resEndDay='16'`)와 달력 이벤트 "선착순예약"으로 보아, 매달 북구민 추첨 → 일반 추첨 → 16일부터 선착순으로 읽힌다(JS 읽기, 날짜 해석은 추정).

## 7. 우선순위 티켓에 주는 시사점

- **어댑터 후보 (잔여 읽힘)**:
  - 국립공원: 야영장 수가 많고 NetFunnel 두 단계에 POST 하나다. 동해 어댑터(ADR 0001)의 틀을 거의 그대로 쓸 수 있다. 응답이 3MB HTML이라 파싱 비용이 크다. 한 번에 약 80일 치가 오므로 바퀴당 시설마다 한 번이면 된다.
  - xticket: JSON이고 시설마다 POST 한두 번이면 된다. 대기열과 로그인이 없어 가장 단순하다. 시설마다 `shopEncode`가 필요하고 세션 쿠키로 시설이 정해진다.
  - 미리해: 자체 게이트를 바퀴마다 거쳐야 할 수 있다. `gateToken` 수명은 확인하지 못했다. 잔여는 첫 화면 HTML에 있다.
  - 울산 울주, 중구, 북구: 각자 다른 구현이고 시설 수가 적다. 어댑터 하나가 덮는 범위가 좁다.
- **빠지는 곳**: 숲나들e는 로그인이 필요해 ADR 0002의 대상이 아니다. 휴양림 183곳과 `huyang.go.kr` 12곳이 함께 빠진다. 앞선 조사가 "한 예약처로 가장 많이 덮는 곳"으로 본 곳이라 커버리지 손실이 가장 크다. `crawlingCheck.do` 같은 장치도 있다.
- **지도의 Destination**: "읽을 수 있는 곳이 없어 줄여야 하는가"에 대한 답은 **아니다**. 중앙기관 가운데 국립공원이 읽히고, 공통 업체(xticket, 미리해)와 지자체 몇 곳이 읽힌다. 줄여야 하는 것은 숲나들e(휴양림)를 전제로 한 부분뿐이다. 이 부분은 숲나들e가 비회원 조회를 다시 열지 않는 한 "읽기 전용, 로그인 없이"라는 원칙과 맞지 않는다.
- **이어 볼 질문**:
  1. 국립공원의 개시 시각(빈자리 접수일 10:00 등)에 `reservation2` 대기가 얼마나 긴가. ADR 0001의 "붐비는 시간 피하기"를 적용할 시간대를 정하는 데 필요하다.
  2. 미리해 `gateToken`의 TTL, xticket `status_code` 3의 뜻(JS는 0·2·4만 따로 다룬다).
  3. 중구 `CLOSED`가 이 날짜만의 일인지.
  4. 숲나들e가 비회원 조회를 막은 시점과 사유(공지).
