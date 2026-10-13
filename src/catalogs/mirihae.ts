// 미리해(mirihae.com, 소스팜) 시설·구역 카탈로그. 정적 목록이며 어댑터 로직과 네트워크 코드는 두지 않는다. 읽는 방법과 판정은 어댑터(`src/adapters/mirihae.ts`) 머리에 있다.
// 시설 `ref`는 `{ tenant, pageId }`다. 예약 화면은 `https://mirihae.com/<tenant>/camping/<pageId>`다. 구역 = 달력 칸 `dl.schedule`의 `dd`(구역 이름이 코드). 자리 목록은 없다.
// 출처: 단양 천동 오토캠핑장은 2026-10-13 09:24 ~ 09:31 KST 기록(research/raw/mirihae, #84)이다. 이 조각(#84)은 천동 하나만 넣는다. 나머지 시설은 카탈로그 채우기 조각(#86)이 넣는다.
//
// 기록으로 확인한 것(#84, 천동 오토캠핑장 `/dytc/camping/V39628874`):
// - 구역 이름: `야영장A`, `야영장B`, `야영장C`. 달력 칸의 `dl.schedule color1/2/3`의 `dd`다. 10/14 ~ 10/31과 11/01 ~ 11/14의 모든 칸에 세 구역이 모두 있었다. 자리 목록은 없다.
//   기록한 10/14의 남은 수는 A 18, B 18, C 29다(알림 `2026-10-14(수) 1박 · 야영장A · 남은 18`).
// - `gateToken`(입장 토큰) 수명: 5분(300초). HS256 JWT이고 payload `{sub: ENTERING_TOKEN, exp, TOKEN_ID, GROUP_ID}`다(`iat` 없음). 받은 시각 09:26:14 KST에 `exp`가 09:31:13 KST다.
//   서버가 같은 토큰을 받아 줬고(발급 약 100초 뒤 두 번째 요청이 200) 만료 20초 뒤에는 302로 게이트(`entering.html`)에 되돌려 보냈다. `/api/entering`을 다시 불러도 같은 토큰이 오고 수명이 늘지 않는다.
//   토큰 재사용은 다음 조각(#85)에서 한다. 이 조각은 바퀴마다 게이트를 새로 지난다.
// - 게이트 흐름: `GET 예약 화면` 302(`Location: https://cdn.mirihae.com:9443/entering.html?uri=<원래 주소>`) -> `GET https://cdn.mirihae.com/api/entering?uri=<인코딩>` 401 ->
//   `POST /api/waiting?uri=…` 200(본문이 대기 토큰) -> `GET /api/waiting?uri=…`(헤더 `X-Mirihae-Waiting-Token`) 200 `{enteringToken, uri}` ->
//   `GET /api/entering?uri=…`(헤더 `X-Mirihae-Reservation-Token`) 200 `{enteringToken, uri}` -> `GET 예약 화면?gateToken=<enteringToken>` 200. 이 기록에서는 첫 폴링이 바로 200이었다(425 없음).
// - 달력 모양: 날짜 칸 `div.td.pignose-calendar-unit-date`(`id="YYYY-MM-DD"`)에 예약 가능한 날이면 `click` 클래스가 붙고 안에 구역마다 `<dl class="schedule colorN"><dt>남은 수</dt><dd>구역 이름</dd></dl>`가 있다.
//   이번 달 화면은 앞 달의 칸도 격자에 그리지만 그 칸과 지난 날짜, 오늘("당일예약 불가")에는 `click`도 `dl`도 없다. 그 달에 속한 칸만 읽는다.
// - 봇 탐지·captcha: 예약 화면, 달력, 게이트 JS와 페이지 스크립트 어디에도 없었다. robots.txt는 `/login.do`로 302라 파일이 없는 것으로 보고 금지가 없다고 본다(ADR 0002).
//
// 확인하지 못한 것(#84):
// - 최대 박수: 확인하지 못했다. 화면 JS에 "최대예약일수는 4박5일입니다." 경고가 두 군데 있다. 하나는 주석 처리된 클라이언트 검사이고 하나는 서버 `nightCheck.do`(날짜를 고른 뒤의 호출이라 부르지 않았다)의 응답으로 띄운다.
//   입점 기관마다 다를 수 있어 이 조각은 예약처 기본 최대 박수를 1로 둔다.
// - 오픈 규칙(며칠 전 몇 시): 확인하지 못했다. 기록한 때 입실일 10/14 ~ 11/14가 열려 있었지만 11/15 이후가 닫힌 것은 천동이 11/14부터 동계 휴장이라서였다(화면 팝업). 열리는 시각이 아니다.
//   그래서 확인 전에는 달력이 `click`을 주지 않는 날짜를 빈자리 없음으로 처리한다.
// - 시설마다 게이트를 따로 지나야 하는지(시설 하나만 기록했다), 붐빌 때의 대기(425 응답은 기록하지 못했다).
// - 구역별 남은 수 0의 표현: 기록한 모든 구역이 1 이상이었다. 칸이 `click`을 잃는지 `dt`가 0이 되는지 모른다(둘 다 빈자리 없음으로 읽는다).
import type { FacilityInfo, ZoneInfo } from "../types.js";

const zone = (name: string): ZoneInfo => ({ code: name, name, type: "야영장" });

const cheondongZones: ZoneInfo[] = [zone("야영장A"), zone("야영장B"), zone("야영장C")];

export const facilities: FacilityInfo[] = [
  { code: "danyang-cheondong", name: "단양 천동 오토캠핑장", ref: { tenant: "dytc", pageId: "V39628874" }, zones: cheondongZones },
];
