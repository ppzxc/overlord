// 미리해(mirihae.com, 소스팜) 시설·구역 카탈로그. 정적 목록이며 어댑터 로직과 네트워크 코드는 두지 않는다. 읽는 방법과 판정은 어댑터(`src/adapters/mirihae.ts`) 머리에 있다.
// 시설 `ref`는 `{ tenant, pageId }`이고 자체 도메인 시설은 `host`·`pathPrefix`를 더한다(예약 화면 `https://<host=mirihae.com><pathPrefix>/<tenant>/camping/<pageId>`). `tenant`는 미리해에 입점한 운영 기관의 경로 접두어이고(단양관광공사 `dytc`) 예약처가 시설을 가리키는 값이다. 구역 = 달력 칸 `dl.schedule`의 `dd`다(구역 이름이 코드이고 범례의 `야영장 A`와 다르다). 자리 목록은 없다.
// 출처: 천동은 2026-10-13 09:24 ~ 09:31 KST 기록, 다리안·소선암·대강은 같은 날 09:47 ~ 09:49 KST에 `catalog mirihae <시설> --live`로 확인했다. 여주 대신 오토·웰빙·금은모래는 같은 날 13:09 ~ 13:15 KST 기록(자체 도메인 `yeojuuc.or.kr`, 게이트 443), 강천섬은 `camp.yjcf.or.kr`(게이트 9443)이다. 여주 구역 이름은 기록한 화면의 달력 칸 `dd`이고 `--live` 대조는 사람 확인 몫이다. `--live` 대조는 사람 확인 몫이다. 조사 기록과 원문은 research/raw/mirihae/README.md.
// 넣지 않은 시설: 포천 비둘기낭은 화면 구조가 달라서다(`/campsite/`, 날짜 칸 없음). 충주 목계솔밭·이천 농업테마공원·성남 율동공원은 공식 예약 링크를 확인하지 못했다. 칠곡보는 땡큐캠핑(ADR 0002 제외)으로 옮겨 갔다. 여주 시설은 모두 robots가 예약 화면을 막지 않아(`yeojuuc.or.kr`은 `/camping/` 허용, `camp.yjcf.or.kr`은 robots.txt 없음) 넣었다.
import type { FacilityInfo, ZoneInfo } from "../types.js";

/** 구역 유형은 화면에 표시하는 값일 뿐이고 예약처가 주지 않는다. 확인한 것은 달력 칸의 이름(`dd`)이다. */
const zone = (name: string): ZoneInfo => ({ code: name, name, type: "야영장" });

const cheondongZones: ZoneInfo[] = [zone("야영장A"), zone("야영장B"), zone("야영장C")];
const darianZones: ZoneInfo[] = [zone("데크야영장C"), zone("데크야영장D"), zone("원두막")];
const soseonamZones: ZoneInfo[] = [zone("야영장A"), zone("야영장B"), zone("야영장C"), zone("산")];
const daegangZones: ZoneInfo[] = [zone("파쇄석 사이트"), zone("데크 사이트")];
const daesinAutoZones: ZoneInfo[] = [zone("파쇄석")];
const daesinWellingZones: ZoneInfo[] = [zone("파쇄석"), zone("데크")];
const geumeunmoraetZones: ZoneInfo[] = [zone("가구역"), zone("나구역"), zone("다구역"), zone("금모래구역"), zone("은모래구역")];
const gangcheonseomZones: ZoneInfo[] = [zone("세종대왕"), zone("원경왕후"), zone("효종대왕"), zone("인현왕후"), zone("명성황후")];

export const facilities: FacilityInfo[] = [
  { code: "danyang-cheondong", name: "단양 천동 오토캠핑장", ref: { tenant: "dytc", pageId: "V39628874" }, zones: cheondongZones },
  { code: "danyang-darian", name: "단양 다리안 캠핑장", ref: { tenant: "dytc", pageId: "G24526799" }, zones: darianZones },
  { code: "danyang-soseonam", name: "단양 소선암 오토캠핑장", ref: { tenant: "dytc", pageId: "Q49993865" }, zones: soseonamZones },
  { code: "danyang-daegang", name: "단양 대강 오토캠핑장", ref: { tenant: "dytc", pageId: "Y88593737" }, zones: daegangZones },
  // 여주시 도시공사 대신 오토캠핑장. 예약 화면이 자체 도메인(`https://yeojuuc.or.kr/camping/epoc/camping/Z65332353`)이라 `ref`에 `host`·`pathPrefix`를 둔다.
  // 최대 박수는 화면 JS에 한도 문구도 `nightCheck.do` 호출도 없어 확인하지 못했다. 1박으로 시작한다(#99, #109). 추첨제는 화면에서 보이지 않았다(해당 없음/미확인).
  { code: "yeoju-daesin-auto", name: "여주 대신 오토캠핑장", ref: { tenant: "epoc", pageId: "Z65332353", host: "yeojuuc.or.kr", pathPrefix: "/camping" }, zones: daesinAutoZones, maxNights: 1 },
  // 대신 웰빙은 대신 오토와 탭으로 나뉜 다른 화면이다(`epoc/B24626523`). 최대 박수·추첨은 대신 오토와 같이 확인하지 못했다(1박, 해당 없음/미확인, #111).
  { code: "yeoju-daesin-welling", name: "여주 대신 웰빙캠핑장", ref: { tenant: "epoc", pageId: "B24626523", host: "yeojuuc.or.kr", pathPrefix: "/camping" }, zones: daesinWellingZones, maxNights: 1 },
  { code: "yeoju-geumeunmoraet", name: "여주 금은모래 캠핑장", ref: { tenant: "gsmc", pageId: "Q86949745", host: "yeojuuc.or.kr", pathPrefix: "/camping" }, zones: geumeunmoraetZones, maxNights: 1 },
  // 강천섬은 `camp.yjcf.or.kr`의 단양 계열 달력이다. 화면 경로는 `/gangcheon/camping/<pageId>`(`pathPrefix` 없음)이고 다른 달 달력은 화면 JS의 절대 경로 `/camping/calendar.do`(같은 호스트)다. 게이트 화면은 9443이다.
  // 구역은 날짜 칸의 `dl.schedule`의 `dd`다. 같은 화면의 이용료(`dd` 50,000원)·행사 문구는 `dl.schedule` 밖이라 구역이 아니다. 어떤 날은 남은 수가 없는 구역의 `dl`이 칸에서 빠진다(10/17). `soldOutOmitted`는 그 구역을 남은 수 0으로 읽게 한다.
  { code: "yeoju-gangcheonseom", name: "여주 강천섬 캠핑장", ref: { tenant: "gangcheon", pageId: "Y35294962", host: "camp.yjcf.or.kr", soldOutOmitted: "true" }, zones: gangcheonseomZones, maxNights: 1 },
];
