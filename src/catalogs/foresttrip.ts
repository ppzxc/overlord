// 숲나들e(`www.foresttrip.go.kr`) 시설·구역 카탈로그. 정적 목록이며 어댑터 로직과 네트워크 코드는 두지 않는다. 읽는 방법과 판정은 어댑터(`src/adapters/foresttrip.ts`) 머리에 있다.
// 시설 `ref`는 `{ insttId }`이다(유명산 `0101`). 구역 코드는 상품 유형 코드(`goodsClsscCd`)이고 이름은 시설이 채운 `goodsClsscNm`이다. 같은 코드가 시설마다 다른 이름일 수 있다.
// 자리 목록은 두지 않는다. 자리는 상품(`goodsId`)이고 로그인 응답의 상품 목록에서 읽는다.
// 출처: 2026-10-20 로그인 스파이크(research/forest-login-probe.md)가 유명산에서 읽은 유형이다. 이 워킹 스켈레톤(#143)은 시설 두 곳만 손으로 둔다. 187곳은 생성 스크립트로 만들 후속 티켓의 몫이다.
// 유명산에는 야영 `02007`(상품 10개)도 보이지만 이름을 기록하지 않아 넣지 않았다.
import type { FacilityInfo, ZoneInfo } from "../types.js";

const yumyeongsanZones: ZoneInfo[] = [
  { code: "02002", name: "야영데크", type: "야영데크" },
  { code: "01002", name: "휴양관", type: "휴양관" },
  { code: "01001", name: "숲속의집", type: "숲속의집" },
  { code: "01003", name: "연립동", type: "연립동" },
];

// 삼척활기(`ID02030104`, 주별 7주)는 한옥동 유형 코드(`01007`)만 문서에 있어 그것만 둔다. 야영데크 등 나머지 유형 코드는 후속 티켓의 생성 스크립트가 채운다.
const samcheokHwalgiZones: ZoneInfo[] = [{ code: "01007", name: "한옥동", type: "한옥동" }];

export const facilities: FacilityInfo[] = [
  { code: "yumyeongsan", name: "유명산자연휴양림", ref: { insttId: "0101" }, zones: yumyeongsanZones },
  { code: "samcheok-hwalgi", name: "삼척활기자연휴양림", ref: { insttId: "ID02030104" }, zones: samcheokHwalgiZones },
];
