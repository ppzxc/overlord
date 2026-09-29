# 브라우저 자동화·스크래핑 표준 조사 (2026-09-29)

티켓: [01-browser-automation-standards](../issues/01-browser-automation-standards.md)

전제는 두 가지다. 폴러는 알림만 보내고 예약은 하지 않는다. 대기열·captcha·봇 탐지는 어떤 방식으로도 우회하지 않는다. 그래서 이 문서에서 "사람처럼"은 사람으로 위장한다는 뜻이 아니라 **예의 바른 클라이언트로 행동한다**는 뜻으로 쓴다.

출처 등급 표기
- **[1차]**: 공식 문서, RFC, 소스 코드
- **[README]**: 오픈소스 저장소의 README. 작성자가 스스로 밝힌 내용이다.
- **[2차·벤더]**: 스크래핑이나 안티봇 제품을 파는 회사의 블로그. 이해관계가 있으니 결론은 참고만 한다.
- **(미검증)**: 이번 조사에서 1차 출처로 확인하지 못한 내용

---

## 1. 도구 비교

| | Playwright | Puppeteer | Selenium | HTTP 클라이언트 + HTML 파서 |
|---|---|---|---|---|
| 제어 방식 | CDP 등 브라우저별 프로토콜 | CDP (Firefox는 WebDriver BiDi) | W3C WebDriver. 명령마다 드라이버 프로세스로 HTTP 요청을 보낸다 | 브라우저 없음 |
| 공식 언어 | JS/TS, Python, Java, .NET 4개 [1차] | JS/TS. 다른 언어는 커뮤니티 포트 [2차·벤더] | Java, Python, C#, Ruby, JS 등 가장 넓다 [2차·벤더] | 모든 언어 |
| 브라우저 | Chromium, Firefox, WebKit | Chrome 중심. v23부터 Firefox 공식 지원 [2차·벤더] | Chrome, Firefox, Safari, Edge 등 | 해당 없음 |
| 리소스 | 브라우저 프로세스 하나에 수백 MB (미검증) | 비슷함 (미검증) | 드라이버 프로세스까지 더해짐 (미검증) | 요청당 KB 단위. 가장 싸다 |
| JS 렌더링 | 됨 | 됨 | 됨 | 안 됨. 서버가 HTML을 렌더링하거나 JSON/XHR 엔드포인트가 있어야 한다 |

- Playwright의 공식 언어는 4개이고, 모두 "the same underlying implementation"을 공유한다 [1차, [playwright.dev/docs/languages](https://playwright.dev/docs/languages)]. Go 바인딩은 [playwright-community/playwright-go](https://pkg.go.dev/github.com/playwright-community/playwright-go)라는 커뮤니티 프로젝트다.
- Playwright는 headless 모드에서 기본으로 별도 빌드인 "chromium headless shell"을 쓴다. `channel: 'chromium'`을 주면 진짜 Chrome인 new headless를 쓴다. 공식 문서는 탐지 가능성에 대해서는 아무 말도 하지 않는다 [1차, [playwright.dev/docs/browsers](https://playwright.dev/docs/browsers)].
- **headless 탐지.** 자동화 브라우저는 W3C WebDriver 규격 때문에 `navigator.webdriver === true`가 된다. Selenium은 여기에 `$cdc_` 흔적까지 남긴다. 업계 비교 글들은 탐지 원인이 라이브러리가 아니라 브라우저 자체에 있다고 본다 [2차·벤더, [browserless](https://www.browserless.io/blog/selenium-vs-playwright-vs-puppeteer), [webdecoy](https://webdecoy.com/blog/headless-browser-detection-playwright-puppeteer-selenium/)].
  - **이 프로젝트의 결론**: 탐지를 피하는 stealth 도구는 쓰지 않는다. playwright-stealth, puppeteer-extra-plugin-stealth, undetected-chromedriver, Patchright, Camoufox가 여기에 해당한다. 예약처가 자동화 브라우저를 막으면 그 예약처는 지원하지 않는다. 그러니 headless 탐지 문제는 우리가 "해결"할 대상이 아니라, 예약처를 지원할 수 있는지 판단하는 기준이다.
- 업계에서 흔히 하는 선택은 이렇다. 새 프로젝트는 Playwright, Chrome만 쓰는 Node 프로젝트는 Puppeteer, 기존 언어나 그리드가 있으면 Selenium [2차·벤더, [browserless](https://www.browserless.io/blog/selenium-vs-playwright-vs-puppeteer)].

## 2. HTTP 우선, 필요할 때만 브라우저

이 방식은 흔하게 쓰이고, 주요 프레임워크가 직접 지원한다.

- **Crawlee `AdaptivePlaywrightCrawler`** (JS와 Python 모두 있다): `PlaywrightCrawler`를 확장했다. 요청 핸들러가 Playwright의 `page`를 직접 만지지 않고 `querySelector`나 `pushData` 같은 컨텍스트 헬퍼만 쓰게 인터페이스를 좁혀 두었다. 그래서 같은 핸들러가 HTTP 모드와 브라우저 모드 양쪽에서 돌 수 있다. "switch to HTTP-only crawling when it detects it may be possible." 렌더링 방식은 `rendering_type_predictor`가 판단하고, 결과는 `result_checker`와 `result_comparator`로 검증한다. 정적 파서로는 BeautifulSoup이나 Parsel을 고를 수 있다 [1차, [JS API](https://crawlee.dev/js/api/playwright-crawler/class/AdaptivePlaywrightCrawler), [Python API](https://crawlee.dev/python/api/class/AdaptivePlaywrightCrawler)]. 실험 기능인지는 확인하지 못했다(미검증).
  - 주의할 점이 있다. Crawlee는 Playwright와 Puppeteer 크롤러에서 **브라우저 지문 무작위화를 기본으로 켠다**. 이는 위장에 해당한다. 쓸 거라면 `browserPoolOptions.useFingerprints: false`로 꺼야 한다 [1차, [avoid-blocking 가이드](https://crawlee.dev/js/docs/guides/avoid-blocking)]. Python 쪽의 `retry_on_blocked` 옵션("Automatically attempt to bypass bot protections")도 쓰지 않는다.
- **scrapy-playwright**: 기본은 Scrapy의 HTTP 다운로더다. 요청마다 `meta={"playwright": True}`를 붙이면 그 요청만 브라우저로 보낸다 [1차, [README](https://github.com/scrapy-plugins/scrapy-playwright)]. 브라우저를 쓸지 요청 단위로 고르는 사례다.
- **Playwright 자체의 하이브리드**: `context.request`(APIRequestContext)는 브라우저 컨텍스트와 **쿠키 저장소를 같이 쓴다**. 쿠키를 자동으로 보내고, 응답의 `Set-Cookie`도 컨텍스트에 반영한다. `storageState`로 세션을 파일에 저장했다가 다시 불러올 수도 있다 [1차, [APIRequestContext](https://playwright.dev/docs/api/class-apirequestcontext), [api-testing](https://playwright.dev/docs/api-testing)]. 이렇게 하면 "브라우저로 로그인해서 쿠키와 CSRF를 얻고, 조회는 HTTP로" 하는 패턴을 한 라이브러리 안에서 만들 수 있다.
- **어댑터 인터페이스 사례**: camply는 예약처마다 `BaseProvider`(ABC)를 상속한다. BaseProvider는 `requests.Session`과 tenacity 지수 백오프 재시도를 제공한다 [1차, [base_provider.py](https://github.com/juftin/camply/blob/main/camply/providers/base_provider.py)]. brensch/campbot(Go)에는 `providers/` 인터페이스가 있다 [README, [campbot](https://github.com/brensch/campbot)] (코드는 미확인).

**정리**: 예약처 어댑터의 인터페이스는 "시설·기간을 받아 자리별 가용 여부를 돌려준다" 정도로 좁힌다. HTTP로 할지 브라우저로 할지는 어댑터 내부의 구현 사항으로 둔다. 인터페이스 설계는 티켓 05에서 한다.

## 3. 예의 바른 요청의 정상 범위

- **User-Agent** [1차, [RFC 9110 §10.1.5](https://www.rfc-editor.org/rfc/rfc9110.html#name-user-agent)]
  - 매 요청에 보내야 한다(SHOULD).
  - 다른 구현체의 제품 토큰을 빌려 쓰지 말라고 권한다: "implementations are encouraged not to use the product tokens of other implementations … as this circumvents the purpose of the field."
  - 그러니 **고정된 자체 UA 하나**를 쓴다. 예: `overlord/0.1 (+연락처 URL)`. camply와 banool이 `fake_useragent`로 UA를 무작위로 바꾸는 방식은 따르지 않는다 [1차, [camply base_provider.py](https://github.com/juftin/camply/blob/main/camply/providers/base_provider.py) L85, [banool camping.py](https://github.com/banool/recreation-gov-campsite-checker/blob/master/camping.py)].
  - 단, 자체 UA 때문에 예약처가 다른 응답을 주는지는 미검증이다. 고래불에서 확인해야 한다.
- **From 헤더** [1차, [RFC 9110 §10.1.2](https://www.rfc-editor.org/rfc/rfc9110.html#name-from)]: "A robotic user agent SHOULD send a valid From header field so that the person responsible for running the robot can be contacted." 운영자 이메일을 설정으로 받아 보내면 된다.
- **robots.txt** [1차, [RFC 9309 §2.4](https://www.rfc-editor.org/rfc/rfc9309.html)]: 캐시는 할 수 있지만 "SHOULD NOT use the cached version for more than 24 hours". 고래불의 `/bbs/` 금지 규칙을 지키는 근거가 된다.
- **간격과 지터** [1차, [Scrapy AutoThrottle](https://docs.scrapy.org/en/latest/topics/autothrottle.html)]
  - 설계 목표는 "be nicer to sites"다.
  - 기본값은 시작 지연 5초, 사이트당 목표 동시성 1.0이다.
  - 다음 지연은 응답 지연을 반영해 조정한다(latency / N과 이전 지연의 평균).
  - 200이 아닌 응답은 지연을 줄이지 못한다.
  - 우리 폴러도 예약처당 동시성 1, 요청 사이 최소 간격 몇 초, 무작위 지터, 5xx/429 응답 시 지수 백오프를 기본값으로 삼는다. 구체적인 수치는 티켓 02와 07에서 정한다.
- **쿠키와 세션**: 세션 하나를 유지하는 것(cookie jar, keep-alive)은 정상이다. 서버 부하도 줄어든다. 반면 세션이나 IP를 돌려 가며 차단을 피하는 것은 우회에 해당하므로 하지 않는다.
- **캐시**: 고래불 응답에는 `Cache-Control: max-age=36000, public`이 붙는다. HTTP 클라이언트나 중간 프록시가 이 헤더를 따르면 10시간 묵은 데이터를 받을 수 있다. 폴러는 클라이언트 캐시를 끄거나 요청마다 새로 받아야 한다. 서버가 실제로 매번 새로 렌더링하는지는 미검증이다.

## 4. 언어·스택별 생태계

| 스택 | HTML 파서 | HTTP | 스케줄러 | 브라우저 바인딩 |
|---|---|---|---|---|
| TS/Node | cheerio (미검증), 내장 없음 | 내장 `fetch` (Node 18+) | node-cron, croner (미검증) | Playwright(공식), Puppeteer(공식) |
| Python | BeautifulSoup, Parsel, lxml ([Crawlee Python이 정적 파서로 지원](https://crawlee.dev/python/api/class/AdaptivePlaywrightCrawler)) | requests, httpx | APScheduler (미검증) | Playwright(공식), Selenium(공식) |
| Go | goquery (미검증) | net/http | 표준 time.Ticker, robfig/cron (미검증) | playwright-go는 **커뮤니티** 포트 [pkg.go.dev](https://pkg.go.dev/github.com/playwright-community/playwright-go), chromedp (미검증) |
| JVM | jsoup (미검증) | java.net.http | Quartz, Spring @Scheduled (미검증) | Playwright(공식), Selenium(공식) |

- Go의 Colly는 도메인별 요청 지연과 최대 동시성 관리를 기능으로 내세운다 [1차, [go-colly.org](https://go-colly.org/)]. 파서 구현은 이번에 확인하지 않았다.
- 언어를 가르는 기준은 **브라우저 폴백에 공식 Playwright 바인딩이 필요한가**다. 필요하다면 TS, Python, JVM, .NET이 남고, Go는 커뮤니티 포트에 기대야 한다.

## 5. 알려진 오픈소스 사례

| 프로젝트 | 대상 | 방식 | 비고 |
|---|---|---|---|
| [juftin/camply](https://github.com/juftin/camply) | Recreation.gov, ReserveCalifornia 등 | Python, requests + 공개 JSON API | Provider ABC, 알림은 여러 채널로 동시에 보낸다(fan-out) [1차 코드 + README]. 아키텍처 요약 중 일부는 [DeepWiki](https://deepwiki.com/juftin/camply)(2차)를 참고했다 |
| [banool/recreation-gov-campsite-checker](https://github.com/banool/recreation-gov-campsite-checker) | Recreation.gov | Python requests, `/api/camps/availability/campground/{id}/month` | "Please don't abuse this script" [README] |
| [heekeunlee/campseek](https://github.com/heekeunlee/campseek) | 숲나들e, 숲이랑 | Node 내장 fetch만 쓴다. 브라우저 없음. 세션 쿠키와 CSRF 토큰을 자동으로 얻고 갱신한다. `POST /rep/or/innerFcfsRcrfrDtlDetls.do?_csrf=…` | 기본 5분 간격("너무 짧게 두지 말 것"), 같은 알림은 1시간 뒤에 다시 보낸다. **GitHub Actions(해외 IP)에서는 접속이 막혀 국내 머신에서 돌려야 한다.** 조회에는 로그인이 필요 없다고 한다 [README] |
| [munbakcha/foresttrip-calendar](https://github.com/munbakcha/foresttrip-calendar) | 숲나들e | Python. Playwright로 **로그인만** 해서 CSRF와 쿠키를 얻고(세션은 10분 캐시), 조회는 JSON으로 한다 | 월별 조회 엔드포인트는 로그인 없이 401을 준다. 예약 화면은 **Referer를 검사해서** 외부에서 들어오면 404를 준다. 동시성은 3이다("사이트 부하 배려"). launchd로 매일 한 번 돈다 [README] |
| [Hwonkyu/knps-camp-notifier](https://github.com/Hwonkyu/knps-camp-notifier) | 국립공원공단 | 알림만 보낸다 | GitHub Actions 스케줄러는 지연이 생겨서 cron-job.org로 트리거한다 [README, 검색 요약] |
| [glxy0104/camping-cancel-alert](https://github.com/glxy0104/camping-cancel-alert) | 공영·국립 캠핑장 | 텔레그램 알림 | Actions 안에서 약 5시간 45분 동안 루프를 돈다 [README, 검색 요약] |
| [para333311/camping-watcher](https://github.com/para333311/camping-watcher) | 미상 | Python + Playwright | 저장소 설명 한 줄 외에는 확인하지 못했다 |

공통 패턴: 국내 사례는 모두 **알림만 보낸다**. 폴링 간격은 5~30분이 흔하다. HTTP로 조회할 수 있으면 HTTP로 하고, 브라우저는 로그인에만 한정한다.

## 6. 예약처 유형별 결론

### A. 서버 렌더링 HTML, 로그인 없음 (고래불)
- **HTTP GET + HTML 파서**면 충분하다. 브라우저는 필요 없다. 정찰에서 쿠키 없이도 200 응답을 받았다([goraebul-recon](goraebul-recon.md)).
- 월 캘린더(`sub.htm?...view_cate=YYYY&view_cate2=MM`)의 `title='… 예약가능'`과 `(N)` 잔여 수량을 먼저 읽는다.
- 감시 조건에 자리 필터(구역, 자리 번호)가 있고 그날 빈자리가 있을 때만 `zoneAreaAjax.htm`을 부른다. 이렇게 요청 수를 최소화한다.
- **호출하지 않는 것**: `/bbs/` 아래 경로(robots.txt 금지), NetFunnel 대기열 흐름(onclick → `stay1.yd.go.kr`), step01 이후의 예약 단계(자리 선점이 일어난다).
- 캐시 헤더 때문에 데이터가 늦게 바뀔 수 있다(미검증). 티켓 03에서 확인한다.

### B. 세션 + CSRF (숲나들e)
- 기본은 **HTTP 클라이언트 + cookie jar + 페이지에서 파싱한 CSRF 토큰**이다. campseek이 브라우저 없이 이렇게 조회한다고 README에 밝혔다.
- **충돌(미검증)**: campseek은 조회에 로그인이 필요 없다고 하고, foresttrip-calendar는 월별 조회가 로그인 없이는 401이라고 한다. 두 프로젝트가 서로 다른 엔드포인트를 쓰는 것으로 보인다. 어떤 엔드포인트가 감시 조건에 필요한 정보를 주는지는 숲나들e 어댑터 티켓에서 정한다.
- 로그인이 꼭 필요하다면 **하이브리드**로 간다. 브라우저(Playwright)로 로그인해서 `storageState`를 저장하고, 조회는 같은 쿠키를 쓰는 HTTP로 한다(APIRequestContext나 별도 HTTP 클라이언트에 쿠키를 넘긴다). 사용자 본인 계정을 쓰는지, 약관이 허용하는지는 따로 판단해야 한다.
- **NetFunnel 키 (차단 이슈, 미검증)**: 정찰에서는 숲나들e 조회에 NetFunnel 키가 필요한 것으로 보였다. 브라우저 대기열 흐름을 거치지 않고 키를 얻거나 재사용하면 **대기열 우회**가 될 수 있다. 이 문제가 풀리기 전에는 숲나들e 어댑터를 설계하지 않는다. 정당한 방법이 대기열 흐름을 정상적으로 통과하는 것뿐이라면 브라우저를 써야 할 수 있다. 그때는 폴링 비용과 예의 문제를 다시 따져야 한다.
- 운영 사항
  - 해외나 클라우드 IP는 차단된다고 한다[campseek README]. 배포 위치는 티켓 10과 관련이 있다.
  - Referer를 검사한다[foresttrip-calendar README]. 알림에 넣을 딥링크 설계에 영향을 준다.

## 7. 추천 스택 (권고일 뿐, 결정은 티켓 04에서)

**TypeScript/Node 또는 Python**을 권한다. 둘 다 조건을 만족한다.
- 둘 다 공식 Playwright 바인딩이 있어서 브라우저 폴백이 필요할 때 바로 쓸 수 있다. Go는 커뮤니티 포트뿐이다.
- 둘 다 국내 참고 구현이 있다. Node에는 campseek(숲나들e HTTP), Python에는 foresttrip-calendar(하이브리드)와 camply(어댑터 구조)가 있다.
- 둘 다 Crawlee의 적응형 크롤러와 HTML 파서 생태계를 쓸 수 있다. 다만 Crawlee를 쓸 경우 지문 위장 기본값을 꺼야 한다.

두 언어 중 고르는 기준
- 운영자에게 익숙한 언어
- 알림 플러그인(티켓 08) 생태계
- 단일 바이너리 배포가 중요하다면 Go도 후보가 된다. 브라우저가 필요한 예약처를 포기하거나 별도 사이드카로 처리한다는 전제에서다.
- 어느 쪽이든 **HTTP를 1순위로 하고, 브라우저는 어댑터 안에서만 선택적으로** 쓰는 구조는 같다.
