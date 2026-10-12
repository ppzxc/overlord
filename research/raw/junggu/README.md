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
