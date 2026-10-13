// 울주군립야영장 통합 예약처(camping.ulju.ulsan.kr) 시설·구역 카탈로그. 정적 목록이며 어댑터 로직과 네트워크 코드는 두지 않는다.
// 시설 `ref`는 예약 화면 라디오의 `classes` 값이고, 구역은 `FACILITY_ID`(이름 `FACILITY_NAME`), 자리는 `CAMP_ID`(이름 `NAME`)다. 자리 id는 `NAME`이다.
// 출처: 네 시설 모두 2026-10-12 18:37~18:49 KST 기록(research/raw/ulju, #73)이다. 시설마다 2026-10-16 하루만 받았다. 호스트의 robots.txt는 `Yeti`(네이버)에만 `Allow: /`를 선언하고 `*` 규칙이 없다.
// `--live` 확인(#75): 2026-10-12 19:03~19:04 KST에 `catalog ulju <시설> --live`를 네 시설에 각각 한 번씩(요청 1회, 내일 2026-10-13, 사이 8초 이상) 실제로 돌려 구역 코드·이름이 모두 일치했다.
//   등억알프스·작천정달빛·대운산하늘숲은 기록(10-16)과 같은 구역이었고 자리 수도 같았다. 대운산하늘숲은 자리 목록까지 일치했다.
//
// 자리 목록(`seats`)은 자리 필터(`seats:` 토큰 `A02`, `A10-A15`)를 쓸 수 있는 시설에만 넣는다(#75). 토큰은 영문 접두어+숫자만 받는데 자리 id는 응답의 `NAME`이다.
//   작천정별빛(`별빛야영장2`, `캐빈하우스1`), 등억알프스(`등억 오토캠핑장1`, `(일반)1.배롱나무`), 작천정달빛(`달빛 왁자지껄1`)은 한글 이름이라 토큰으로 걸 수 없어 목록을 두지 않는다.
//   `--live`는 그 시설에서 구역 코드·이름과 구역별 실제 자리 수만 보이고 자리 단위 차이는 잡지 못한다. 대운산하늘숲만 이름이 `A1`~`A20`이라 목록을 두고 `--live`가 자리까지 대조한다.
//   한글 이름 자리를 거르는 방법은 자리 필터 형식을 넓히는 별도 일이다.
//   `--live` 이름 대조는 `FACILITY_NAME`을 다듬어(trim) 비교한다. 내일(KST)이 `booking_ended`·`no_list`면 다음 날로 한 번 더 시도하고, 그래도 없으면 대조할 날짜가 없다고 알리고 0으로 끝난다.
//
// 기록으로 확인한 것(#73, 작천정별빛, `classes=C0000001`):
// - 요청: `POST /ujcamping/campsite/get_cal_day_data_list`, 본문 JSON `{sql_state:"GetData", select_date, classes, facility:"", use_only}`. 헤더는 페이지(`mscommon.js`의 `getPostData`)와 같은
//   `Content-Type: application/json`, `X-HTTP-Method-Override: POST`, `X-CSRF-TOKEN`이다. 페이지에 `#csrf_token` 요소가 없다. 서버는 이 헤더를 보지 않는다(없음, 빈 값, 문자열 `undefined` 모두 같은 응답).
// - `use_only`: 페이지는 "예약가능 사이트만 보기" 체크박스(기본 해제)로 `"Y"`/`"N"`을 보낸다. 서버는 값을 가리지 않고 같은 88행을 준다(`Y`여도 N 행이 온다). 페이지가 `Y`일 때 N 행을 그리지 않을 뿐이다. 어댑터는 기본값 `"N"`을 보낸다.
// - 쿠키 세션은 필요 없다. 쿠키·Referer·Origin·`X-Requested-With` 없이 헤더 세 개만 보낸 요청이 쿠키를 실은 요청과 응답이 바이트까지 같았다. 서버가 `JSESSIONID`(Path=/ujcamping)를 주지만 쓰지 않는다.
// - `get_cal_month_data`를 먼저 부를 필요가 없다. 예약 화면 GET도 month 호출도 없이 보낸 첫 요청이 정상 응답을 받았다. month 응답은 날짜 틀과 공휴일(`DTYPE`, `DSTR`)뿐이고 잔여가 없다.
// - 응답 `{result, list[]}`: `result`는 `ok`, `booking_ended`(`msg`만 있고 `list`가 없다), `no_list`(이번 기록에서는 못 봄, 페이지 JS가 다룬다)다.
//   `ok`일 때 한 번에 그 시설의 모든 구역·자리가 온다(88행, 예약 여부와 무관). 행의 키: `CAMP_ID`, `NAME`, `OWNER_ID`, `ITEM_KIND`(= classes), `FACILITY_ID`, `FACILITY_NAME`, `SORT_ORDER`, `TITLE`, `SDATE`(=선택한 밤), `EDATE`(=그 다음 날), `ISRESERVABLE`.
//   `IS_RESERVED_YN: "Y"`(예약됨)와 `EXP_PERIOD_YN: "Y"`(뜻 모름, 늘 캐빈하우스3·10, 작괘천 오토캠핑장1 등 같은 자리)는 일부 행에만 붙는다. 어느 쪽이 붙은 행도 `ISRESERVABLE`은 `N`이었다. 판정은 `ISRESERVABLE == "Y"`뿐이다.
//   `SDATE`~`EDATE`가 하루라서 한 요청은 밤 하나다.
// - `booking_ended`는 세 가지다: 17시 이후 당일(`당일(2026-10-12) 예약은 17시에 마감되었습니다.`, 18:40 KST에 받음), 과거 날짜(`지난 날짜(…)는 예약할 수 없습니다.`), 현재 달과 다음 달 밖
//   (`예약은 현재 달과 다음 달까지만 조회 가능합니다.`, 12/25·2027-01-15·2027-06-04). 셋 모두 HTTP 200이다.
// - 날짜 창과 오픈 규칙: 서버는 현재 달과 다음 달만 조회시킨다. 10/12에 11월 날짜는 열려 있었다(11/27 `Y` 50자리), 12월은 닫혀 있었다.
//   공지(`2026년 11월 추첨 일정 안내`, 신불산 3곳과 대운산)의 매달 순서: 울주군민 우선 추첨 접수 1~3일, 추첨 4일, 결제 5일 13:00까지 -> 일반 추첨 접수 6~8일, 추첨 9일, 결제 10일 13:00까지 -> **미당첨·취소분 선착순(즉시결제)은 11일 10:00부터**.
//   즉시결제 화면 안내와 FAQ도 "추첨이 완료되고 남은 사이트에 한해 선착순", "취소분은 오전 10시, 오후 2시에 반영"이라 한다. 그래서 다음 달 날짜는 이번 달 11일 10:00 KST부터 조회하고, 이번 달 날짜는 늘 조회한다(어댑터가 계산한다). 11일 규칙은 공지(10월분 9월, 11월분 10월 두 번)에서 읽은 것이고 이 기록에서 데이터로 검증하지는 못했다.
//   이용안내 운영조례 제4조는 "30일 전부터"라고 하지만 서버가 실제로 열어 주는 창(현재 달과 다음 달)과 달라 쓰지 않는다. 당일 입실은 17:00 KST에 마감된다.
// - 최대 박수: 서버에는 최대 박수가 없고 요청에 박수 값도 없다. 즉시결제는 한 번에 한 밤이다. FAQ "연박은 어떻게 신청하나요?"가 "연박은 추첨 시 금, 토요일 및 지정 사이트에 한하여 신청 가능합니다. 추첨 이외의 연박은 즉시결제로 1박씩 예약하면 됩니다"라고 답한다.
//   추첨은 지정 사이트에 한해 최대 2박 3일(매월 말일은 1박 2일)이다. **어댑터의 최대 박수 2는 우리가 정한 정책이다**(#74). 근거: 같은 자리를 밤마다 따로 예약하는 이용자가 연박을 원할 때 두 밤이 모두 비는 때를 알고 싶다는 스펙 사용자 스토리 5,
//   그리고 추첨의 상한(2박 3일)과 같다. 더 길게 걸면 모든 밤이 동시에 비는 일이 드물고 밤마다 요청이 늘어서 2로 막는다. 서버가 정한 값이 아니니 늘릴 수 있다.
// - 추첨 날짜의 모양: 추첨 대상 날짜가 즉시결제 데이터에서 어떻게 보이는지는 **보지 못했다**. 이번 기록은 다음 달(11월) 추첨이 끝난 10/11 뒤라 날짜가 모두 선착순 데이터다. 12월 날짜는 서버 창 밖이라 닫혀 있었다.
//   다음 관찰 시점은 11/1~11/10(12월분 추첨 기간)이다. 위 11일 규칙으로 다음 달은 추첨 기간에 조회하지 않으므로 이 어댑터는 추첨 날짜를 알리지 않는다.
// - 대기열·봇 탐지·captcha: `netfunnel.js`를 싣지만 `NetFunnel_Action` 호출 세 곳이 주석 처리돼 있다. 예약 화면, `mscommon.js`에 `crawlingCheck`·`dynapath`·`botmanager`·captcha가 없고, 조회 응답에도 오지 않았다.
// - 접근 금지 경로(화면 링크와 스크립트에서 확인): `/ujcamping/campsite/booking_`(`booking_step1`과 그 뒤 단계), `/ujcamping/campsite/ulju_resident_apply`·`general_apply`(추첨 신청), `/ujcamping/campsite/winnerList`(당첨자 확인, 주석 처리된 링크),
//   `/ujcamping/memberIntro/`(로그인·회원정보), `/ujcamping/mypage`(예약확인·결제·취소·군민인증), `/ujcamping/camp_exp/`(숲공작 체험 예약, 다른 상품). 회원가입·ID 찾기는 다른 호스트(`crs.uljusiseol.or.kr`)다.
// - 다른 시설(2026-10-16, #74가 카탈로그에 넣음): 등억알프스(`C0000002`) 68행: `F0000001` 오토캠핑장 48, `F0000006` 카라반(일반) 10, `F0000007` 카라반(테마) 10.
//   작천정달빛(`C0000003`) 47행: `F0000001` 오토캠핑장 35, `F0000018` 야영데크(8.5*6.5) 12. 대운산하늘숲(`C0000005`) 20행: `F0000015` 7.3m × 7m 10, `F0000008` 7.2m × 7m 4, `F0000009`~`F0000014` 한 자리씩.
//   `FACILITY_ID`는 시설 사이에 공유된다(`F0000001`은 별빛·등억·달빛 모두). 구역은 (시설, `FACILITY_ID`)로 가린다. 응답의 `FACILITY_NAME`은 `카라반(일반) `처럼 끝에 공백이 붙는 때가 있어 카탈로그는 다듬어 적는다.
//   대운산하늘숲은 구역 이름이 크기(예 `7.2m × 7m`)라 구역 유형을 따로 알 수 없어 "크기별 구역"로 적는다. 자리 이름은 `A1`~`A20` 꼴이다.
//   추첨 기간 날짜: 이 기록에서는 즉시결제 데이터에 추첨 날짜가 `Y`로 나오는지 **미관찰, 해당 여부 미확정**이다(11/1~11/10에 관찰 가능). 어댑터는 다음 달 날짜를 11일 10:00 전에는 조회하지 않아 추첨 날짜를 알리지 않는다.
import type { FacilityInfo, ZoneInfo } from "../types.js";

const jakcheonByeolbitZones: ZoneInfo[] = [
  { code: "F0000001", name: "오토캠핑장", type: "오토캠핑장" },
  { code: "F0000002", name: "야영데크(8*8)", type: "야영데크" },
  { code: "F0000003", name: "야영데크(8*4)", type: "야영데크" },
  { code: "F0000004", name: "야영데크(4*4)", type: "야영데크" },
  { code: "F0000016", name: "야영데크(6*4)", type: "야영데크" },
  { code: "F0000017", name: "야영데크(8*5)", type: "야영데크" },
  { code: "F0000005", name: "캐빈하우스", type: "캐빈하우스" },
];

const deungeokZones: ZoneInfo[] = [
  { code: "F0000001", name: "오토캠핑장", type: "오토캠핑장" },
  { code: "F0000006", name: "카라반(일반)", type: "카라반" },
  { code: "F0000007", name: "카라반(테마)", type: "카라반" },
];

const jakcheonDalbitZones: ZoneInfo[] = [
  { code: "F0000001", name: "오토캠핑장", type: "오토캠핑장" },
  { code: "F0000018", name: "야영데크(8.5*6.5)", type: "야영데크" },
];

/** `A5`~`A14`처럼 이어지는 자리 이름. 대운산하늘숲의 자리 이름은 `A1`~`A20` 꼴이라 `seats:` 필터 토큰(`A5`, `A5-A14`)으로 걸 수 있다. */
const aSeats = (from: number, to = from) => Array.from({ length: to - from + 1 }, (_, i) => `A${from + i}`);

const daeunsanZones: ZoneInfo[] = [
  { code: "F0000015", name: "7.3m × 7m", type: "크기별 구역", seats: aSeats(5, 14) },
  { code: "F0000008", name: "7.2m × 7m", type: "크기별 구역", seats: [...aSeats(1), ...aSeats(16, 18)] },
  { code: "F0000009", name: "8m × 5.8m", type: "크기별 구역", seats: aSeats(2) },
  { code: "F0000010", name: "7.1m × 7m", type: "크기별 구역", seats: aSeats(3) },
  { code: "F0000011", name: "7.1m × 6.9m", type: "크기별 구역", seats: aSeats(4) },
  { code: "F0000012", name: "2.5m × 12m, 8m × 8m", type: "크기별 구역", seats: aSeats(15) },
  { code: "F0000013", name: "7.2m × 7.2m", type: "크기별 구역", seats: aSeats(19) },
  { code: "F0000014", name: "7.2m × 6.9m", type: "크기별 구역", seats: aSeats(20) },
];

export const facilities: FacilityInfo[] = [
  {
    code: "jakcheon-byeolbit",
    name: "작천정별빛야영장",
    ref: "C0000001",
    zones: jakcheonByeolbitZones,
  },
  { code: "deungeok", name: "등억알프스야영장", ref: "C0000002", zones: deungeokZones },
  { code: "jakcheon-dalbit", name: "작천정달빛야영장", ref: "C0000003", zones: jakcheonDalbitZones },
  { code: "daeunsan", name: "대운산하늘숲야영장", ref: "C0000005", zones: daeunsanZones },
];
