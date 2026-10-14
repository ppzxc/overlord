// 태백시시설관리공단(`tfmc.huyang.co.kr:452`) 시설·구역 카탈로그. 정적 목록이며 어댑터 로직과 네트워크 코드는 두지 않는다. 읽는 방법과 판정은 어댑터(`src/adapters/taebaek.ts`) 머리에 있다.
// 시설 `ref`는 `{ wloc }`이다(예약 화면 `/reservation.asp?location=002&wloc=B01`). 구역 코드는 예약처가 달력 탭에 쓰는 `man` 값 그대로다(`1` 야영데크, `2` 자동차야영장 = 기본 탭, `3` 카라반).
// 자리 번호와 남은 자리 수는 달력이 주지 않는다(날짜 칸이 예약가능/예약종료/예약완료뿐). 그래서 자리 목록은 없다.
// 출처: 2026-10-14 13:2x ~ 13:4x KST에 달력 4장(10월 세 탭, 11월 기본 탭)을 기록했다(research/raw/taebaek/README.md). 탭 이름과 `man` 값은 그 화면의 탭 버튼과 폼에서 읽었다.
// 넣지 않은 시설: 절골힐링캠핑장(`wloc=A01`)은 같은 사이트의 다른 시설이다. 탭 구성이 달라(차량야영 `man=1`, 야영노지 `man=2`) 고원과 구역 코드가 맞지 않고, 이번 범위 밖이다. 예약처 id가 공단 단위(`taebaek`)라 나중에 시설로 더하기만 하면 된다.
// 접근 원칙의 예외: 이 예약처는 robots.txt가 막지만 사용자가 예외로 허용했다(ADR 0003).
import type { FacilityInfo, ZoneInfo } from "../types.js";

const zones: ZoneInfo[] = [
  { code: "1", name: "야영데크", type: "야영데크" },
  { code: "2", name: "자동차야영장", type: "자동차야영장" },
  { code: "3", name: "카라반", type: "카라반" },
];

export const facilities: FacilityInfo[] = [{ code: "gowon", name: "태백 고원힐링캠핑장", ref: { wloc: "B01" }, zones }];
