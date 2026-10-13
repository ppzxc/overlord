// 미리해(mirihae.com, 소스팜) 시설·구역 카탈로그. 정적 목록이며 어댑터 로직과 네트워크 코드는 두지 않는다. 읽는 방법과 판정은 어댑터(`src/adapters/mirihae.ts`) 머리에 있다.
// 시설 `ref`는 `{ tenant, pageId }`이고 자체 도메인 시설은 `host`·`pathPrefix`를 더한다(예약 화면 `https://<host=mirihae.com><pathPrefix>/<tenant>/camping/<pageId>`). `tenant`는 미리해에 입점한 운영 기관의 경로 접두어이고(단양관광공사 `dytc`) 예약처가 시설을 가리키는 값이다. 구역 = 달력 칸 `dl.schedule`의 `dd`다(구역 이름이 코드이고 범례의 `야영장 A`와 다르다). 자리 목록은 없다.
// 출처: 천동은 2026-10-13 09:24 ~ 09:31 KST 기록, 다리안·소선암·대강은 같은 날 09:47 ~ 09:49 KST에 `catalog mirihae <시설> --live`로 확인했다. 여주 대신 오토는 같은 날 13:11 KST 기록(자체 도메인 `yeojuuc.or.kr`, 게이트 443)이다. `--live` 대조는 사람 확인 몫이다. 조사 기록과 원문은 research/raw/mirihae/README.md.
// 넣지 않은 시설: 여주 대신 웰빙(`epoc/B24626523`)·금은모래(`gsmc/Q86949745`)·강천섬(`camp.yjcf.or.kr/gangcheon/camping/Y35294962`)은 같은 점검(2026-10-13)을 통과했지만 후속 조각(#110·#111)이 넣는다. 포천 비둘기낭은 화면 구조가 달라서다. 충주·이천·성남은 예약 링크를 확인하지 못했다.
import type { FacilityInfo, ZoneInfo } from "../types.js";

/** 구역 유형은 화면에 표시하는 값일 뿐이고 예약처가 주지 않는다. 확인한 것은 달력 칸의 이름(`dd`)이다. */
const zone = (name: string): ZoneInfo => ({ code: name, name, type: "야영장" });

const cheondongZones: ZoneInfo[] = [zone("야영장A"), zone("야영장B"), zone("야영장C")];
const darianZones: ZoneInfo[] = [zone("데크야영장C"), zone("데크야영장D"), zone("원두막")];
const soseonamZones: ZoneInfo[] = [zone("야영장A"), zone("야영장B"), zone("야영장C"), zone("산")];
const daegangZones: ZoneInfo[] = [zone("파쇄석 사이트"), zone("데크 사이트")];
const daesinAutoZones: ZoneInfo[] = [zone("파쇄석")];

export const facilities: FacilityInfo[] = [
  { code: "danyang-cheondong", name: "단양 천동 오토캠핑장", ref: { tenant: "dytc", pageId: "V39628874" }, zones: cheondongZones },
  { code: "danyang-darian", name: "단양 다리안 캠핑장", ref: { tenant: "dytc", pageId: "G24526799" }, zones: darianZones },
  { code: "danyang-soseonam", name: "단양 소선암 오토캠핑장", ref: { tenant: "dytc", pageId: "Q49993865" }, zones: soseonamZones },
  { code: "danyang-daegang", name: "단양 대강 오토캠핑장", ref: { tenant: "dytc", pageId: "Y88593737" }, zones: daegangZones },
  // 여주시 도시공사 대신 오토캠핑장. 예약 화면이 자체 도메인(`https://yeojuuc.or.kr/camping/epoc/camping/Z65332353`)이라 `ref`에 `host`·`pathPrefix`를 둔다.
  // 최대 박수는 화면 JS에 한도 문구도 `nightCheck.do` 호출도 없어 확인하지 못했다. 1박으로 시작한다(#99, #109). 추첨제는 화면에서 보이지 않았다(해당 없음/미확인).
  { code: "yeoju-daesin-auto", name: "여주 대신 오토캠핑장", ref: { tenant: "epoc", pageId: "Z65332353", host: "yeojuuc.or.kr", pathPrefix: "/camping" }, zones: daesinAutoZones, maxNights: 1 },
];
