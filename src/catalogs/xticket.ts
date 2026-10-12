// xticket(camp.xticket.kr) 시설·구역 카탈로그. 정적 목록이며 어댑터 로직과 네트워크 코드는 두지 않는다.
// 출처: 달서별빛캠프는 2026-10-12 17:52~18:02 KST 기록(research/raw/xticket)이다. 시설 `ref`는 `shopEncode`이고, 구역은 상품군(`product_group_code`)이다.
//
// 기록으로 확인한 것(#69, 달서별빛캠프):
// - `shopEncode`(고캠핑 `resveUrl`의 값 f27ad348...)는 유효하다. `GetShopInformation.json`이 `shop_name: 달서별빛캠프 캠핑장`을 준다.
// - 상품군(`GetBookProductGroup.json`, 월 범위와 하루 범위가 같다): 0001 카라반, 0002 오토캠핑장, 0003 숲속캠핑장, 0004 데크캠핑장. 자리는 상품(`product_name`, 예: 카라반-11)이고 자리 목록은 적지 않는다(자리 필터가 필요한 시설만 적는다).
// - 선행 호출 없음: 쿠키가 비어 있는 새 세션에서 `/web/main`(302 두 번) -> `GetBookPlayDate.json` -> `GetBookProduct010001.json`만으로 응답한다.
//   `GetBookProductGroup.json`도 `GetShopInformation.json`도 먼저 부르지 않아도 된다.
// - 요청 본문은 **form 인코딩**(`application/x-www-form-urlencoded; charset=UTF-8`)이고 응답이 JSON이다. 쿠키(`JSESSIONID`)가 없으면 HTTP 200에 `{"error":{"message":"세션이 만료되었습니다..."},"redirect":true}`,
//   `Referer`·`Origin`이 없으면 HTTP 200에 `{}`가 온다. POST에는 `Referer`(`/web/main?shopEncode=<값>`), `Origin`, `X-Requested-With: XMLHttpRequest`를 싣는다.
//   시설은 세션에 묶이므로(본문에 시설 값이 없다) 시설을 바꿀 때 `/web/main?shopEncode=<새 값>`부터 새 세션으로 연다. `shopCode`(페이지가 덧붙이는 값)는 필요 없다.
// - `shopInfo`는 `POST /Web/Book/GetShopInformation.json {shop_encode}`가 준다. 달서는 `two_stay_days: 0`, `book_days: 3`(페이지 박수 선택지 상한), `advance_ddays: 0`.
//   `GetBookProduct010001.json`은 `two_stay_days`를 빼도 같은 응답이라 어댑터는 `two_stay_days=0`을 보낸다(페이지는 `shopInfo.two_stay_days`를 보낸다). 0이 아닌 시설(2박3일 우선 예약)은 시설 단위 덮어쓰기가 필요하다.
// - 최대 박수: 페이지는 `shopInfo.book_days`(달서 3)까지만 고르게 한다. 서버는 `book_days: 4`도 거부하지 않았다. 이 예약처의 `maxNights`는 이번 조각에서 1이다.
// - 날짜 목록(`GetBookPlayDate.json`): 17:54 KST에는 오늘(10/12)부터, 18:01 KST에는 내일(10/13)부터 11/30까지다. 12월과 지난 달은 빈 배열이다. 당일 입실은 18:00 KST에 마감되는 것으로 본다.
//   `shopInfo.advance_period`("2026.10.01 14:00 ~ 10.02 13:00 (11월분)")와 `warning_text`("타지역민예약 오픈: 10월 2일(금) 14:00")로 보아 다음 달분이 매월 초에 열린다. 확정한 규칙이 아니라서 목록이 주지 않는 날짜는 빈자리 없음으로 친다.
//   `book_remain_count`는 상품군 전체 합으로 보인다(1015는 3인데 카라반 선택가능은 2곳). 0이면 어느 상품군에도 자리가 없다.
// - `advance_yn`(날짜별): "1"이면 우선예약 날짜(달서구민에게만 열림, `advance_target`·`advance_proof`)다. 일반 이용자는 예약할 수 없으므로 조회 단위에서 뺀다. 기록한 모든 날짜는 "0"이었다.
// - `status_code`: `(0,1)` 선택가능, `(0,0)` 판매됨, `(1,0)` 예약완료로 읽힌다(조사 때 없던 `1`). `(3,1)`은 이번 기록에서 보지 못했다. 판정은 페이지 `main.js`의 `getProductAlt`와 같다.
// - 봇 탐지·captcha: 조회 흐름에 `crawlingCheck`·`dynapath`·`botmanager`는 없다. captcha(`/Web/jcaptcha`)는 로그인 뒤 예약 신청(`Book010001.json`) 직전에만 쓰인다.
// - 접근 금지로 확인한 경로(`main.js`·`common.js`·화면 링크): `/Web/Book/Book010001.json`(예약 확정), `/Web/jcaptcha`, `/Web/Member/`(로그인·로그아웃·비밀번호 변경),
//   `/web/books`(예약내역 결제·취소), `/web/profile`, `/web/join`, `/web/findId`, `/web/ciRequest`, `/web/ipinRequest`. 서버가 `/Web`과 `/web`을 가리지 않으므로 대소문자 구분 없이 막는다.
// - 이 목록은 지자체·공공기관 운영 시설만 담는다. 칠곡보 등 다른 시설은 #70 이후에 더한다.
import type { FacilityInfo, ZoneInfo } from "../types.js";

const dalseoZones: ZoneInfo[] = [
  { code: "0001", name: "카라반", type: "카라반" },
  { code: "0002", name: "오토캠핑장", type: "오토캠핑장" },
  { code: "0003", name: "숲속캠핑장", type: "숲속캠핑장" },
  { code: "0004", name: "데크캠핑장", type: "데크캠핑장" },
];

export const facilities: FacilityInfo[] = [
  {
    code: "dalseo",
    name: "달서별빛캠프 캠핑장",
    ref: "f27ad3485cf140b64341e2cc975c376d14561a12aca07349ae393d97379882c7",
    zones: dalseoZones,
  },
];
