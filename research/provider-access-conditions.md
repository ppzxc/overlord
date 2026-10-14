# 후보 예약처 12곳의 조회 접근 조건 (2026-10-12)

[#52](https://github.com/ppzxc/overlord/issues/52)를 풀려고 조사했다. 지도는 [#49](https://github.com/ppzxc/overlord/issues/49)다. 질문은 "공공 시설 예약 주소 상위 예약처마다, 읽기 전용 공개 조회로 빈자리를 알 수 있는가"이다. 후보 도메인은 [#50](https://github.com/ppzxc/overlord/issues/50) 해소 댓글의 고캠핑 API 집계(공공 411곳)에서 가져왔다. 이미 조사된 것(예약처 유형 분류, 업체 군집)은 [`booking-system-landscape.md`](booking-system-landscape.md)([#51](https://github.com/ppzxc/overlord/issues/51))와 [`nationwide-facility-list-sources.md`](nationwide-facility-list-sources.md)에 있어 되풀이하지 않았다. 여기서는 그 문서들이 "미검증"으로 남긴 부분(달력을 로그인 없이 볼 수 있는가, 국립공원의 `captcha` 필드가 어느 단계의 것인가)을 먼저 봤다.

## 핵심 결론

판정은 "가능 / 대기열 뒤 / 로그인·캡차 필요 / 확인 못 함" 중 하나다. 아래 "근거 수준"에서 **직접**은 이번에 `curl` GET 원문으로 본 것이고, **JS 읽기**는 페이지가 싣는 정적 JS를 읽어 호출 경로를 안 것이다. 어느 곳도 실제 잔여 응답을 받아 보지는 못했다. 대기열 참여, POST, 로그인을 하지 않는다는 제약 때문이다.

| 예약처 | 판정 | 한 줄 근거 |
|---|---|---|
| 숲나들e `www.foresttrip.go.kr` | **대기열 뒤** | 월별 현황 URL을 직접 GET하면 401과 로그인 화면이 온다. 링크는 NetFunnel을 거쳐 이동한다 |
| 국립공원공단 `reservation.knps.or.kr`, `res.knps.or.kr` | **대기열 뒤** | 야영장 화면 로드에 NetFunnel `landingCamp`, 목록 조회에 `reservation2`. 로그인·캡차는 예약 단계에만 있다 |
| 서울시 공공서비스예약 `yeyak.seoul.go.kr` | **확인 못 함** | 달력은 POST AJAX이고 난독화된 봇 차단 스크립트(dynapath)가 감싼다. 상세 화면은 로그인 없이 200이다 |
| 미리해 `mirihae.com` | **대기열 뒤** | 예약 URL이 항상 자체 대기실(`entering.html`)로 302. 통과 여부는 `/api/entering` 호출이 필요해 하지 않았다 |
| 땡큐캠핑 `m.thankqcamping.com` | **확인 못 함** | 화면은 로그인 없이 200이나 잔여는 POST로 가져오고, STCLab 봇 관리 스크립트가 있다 |
| 숲나들e 휴양림 사이트 `www.huyang.go.kr` | **확인 못 함** | 이 환경에서 DNS가 풀리지 않는다 |
| 인터파크 티켓 `tickets.interpark.com` | **확인 못 함** (robots 금지) | `User-agent: *`에 `Disallow: /`. 더 시도하지 않았다 |
| 강원 `gwgs.pubcamping.kr` | **확인 못 함** (robots 금지) | `User-agent: *`에 `Disallow: /`. 더 시도하지 않았다 |
| `camp.xticket.kr` | **확인 못 함** | 화면은 쿠키만 있으면 로그인 없이 200이나 달력은 POST JSON이고 캡차는 예약 단계에 있다 |
| 울산 울주 `camping.ulju.ulsan.kr` | **확인 못 함** | 예약 화면은 로그인 없이 200이고 NetFunnel 호출은 주석 처리돼 있다. 달력 데이터 경로를 못 찾았다 |
| 울산 중구 `camping.junggu.ulsan.kr` | **확인 못 함** | 고캠핑이 준 주소는 404, 이전 조사의 NetFunnel `main` 호출은 이번에 다시 보지 못했다 |
| 울산 북구 `autocamping.bukgu.ulsan.kr` | **확인 못 함** | 이 환경에서 DNS가 풀리지 않는다 |

요약하면 이번 조사로 "로그인 없이 GET만으로 잔여가 나오는 곳"은 하나도 새로 확인되지 않았다. 중앙기관 두 곳(숲나들e, 국립공원)과 미리해는 대기열이 걸려 있고, 나머지 주요 곳은 잔여 조회가 POST라서 이 조사의 제약 안에서는 열어 볼 수 없다. 이 POST가 로그인 없이 응답하는지는 [ADR 0001](../docs/adr/0001-donghae-netfunnel-participation.md)의 기준("브라우저가 보내는 조회용 요청이고 예약 상태를 바꾸지 않는 POST는 허용")으로 따로 판단해야 한다.

## 조사 방법과 한계

- 2026-10-12 13:59~14:20 KST 사이에 읽기 전용 GET을 약 50회 보냈다. 호스트가 달라도 요청 사이를 4초 이상 뒀다. 예외는 리다이렉트를 따라간 요청(아래 "예외")이다.
- UA는 `overlord-availability-poller/0.1 (research)` 하나다. POST, 로그인, 폼 제출, 대기열 참여, 캡차 풀이는 하지 않았다.
- 쿠키는 평소 보내지 않았다. 숲나들e에서 한 번, `camp.xticket.kr`에서 한 번 서버가 준 세션 쿠키를 그대로 되돌려 보냈다(브라우저와 같은 동작이다. 세션 값은 문서에 옮기지 않았다).
- 예외 두 가지를 적는다.
  - `camp.xticket.kr`는 쿠키 없이는 `/web/main`과 `/Web/Reservation` 사이를 오가는 리다이렉트 루프를 돌아, 쿠키 단지(cookie jar)를 쓴 `curl -L`로 한 번 받았다. 이 요청 안의 리다이렉트 2번은 서버가 준 응답을 그대로 따른 것이라 3초 간격 없이 나갔다.
  - `gwgs.pubcamping.kr`는 `robots.txt`와 첫 화면을 같은 명령에서 연달아 보냈다. 첫 화면 요청은 robots 내용을 읽기 전에 나갔고 `/Home/index`로 가는 한 줄짜리 JS를 받았다. 이후 시도는 하지 않았다. 인터파크는 `robots.txt`와 첫 화면(302)을 같은 식으로 받았고 이후 시도는 하지 않았다.
- 403이나 차단 응답은 한 번도 받지 않았다. 숲나들e의 401은 차단이 아니라 로그인 화면이다(아래 1절).
- 이전 조사가 숲나들e 월별 현황 URL을 "200, 로그인 리다이렉트 없음"이라고 적은 것과 이번 결과(401)가 다르다. 같은 URL(`insttId=0103`)이다. 응답이 시점이나 쿠키 상태에 따라 달라질 수 있어서 이 문서는 "지금은 401"로만 적는다.
- 고캠핑 API 원본(`all*.json`)에서 후보 도메인의 `resveUrl` 예시를 뽑아 썼다. 원본과 키는 저장소에 없고 이 문서에도 없다. 미리해 URL 몇 개에 든 `gateToken` 값은 옮기지 않았다.
- 한계: 판정은 첫 화면과 정적 JS에서 읽은 것이다. 실제 잔여 응답을 본 곳이 없어, "대기열 뒤"는 화면 코드가 그렇게 짜여 있다는 뜻이다. 대기열 없이 응답하는 경우가 있는지는 모른다.

## 1. 숲나들e (`www.foresttrip.go.kr`) — 대기열 뒤

- `robots.txt`: 이전 조사가 확인했다(전체 허용, 통합검색 경로만 금지). 이번에는 다시 받지 않았다.
- `GET /main.do`는 200이다(직접). 첫 화면이 `/js/netfunnel.js`를 싣는다.
- 월별 현황 링크는 `onclick="movePageUsingNetFunnel('/rep/or/sssn/monthRsrvtStatus.do?hmpgId=FRIP&menuId=001004', 'action3')"` 형태다. 공통 JS(`/portal/js/common.js`)에서 이 함수는 `NetFunnel_Action({action_id: actionId, service_id: "service_1"}, …)` 뒤에 `location.href = url`을 한다(JS 읽기).
- 그 URL을 NetFunnel 없이 직접 GET하면 **401**이고 본문은 로그인 화면이다(직접, 쿠키 있음과 없음 두 번 모두). 시설 검색 폼도 `NetFunnel_Action({action_id:"action1"|"action2"})` 뒤에 `fcfsRsrvtRcrfrDtlDetls.do`나 `fcfsRsrvtPssblGoodsDetls.do`로 GET 제출한다(JS 읽기).
- 판정 근거: 잔여 화면에 가는 길이 모두 NetFunnel 뒤이고, 키 없이 직접 GET하면 로그인 화면이 온다. 401의 정확한 원인이 NetFunnel 키 부재인지 로그인 요구인지는 대기열에 들어가지 않고는 가릴 수 없다. 사이트 전체가 쓰는 같은 STCLab 제품이다. 동해시에서 해 본 방식(ADR 0001)이 선례이지만 이 조사는 거기까지 가지 않았다.
- 휴양림 183곳을 한 예약처로 덮는 가치는 그대로다. 막히는 것은 "NetFunnel 참여를 ADR 0001처럼 받아들이는가"이다.

## 2. 국립공원공단 (`reservation.knps.or.kr`, `res.knps.or.kr`) — 대기열 뒤

- 두 호스트는 같은 시스템이다. `res.knps.or.kr/`는 200이고 같은 "국립공원공단 예약시스템" 화면이다(직접). 고캠핑 `resveUrl`에는 두 호스트가 섞여 있다.
- `robots.txt`는 404다(직접). 금지 경로가 없다.
- `GET /reservation/searchSimpleCampReservation.do`는 **200이고 로그인 없이 열린다**(직접). 이전 조사가 미검증으로 둔 "`captcha` 필드"의 정체는 다음과 같다.
  - `captcha` 입력은 예약 확정 폼(`registerCampReservation.do` 직전) 안에 있다. 이미지는 `/reserCaptcha.do`다(직접, JS 읽기). **조회 단계에는 캡차가 없다.**
  - 로그인은 예약 시도 때 `/reservation/auth.do`가 401을 주면 로그인 팝업이 뜨는 방식이다(JS 읽기, `campsite.js`). 조회가 아니라 예약 단계다.
- 대기열은 두 곳에 있다. 화면이 로드될 때 `NetFunnel_Action({action_id:'landingCamp'})`가 돈다(직접). 야영장을 고르면 `NetFunnel_Action({action_id:'reservation2'})` 콜백 안에서 **`POST /reservation/campsiteList.do`**(`dept_id` 등)로 잔여 목록을 받는다(JS 읽기, `campsite.js`).
- 그래서 잔여 조회는 GET이 아니라 NetFunnel 뒤의 POST다. 로그인 없이 이 POST가 응답하는지는 이번 조사로 알 수 없다. 개시일에는 "랜딩 시간" 체크도 있다(화면 소스 주석).
- 이전 조사가 뉴스(2차 출처)로만 본 "전면 추첨제"는 이번에도 공식 근거를 못 잡았다. 추첨 화면(`selectCampLottery.do`)이 따로 있다는 것까지가 확인된 사실이다.

## 3. 서울시 공공서비스예약 (`yeyak.seoul.go.kr`) — 확인 못 함

- `robots.txt`는 200이다(직접). 구글봇에는 검색 경로 몇 개를, `*`에는 게시판 경로(`/web/bbs/selectPageListBbs.do`) 하나를 막는다. 아래에서 쓴 경로는 `*` 금지 목록에 없다. 다만 목록 경로(`selectPageListDetailSearchImg.do`)는 구글봇에게는 금지다.
- `GET /web/main.do`와 캠핑장 분류 목록(`/web/search/selectPageListDetailSearchImg.do?code=T500&dCode=T502`)은 200이다(직접). 목록의 시설 id(`S2606…` 형태)를 `selectReservView.do?rsv_svc_id=…`로 GET하면 **로그인 없이 200**이다. 본문에 포천 서울캠핑장의 접수 기간(2026.10.08 14:00~10.16 23:59), 선정 방법(선착순), "이용 예정일 1일 전까지 선착순, 데크는 선착순 배정"이 있다(직접).
- 달력과 잔여는 `POST /web/reservation/selectListReservCalAjax.do`(JSON)로 받는다(직접, 화면 소스). 응답에 날짜별 `RCEPT_POSBL_YN`과 `RESVE_POSBL_CNT`, `REG_TOTAL_CNT/RCRIT_NMPR_CNT`가 있어 잔여 수가 거기 있는 것으로 읽힌다.
- 이 세 AJAX 경로(`selectListReservCalAjax.do`, `selectAllTimeCheckAjax.do`, `selectListReservCalUnitAjax.do`)는 `dynapath`(`/common/js/dynapath/dp.helper.js`, `/dynaPath.jsp`)에 등록돼 있고, 설정에 "비정상 접근으로 파악되어 서비스가 제한되었습니다"라는 차단 안내가 들어 있다. 스크립트는 난독화돼 있다. **봇 탐지 장치로 보이며, 이 장치를 우회하는 일은 하지 않았다.**
- 로그인은 예약 클릭 때 요구한다("예약을 하기 위해서는 로그인이 필요합니다"). 조회에는 쓰이지 않는 것으로 읽힌다(JS 읽기).
- 판정 근거: 로그인·캡차·대기열은 이번에 보지 못했지만, 잔여 응답을 받는 POST가 봇 차단 스크립트 뒤에 있어 GET만으로는 검증할 수 없다. 이 장치를 통과하는 요청이 정상 브라우저가 보내는 것과 같은지가 열린 질문이다.
- 이전 조사가 "달력은 못 봄"으로 남긴 부분을 여기까지 좁혔다. 목록·상세(접수 기간, 선정 방법)는 GET으로 읽히고, 잔여 수만 봇 차단 뒤에 있다.

## 4. 미리해 (`mirihae.com`) — 대기열 뒤

- `robots.txt` 요청은 `/login.do`로 302된다(직접). 선언된 금지가 없다고 볼 수 있으나 파일 자체가 없다.
- `GET https://mirihae.com/dytc/camping/1`은 `/dytc/camping`으로 302, 다시 `GET /dytc/camping`은 `cdn.mirihae.com:9443/entering.html?uri=…/dytc/camping/<ID>`로 302다(직접). 예약 화면에 닿기 전에 **항상** 대기실 게이트로 보낸다.
- `entering.html`은 385바이트짜리 빈 페이지이고 `entering.js`(3,157바이트)가 `GET {domain}/api/entering?uri=…`를 부른다. 응답이 200이면 `enteringToken`을 받아 원래 주소에 `gateToken`으로 붙여 이동하고, 401이면 대기 화면, 403이면 사전 대기 화면, 404면 없음 화면이다(JS 읽기).
- 이 `/api/entering`은 대기열 입장 요청이라 부르지 않았다. 평소에도 200으로 바로 통과시키는지, 아니면 항상 줄을 세우는지는 모른다. 이 점이 이전 조사가 연 질문 (1)의 답이다. "게이트가 항상 앞에 있다"까지가 확인된 사실이고, "항상 줄을 선다"는 확인하지 못했다.
- 고캠핑 `resveUrl`에 든 URL 일부에 `gateToken` 쿼리가 붙어 있다. 게이트를 통과한 URL이 저장된 것이다. 토큰은 만료되며 재사용할 수 없다고 봐야 한다.
- 로그인·캡차는 게이트 뒤라 보지 못했다.

## 5. 땡큐캠핑 (`m.thankqcamping.com`) — 확인 못 함

- `robots.txt`는 200이고 `User-agent: *`에 `Allow: /`다(직접).
- 첫 화면, 시설 상세(`/resv/view.hbb?cseq=1`, 자라섬), 날짜 지정 상세(`&res_dt=20261017&res_edt=20261018`), 시설 목록(`/resv/list.hbb?…&ser_only_able=on`)이 모두 **로그인 없이 200**이다(직접). 상세 화면에는 "비회원 예약하기" 버튼도 있다.
- 잔여 사이트 목록은 화면이 `POST /resv/axResCampSite.hbb`(`campseq`, `res_dt`, `res_edt`, `site_tp`, `only_able_yn`)로 가져와 `#resCampSiteList`에 채운다(직접, JS 읽기). 목록 화면도 시설 카드를 서버 HTML에 싣지 않고 JS가 채운다(카드 수가 0이었다). GET만으로는 잔여를 읽을 수 없다.
- 예약 단계는 다른 호스트(`/resv/axCampResVerUrl.hbb`가 주는 `…/thankQRes.hbb`)로 넘어가며 로그인 팝업이 뜬다("회원로그인후 예약하실 수 있습니다").
- 첫 화면과 상세가 `botmanager.stclab.com`의 브라우저 에이전트를 싣고 `/api/v1/macro`를 부른다(직접). 자동 조회를 가려내는 장치로 보인다(이전 조사의 추정을 같은 방향으로 확인했다. 효과는 검증하지 않았다).
- 판정 근거: 로그인은 조회에 필요 없어 보이지만 잔여는 POST이고 봇 관리가 붙어 있어, 이 조사의 제약 안에서는 잔여 응답을 볼 수 없다. 지자체 시설은 가평 공단 등이고, 고캠핑 목록에서는 민간 시설이 대부분이다.

## 6. 휴양림 사이트 (`www.huyang.go.kr`) — 확인 못 함

- 이 환경에서 `www.huyang.go.kr`와 `huyang.go.kr`의 DNS가 풀리지 않는다(`curl` 오류 6, `getent hosts`도 결과 없음). 같은 환경에서 `foresttrip.go.kr`은 풀린다.
- 고캠핑 `resveUrl`은 `http://www.huyang.go.kr/main.action`처럼 `.action` 확장자의 예전 주소다. 이름으로 보아 숲나들e로 통합되기 전 국립휴양림 사이트의 흔적일 가능성이 있으나 근거는 없다(추정). 열려 있지 않은 도메인을 예약처로 보기는 어렵다. 영향받는 12곳이 실제로는 숲나들e로 예약받는지 확인이 필요하다.

## 7. 인터파크 티켓 (`tickets.interpark.com`) — 확인 못 함 (robots 금지)

- `robots.txt`는 200이다(직접). 구글봇 등 검색 크롤러 몇 곳에는 일부 경로만 막고 `Allow: /`이지만, **`User-agent: *`에는 `Disallow: /`**다.
- 첫 화면은 `nol.interpark.com/ticket`으로 302다(직접). 그 이상 시도하지 않았다. 시설 상세(`/goods/<번호>`)와 잔여 호출은 보지 않았다.
- 판정: 자동 조회를 일반 봇에게 허용하지 않는 곳이라 이 조사에서는 확인 못 함이다. 고캠핑 상위 도메인에서 6곳이다(구리 토평, 연천 재인폭포, 안성맞춤, 소요별앤숲, 진위천 등).

## 8. `camp.xticket.kr` — 확인 못 함

- `robots.txt`는 404다(직접). 금지 경로가 없다.
- `/web/main?shopEncode=<시설 코드>`는 쿠키 없이는 `/Web/Reservation?shop_encode=…`와 사이를 오가는 302 루프이고, 쿠키를 유지하면 200이다(직접). 본문은 시설 하나(강동그린웨이 가족캠핑장)의 예약 화면이다. 로그인 링크는 있으나 화면은 열린다.
- 정적 JS(`/resources/accommodation/js/main.js`)를 읽으면 날짜·상품 조회가 `POST /Web/Book/GetBookPlayDate.json`, `GetBookProductGroup.json`, `GetBookProduct010001.json`이다. 예약 확정은 `Book010001.json`이고, 그 직전에 캡차(`/Web/jcaptcha`)를 요구한다(JS 읽기). NetFunnel 문자열은 없었다.
- 판정 근거: 조회가 POST JSON이라 GET만으로는 볼 수 없다. 캡차는 예약 단계로 보이고 조회에는 없어 보인다. 시설 코드(`shopEncode`)마다 화면이 하나라 시설당 URL이 필요하다.

## 9. `gwgs.pubcamping.kr` — 확인 못 함 (robots 금지)

- `robots.txt`는 200이고 **`User-agent: *`에 `Disallow: /`**다. 구글봇·네이버·다음 검색 로봇만 `/Home*`과 `/@*`를 허용한다(직접).
- 위 "조사 방법"에 적은 대로 첫 화면(`/`, 563바이트, `/Home/index`로 이동하는 JS)만 받았다. 시설 경로(`/@song/index` 등)는 열지 않았다.
- 판정: 일반 봇에게 열어 두지 않은 곳이다. 고캠핑 5곳이다(송지호, 백도, 오호, 명파, 자작도).

## 10. 울산 세 곳

- **울주 `camping.ulju.ulsan.kr`**: `robots.txt`는 200인데 `Yeti`(네이버)에만 `Allow: /`를 선언하고 `*` 규칙은 없다(직접). `/ujcamping/campsite/booking`은 **로그인 없이 200**이다(직접). 화면에 "예약하기(즉시결제)", "울주군민추첨제", "일반추첨제"가 따로 있고, 로그인 링크는 있다. `netfunnel.js`를 싣지만 이 화면의 `NetFunnel_Action` 호출 세 곳은 모두 주석 처리돼 있다(직접). 달력은 JS가 그리고 날짜를 고르면 `/campsite/booking_step1?CAMP_ID=…&SDATE=…&EDATE=…`로 이동한다(JS 읽기). 잔여 수를 가져오는 호출은 이 화면 JS에서 찾지 못했다. 예약 흐름의 다음 단계라 열지 않았다. 판정은 확인 못 함이다.
- **중구 `camping.junggu.ulsan.kr`**: `robots.txt`는 404다. 고캠핑이 준 `http://camping.junggu.ulsan.kr/05_menu/01.php`는 https로 302된 뒤 404다(직접). 이전 조사가 본 NetFunnel `main` 호출과 토스페이먼츠 흔적은 이번에 확인하지 못했다. 시설 주소가 바뀐 것으로 보이나 새 주소를 찾지 못했다. 확인 못 함이다.
- **북구 `autocamping.bukgu.ulsan.kr`**: DNS가 풀리지 않는다(`curl` 오류 6). 고캠핑 주소는 `/Pmreservation.do`다. 확인 못 함이다.

## 11. #52~#54에 주는 시사점

- **이번 조사의 가장 큰 결론은 "공개 GET만으로 잔여를 읽는 곳이 새로 나오지 않았다"는 점이다.** 읽는 길은 크게 세 가지다. (a) NetFunnel 뒤에 두고 링크로 이동시키는 곳(숲나들e, 국립공원, 미리해의 변형). (b) 잔여를 POST JSON으로 받는 곳(국립공원, 서울시, 땡큐캠핑, xticket). (c) robots로 일반 봇을 막은 곳(인터파크, pubcamping). 영덕 어댑터처럼 일반 GET 한 번으로 끝나는 곳은 없었다.
- 동해시 어댑터(ADR 0001)는 (a)와 (b)가 겹친 경우를 이미 풀었다. 같은 틀이 국립공원(NetFunnel `reservation2` 뒤 POST)과 숲나들e에 이어질 수 있다. 이어도 되는지는 대기열 참여를 허용하는 ADR의 범위를 정하는 문제라 이 조사의 제약 밖이다.
- **robots가 막은 두 곳(인터파크 6곳, pubcamping 5곳)은 어댑터 후보에서 빼는 것이 맞아 보인다.** 이 서비스가 폴링 UA를 밝히고 robots를 지키는 방침이라면 그렇다. 방침은 이 문서가 정할 일이 아니다.
- 서울시는 상세·접수 기간·선정 방식을 GET으로 읽을 수 있어 "접수 시작 알림" 같은 용도는 가능하나, 잔여 수는 봇 차단 장치 뒤에 있다. 우회하지 않는다면 감시 대상으로는 어렵다.
- 다음에 이어 볼 질문: (1) 국립공원 `campsiteList.do`와 땡큐캠핑 `axResCampSite.hbb`, xticket `GetBookProduct010001.json`이 로그인 없이 응답하는지. POST 한 번이 필요하다. (2) 미리해 게이트가 평소에도 줄을 세우는지. (3) 숲나들e 401의 원인. (4) `huyang.go.kr`가 다른 망에서는 열리는지, 숲나들e로 대체됐는지.

## 12. 태백시시설관리공단 (`tfmc.huyang.co.kr:452`) — robots 금지, 사용자 예외 ([#115](https://github.com/ppzxc/overlord/issues/115))

2026-10-14 13:2x ~ 13:4x KST에 UA `overlord-availability-poller/0.1`로 GET 8회와 달력 조회 POST 4회를 보냈다. 원문은 `research/raw/taebaek/`(README에 요청 목록)다.

- `robots.txt`는 200이고 `User-agent: *`와 `Googlebot`에 `Disallow: /`, `NaverBot`과 `Yeti`에만 `Allow: /`다(직접). ADR 0002라면 대상이 아니지만 사용자가 이 예약처만 예외로 허용했다. 근거와 조건은 [ADR 0003](../docs/adr/0003-taebaek-robots-exception.md)이다. 공단의 허락을 받은 것은 아니다.
- 달력은 서버가 그린 HTML이다. 이번 달 기본 탭(고원힐링 `wloc=B01`은 자동차야영장 `man=2`)은 `GET /reservation.asp?location=002&wloc=B01`이고, 다른 달과 탭은 `POST /reservation.asp?location=002`(`wh_year, wh_month, man, wloc`)다. 쿠키 없이 답한다(서버는 ASP 세션 쿠키를 주지만 없이도 같은 본문이다). 로그인·캡차·대기열·봇 탐지는 나타나지 않았다.
- 탭: `man=1` 야영데크, `man=2` 자동차야영장, `man=3` 카라반. 스펙(#115)의 가정과 같다. 날짜 칸은 `예약가능`, `예약종료`, `예약완료`(다 찬 날, 카라반 탭에서 봤다)이고 남은 수와 자리 번호가 없다. 다음 달(11월) 달력은 10월 14일에 이미 열려 있었다.
- 접근 금지: 예약 제출·자리 목록 `reservation.asp?location=002_01`, 예약확인·취소·결제 `location=003`, 로그인·회원 경로. 안내 화면(`location=001`)과 달력(`location=002`)은 막지 않는다.
- 같은 호스트에서 `wloc=A01`(절골힐링캠핑장)이 기본이다. `wloc`를 빼거나 모르는 값을 주면 절골이 나온다(`wloc=B02`는 무시되고 절골 달력이 왔다. 고원은 `B01`). 절골의 탭은 차량야영(`man=1`)과 야영노지(`man=2`)로 고원과 구역 코드가 맞지 않아 이번 범위에서 뺐다. 예약처 id를 공단 단위(`taebaek`)로 둬서 나중에 시설로 더하면 된다.
- 해당 없음/미확인: 추첨 기간과 선착순 개시는 안내와 달력 어디에도 없어 "해당 없음"이다(날짜를 가리는 규칙을 만들지 않는다). 최대 박수 4박(화면의 1~4박 라디오)과 실제 오픈 시각(예약 화면은 "전월 1일 오전 10시", 안내 화면은 9시)은 **미확인**이라 사람이 확인한다. 서버가 받는 최대 박수는 보지 못했다.
