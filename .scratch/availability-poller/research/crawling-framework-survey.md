# 크롤링 프레임워크 표준 조사 (2026-09-29)

티켓: [11-crawling-framework-survey](../issues/11-crawling-framework-survey.md)
선행 조사: [browser-automation-standards](browser-automation-standards.md)(브라우저 도구, 적응형 크롤러, 예의 바른 요청 범위), [polling-etiquette](polling-etiquette.md)(간격, 백오프, 차단 페이지 처리 정책). 두 문서에 있는 내용은 여기서 되풀이하지 않고 링크만 건다.

출처 표기: **[1차]** 공식 문서·소스 코드·레지스트리 API, **[측정]** 이번에 직접 설치하거나 조회해서 얻은 값, **(미검증)** 1차 출처로 확인하지 못한 것.
예약처 사이트에는 요청을 보내지 않았다. GitHub, npm 레지스트리, Context7만 조회했다.

## 요약

- 상주 폴러에는 **프레임워크를 쓰지 않는 쪽을 권한다.** 구성은 Node 내장 `fetch`, `cheerio`, 직접 만든 스케줄 루프다(원하면 `croner`를 쓴다).
- 사실상 표준은 **Scrapy**(Python)와 **Crawlee**(JS/Python)다. 둘 다 "링크를 따라가며 큐를 비우면 끝나는 크롤"이 기본 모델이다. 같은 URL을 150초마다 다시 보는 폴러와는 모델이 어긋난다.
- Node에서 유일한 실질 후보는 Crawlee다. 그런데 v3 `HttpCrawler`는 기본값 여러 개가 이 프로젝트의 윤리 원칙과 부딪힌다. 브라우저 헤더 생성, 브라우저 TLS 흉내, 차단되면 세션을 바꿔 재시도, robots.txt 무시, TLS 검증 끔이 그렇다. 전부 끌 수는 있다. 하지만 스위치가 5개 이상 흩어져 있고, TLS 흉내를 끄는 방법은 문서화된 윤리 스위치가 아니다. v4에서는 기본 HTTP 클라이언트가 TLS 위장 클라이언트(impit)로 바뀌므로 업그레이드할 때마다 다시 점검해야 한다.
- 대신 쓸 만한 레퍼런스는 Scrapy의 **정직한 기본값**이다. `+URL`이 붙은 도구 UA, 프로젝트 템플릿의 `ROBOTSTXT_OBEY = True`, `DOWNLOAD_DELAY`가 그 예다. 직접 만드는 루프가 이 기본값을 흉내 내면 된다.

## 1. 후보별 규모·성숙도·유지보수 (스냅샷 2026-09-29)

스타 수, 마지막 push, 최근 릴리스는 GitHub REST API(`gh api repos/…`, `…/releases`)에서, 주간 다운로드는 `api.npmjs.org/downloads/point/last-week`에서 가져왔다 [측정].

| 후보 | 언어 | 스타 | 최근 릴리스 | 릴리스 주기 | 라이선스 | 비고 |
|---|---|---|---|---|---|---|
| [scrapy/scrapy](https://github.com/scrapy/scrapy) | Python | 64,515 | 2.19.0 (2026-09-10) | 1~2개월(2.16 05-19, 2.17 07-07, 2.18 08-20, 2.19 09-10) | BSD-3 | 가장 큰 크롤링 프레임워크. Python이라 이 프로젝트에서는 제외 |
| [apify/crawlee](https://github.com/apify/crawlee) | TS/JS | 25,930 | v3.18.1 (2026-08-12), v4.0.0-rc.0 (2026-08-13) | 수 주~2개월 | Apache-2.0 | npm `crawlee` 주 164,009회, `@crawlee/http` 206,317회, `@crawlee/cheerio` 199,244회 |
| [apify/crawlee-python](https://github.com/apify/crawlee-python) | Python | 9,561 | v1.10.2 (2026-09-22) | 1~2주 | Apache-2.0 | 언어 조건 때문에 제외 |
| [gocolly/colly](https://github.com/gocolly/colly) | Go | 25,535 | v2.2.0 (2025-03-27) | 불규칙(v2.1.0 2020-06 다음이 v2.2.0 2025-03) | Apache-2.0 | 2026-09 push는 있다. 언어 조건 때문에 제외 |
| [apify/apify-sdk-js](https://github.com/apify/apify-sdk-js) | TS | 185 | v3.7.2 (2026-05-11) | 수 개월 | Apache-2.0 | Apify 플랫폼(Actor, 플랫폼 스토리지·프록시)과 연결하는 층. Crawlee 위에 얹는다. 자체 호스팅 폴러에는 더해 주는 것이 없다 |
| [apache/stormcrawler](https://github.com/apache/stormcrawler) | Java | 997 | 3.7.0 (2026-07-29) | 2~4개월 | Apache-2.0 | Apache Storm 위의 분산 스트리밍 크롤러. 규모가 맞지 않는다 |
| [apache/nutch](https://github.com/apache/nutch) | Java | 3,292 | GitHub 릴리스 없음 | — | Apache-2.0 | 2026-09-23 push는 있다. Apache 프로젝트는 릴리스를 dist/웹사이트로 배포하므로 GitHub 릴리스가 없다고 해서 유지보수가 끊긴 것은 아니다. 실제 릴리스 주기는 확인하지 못했다(미검증). Hadoop 기반 배치 크롤러라 규모가 맞지 않는다 |
| [apify/got-scraping](https://github.com/apify/got-scraping) | TS | 771 | v4.2.1 (2026-02-24) | 수 개월 | Apache-2.0 (npm package.json) | npm 주 304,593회. 대부분 Crawlee v3를 통한 전이 의존으로 보인다(미검증). Crawlee v4에서 기본 클라이언트 자리를 impit에 내준다(§3.2) |
| [bda-research/node-crawler](https://github.com/bda-research/node-crawler) | JS | 6,794 | v2.1.1 (2026-06-16) | 불규칙 | MIT | npm `crawler` 주 4,410회. 스타에 비해 실사용이 적다 |
| Playwright Test 기반 러너 | TS | ([microsoft/playwright](https://github.com/microsoft/playwright) 96,825) | — | — | Apache-2.0 | 테스트 하네스다. 상주 데몬이나 스케줄러 모델이 없다(판단, 문서로 확인한 것은 아님). 브라우저가 필요하면 Playwright 라이브러리를 직접 쓰는 편이 낫다([browser-automation-standards §1](browser-automation-standards.md)) |

참고로 직접 만드는 구성의 부품:

| 부품 | 스타 | 최근 릴리스 | npm 주간 |
|---|---|---|---|
| [cheeriojs/cheerio](https://github.com/cheeriojs/cheerio) | 30,515 | v1.2.0 (2026-01-23) | 31,266,589 |
| [Hexagon/croner](https://github.com/Hexagon/croner) | 2,597 | 10.0.1 (npm, 2026-09-28 갱신) | 11,287,226 |
| [kelektiv/node-cron](https://github.com/kelektiv/node-cron) | 8,949 | — | — |
| [nodejs/undici](https://github.com/nodejs/undici) (Node 내장 `fetch`의 구현) | 7,706 | — | — |

**주요 사용처**: 후보별 대표 사용 기업이나 서비스는 1차 출처로 확인하지 못했다(미검증). 확실한 것은 소유 조직뿐이다. Crawlee, got-scraping, Apify SDK는 GitHub `apify` 조직이, Scrapy는 `scrapy` 조직이 관리한다. Scrapy는 Zyte(옛 Scrapinghub)가 주도한다고 알려져 있지만 이번에 1차 확인은 하지 않았다(미검증).

## 2. 프레임워크가 주는 것과 폴러에 필요한 것

| 프레임워크 기능 | 이 폴러에 필요한가 |
|---|---|
| 요청 큐, 링크 추출·중복 제거(`enqueueLinks`, `RequestQueue`) | **필요 없다.** URL이 시설마다 고정이다. 오히려 방해가 된다. Crawlee `RequestQueue`는 `uniqueKey`(정규화한 URL)로 중복을 걸러 낸다 [1차, [adding-urls 가이드](https://crawlee.dev/js/docs/introduction/adding-urls)]. 같은 URL을 주기마다 다시 넣으면 건너뛰므로 주기마다 `uniqueKey`를 새로 만들어 줘야 한다. 큐를 디스크에 계속 쌓는지는 확인하지 못했다(미검증) |
| 큐가 비면 종료, `keepAlive`로 상주 | 상주가 기본이어야 한다. Crawlee에서는 `keepAlive: true`를 켜야 "큐가 비어도 계속 돈다" [1차, [basic-crawler.ts L320-325](https://github.com/apify/crawlee/blob/v3.18.1/packages/basic-crawler/src/internals/basic-crawler.ts#L320-L325), [running-in-web-server 가이드](https://crawlee.dev/js/docs/guides/running-in-web-server)]. 크롤이 끝나는 것이 기본 모델이라는 뜻이다 |
| 자동 스케일링 동시성(AutoscaledPool) | 필요 없다. 예약처당 연결 1개, 직렬 요청이다([polling-etiquette §5](polling-etiquette.md)) |
| 재시도(`maxRequestRetries`, 기본 3) | 부분적으로 필요하다. 다만 원하는 정책은 "5xx·타임아웃은 지수 백오프, 차단은 즉시 멈춤"이다([polling-etiquette §5](polling-etiquette.md)). 프레임워크 재시도는 실패한 요청을 큐에 다시 넣는 방식이라 다음 폴링 주기까지 기다리지 않는다(세부 지연 동작은 미검증) |
| 도메인별 속도 제한(`sameDomainDelaySecs`, `maxRequestsPerMinute`) | 필요하다. 다만 150초에 1~2건이면 `setTimeout` 하나로 충분하다 |
| 세션·쿠키 풀(`SessionPool`) | 쿠키 유지는 필요하다(숲나들e CSRF, 고래불 `PHPSESSID`). 세션을 여러 개 **돌리는** 풀은 필요 없고, 윤리 원칙과 부딪힌다(§3.1) |
| 프록시 설정·로테이션 | 쓰지 않는다(원칙) |
| HTTP↔브라우저 자동 전환(`AdaptivePlaywrightCrawler`) | 지금은 필요 없다. 필요해지면 [browser-automation-standards §2](browser-automation-standards.md) 참조 |
| 데이터셋·키-값 저장소 | 필요 없다. 상태 저장은 폴러 도메인 모델이 맡는다 |

겹치는 것은 재시도, 호스트별 간격, 쿠키 유지 정도다. 셋 다 몇십 줄이면 만든다.

## 3. 윤리 원칙과 부딪히는 기본값

### 3.1 Crawlee v3.18.1 `HttpCrawler`/`CheerioCrawler`

v3.18.1 태그 소스를 읽었다. got-scraping은 GitHub 소스와, `@crawlee/cheerio@3.18.1`을 설치했을 때 딸려 온 got-scraping 4.2.1의 `dist/index.js`를 대조했다. `useHeaderGenerator: true`, `beforeRequest` 배열의 `browserHeadersHook`·`tlsHook`, `?? "firefox"` 대체값이 모두 4.2.1 배포본에도 있다 [1차 + 측정].

| 기본 동작 | 근거 | 끄는 방법 |
|---|---|---|
| **브라우저처럼 보이는 헤더 생성.** got-scraping 기본값이 `useHeaderGenerator: true`이고, `headers['user-agent']`는 `undefined`다. 생성한 헤더 위에 사용자 헤더를 덮어쓴다 | [got-scraping src/index.ts L40-L65](https://github.com/apify/got-scraping/blob/v4.2.1/src/index.ts), [browser-headers.ts](https://github.com/apify/got-scraping/blob/v4.2.1/src/hooks/browser-headers.ts) (`mergeHeaders(generatedHeaders, options.headers)`). 공식 가이드는 이 옵션을 "recommended to be kept enabled"라고 쓴다 [1차, [got-scraping 가이드](https://crawlee.dev/js/docs/guides/got-scraping)] | `preNavigationHooks`에서 `gotOptions.useHeaderGenerator = false`로 두고 `headers['user-agent']`를 정직한 UA로 넣는다. `HttpCrawler._getRequestOptions`가 `...gotOptions`를 요청 옵션에 펼친다 [1차, [http-crawler.ts L807-L822](https://github.com/apify/crawlee/blob/v3.18.1/packages/http-crawler/src/internals/http-crawler.ts#L807-L822)] |
| **세션 단위 지문 고정.** `sessionToken: session`을 넘겨 같은 세션이면 같은 가짜 지문을 쓴다 | http-crawler.ts L814, [got-scraping 가이드 sessionToken](https://crawlee.dev/js/docs/guides/got-scraping) | 헤더 생성을 끄면 의미가 없어진다 |
| **브라우저 TLS 흉내.** `tlsHook`은 헤더 생성 여부와 **상관없이** 항상 등록된다(`beforeRequest` 배열). UA에서 Firefox/Chrome/Safari를 추정하고, 추정이 안 되면 Firefox의 cipher, sigalgs, ECDH curve, TLS 옵션을 쓴다. 정직한 UA를 넣어도 TLS는 Firefox처럼 보인다 | [got-scraping src/index.ts L24-L32](https://github.com/apify/got-scraping/blob/v4.2.1/src/index.ts), [hooks/tls.ts](https://github.com/apify/got-scraping/blob/v4.2.1/src/hooks/tls.ts) (`getBrowser(...) ?? 'firefox'`) | 문서화된 스위치가 없다. `https.ciphers`, `signatureAlgorithms`, `minVersion`, `maxVersion` 중 하나를 직접 지정하면 훅이 바로 반환한다(소스상 동작). 또는 `httpClient` 옵션으로 got-scraping을 다른 클라이언트로 교체한다 [1차, [custom-http-client 가이드](https://crawlee.dev/js/docs/guides/custom-http-client), 실험 기능으로 표시됨] |
| **차단되면 신원을 바꿔 재시도.** `useSessionPool` 기본값은 `true`다. 응답이 401/403/429이면 세션을 폐기하고 새 세션으로 재시도하며, 최대 `maxSessionRotations = 10`회까지 간다. 폴러의 요청 예산(150초에 1~2건)을 크게 넘길 수 있고, "차단 페이지를 보면 즉시 멈춤" 정책과 정반대다 | [basic-crawler.ts L646-L665](https://github.com/apify/crawlee/blob/v3.18.1/packages/basic-crawler/src/internals/basic-crawler.ts#L646-L665), [L1433-L1439](https://github.com/apify/crawlee/blob/v3.18.1/packages/basic-crawler/src/internals/basic-crawler.ts#L1433-L1439), [session_pool/consts.ts](https://github.com/apify/crawlee/blob/v3.18.1/packages/core/src/session_pool/consts.ts) (`[401, 403, 429]`). `_throwOnBlockedRequest`는 `if (this.useSessionPool)` 안에서만 호출된다 [http-crawler.ts L546-L547](https://github.com/apify/crawlee/blob/v3.18.1/packages/http-crawler/src/internals/http-crawler.ts#L546-L547) | `useSessionPool: false`로 둔다(그러면 `persistCookiesPerSession`도 못 쓰므로 쿠키는 직접 관리해야 한다 [http-crawler.ts L435-L436](https://github.com/apify/crawlee/blob/v3.18.1/packages/http-crawler/src/internals/http-crawler.ts#L435-L436)). 또는 `sessionPoolOptions.blockedStatusCodes: []`와 `maxSessionRotations: 0`을 함께 쓴다(조합 동작은 미검증) |
| **robots.txt 무시.** `respectRobotsTxtFile` 기본값이 `false`다 | [basic-crawler.ts L662](https://github.com/apify/crawlee/blob/v3.18.1/packages/basic-crawler/src/internals/basic-crawler.ts#L646-L665) | `respectRobotsTxtFile: true` |
| **TLS 인증서 검증 끔.** `ignoreSslErrors = true`가 기본이다(윤리보다는 보안 문제) | [http-crawler.ts L389](https://github.com/apify/crawlee/blob/v3.18.1/packages/http-crawler/src/internals/http-crawler.ts#L389), L819 `rejectUnauthorized: !this.ignoreSslErrors` | `ignoreSslErrors: false` |
| 프록시 로테이션 | `proxyConfiguration`을 넘길 때만 켜진다 | 넘기지 않으면 된다 |
| 브라우저 크롤러의 지문 무작위화 | [browser-automation-standards §2](browser-automation-standards.md)에 정리됨 | `browserPoolOptions.useFingerprints: false` |

정리하면 **끌 수는 있다.** 그러나 스위치가 최소 5개이고, 그중 TLS 흉내는 내부 구현에 기대야 끌 수 있다. 끄고 나면 Crawlee에 남는 것은 재시도 루프와 `keepAlive` 큐 정도다.

### 3.2 Crawlee v4 (v4.0.0-rc.0)

`docs/upgrading/upgrading_v4.md`(rc.0 태그)를 읽었다 [1차, [upgrading_v4.md](https://github.com/apify/crawlee/blob/v4.0.0-rc.0/docs/upgrading/upgrading_v4.md)].

- "The default HTTP client is now `impit`". impit은 "a Rust-based client with TLS fingerprint impersonation"이다. 설치되어 있지 않으면 "a plain `fetch`-based client with a logged warning"으로 떨어진다.
- "each new session gets a randomized realistic fingerprint by default". 세션마다 무작위 지문을 받는다.
- `ignoreSslErrors`는 `ignoreTlsErrors`로 이름이 바뀌었고 기본값은 여전히 `true`다.
- Node 22 이상이 필요하다.
- 이 프로젝트가 원하는 경로(평범한 fetch)는 v4에서 **경고를 띄우는 대체 경로**가 된다. v3에서 끈 스위치는 업그레이드할 때 다시 끄고 확인해야 한다.

### 3.3 비교 기준: Scrapy의 정직한 기본값

Scrapy는 Python이라 후보에서 빠지지만, 기본값은 레퍼런스로 쓸 만하다 [1차, [default_settings.py](https://github.com/scrapy/scrapy/blob/master/scrapy/settings/default_settings.py), [프로젝트 템플릿 settings.py.tmpl](https://github.com/scrapy/scrapy/blob/master/scrapy/templates/project/module/settings.py.tmpl)].

- `USER_AGENT = f"Scrapy/{version} (+https://scrapy.org)"`. 도구 이름, 버전, URL을 밝힌다.
- 전역 기본값은 `ROBOTSTXT_OBEY = False`지만, `scrapy startproject`가 만드는 템플릿은 `ROBOTSTXT_OBEY = True`와 `DOWNLOAD_DELAY = 1`로 시작한다.
- `DOWNLOAD_DELAY_JITTER = 0.5`, `CONCURRENT_REQUESTS_PER_DOMAIN = 8`, `AUTOTHROTTLE_ENABLED = False`.
- Colly도 UA를 설정 가능한 필드(`c.UserAgent`)로 둔다 [1차, [colly.go](https://github.com/gocolly/colly/blob/master/colly.go)]. 기본 UA 문자열은 확인하지 못했다(미검증).

## 4. Node 기준 비교: Crawlee(JS) 대 fetch + cheerio + 직접 만든 루프

설치 크기는 빈 프로젝트에 `npm i`를 하고, `npm ls --all --parseable | sort -u`로 패키지 수를 세고, `du -sh node_modules`로 크기를 쟀다. Node v24.19.0 기준이다 [측정].

| 항목 | Crawlee v3 (`@crawlee/cheerio@3.18.1`) | fetch + cheerio + croner |
|---|---|---|
| 설치 패키지 수 | 136 | cheerio 24 + croner 2 |
| `node_modules` 크기 | 37 MB | cheerio 9.0 MB + croner 168 KB |
| 딸려 오는 것 | got, got-scraping, header-generator, `@apify/*` 7개, `@crawlee/*` 7개 | 없음 |
| HTTP 클라이언트 | got-scraping(헤더·TLS 흉내, §3.1) | Node 내장 `fetch`(undici). 정직한 UA를 넣으면 그대로 나간다 |
| 쿠키 | `SessionPool` + `persistCookiesPerSession`. 단 이것을 켜면 차단 시 세션 로테이션도 같이 켜진다 | 내장 `fetch`에는 쿠키 저장소가 없다. `Headers.getSetCookie()`로 직접 모으거나 `tough-cookie`를 추가해야 한다. 숲나들e(CSRF)처럼 쿠키가 필요한 예약처에서는 반드시 만들어야 하는 부분이다 |
| 호스트별 최소 간격·지터 | `sameDomainDelaySecs`, `maxRequestsPerMinute` | 직접 만든다(`setTimeout` + 지터, 호스트별 마지막 요청 시각) |
| 타임아웃 | `navigationTimeoutMillis` | `AbortSignal.timeout(ms)` |
| 재시도·백오프 | `maxRequestRetries`(즉시 재시도 성격). `Retry-After`와 지수 백오프 정책은 결국 직접 짜야 한다 | 직접 만든다. [polling-etiquette §5](polling-etiquette.md) 정책을 그대로 코드로 옮긴다 |
| 상주 스케줄 | `keepAlive` + 주기마다 `uniqueKey`를 바꿔 재투입 | `croner`나 `setTimeout` 루프 |
| robots.txt | `respectRobotsTxtFile` | 직접 만든다(24시간 캐시, [browser-automation-standards §3](browser-automation-standards.md)의 RFC 9309) |
| 학습 비용 | 크롤러 계층, 라우터, 큐, 세션 풀, 스토리지, 훅 개념과 끌 스위치 5개 이상 | Web 표준 `fetch`와 jQuery 스타일 선택자 |
| 업그레이드 위험 | v4에서 기본 클라이언트가 TLS 위장 클라이언트로 바뀐다 | 낮다 |

직접 만드는 쪽의 비용도 분명히 있다. 쿠키 저장소, 호스트별 간격, `Retry-After`를 포함한 백오프, 타임아웃, robots.txt 캐시는 직접 짜고 테스트해야 한다. 규모는 수백 줄 이하로 예상한다(추정). 대신 모든 동작이 [polling-etiquette](polling-etiquette.md) 정책과 1:1로 대응하고, 끄는 것을 잊은 위장 기본값이 끼어들 여지가 없다.

## 5. 권고

1. **프레임워크를 쓰지 않는다.** Node 내장 `fetch` + `cheerio` + 직접 만든 스케줄 루프(선택적으로 `croner`)로 간다. 쿠키가 필요한 예약처가 생기면 `tough-cookie`를 더한다.
2. 루프는 Scrapy의 정직한 기본값을 따른다. `overlord/0.1 (+연락처 URL)` UA와 `From` 헤더, robots.txt 준수, 호스트별 직렬 요청과 지터를 넣는다. 세부 값은 [polling-etiquette §5](polling-etiquette.md)를 따른다. 간격은 문서마다 다르다. 이 티켓은 150초를 전제했고 polling-etiquette §5는 60초 ±25%를 제안한다. 어느 쪽으로 할지는 폴링 정책 티켓에서 정한다. 이 문서의 결론은 어느 간격이든 똑같다.
3. 브라우저가 필요해지면 Playwright 라이브러리를 직접 쓴다. Crawlee의 적응형 크롤러를 검토할 경우 [browser-automation-standards §2](browser-automation-standards.md)와 이 문서 §3의 스위치 목록을 함께 적용한다.
4. Crawlee를 나중에 다시 검토한다면 최소한 `useHeaderGenerator: false`, TLS 옵션 명시(또는 `httpClient` 교체), `useSessionPool: false`, `respectRobotsTxtFile: true`, `ignoreSslErrors: false`가 필요하다. v4로 올릴 때는 impit 기본값 때문에 다시 점검해야 한다.

## 6. 남은 불확실성

- 각 프레임워크의 대표 사용처(미검증).
- Crawlee `RequestQueue`를 상주 모드로 오래 돌릴 때 로컬 저장소가 계속 커지는지(미검증).
- `blockedStatusCodes: []`와 `maxSessionRotations: 0` 조합으로 세션 풀을 켠 채 로테이션만 막을 수 있는지(미검증, 소스상 가능해 보인다).
- Nutch의 실제 릴리스 주기(Apache dist 미확인).
