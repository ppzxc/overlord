# 고래불(stay.yd.go.kr) 1차 정찰 (2026-09-28)

읽기 전용 GET 요청 약 10회로 확인했다. 수집한 HTML 원본은 `raw/`에 있다.

> **UA 주의**: 이 정찰은 브라우저 User-Agent를 쓰라는 지시를 받고 진행했다. 사용한 정확한 UA는 기록되지 않았다. 고래불이 브라우저가 아닌 UA를 차단한다는 사실은 나중에 확인됐다([polling-etiquette.md](polling-etiquette.md) 참고). 그러므로 이 정찰 결과는 위장 UA로 관찰한 것일 수 있다.

- **로그인 없음.** 캘린더, step01, 자리 배치 모두 쿠키 없이 200 응답이 온다. 예약 확인은 이름, 예약번호, 휴대폰 번호로 한다.
- **월 캘린더**: `https://stay.yd.go.kr/pages/sub.htm?nav_code=gor1501675800&view_cate=YYYY&view_cate2=MM&code=`
  - 빈자리가 있는 날은 `<a title='2026-09-29 카라반 4인실 예약가능'>…</a><em>(3)</em>`처럼 나온다. 괄호 안이 잔여 수량이다.
  - 매진인 날은 `(마감)`으로 나온다.
- **자리 배치 (XHR, HTML 조각)**: `https://stay.yd.go.kr/pages/zoneAreaAjax.htm?res_Day=YYYY-MM-DD&room_Code=DKA&site_date=1`
  - 빈 자리: `<a onclick="zone_area_select('31','dka_2','텐트사이트 A02호')" class="num ">`
  - 예약된 자리: `class="num ban"`
  - `site_date`는 박수로 보인다(미검증).
- **step01**: `sub.htm?nav_code=gor1501675800&mode=step01&type=DKA&today=YYYY-MM-DD&col=3`
- **구역 코드**: CAA/CAB(카라반 4·6인), DKA/DKB/DKC(숲속야영장 A·B·C), AUA(캠핑카존), PEA/PEB/PEC(펜션형 6·8·10인).
  - 폐쇄된 카라반: 1, 2, 3, 4, 5, 6, 10, 13, 15, 16, 17, 19, 24번.
- **예약 규칙**
  - 선착순이다. 30일 롤링으로 열리고, 새 날짜는 매일 10시에 열린다.
  - 최대 2박이다.
  - 미결제 예약은 24시간이 지나면 취소된다. 당일 예약은 1시간 안에 결제해야 하고, 14시까지 미결제면 취소된다. 당일 예약은 18시에 마감된다.
  - "다음단계"를 누르면 자리가 잠시 선점된다.
  - 2박 예약을 취소하면 0~3시간 사이 임의 시각에 자리가 다시 풀린다.
- **봇 방어**
  - NetFunnel 대기열(`stay1.yd.go.kr`, `goraebul_res`)은 onclick에서 브라우저 쪽으로만 동작한다.
  - captcha와 JS 챌린지는 없다. CSRF는 예약 확인 폼에만 있다.
  - robots.txt는 `Disallow: /*cmsware*`, `Disallow: /*bbs*` 두 줄이다. 예약 폼 전송인 `/bbs/res_step01_rdata.php`는 금지 경로에 있으므로 호출하지 않는다.
- 응답에 `Cache-Control: max-age=36000, public`이 붙는다. 데이터 신선도에 영향이 있는지는 미검증이다.
- 이용약관 페이지는 찾지 못했다. 자동화를 금지하는 문구는 보지 못했다(미검증).
- **참고: 숲나들e**
  - 조회할 때 NetFunnel 키, `_csrf`, `X-Ajax-call` 헤더가 필요한 것으로 보인다.
  - 회원제다. 로그인 없이 가용 현황을 볼 수 있는지는 미검증이다.
