// 국립공원공단 야영장 예약(reservation.knps.or.kr) 시설·구역 카탈로그. 정적 목록이며 어댑터 로직과 네트워크 코드는 두지 않는다.
// 출처: 갓바위(B252001)는 2026-10-12 17시대(평일 오후, 대기 0) 기록(research/raw/knps)이다. 도학(B251001)은 아직 기록하지 않아 구역이 비어 있다(#67에서 채운다).
//
// 기록으로 확인한 것(#63):
// - 구역 코드는 `prod-ctg-id`(갓바위 일반(대형)야영지 0200901), 구역 이름은 `data-title`의 세 번째 마디(왼쪽 표 머리의 구역 칸과 같다), 자리 id는 자리 이름(A01).
// - 닫힌 칸(`_C` 예약만료, `_R` 예약불가)에는 `prod-ctg-id`가 없고 `title="<자리> : YYYY-MM-DD"`와 class뿐이다.
//   그래서 닫힌 칸의 구역은 표 구조로 정한다. 응답은 왼쪽 표(`table-sticky-body`: rowspan 구역 머리 + 자리 행)와 오른쪽 표(`table-body`: 자리 행마다 날짜 칸)가
//   행 순서로 맞물린다. 자리 A08은 80일 전부 `_R`이라 `prod-ctg-id`가 한 칸도 없지만 왼쪽 표의 구역 머리 아래에 있어 구역을 알 수 있다.
//   갓바위는 구역이 하나(일반(대형)야영지, A01~A11)라서 다구역 시설의 rowspan 묶음은 이 기록으로 확인하지 못했다.
// - `isGreenpoint`: 페이지가 `window.isGreenpoint || 'N'`으로 보낸다. 값은 `N`이다(`Y`는 그린포인트 예약 화면용).
// - 응답 날짜 범위: 내일부터 약 80일(2026-10-12 기록에서 10/13~12/31, 80일). 오늘 날짜는 17시대에 이미 없었다. 정확한 당일 마감 시각은 한 번의 기록으로는 알 수 없고
//   17시 이전에 닫힌다는 것만 안다. 입실일이 응답 범위 밖이면 빈자리 없음으로 친다.
// - 응답 크기·시간: 갓바위 1,995,734바이트(약 2MB, 스펙의 3MB보다 작다), 0.3초. HTTP 층의 10초 제한으로 충분해 요청별 제한 시간 옵션은 더하지 않는다.
// - `landingCamp` 키: 페이지의 `landingCamp` 성공 핸들러는 `NetFunnel_Complete`(5004)를 부르지 않는다. 5004는 `reservation2`(campsiteList.do 성공) 뒤에만 보낸다.
//   `campsite.js`에서 5004를 보내는 곳은 `NetFunnel_Complete` 호출뿐이다.
// - 접근 금지로 확인한 경로(`campsite.js`·화면 링크): 예약 확정 `/reservation/auth.do`, `/reservation/registerCampReservation.do`, 캡차 `/reserCaptcha.do`,
//   옵션 `/reservation/campsite/selectOptionList.do`, 회원 `/member/`·`/mmb/`, 예약·결제 조회 `/mypage/`(dashBoard, selectReservationPayment), 결제 `/pay/`, `/common/authGpkiForPay.do`, 환불 `/srchrefund/`.
import type { FacilityInfo, ZoneInfo } from "../types.js";

const seatIds = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}`);

const gatbawiZones: ZoneInfo[] = [{ code: "0200901", name: "일반(대형)야영지", type: "일반야영지", seats: seatIds("A", 11) }];

export const facilities: FacilityInfo[] = [
  { code: "gatbawi", name: "팔공산 갓바위야영장", ref: { dept_id: "B252001", dept_name: "갓바위", parent_dept_name: "팔공산" }, zones: gatbawiZones },
  { code: "dohak", name: "팔공산 도학야영장", ref: { dept_id: "B251001", dept_name: "도학", parent_dept_name: "팔공산" }, zones: [] },
];
