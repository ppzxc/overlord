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
// - 이 목록은 지자체·공공기관 운영 시설만 담는다.
//
// 기록으로 확인한 것(#70, 2026-10-12 저녁 KST, research/raw/xticket의 najeong_*·chilgokbo_*):
// - 나정고운모래해변 오토캠핑장(`najeong`): 경주시가 조성한 공공 시설이다(경주시 누리집 웹진 「지금, 나정고운모래해변 오토캠핑장으로」, 사이트 njcamping.or.kr 하단 "Copyright 2022 경주시청"). 위탁 운영자가 있는 공립 시설로 보고 넣는다.
//   예약 링크는 시설 공식 사이트 njcamping.or.kr의 "실시간예약"(`www.xticket.kr/Web/Reservation?shop_encode=08f2d6ac...`)에서 읽었다. 같은 값이 `camp.xticket.kr/web/main?shopEncode=`에서도 열린다(302 두 번 뒤 200).
//   `GetShopInformation.json`: `shop_name: 나정고운모래해변`, `two_stay_days: 0`, `book_days: 2`(박수 선택지 상한), `advance_ddays: 0`, `max_book_count: 1`. 상품군은 `0101` 카라반사이트, `0201` 오토사이트이다.
//   서버는 `book_days: 3`도 거부하지 않고 응답했지만(선택가능 0) 시설 안내도 "1회 최대 2박 3일"이라 페이지 상한 2박을 쓴다. 날짜 목록은 내일(10/13)부터 11/30까지다(달서와 같은 모양, `advance_yn` 모두 "0").
//   2박 조회(`book_days: 2`, 10/16~10/17 카라반사이트)에서는 1박에서 선택가능이던 10곳이 모두 선택불가로 돌아왔다. 서버가 박수에 맞춰 판정한다는 증거다.
// - 칠곡보 오토캠핑장(`chilgokbo`): 넣지 않았다. 칠곡군 관광 누리집이 "칠곡보오토캠핑장 예약"으로 `camp.xticket.kr/web/main?shopEncode=3b8dfd4f...`를 걸어 두었지만(운영은 칠곡군, 민간이 아니다), 이 값은 xticket에서 열리지 않는다.
//   `/web/main`이 302로 `/Web/Reservation`을 거쳐 `/web/error.html?code=9001`("잘못된 접근입니다.")로 보낸다. 같은 요청 흐름이 달서·나정에서는 200이다. 같은 누리집 소개란의 "홈페이지 바로가기"는 땡큐캠핑(`m.thankqcamping.com`)이라 예약이 옮겨 갔을 가능성이 크다.
//   그래서 xticket 어댑터가 볼 수 없는 시설로 보고 카탈로그에 두지 않는다.
//
// 기록으로 확인한 것(#71, 2026-10-12 저녁 KST, research/raw/xticket의 gyeongju-caravan_*·gangdong_*·aengbongsan_*·gangnaru_*): 운영 주체와 `shopEncode`는 시설 공식 안내의 예약 링크로,
// 상품군은 `catalog xticket <시설> --live`(내일 10/13, `GetBookProductGroup.json`)로 확인해 아래에 넣었다. 네 값 모두 `/web/main`이 302 두 번 뒤 200으로 열렸다. 조회 흐름에 `crawlingCheck`·`dynapath`·`botmanager`·captcha는 없었다.
// - 경주시종합자원화단지 별빛카라반(`gyeongju-caravan`): 경주시 천군동 종합자원화단지에 경주시가 조성한 시설이고 위탁 운영자(2021년 (주)유니레저, 경북매일)가 운영한다. 폐기물처리시설 영향지역 주민 감면이 있는 주민지원 성격의 공공 시설이라 넣는다(나정과 같은 기준).
//   고캠핑이 "민간"이라 적은 값은 이 근거로 따르지 않았다. 값은 공식 예약 안내(보문카라반파크 홈페이지 실시간예약, `www.xticket.kr/Web/Reservation?shop_encode=8918d7dc...`)에서 읽었다.
//   `shop_name: 별빛카라반`, `book_days: 2`(박수 상한), `two_stay_days: 0`. 상품군 `0101` 카라반, `0401` 글램핑, `0701` 캠핑사이트.
// - 강동그린웨이 가족캠핑장(`gangdong`): 서울시 서울캠핑장 안내에 오른 강동구의 공영 캠핑장이고 예약 안내는 강동구 공단 누리집(igangdong.or.kr)이 낸다(seoul.go.kr/storyw/campingjang/gangdong.do, igangdong.or.kr/page/ce/ce_0201.asp). 공단의 정확한 명칭과 위탁 여부는 두 안내에 적혀 있지 않다.
//   값 `5f9422e2...`는 그 두 곳의 "예약 바로가기"에서 읽었다. `shop_name: 그린웨이가족캠핑장`, `book_days: 3`, `two_stay_days: 0`. 상품군 `0001` 가족캠핑장, `0002` 오토캠핑장, `0003` 매화나무캠핑장.
//   `0001`에서 `status_code` `3`을 봤다(어댑터는 예약완료로 치고 로그 경고만 남긴다).
// - 앵봉산 가족캠핑장(`aengbongsan`): 서울 은평구 앵봉산 공공 캠핑장이다(서울시 서울캠핑장 안내 seoul.go.kr/storyw/campingjang/angbong.do, 은평구 개장 보도). 값 `a12d6508...`은 그 안내의 예약 링크에서 읽었다.
//   `shop_name: 앵봉산캠핑장`, `book_days: 2`, `two_stay_days: 0`. 상품군 `0001` 데크캠핑장, `0002` 글램핑. 관내 거주자 우선예약(매월 8일)·고향사랑기부 예약(9일)이 있고 일반 예약은 매월 10일 13:00에 열린다(서울시 안내).
// - 강나루 오토캠핑장(`gangnaru`, 함안): 함안군(안전총괄과 하천관리담당)이 관리하는 공공 시설이다(함안군 문화관광포털 haman.go.kr/01834/01861/01917.web). 고캠핑에는 값이 없었지만 이 페이지의 "실시간예약" 링크에 값이 있다(`0ca2dbc4...`).
//   `shop_name: 강나루오토캠핑장`, `book_days: 2`, `two_stay_days: 0`, `advance_ddays: 1`(함안군민 우선예약, 날짜별 `advance_yn`으로 걸러진다). 상품군 `0002` 1캠핑장(오토캠핑60면), `0003` 2캠핑장(오토캠핑77면).
// - 없는 상품군 코드로 `GetBookProduct010001.json`을 보내면 `{"data":{"bookProductList":[]}}`이다(gangdong_GetBookProduct010001_9999). 정상 상품군은 자리 상태와 관계없이 모든 자리를 주므로 빈 목록을 상품군 소실로 본다.
import type { FacilityInfo, ZoneInfo } from "../types.js";

const dalseoZones: ZoneInfo[] = [
  { code: "0001", name: "카라반", type: "카라반" },
  { code: "0002", name: "오토캠핑장", type: "오토캠핑장" },
  { code: "0003", name: "숲속캠핑장", type: "숲속캠핑장" },
  { code: "0004", name: "데크캠핑장", type: "데크캠핑장" },
];

const najeongZones: ZoneInfo[] = [
  { code: "0101", name: "카라반사이트", type: "카라반" },
  { code: "0201", name: "오토사이트", type: "오토캠핑장" },
];

const gyeongjuCaravanZones: ZoneInfo[] = [
  { code: "0101", name: "카라반", type: "카라반" },
  { code: "0401", name: "글램핑", type: "글램핑" },
  { code: "0701", name: "캠핑사이트", type: "캠핑사이트" },
];

const gangdongZones: ZoneInfo[] = [
  { code: "0001", name: "가족캠핑장", type: "가족캠핑장" },
  { code: "0002", name: "오토캠핑장", type: "오토캠핑장" },
  { code: "0003", name: "매화나무캠핑장", type: "매화나무캠핑장" },
];

const aengbongsanZones: ZoneInfo[] = [
  { code: "0001", name: "데크캠핑장", type: "데크캠핑장" },
  { code: "0002", name: "글램핑", type: "글램핑" },
];

const gangnaruZones: ZoneInfo[] = [
  { code: "0002", name: "1캠핑장(오토캠핑60면)", type: "오토캠핑장" },
  { code: "0003", name: "2캠핑장(오토캠핑77면)", type: "오토캠핑장" },
];

export const facilities: FacilityInfo[] = [
  {
    code: "dalseo",
    name: "달서별빛캠프 캠핑장",
    ref: "f27ad3485cf140b64341e2cc975c376d14561a12aca07349ae393d97379882c7",
    zones: dalseoZones,
    maxNights: 3,
  },
  {
    code: "najeong",
    name: "나정고운모래해변 오토캠핑장",
    ref: "08f2d6ac872d55a829cd62de5a910ff0922eeb57506d4ddbe021224fce47d006",
    zones: najeongZones,
    maxNights: 2,
  },
  {
    code: "gyeongju-caravan",
    name: "경주시종합자원화단지 별빛카라반",
    ref: "8918d7dcb333ee50b6d26bbef7501b526cd576f4a91f2f5bf82278f6096f486f",
    zones: gyeongjuCaravanZones,
    maxNights: 2,
  },
  {
    code: "gangdong",
    name: "강동그린웨이 가족캠핑장",
    ref: "5f9422e223671b122a7f2c94f4e15c6f71cd1a49141314cf19adccb98162b5b0",
    zones: gangdongZones,
    maxNights: 3,
  },
  {
    code: "aengbongsan",
    name: "앵봉산 가족캠핑장",
    ref: "a12d6508ae5ea0562923cb1f2762761f3413ab4c988a6c8aa92ea7873e263bec",
    zones: aengbongsanZones,
    maxNights: 2,
  },
  {
    code: "gangnaru",
    name: "강나루 오토캠핑장",
    ref: "0ca2dbc468034c0554a59d50a00e1fa0d273547243cd913e8ffc7fe403c13729",
    zones: gangnaruZones,
    maxNights: 2,
  },
];
