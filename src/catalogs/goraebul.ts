// 영덕군 통합예약(stay.yd.go.kr) 시설·구역 카탈로그. 정적 목록이며 어댑터 로직과 네트워크 코드는 두지 않는다.
// 고래불 국민야영장, 웰빙문화테마마을, 바다숲향기마을이 같은 예약 엔진(캘린더 + zoneAreaAjax)을 쓴다. 주소만 다르다(`ref`).
// 출처: 고래불의 구역·자리 목록은 2026-09-29 `catalog goraebul --live`로 확인했다. 예약된 자리도 목록에 있다(class에 ban).
// 웰빙문화테마마을·바다숲향기마을은 2026-11-16 캘린더(2026-11 ~ 2027-01)와 구역별 zoneAreaAjax 응답에서 구역·자리를 읽었다.
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

// 웰빙문화테마마을. 문화센터는 펜션형이 아닌 모텔형(주방 기구 없음)이다. 자리 번호는 구역 안이 아니라 시설 전체 번호다(HTB 11~15).
const wellbeingZones: ZoneInfo[] = [
  { code: "HTA", name: "펜션형 4인용", type: "펜션형", capacity: 4, seats: seatIds("HTA", sequence(10)) },
  { code: "HTB", name: "펜션형 8인용", type: "펜션형", capacity: 8, seats: seatIds("HTB", [11, 12, 13, 14, 15]) },
  { code: "HTC", name: "펜션형 10인용", type: "펜션형", capacity: 10, seats: seatIds("HTC", [16, 17]) },
  { code: "MHA", name: "문화센터 4인용", type: "문화센터", capacity: 4, seats: seatIds("MHA", [1, 2, 3, 4, 5, 6, 10]) },
  { code: "MHB", name: "문화센터 6인용", type: "문화센터", capacity: 6, seats: seatIds("MHB", [7, 8, 11, 12]) },
  { code: "MHC", name: "문화센터 장애인실", type: "문화센터", seats: seatIds("MHC", [9]) },
  { code: "MHD", name: "문화센터 세미나실", type: "문화센터", seats: seatIds("MHD", [13]) },
  { code: "CMA", name: "카라반", type: "카라반", seats: seatIds("CMA", sequence(5)) },
  { code: "CMB", name: "캠핑데크", type: "캠핑데크", seats: seatIds("CMB", sequence(11)) },
];

// 바다숲향기마을. 통나무형 숙박시설이다. 1박만 예약된다(예약 화면에 1박2일 선택지뿐).
const villageZones: ZoneInfo[] = [
  { code: "VAA", name: "8인실", type: "통나무집", capacity: 8, seats: seatIds("VAA", [1, 2, 6, 7, 11]) },
  { code: "VBA", name: "10인실", type: "통나무집", capacity: 10, seats: seatIds("VBA", [3, 4, 5]) },
  { code: "VCA", name: "12인실", type: "통나무집", capacity: 12, seats: seatIds("VCA", [8, 9, 10]) },
];

/**
 * `ref`는 예약 화면 주소를 만드는 값이다. `pathPrefix`는 `https://stay.yd.go.kr` 뒤 경로(고래불은 루트라 없다), `navCode`는 예약 캘린더의 `nav_code`다.
 * 첫 시설(고래불)이 시설을 안 고른 설정의 기본값이다.
 */
export const facilities: FacilityInfo[] = [
  { code: "goraebul", name: "고래불 국민야영장", ref: { navCode: "gor1501675800" }, zones },
  { code: "wellbeing", name: "영덕 웰빙문화테마마을", ref: { pathPrefix: "/wellbeing", navCode: "wel1541599465" }, zones: wellbeingZones },
  { code: "village", name: "영덕 바다숲향기마을", ref: { pathPrefix: "/village", navCode: "pa21524120539" }, zones: villageZones, maxNights: 1 },
];
