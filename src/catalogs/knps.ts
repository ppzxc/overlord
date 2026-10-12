// 국립공원공단 야영장 예약(reservation.knps.or.kr) 시설·구역 카탈로그. 정적 목록이며 어댑터 로직과 네트워크 코드는 두지 않는다.
// 출처: 갓바위(B252001)는 2026-10-12 17시대(평일 오후, 대기 0) 기록(research/raw/knps)이다. 도학(B251001)과 주왕산 상의(B071001)는 같은 날 17시대에 같은 흐름으로 한 번씩 기록했다(#67).
// `catalog knps <시설> --live`로 확인한 날짜(모두 2026-10-12 17시대, 일치): gatbawi, dohak, sangui.
// 카탈로그에는 `--live`로 확인한 시설만 넣는다. 예약처 화면에는 48곳이 있고 나머지 45곳은 #67 이슈 댓글의 목록에 있다(하루에 몇 곳씩 확인해 넣는다).
//
// 기록으로 확인한 것(#63):
// - 구역 코드는 `prod-ctg-id`(갓바위 일반(대형)야영지 0200901), 구역 이름은 `data-title`의 세 번째 마디(왼쪽 표 머리의 구역 칸과 같다), 자리 id는 자리 이름(A01).
// - 닫힌 칸(`_C` 예약만료, `_R` 예약불가)에는 `prod-ctg-id`가 없고 `title="<자리> : YYYY-MM-DD"`와 class뿐이다.
//   그래서 닫힌 칸의 구역은 표 구조로 정한다. 응답은 왼쪽 표(`table-sticky-body`: rowspan 구역 머리 + 자리 행)와 오른쪽 표(`table-body`: 자리 행마다 날짜 칸)가
//   행 순서로 맞물린다. 자리 A08은 80일 전부 `_R`이라 `prod-ctg-id`가 한 칸도 없지만 왼쪽 표의 구역 머리 아래에 있어 구역을 알 수 있다.
//   갓바위는 구역이 하나(일반(대형)야영지, A01~A11)다. 다구역 시설의 rowspan 묶음은 상의(자동차야영장·카라반·특화야영장 3구역)로 확인했다. 카라반 C1(4인)은 80일 모두 닫혀 있어 구역 코드가 없지만 표 구조로 카라반에 속한다.
// - 자리 이름은 구역마다 다르다: 갓바위 A01~A11, 도학은 숫자 1~29(한 구역 자동차야영장 0201100), 상의는 A1~A11·B1~B19·E1~E8, C1(4인)~C10(4인)(정원 4), D1~D6. 0을 채우지 않는다.
// - 구역 코드는 시설마다 따로 쓴다(도학과 상의의 자동차야영장이 둘 다 0201100이다).
// - `isGreenpoint`: 페이지가 `window.isGreenpoint || 'N'`으로 보낸다. 값은 `N`이다(`Y`는 그린포인트 예약 화면용).
// - 응답 날짜 범위: 내일부터 약 80일(2026-10-12 기록에서 10/13~12/31, 80일). 오늘 날짜는 17시대에 이미 없었다. 정확한 당일 마감 시각은 한 번의 기록으로는 알 수 없고
//   17시 이전에 닫힌다는 것만 안다. 입실일이 응답 범위 밖이면 빈자리 없음으로 친다.
// - 응답 크기·시간: 갓바위 1,995,734바이트(0.3초), 도학 5,391,525바이트(1.7초), 상의 10,126,443바이트(0.6초). 스펙의 3MB 가정보다 큰 시설이 있다. HTTP 층의 10초 제한 안이라 요청별 제한 시간 옵션은 더하지 않는다.
// - `landingCamp` 키: 페이지의 `landingCamp` 성공 핸들러는 `NetFunnel_Complete`(5004)를 부르지 않는다. 5004는 `reservation2`(campsiteList.do 성공) 뒤에만 보낸다.
//   `campsite.js`에서 5004를 보내는 곳은 `NetFunnel_Complete` 호출뿐이다.
// - 접근 금지로 확인한 경로(`campsite.js`·화면 링크): 예약 확정 `/reservation/auth.do`, `/reservation/registerCampReservation.do`, 캡차 `/reserCaptcha.do`,
//   옵션 `/reservation/campsite/selectOptionList.do`, 회원 `/member/`·`/mmb/`, 예약·결제 조회 `/mypage/`(dashBoard, selectReservationPayment), 결제 `/pay/`, `/common/authGpkiForPay.do`, 환불 `/srchrefund/`.
import type { FacilityInfo, ZoneInfo } from "../types.js";

const seatIds = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}`);

const nums = (prefix: string, from: number, to: number, suffix = "") => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}${suffix}`);

const gatbawiZones: ZoneInfo[] = [{ code: "0200901", name: "일반(대형)야영지", type: "일반야영지", seats: seatIds("A", 11) }];
// 자리 이름은 응답의 표 그대로다(0을 채우지 않는다). 도학은 숫자만이다.
const dohakZones: ZoneInfo[] = [{ code: "0201100", name: "자동차야영장", type: "자동차야영장", seats: nums("", 1, 29) }];
const sanguiZones: ZoneInfo[] = [
  { code: "0201100", name: "자동차야영장", type: "자동차야영장", seats: [...nums("A", 1, 11), ...nums("B", 1, 19), ...nums("E", 1, 8)] },
  { code: "0203201", name: "카라반", type: "카라반", capacity: 4, seats: nums("C", 1, 10, "(4인)") },
  { code: "0202101", name: "특화야영장", type: "특화야영장", seats: nums("D", 1, 6) },
];

export const facilities: FacilityInfo[] = [
  { code: "gatbawi", name: "팔공산 갓바위야영장", ref: { dept_id: "B252001", dept_name: "갓바위", parent_dept_name: "팔공산" }, zones: gatbawiZones },
  { code: "dohak", name: "팔공산 도학야영장", ref: { dept_id: "B251001", dept_name: "도학", parent_dept_name: "팔공산" }, zones: dohakZones },
  { code: "sangui", name: "주왕산 상의야영장", ref: { dept_id: "B071001", dept_name: "상의", parent_dept_name: "주왕산" }, zones: sanguiZones },
];
