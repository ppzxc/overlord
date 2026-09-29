# 브라우저 자동화·스크래핑 표준 조사

Type: research
Label: wayfinder:research
Status: resolved
Blocked by:

## Question

사람이 쓰는 것처럼 예약 페이지를 조회하는 폴러를 만들 때, 업계가 표준처럼 쓰는 방식은 무엇인가?

- **도구 비교**: Playwright, Puppeteer, Selenium, 그리고 HTTP 클라이언트로 HTML을 파싱하는 방식. 성숙도, 언어별 지원, 리소스 비용, headless 탐지 문제를 비교한다.
- **HTTP 우선 + 필요할 때만 브라우저** 전략이 일반적인가? 두 방식을 하나의 어댑터 인터페이스 뒤에 섞는 사례는 어떤 모습인가?
- **사람처럼 보이는 요청의 정상 범위**: 헤더, User-Agent, 쿠키와 세션 유지, 지터. 여기서 "정상 범위"는 우회가 아니라 매너 있는 클라이언트를 뜻한다.
- **언어·스택별 생태계**: TypeScript/Node, Python, Go, JVM에서 쓸 수 있는 HTML 파서, 스케줄러, 브라우저 바인딩.
- **알려진 오픈소스 사례**: 캠핑장이나 공연 빈자리 알리미가 어떤 구조로 만들어져 있는지.

결론적으로 두 가지를 답해야 한다. 고래불처럼 서버에서 HTML을 렌더링하는 예약처와 숲나들e처럼 세션과 CSRF를 쓰는 예약처에 각각 어떤 수집 방식이 맞는가? 그리고 추천하는 언어와 스택은 무엇인가?

## Answer

- **고래불처럼 서버에서 HTML을 렌더링하고 로그인이 없는 예약처**는 HTTP GET과 HTML 파서로 수집한다. 브라우저는 쓰지 않는다.
  - 월 캘린더에서 잔여 수량을 먼저 읽는다.
  - 감시 조건에 자리 필터가 있고 그날 빈자리가 있을 때만 `zoneAreaAjax`를 호출한다.
  - `/bbs/` 경로, NetFunnel 대기열, step01 이후의 예약 단계는 호출하지 않는다.
- **숲나들e처럼 세션과 CSRF를 쓰는 예약처**는 HTTP 클라이언트로 수집한다. cookie jar로 세션을 유지하고, CSRF 토큰은 페이지에서 파싱한다.
  - 로그인이 꼭 필요하다고 확인되면 하이브리드로 간다. Playwright로 로그인만 하고 `storageState`를 저장한 뒤, 같은 쿠키로 HTTP 조회를 한다.
  - 로그인 필요 여부는 미검증이다. 두 오픈소스의 설명이 서로 다르다.
  - NetFunnel 키가 필요한지도 미검증이다. 필요하다면 대기열 우회에 해당할 수 있다. 이 두 가지가 풀릴 때까지 숲나들e 어댑터 설계는 보류한다.
- **공통 원칙**: HTTP를 우선하고, 브라우저 사용 여부는 어댑터 내부 구현으로 숨긴다.
  - User-Agent는 고정된 자체 값 하나만 쓰고 `From` 헤더를 보낸다(RFC 9110).
  - 예약처당 동시성은 1, 요청 간격에는 지터를 넣고, 실패하면 백오프한다.
  - stealth 도구, UA 로테이션, 지문 위장은 쓰지 않는다.
- **추천 스택**은 TypeScript/Node 또는 Python이다. 둘 다 공식 Playwright 바인딩과 국내 참고 구현이 있다. 이것은 권고이고, 최종 결정은 티켓 04에서 grilling으로 한다.

상세: [research/browser-automation-standards.md](../research/browser-automation-standards.md)
