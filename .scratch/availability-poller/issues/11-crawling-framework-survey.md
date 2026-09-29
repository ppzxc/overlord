# 크롤링 프레임워크 표준 조사

Type: research
Label: wayfinder:research
Status: resolved
Blocked by:

## Question

전 세계적으로 표준처럼 쓰이는 크롤링·스크래핑 프레임워크는 무엇이고, 이 폴러에 쓸 만한가? 언어는 TypeScript/Node로 정했다(「언어·스택 결정」 진행 중).

- **후보**: Scrapy, Crawlee(JS/Python), Colly, Apify SDK, StormCrawler/Nutch, Playwright Test 기반 러너, 그 밖에 Node 생태계에서 쓰이는 것(got-scraping, node-crawler 등).
- **각 후보의 사용 규모·성숙도·유지보수 상태**: 스타 수, 릴리스 주기, 주요 사용처.
- **이 폴러에 맞는지**: 대상 시설 몇 곳을 150초마다 요청 한두 건씩 보내는 **상주 폴러**다. 링크를 따라가며 긁는 크롤러가 아니다. 프레임워크가 제공하는 것(요청 큐, 재시도, 도메인별 속도 제한, 세션·쿠키 풀, HTTP↔브라우저 전환)과 이 폴러에 필요한 것이 얼마나 겹치는가?
- **윤리 원칙과 충돌하는 기본값**: 지문 위장, UA 로테이션, 프록시 로테이션, 봇 방어 우회 같은 기본값이 있는가? 끌 수 있는가?
- **Node 기준 비교**: Crawlee(JS)를 쓰는 경우와 fetch + cheerio + 직접 만든 스케줄 루프를 쓰는 경우의 비교. 의존성 크기와 학습 비용도 포함한다.

결론: TypeScript 폴러에 프레임워크를 쓸지, 쓴다면 무엇을 쓸지 권고한다.

## Answer

프레임워크를 쓰지 않는다. Node 내장 `fetch` + `cheerio` + 직접 만든 스케줄 루프(선택적으로 `croner`, 쿠키가 필요하면 `tough-cookie`)로 간다. 사실상 표준은 Scrapy와 Crawlee지만 둘 다 "큐를 비우면 끝나는 크롤"이 기본 모델이라 고정 URL 상주 폴러와 맞지 않는다. Node의 유일한 후보인 Crawlee v3 `HttpCrawler`는 브라우저 헤더 생성, 브라우저 TLS 흉내, 401/403/429 시 세션 로테이션 재시도, robots.txt 무시, TLS 검증 끔이 기본이다. 끌 수는 있지만 스위치가 5개 이상이고, v4에서는 기본 클라이언트가 TLS 위장 클라이언트(impit)로 바뀐다. 설치 규모도 136개 패키지, 37MB로 fetch+cheerio(24개, 9MB)보다 크다. 정직한 기본값은 Scrapy(`+URL` UA, 템플릿의 `ROBOTSTXT_OBEY = True`)를 레퍼런스로 삼는다.

상세: [crawling-framework-survey](../research/crawling-framework-survey.md)
