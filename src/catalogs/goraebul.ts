// 고래불(영덕군 고래불 야영장) 시설·구역 카탈로그. 정적 목록이며 어댑터 로직과 네트워크 코드는 두지 않는다.
// 출처: 구역·자리 목록은 2026-09-29 `catalog goraebul --live`로 확인했다. 예약된 자리도 목록에 있다(class에 ban).
// 폐쇄된 자리가 어떻게 나오는지는 확인하지 못했다. 정원은 확인한 구역만 적는다.
import { seatPrefix } from "../goraebul-seat.js";
import type { FacilityInfo, ZoneInfo } from "../types.js";

/** 구역 코드와 번호로 자리 id 목록을 만든다. 예: ("DKA", [1, 2]) → A01, A02 */
const seatIds = (zone: string, numbers: number[]) => numbers.map((n) => `${seatPrefix(zone)}${String(n).padStart(2, "0")}`);
const sequence = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

const zones: ZoneInfo[] = [
  { code: "CAA", name: "카라반 4인실", type: "카라반", capacity: 4, seats: seatIds("CAA", [1, 2, 6, 7, 11, 12, 20, 21, 22]) },
  { code: "CAB", name: "카라반 6인실", type: "카라반", capacity: 6, seats: seatIds("CAB", [3, 4, 5, 8, 9, 10, 13, 14, 15, 16, 17, 18, 19, 23, 24, 25]) },
  { code: "DKA", name: "숲속야영장 A", type: "숲속야영장", seats: seatIds("DKA", sequence(38)) },
  { code: "DKB", name: "숲속야영장 B", type: "숲속야영장", seats: seatIds("DKB", sequence(52)) },
  { code: "DKC", name: "숲속야영장 C", type: "숲속야영장", seats: seatIds("DKC", sequence(20)) },
  { code: "AUA", name: "캠핑카존", type: "캠핑카", seats: seatIds("AUA", [4, 5, 6, 7, 10, 11, 12]) },
  { code: "PEA", name: "펜션형 A", type: "펜션형", capacity: 6, seats: seatIds("PEA", [1]) },
  { code: "PEB", name: "펜션형 B", type: "펜션형", capacity: 8, seats: seatIds("PEB", [1]) },
  { code: "PEC", name: "펜션형 C", type: "펜션형", capacity: 10, seats: seatIds("PEC", [1, 2]) },
];

/** 예약처 쪽 시설 참조값(ref)은 없다. 예약처 하나에 시설 하나다. */
export const facilities: FacilityInfo[] = [{ code: "goraebul", name: "고래불 국민야영장", zones }];
