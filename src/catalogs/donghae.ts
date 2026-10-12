// 동해시 관광지 통합 예약시스템 시설·구역 카탈로그. 정적 목록이며 어댑터 로직과 네트워크 코드는 두지 않는다.
// 출처: 구역은 research/donghae-provider-details.md(동해시 예약처 상세 조사)와 2026-09 대기열 뒤 기록이다.
// 구역 코드와 이름은 모두 응답의 표시 이름이다(2026-09-29 확인). 구역 이름 앞의 분류는 넓은 분류일 뿐이고
// 든바다·난바다·허허바다는 확인하지 못했다. 정원은 확인한 구역만 적는다.
// 시설 ref의 trrsrtCode는 망상오토캠핑리조트의 관광지 코드다.
import type { FacilityInfo, ZoneInfo } from "../types.js";

const zone = (name: string, type: string, capacity?: number): ZoneInfo => ({
  code: name,
  name,
  type,
  ...(capacity ? { capacity } : {}),
});

const zones: ZoneInfo[] = [
  zone("전통한옥", "한옥"),
  zone("캐빈하우스", "캐빈", 4),
  zone("든바다", "미확인"),
  zone("난바다", "미확인"),
  zone("허허바다", "미확인"),
  zone("자동차캠핑장", "오토캠핑", 4),
  zone("캐라반", "카라반", 6),
  zone("글램핑(4인)", "글램핑", 4),
  zone("글램핑(2인)", "글램핑", 2),
];

export const facilities: FacilityInfo[] = [{ code: "mangsang", name: "망상오토캠핑리조트", ref: { trrsrtCode: "1000" }, zones }];
