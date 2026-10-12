# 울산 중구 입화산 제2오토야영장(cpId=iphwa_auto2) 기록 (#78)

2026-10-12 20:16~20:25 KST(월요일 밤), ADR 0002 원칙으로 한 번 기록했다. UA `overlord-availability-poller/0.1 (ADR0002 one-time recording)`.
요청마다 앞에서 5초 + 0~3초를 쉬었다(요청 사이는 끝 시각 기준 최소 7초). 대기열 서버(`campwait.junggu.ulsan.kr`)와 예약처(`camping.junggu.ulsan.kr`)를 합쳐 HTTP 요청 14건이다.
TLS는 검증을 끄지 않고 Node 기본 루트에 `certs/`의 Sectigo 중간 인증서를 더한 신뢰 목록으로 받았다(#77, curl `--cacert`).
로그인·captcha·봇 탐지 호출 없음. 접근 금지 경로 호출 없음. 쿠키 단지는 하나이고 서버가 준 `JSESSIONID`와, 페이지 JS처럼 만든 `NetFunnel_ID`만 보냈다.

요청 순서(시각은 요청이 끝난 KST):
1. GET `/camping/index.jsp` -> 200, 1,250바이트 (20:16:39) -> `index.jsp.html`. `NetFunnel_Action({action_id:"main"})` 뒤 `/camping/index.do`로 보낸다. (`/`와 `/camping/`의 302 두 번은 따라가지 않았다. 조사 때 이미 본 경로다.)
2. GET `/camping/js/netfunnel.js` -> 200, 105,312바이트 (20:16:49). 버전 2.2.19, `TS_HOST=campwait.junggu.ulsan.kr`, `TS_SERVICE_ID=service_1`. 머리 20줄만 `netfunnel.excerpt.js`에 뒀다.
3. GET `campwait.junggu.ulsan.kr/ts.wseq?opcode=5101&nfid=0&prefix=NetFunnel.gRtype=5101;&sid=service_1&aid=main&js=yes&<ms>` -> 200, `5002:200:key=…&nwait=0&nnext=0&tps=0.000000&ttl=0` (20:16:59) -> `nf_main_5101.txt`. 5004는 보내지 않았다.
4. GET `/camping/pageCont.do?menuNo=1010300` (쿠키 `NetFunnel_ID` = 3번 결과 문자열 전체를 `escape()`) -> 200, 104,228바이트 (20:17:23) -> `pageCont.do_menuNo-1010300.html`. 로그인 없이 열린다.
5. POST `/camping/ajaxGetMonthlyMap.do` `searchDate=2026-10-01&cpId=iphwa_auto2` -> 200 (20:18:12) -> `ajaxGetMonthlyMap.do_iphwa_auto2_2026-10.json`. 10/12~10/31이 `isAbleDate:true`, 그 앞은 `false`다. `isExclusive`는 모두 `false`.
6. POST `/camping/ajaxGetSiteList.do` `searchDate=<날짜>&cpId=iphwa_auto2&csId=<구역>&isExclusive=` (본문 끝이 빈 `isExclusive=`다. 페이지 JS가 중구민 전용이 아닌 날 빈 문자열을 보낸다). 헤더는 페이지의 jQuery ajax와 같게 `X-Requested-With: XMLHttpRequest`, `Referer`(4번 주소), `Origin`을 실었다.
   파일 이름의 숫자는 `csId`의 끝 두 자리(`CP_SPEC_0000000000NN`)다.
   - `ajaxGetSiteList.do_31_2026-10-20.json` (20:18:32) 구역 31 입화산 제2오토A(대형), 11자리 모두 **`ACTIVE` / `ctIsBookable:"Y"` / `ctIsIng:"N"` / `lotteryCount:0`** (열린 자리)
   - `ajaxGetSiteList.do_31_2026-10-17.json` (20:19:05) 토요일. 11자리 모두 `RESERVED` / `N`
   - `ajaxGetSiteList.do_31_2026-10-14.json` (20:19:21) 11자리 모두 `CLOSED` / `N` (조사 때와 같다)
   - `ajaxGetSiteList.do_33_2026-10-20.json` (구역 33 A(소형), 5자리 모두 열림), `_32_` (구역 32 A(중형), 8자리 가운데 7자리 열림, `오토(중형)504`만 `RESERVED`), `_36_`(B(소형) 6자리 열림), `_35_`(B(중형) 6자리 열림)
7. GET `/camping/pageCont.do?menuNo=1010300` 을 쿠키 없이 (딥링크 확인, 20:20:20) -> 200, 4번과 바이트까지 같다(`cmp`).
8. GET `/camping/js/ajax.js` -> 200, 3,353바이트 (20:24:56) -> `ajax.js`. 폼 제출 도우미뿐이고 봇 탐지·captcha가 없다.

값을 가린 곳: 3번 `key=`는 `MASKED`로 바꿨다. `JSESSIONID`와 `Set-Cookie`는 저장하지 않았다(응답 헤더 파일을 두지 않았다). 응답 본문에는 키·토큰이 없다(`pageCont.do`에는 `jsessionid`도 CSRF 토큰도 없다. `naver-site-verification`은 공개 메타 태그다).
`ajaxGetSiteList.do` 응답에는 운영자 시스템 계정 id(`regId`, `uptId`)가 들어 있다. 비밀이 아니고 가리지 않았다.

봇 탐지: `index.jsp`, `pageCont.do`, `netfunnel.js`, `ajax.js`에 `crawlingCheck`, `dynapath`, `botmanager`, `captcha`가 없다. 조회 응답에도 오지 않았다.

보내지 않은 것: `ajaxSelecteSite.do`, `ajaxChangeStayGigan.do`, `iphwa_auto2/insert.do`, 로그인(`menuNo=5010000`)·회원가입(`5020000`)·아이디/비밀번호 찾기(`5030000`)·마이페이지(`5040100`, 예약확인·취소), 결제(토스페이먼츠 `xpay.tosspayments.com`).
다른 구역(`32`, `33`, `35`, `36`)은 브라우저처럼 `intro.do?searchCsId=…` 화면을 거치지 않고 같은 `ajaxGetSiteList.do`에 `csId`만 바꿔 보냈다.

# 황방산(cpId=hwangbang)·태화연(cpId=taehwa) 기록 (#79)

2026-10-12 20:36~20:40 KST, 위와 같은 원칙(UA `overlord-availability-poller/0.1 (ADR0002 one-time recording)`, 요청마다 앞에서 5초 + 0~3초, 접근 금지 경로 호출 없음, 로그인·captcha·봇 탐지 호출 없음)과 같은 TLS 방식(Node 기본 루트에 `certs/`의 중간 인증서)으로 시설마다 브라우저 흐름(`main` → 예약 화면 → 월 지도 → 구역마다 자리 목록)을 한 번씩 기록했다. HTTP 요청 12건이다. 시설을 바꿀 때 `main`을 다시 지났다(화면 버튼 `fnRev2`·`fnRev3`의 흐름).
쿠키 단지 하나, 요청 헤더는 #78과 같다(`X-Requested-With`, `Referer`는 그 시설의 `pageCont.do`, `Origin`). 자리 목록 본문은 이전과 같이 `isExclusive=`(빈 값)이다.

요청 순서(시각은 요청이 끝난 KST):
1. GET `campwait.junggu.ulsan.kr/ts.wseq?opcode=5101&…&aid=main` -> 200 (20:36:58). 결과 문자열은 #78의 `nf_main_5101.txt`와 같은 모양이라 다시 저장하지 않았다(`key`는 가리는 값).
2. GET `/camping/pageCont.do?menuNo=1020300` (쿠키 `NetFunnel_ID`) -> 200 (20:37:14) -> `pageCont.do_menuNo-1020300.html`
3. POST `ajaxGetMonthlyMap.do` `searchDate=2026-10-01&cpId=hwangbang` -> 200 (20:37:53) -> `ajaxGetMonthlyMap.do_hwangbang_2026-10.json`. 10/12~10/31이 `isAbleDate:true`, `isExclusive`는 모두 `false`.
4. POST `ajaxGetSiteList.do` `searchDate=2026-10-20&cpId=hwangbang&csId=<구역>&isExclusive=` -> 200 (20:38:10~20:38:30). 파일 이름은 `ajaxGetSiteList.do_hwangbang_<csId 끝 두 자리>_2026-10-20.json`이다.
   - `04` 황방산 오토야영장 18자리, `34` 황방산 차량카라반(소) 1자리, `05` 황방산 카라반야영장 3자리. 세 구역 모두 모든 자리가 `CLOSED`/`N`/`N`/`0`이었다(열린 자리 응답은 이 시설에서 기록하지 못했다).
5. GET `campwait.junggu.ulsan.kr/ts.wseq?opcode=5101&…&aid=main` -> 200 (20:38:53)
6. GET `/camping/pageCont.do?menuNo=1030300` -> 200 (20:39:05) -> `pageCont.do_menuNo-1030300.html`
7. POST `ajaxGetMonthlyMap.do` `searchDate=2026-10-01&cpId=taehwa` -> 200 (20:39:21) -> `ajaxGetMonthlyMap.do_taehwa_2026-10.json`. 황방산과 같은 모양이다(10/12~10/31 선택 가능).
8. POST `ajaxGetSiteList.do` `searchDate=2026-10-20&cpId=taehwa&csId=<구역>&isExclusive=` -> 200 (20:39:35~20:39:59) -> `ajaxGetSiteList.do_taehwa_<끝 두 자리>_2026-10-20.json`
   - `06` 태화연 오토캠핑장 47자리(열림 `ACTIVE`/`Y`/`N` 37, `RESERVED` 10), `07` 태화연 오토(소형)캠핑장 4자리(모두 열림), `08` 태화연 오토(이동식카라반) 6자리(모두 열림).

확인한 값: `cpId` 황방산 `hwangbang`, 태화연 `taehwa`(예약 화면의 ajax 호출 값, 폼 action `/camping/hwangbang/insert.do`·`/camping/taehwa/insert.do`). 구역은 예약 화면의 `changeCp(...)` 목록과 자리 목록 응답(`csId`, `csName`, `csType`, `csMaxCapacity`)이 일치한다.
황방산: `…04` 오토 `AUTO` 6인, `…34` 차량카라반(소) `CARAVAN` 4인, `…05` 카라반 `CARAVAN` 6인. 태화연: `…06`, `…07`, `…08` 모두 `AUTO` 6인.
세 시설의 화면 JS는 같은 코드다(`rsStay` 1, 2와 "2박 3일, 1박 2일" 주석). 서버가 정한 최대 박수 값은 어느 응답에도 없다(`cpMaxStay: 0`).
`ajaxGetSiteList.do` 응답의 `ableEndDate`는 세 시설 모두 2026-10-31이다.

값을 가린 곳: 1번과 5번의 `key=`는 저장하지 않았다. `JSESSIONID`는 저장하지 않았다. 자리 목록 응답에는 #78과 같이 운영자 시스템 계정 id(`regId`, `uptId`)가 있고 가리지 않았다.
봇 탐지: 두 `pageCont.do`와 조회 응답에 `crawlingCheck`, `dynapath`, `botmanager`, `captcha`가 없다.

"입화산 참살이숲야영장": 이 예약처의 메뉴·`changeCp` 목록·응답 어디에도 나오지 않았다. 예약 화면 JS의 배치도 분기에 `cpId` `iphwa`(`plotplan5.png`)와 `iphwa2`(별뜨락의 `menuNo=2010400`)가 있을 뿐이고 `iphwa`는 메뉴에 연결되어 있지 않다. 별도 시설인지, 지금 예약을 받는지는 확인하지 못했다(없는 값으로 요청하지 않았다).
