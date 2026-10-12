# xticket 달서별빛캠프(`dalseo`) 기록 (#69)

2026-10-12 17:52~18:0x KST(평일 오후), ADR 0002 원칙으로 한 번 기록했다. UA `overlord-availability-poller/0.1 (personal availability notifier)`,
`camp.xticket.kr` 요청 사이 5~8초(302 홉도 한 건씩 5초 이상 띄웠다). 로그인·captcha·봇 탐지 호출 없음. 접근 금지 경로 호출 없음.
`robots.txt`는 이번에 다시 요청하지 않았다(스펙 #68이 404로 기록).
요청은 모두 `curl`이고, 응답 형식·헤더는 브라우저와 같게 보냈다(아래 "요청 형식").

shopEncode: `f27ad3485cf140b64341e2cc975c376d14561a12aca07349ae393d97379882c7`. **유효하다**(`GetShopInformation.json`이 `shop_name: 달서별빛캠프 캠핑장`).

## 요청 순서

1. GET `/web/main?shopEncode=<값>` -> 302 `/Web/Reservation?shop_encode=<값>` (+ `JSESSIONID`, `AWSELB` Set-Cookie) -> `headers_h1.txt`
2. GET `/Web/Reservation?shop_encode=<값>` -> 302 `/web/main?shopEncode=<값>` -> `headers_h2.txt`
3. GET `/web/main?shopEncode=<값>` (쿠키 있음) -> 200, 23KB -> `main.html`
4. GET `/resources/accommodation/js/main.js?ver=20260518`, `/resources/js/common.js?ver=20260518` (페이지가 싣는 스크립트) -> `main.js`, `common.js`
5. POST `/Web/Book/GetShopInformation.json` `shop_encode=<값>` -> `GetShopInformation.json` (`web_store_key`·`web_cancel_key`·`web_store_id`·`mobile_store_id`는 `<masked>`)
6. POST `/Web/Book/GetBookPlayDate.json` `play_month=202610|202611|202612` -> `GetBookPlayDate_*.json`
7. POST `/Web/Book/GetBookProductGroup.json` `start_date&end_date`(월 범위, 하루) -> `GetBookProductGroup_*.json`
8. POST `/Web/Book/GetBookProduct010001.json` `product_group_code, start_date, end_date, book_days, two_stay_days` -> `GetBookProduct010001_*.json`

값을 가린 곳: `Set-Cookie` 값(`<masked>`), 위 네 키. 쿠키 단지는 저장하지 않았다. 다른 파일에는 가릴 값이 없다.

## 요청 형식(확인한 것)

- 본문은 **form 인코딩**이다(`Content-Type: application/x-www-form-urlencoded; charset=UTF-8`). JSON 본문이 아니다. 응답이 JSON이다. 페이지는 `$.post(url, {객체}, 콜백)`을 쓴다.
- `Referer`(`https://camp.xticket.kr/web/main?shopEncode=<값>`)와 `Origin`(`https://camp.xticket.kr`), `X-Requested-With: XMLHttpRequest`를 실어야 한다. 빼면 HTTP 200에 본문 `{}`가 온다(`GetBookPlayDate_202610.no-referer.json`).
  `Referer`와 `Origin` 가운데 어느 쪽이 필수인지는 가르지 않았다(둘 다 보낸다).
- 쿠키(`JSESSIONID`)가 없으면 `{"error":{"message":"세션이 만료되었습니다. 다시 시도 부탁드립니다."},"returnUrl":"main?shopEncode=","redirect":true}`(`GetBookPlayDate_202610.no-cookie.json`). HTTP 200이다.
  시설은 세션에 묶인다(`/web/main?shopEncode=`로 정해진다). 이후 POST 본문에는 시설 값이 없다.
- 페이지는 `GetShopInformation.json` 응답을 받은 뒤 모든 POST에 `shopCode=<shop_code>`를 덧붙이지만(common.js `ajaxPrefilter`), 서버는 이것 없이도 응답한다(`GetBookPlayDate_202611.json`은 `shopCode` 없이 받았다).
- 응답은 `Content-Type: application/json;charset=UTF-8`, 오류는 `{"error": {...}}` 또는 `{"error1": {...}, "redirect": true, "returnUrl": ...}`(main.js의 `loadedBook*` 핸들러)다.

## 확인한 사실

- **상품군**(`GetBookProductGroup.json`, 월 범위와 하루 범위 모두 같은 4개): `0001` 카라반, `0002` 오토캠핑장, `0003` 숲속캠핑장, `0004` 데크캠핑장(모두 `product_group_kind: 010001`).
- **`GetBookProductGroup.json`·`GetShopInformation.json` 선행 필요 없음**: 쿠키 단지를 비운 새 세션에서 `/web/main`(302 두 번 뒤 200) -> `GetBookPlayDate.json`(`shopCode` 없음) -> `GetBookProduct010001.json`(0001, `two_stay_days=0`)만 불러 정상 응답을 받았다
  (18:01 KST, `clean_session_GetBookPlayDate_202610.json`, `clean_session_GetBookProduct010001_0001_20261015_1n.json`). 그래서 스펙의 바퀴(main -> 달마다 PlayDate -> 남은 날만 Product)가 그대로 선다.
  첫 기록의 같은 요청(`GetBookProduct010001_0001_20261015_1n.json`)은 `GetShopInformation.json` 호출 뒤였지만, 새 세션 결과가 같다.
- **`two_stay_days`·`shopInfo`의 출처**: `POST /Web/Book/GetShopInformation.json {shop_encode}`(`common.js`의 `loadShopInfo`)가 `shopInfo`를 준다. 달서는 `two_stay_days: 0`, `book_days: 3`, `play_month: 202610`.
  `GetBookProduct010001.json`은 `two_stay_days`를 빼도 같은 응답을 준다(`..._1n.no-two_stay_days.json`).
- **최대 박수**: 페이지가 박수 선택지를 `shopInfo.book_days`(달서 3)까지 만든다(`main.js` `applyStayDays`). 서버는 `book_days: 4`도 거부하지 않고 응답했다(`GetBookProduct010001_0001_20261019_4n.json`, 선택가능 3). 서버 상한은 알 수 없고, 페이지 상한(3박)을 쓴다. 이번 조각의 최대 박수는 1이다.
- **`start_date`/`end_date`**: `end_date = start_date + (book_days - 1)`일(페이지 `DayAdd(date, days - 1)`).
- **오픈 규칙**: `GetBookPlayDate.json`은 오늘(10/12)부터 11/30까지만 날짜를 주고 12월(`202612`)과 지난 달(`202609`)은 빈 배열이다. `shopInfo.advance_period`가 `2026.10.01 14:00 ~ 2026.10.02 13:00 (11월분)`이고
  `warning_text`가 "타지역민예약 오픈: 10월 2일(금) 14:00"이다. 즉 다음 달분이 매월 초(1일 14:00 달서구민 우선, 2일 14:00 일반)에 열리는 것으로 보인다. 정확한 규칙은 한 번의 기록으로 확정하지 못했다.
  그래서 `GetBookPlayDate.json`이 주지 않는 날짜를 빈자리 없음으로 친다.
  **당일 마감**: 17:54 KST 응답에는 오늘(10/12)이 있었고 18:01 KST 응답(새 세션)에는 없었다(10/13부터). 당일 입실은 18:00 KST에 마감되는 것으로 본다(`sameDayCutoff: 18:00`). 한 번의 기록이라 정확한 분은 모른다.
- **`advance_yn`**: 날짜별 값. `main.js`에서 `advance_yn == '1'`인 날은 달력에서 `advance`(우선예약) 칸으로 그리고, 그 날을 누르면 `showAdvanceInfoLayer()`(우선예약 대상 `advance_target`, 증빙 `advance_proof` 안내)를 거쳐 captcha로 간다.
  `shopInfo.advance_target`은 "달서구민 우선예약(달서구에 주민등록을 둔 자)"이다. 즉 해당 주민에게만 열린 우선예약 날짜다. 이번 기록의 모든 날짜는 `advance_yn: "0"`이다(우선예약 기간 `2026.10.01 14:00 ~ 10.02 13:00`은 이미 지났다).
  `validateSchedule`은 연박의 모든 날이 같은 `advance_yn`일 때만 선택을 허용한다.
- **`status_code`**: 이 기록에서 `(0,0)`, `(0,1)`, `(1,0)`을 봤다. `1`은 조사 때 없던 값이다(select_yn 0, 페이지의 `getProductAlt`는 예약완료로 그린다). `(3,1)`은 이번에는 보지 못했다.
- **봇 탐지·captcha**: 조회 흐름(`main.html`, `main.js`, `common.js`)에 `crawlingCheck`, `dynapath`, `botmanager` 등은 없다. captcha는 `clickReservation`(로그인 후 예약 신청)에서만 `/Web/jcaptcha`를 불러오고 `Book010001.json`을 보낸다. 조회 요청 응답에 captcha가 오지 않았다.
- **접근 금지 경로**(스크립트·화면 링크에서 확인): `/Web/Book/Book010001.json`(예약 확정), `/Web/jcaptcha`, `/Web/Member/`(MemberLogin·MemberLogout·ChangePassword), `/web/books`(예약내역 결제/취소), `/web/profile`, `/web/join`, `/web/findId`, `/web/ciRequest`, `/web/ipinRequest`.
- 응답 크기·시간: `GetBookPlayDate.json` 1.3KB, `GetBookProduct010001.json` 14개에 약 5KB, 모두 0.2초 안쪽이다.

## 달서별빛캠프 1015(목) 카라반(0001) 1박

`(0,1)` 2곳(카라반-11, 카라반-13), `(1,0)` 1곳(카라반-01), 나머지 `(0,0)`. `GetBookPlayDate_202610.json`의 `20261015`는 `book_remain_count: 3`이다. 카라반 2곳보다 많으니 `book_remain_count`는 상품군 전체 합으로 보인다(0003·0004는 이 날 조회하지 않았다). 오토캠핑장(0002)은 같은 날 15곳 모두 `(0,0)`이다.
테스트용 fixture는 `test/fixtures/xticket-*.json`으로 같은 원문을 복사했다.

# 나정고운모래해변(`najeong`)·칠곡보(`chilgokbo`) 기록 (#70)

2026-10-12 저녁 KST, ADR 0002 원칙(UA `overlord-availability-poller/0.1 (personal availability notifier)`, 요청 사이 5~8초, 302 홉도 한 건씩)으로 `camp.xticket.kr`에 시설마다 몇 건씩 보냈다. 로그인·captcha·봇 탐지 호출과 접근 금지 경로 요청은 없다. 요청은 `curl`이고 형식은 달서 기록과 같다.
쿠키 값과 `GetShopInformation.json`의 `web_store_key`·`web_cancel_key`·`web_store_id`·`mobile_store_id`는 `<masked>`다. 파일은 `najeong_*`, `chilgokbo_*`다.

## 운영 주체(시설 공식 안내)

- 나정: 경주시가 조성한 시설이다(경주시 웹진 「지금, 나정고운모래해변 오토캠핑장으로」, 공식 사이트 njcamping.or.kr 하단 "Copyright 2022 경주시청"). 사이트에 대표자 이름이 있어 위탁 운영으로 보이지만 공립 시설이다. 예약 링크는 사이트의 "실시간예약"(`www.xticket.kr/Web/Reservation?shop_encode=08f2d6ac...`)이고 같은 값이 `camp.xticket.kr/web/main?shopEncode=`에서도 열린다.
- 칠곡보: 칠곡군 관광 누리집(chilgok.go.kr/tour)의 부속사이트 "칠곡보오토캠핑장 예약" 링크가 `camp.xticket.kr/web/main?shopEncode=3b8dfd4f...`다. 지자체 시설이라 민간이 아니다. 소개란의 "홈페이지 바로가기"는 땡큐캠핑(`m.thankqcamping.com`)이다.

## 나정 확인한 사실

- 흐름은 달서와 같다: `/web/main`(302 두 번 뒤 200) -> `GetShopInformation.json` -> `GetBookPlayDate.json` -> `GetBookProductGroup.json` -> `GetBookProduct010001.json`(`najeong_*`).
- `shopInfo`: `shop_name: 나정고운모래해변`, `two_stay_days: 0`, **`book_days: 2`**, `advance_ddays: 0`, `max_book_count: 1`. 최대 박수는 달서 3, 나정 2로 시설마다 다르다. 시설 안내도 "1회 최대 2박 3일"이다.
- 상품군(`GetBookProductGroup.json`): `0101` 카라반사이트, `0201` 오토사이트.
- 날짜 목록은 10/13부터 11/30까지이고 `advance_yn`은 모두 "0"이다(우선예약 없음).
- 자리 판정: 10/16 카라반사이트(40곳) 1박은 `(0,1)` 10곳, 2박(`book_days: 2`)은 모두 `(0,0)`, 3박(`book_days: 3`, 페이지 상한 밖)도 모두 `(0,0)`이고 서버는 거부하지 않았다. 10/18~19 2박은 `(0,1)` 28곳이다. 서버가 박수에 맞춰 판정한다.

## 칠곡보 확인한 사실

- 같은 요청 흐름이 `/web/main` -> 302 `/Web/Reservation` -> 302 `/web/error.html?code=9001`("잘못된 접근입니다.")로 끝난다(`chilgokbo_headers_h1.txt`, `chilgokbo_headers_h2.txt`, `chilgokbo_error_9001.html`). 이 shopEncode는 xticket에서 열리지 않아 카탈로그에 넣지 않았다.

# 카탈로그 채우기와 `--live` 기록 (#71)

2026-10-12 저녁 KST, 같은 원칙(정직한 UA, 요청 사이 5~8초, 302 홉도 한 건씩)으로 시설마다 `/web/main`(302 두 번 뒤 200) -> `GetShopInformation.json` -> `GetBookProductGroup.json`(내일 10/13) -> 상품군마다 `GetBookProduct010001.json`(1박)을 한 번씩 보냈다.
로그인·captcha·봇 탐지 호출과 접근 금지 경로 요청은 없었고, 시설 화면에 `crawlingCheck`·`dynapath`·`botmanager`는 없었다. 쿠키와 `GetShopInformation.json`의 키 네 개는 `<masked>`다. 파일은 `gyeongju-caravan_*`, `gangdong_*`, `aengbongsan_*`, `gangnaru_*`다.

- `shopInfo.book_days`: 경주 별빛카라반 2, 강동그린웨이 3, 앵봉산 2, 강나루 2. `two_stay_days`는 모두 0이다. 강나루는 `advance_ddays: 1`(함안군민 우선예약)이다.
- `gangdong_GetBookProduct010001_9999_20261013_1n.json`: 없는 상품군 코드(9999)로 한 번 조회하면 `{"data":{"bookProductList":[]}}`다(`gangdong_probe_headers_h*.txt`). 정상 상품군은 모든 자리를 주므로 빈 목록을 상품군 소실로 본다.
- 강동그린웨이 0001에서 `status_code` `3`이 보였다.
- `catalog_live_20261012.txt`: 시설마다 실제로 돌린 `node dist/main.js catalog xticket <시설> --live`의 출력이다(달서·나정·경주 별빛카라반·강동그린웨이·앵봉산·강나루 모두 "차이 없음", 종료 코드 0).
