// 미리해(mirihae.com, 소스팜) 예약처 어댑터. 입점 기관(단양관광공사, 여주 등)의 캠핑장이 같은 예약 화면과 같은 게이트를 쓴다. 시설·구역 목록과 기록으로 확인한 값은 카탈로그(`src/catalogs/mirihae.ts`)에 있다.
//
// 읽는 방법(#84, 천동 `/dytc/camping/V39628874`, research/raw/mirihae):
// - 예약 화면은 항상 자체 게이트(`cdn.mirihae.com`) 뒤에 있다. 게이트는 예약 화면 요청이 302로 알려 주는 `uri`로 시작한다(ADR 0002: 자체 게이트도 대기열로 보고 페이지 JS(`entering.js`, `waiting.js`)대로 참여한다).
//   `/api/entering` 401 → `POST /api/waiting` → `GET /api/waiting` 10초 간격(425면 계속) → `/api/entering` 200 → `?gateToken=`을 붙인 예약 화면 200.
//   게이트 요청은 간격 큐 밖에서 보내고 예약 화면 요청은 큐 안에서 보낸다. 요청 사이 간격은 HTTP 층이 맡는다.
// - `entering.js`가 `/api/entering`이 200·401·403·404 밖의 응답일 때 쓰는 임의 UUID `gateToken`(실패 시 열림)은 키 위조라서 어떤 경우에도 쓰지 않는다. 그런 경로를 두지 않는다.
// - 달력은 서버가 그린다. 날짜 칸 `div.td.pignose-calendar-unit-date`에 `click` 클래스가 있으면 예약할 수 있는 날이고 `dl.schedule`의 `dt`가 구역(`dd`)별 남은 수다.
//   감시 단위는 구역이다. 자리 번호는 보지 않는다. 날짜를 고르는 순간부터는 자리를 잡는 호출(`tokenCheck.do`, `initSelectReservation.do` 등)이 나가므로 첫 화면에서 멈춘다.
// - 예약 화면은 이번 달 달력을 싣는다. 다른 달 입실일(여러 박이 달을 넘는 밤 포함)은 그 화면의 `searchForm`을 직렬화한 `POST /camping/calendar.do`(`selectMonth=YYYY-MM`)로 읽고, 필요한 달마다 한 번만 보낸다(#85).
//   여러 박은 밤마다 칸을 읽어 남은 수의 최솟값을 쓴다. 같은 자리가 이어진다는 보장은 없다.
// - 입장 토큰(`gateToken`)은 받은 뒤 수명(300초, 기록 #84) 안이면 다음 바퀴가 게이트를 지나지 않고 그대로 쓴다. 서버가 받지 않으면 같은 바퀴에서 게이트를 새로 지난다. 토큰 값을 바꾸거나 만들지 않는다.
import * as cheerio from "cheerio";
import {
  AdapterError,
  type AdapterContext,
  type AvailabilityQuery,
  type AvailableSite,
  type ProviderAdapter,
  type HttpClient,
  type ProviderInfo,
  type TransportResponse,
  type ZoneObservation,
} from "../types.js";
import { facilities } from "../catalogs/mirihae.js";
import { resolveFacility } from "../facility.js";
import { BOT_DETECTION, ConnectionFailure, UnitStructureError, assertOk, redirectOf, send, unknownRedirect } from "../adapter-signals.js";
import { warnDriftOnce } from "../netfunnel.js";
import { addDays } from "../schedule.js";

const ORIGIN = "https://mirihae.com";
/** 게이트의 정적 화면(`entering.html`, `waiting.html`)이 있는 곳. API는 이 화면의 JS가 `https://cdn.mirihae.com`으로 보낸다. */
const GATE_PAGES = "https://cdn.mirihae.com:9443";
const GATE_API = "https://cdn.mirihae.com/api";
const GATE_HOST = "cdn.mirihae.com";
const ENTERING_TOKEN_NAME = "X-Mirihae-Reservation-Token";
const WAITING_TOKEN_NAME = "X-Mirihae-Waiting-Token";

const tenants = [...new Set(facilities.flatMap((f) => (typeof f.ref === "object" && f.ref.tenant ? [f.ref.tenant] : [])))];

const INFO: ProviderInfo = {
  id: "mirihae",
  facilities,
  // 4박. 서버가 거절하는 값을 확인한 것이 아니다(research/raw/mirihae/README.md). 근거는 천동 화면 JS의 "최대예약일수는 4박5일입니다." 경고 문구뿐이다(주석 처리된 클라이언트 검사와 `nightCheck.do` 실패 알림). 입점 기관마다 다를 수 있다.
  maxNights: 4,
  // 오픈 규칙은 확인하지 못했다. 아래 세 값은 타입상 필수인 날짜 창이고 열리는 때를 주장하지 않는다. 확인 전에는 달력이 `click`을 주지 않는 날짜를 빈자리 없음으로 처리하므로 날짜를 미리 거르지 않는다.
  // - openDaysBefore 36500, openTime 00:00: 100년이라 어떤 입실일도 요청 없이 건너뛰지 않는다(걸러내지 않겠다는 뜻이고 열리는 때가 아니다).
  // - sameDayCutoff 00:00: 화면이 오늘 칸에 "당일예약 불가"를 달고 `click`을 주지 않는다(2026-10-13 09:28 기록). 당일 입실 마감 시각은 모른다.
  openingRule: { openDaysBefore: 36_500, openTime: "00:00", sameDayCutoff: "00:00" },
  // 오픈 경쟁 시간(`openingRush`)은 두지 않는다. 입점 기관마다 여는 시각을 모른다.
  // 게이트를 바퀴마다 지날 수 있고 시설이 늘 수 있어 150초보다 길게 잡는다. `gateToken` 재사용(#85)은 수명(300초) 안에 다음 바퀴가 돌아야 하므로 이 간격으로는 드물게만 일어난다(이슈 #85 의견).
  defaultPollIntervalSeconds: 300,
  // 날짜·구역을 고른 뒤의 호출(자리를 잡는다), 결제, 예약확인/취소, 로그인·회원. 조회에 필요 없다. 경로 접두어는 호스트를 가리지 않는다.
  // `cdn.mirihae.com`에서는 `/api/entering`, `/api/waiting` 말고는 부르지 않는다(어댑터가 다른 경로를 만들지 않는다).
  // `/camping/calendar.do`(다른 달 달력)와 예약 화면(`/<tenant>/camping/<pageId>`)은 막지 않는다.
  blockedPaths: [
    "/camping/tokenCheck.do",
    "/camping/initSelectReservation.do",
    "/camping/updateSelctItemticketCntChange.do",
    "/camping/deSelectTicket.do",
    "/camping/nightCheck.do",
    "/camping/selectItemList.do",
    "/camping/selectItemForm.do",
    "/camping/reservationForm.do",
    "/camping/selectAjaxDatePinInfo.do",
    "/camping/selectReservationCheck.do",
    "/camping/selectTicketInfo.do",
    "/camping/totalTicketPrice.do",
    "/camping/paymentForm.do",
    // 예약확인/취소와 로그인은 카탈로그의 입점 기관(tenant)마다 넣는다.
    ...tenants.flatMap((t) => [`/${t}/camping/reservation/`, `/${t}/login.do`]),
    "/login.do",
    "/logout.do",
    "/mypage.do",
    "/api/camping/",
  ],
  // 예약 화면이 `mirihae` 쿠키를 주고(`calendar.do`가 쓴다), 입장 토큰을 쿠키 단지에도 심는다.
  cookieSession: true,
  // 시설이 여럿이라(입점 기관마다) 시설을 꼭 골라야 한다.
  facilityRequired: true,
};

const pageUrlOf = (facility: string): string => {
  const ref = resolveFacility(INFO, facility).ref;
  if (typeof ref !== "object" || !ref.tenant || !ref.pageId) throw new Error(`mirihae 시설 ${facility}에 tenant·pageId가 없다`);
  return `${ORIGIN}/${ref.tenant}/camping/${ref.pageId}`;
};

/** 게이트 대기 폴링 간격. `waiting.js`의 `setInterval(…, 10000)`과 같다. */
const POLL_MS = 10_000;
/** 대기가 이만큼 넘게 이어지면 그 바퀴를 포기한다(동해시와 같은 값). */
const MAX_WAIT_MS = 120_000;

/** 응답 본문에서 입장 토큰을 읽는다. 없거나 모양이 다르면 구조 변경이다. */
function enteringTokenOf(body: string, where: string): string {
  let token: unknown;
  try {
    token = (JSON.parse(body) as { enteringToken?: unknown }).enteringToken;
  } catch {
    // 아래에서 같이 처리한다.
  }
  if (typeof token !== "string" || token === "") throw new AdapterError("unrecognized", `${where}: 응답에 enteringToken이 없다`);
  return token;
}

/**
 * 게이트 응답의 상태를 신호로 옮긴다. 403은 사전 대기(예약 개시 전 막는 구간)이고 예약처가 일부러 막은 것이다. 404는 구조 변경이다.
 * 그 밖의 모든 상태(5xx 포함)는 일시 오류다. `entering.js`는 200·401·403·404 밖의 응답이면 임의 UUID를 `gateToken`으로 붙여 넘어가지만(실패 시 열림) 키 위조라서 그런 경로는 두지 않는다.
 */
function gateStatusError(status: number, where: string): AdapterError {
  if (status === 403) return new AdapterError("unavailable", `${where}: 사전 대기(HTTP 403), 예약 개시 전 예약처가 막았다`);
  if (status === 404) return new AdapterError("unrecognized", `${where}: HTTP 404`);
  return new AdapterError("transient", `${where}: 예상 밖 HTTP ${status}`);
}

/** 예약 화면 주소에서 게이트가 되돌려 주는 `uri`를 읽는다. 리다이렉트는 따라가지 않고 `Location`의 `uri`만 읽는다. */
async function readGateUri(ctx: AdapterContext, pageUrl: string): Promise<string> {
  return gateUriOf(await send("예약 화면", () => ctx.http.get(pageUrl, { followRedirects: false })), pageUrl);
}

/** 게이트로 보내는 302 응답에서 `uri`를 읽는다. 게이트로 보내지 않으면 응답 상태로 신호를 가른다. */
function gateUriOf(res: TransportResponse, pageUrl: string): string {
  const to = redirectOf(res, pageUrl, "예약 화면");
  if (!to) {
    assertOk(res, "예약 화면");
    throw new AdapterError("unrecognized", "예약 화면이 게이트로 보내지 않았다(HTTP 200)");
  }
  const uri = to.searchParams.get("uri");
  // 게이트가 보낸 주소는 요청한 예약 화면과 같아야 한다. 다른 곳으로 가는 요청은 만들지 않는다.
  if (uri === null || uri.split("?")[0] !== pageUrl) throw new AdapterError("unrecognized", `게이트 화면의 uri가 예약 화면과 다르다(${uri ?? "없음"})`);
  return uri;
}

const gateHeaders = (uri: string, extra: Record<string, string> = {}) => ({
  Origin: GATE_PAGES,
  Referer: `${GATE_PAGES}/entering.html?uri=${uri}`,
  ...extra,
});

const gateUrl = (path: string, uri: string) => `${GATE_API}/${path}?uri=${encodeURIComponent(uri)}`;

/** `GET /api/entering`. 입장 토큰이 있으면 페이지 JS처럼 같은 이름의 헤더로 싣는다. 게이트 요청은 간격 큐 밖에서 보내고 리다이렉트는 따라가지 않는다(게이트 API는 3xx를 주지 않는다). */
const entering = (ctx: AdapterContext, uri: string, token?: string) =>
  send("게이트 입장", () =>
    ctx.http.get(gateUrl("entering", uri), {
      unpaced: true,
      followRedirects: false,
      headers: gateHeaders(uri, { "Content-Type": "application/json", ...(token ? { [ENTERING_TOKEN_NAME]: token } : {}) }),
    }),
  );

/** 대기 토큰을 받는다(`POST /api/waiting`). */
async function takeWaitingToken(ctx: AdapterContext, uri: string): Promise<string> {
  const res = await send("대기 토큰", () => ctx.http.post(gateUrl("waiting", uri), "", { unpaced: true, followRedirects: false, headers: gateHeaders(uri) }));
  if (res.status !== 200) throw gateStatusError(res.status, "대기 토큰");
  const token = res.body.trim();
  if (token === "") throw new AdapterError("transient", "대기 토큰을 받지 못했다");
  return token;
}

/**
 * 대기열에서 순서를 기다려 입장 토큰을 받는다. 425는 대기 중이라 10초 뒤 다시 묻고, 상한(120초)을 넘으면 포기한다.
 * 알려진 한계: `waiting.js`는 425 응답이 응답 헤더 `X-Mirihae-Waiting-Token`으로 새 대기 토큰(만료된 토큰의 같은 순서 재발급)을 주면 바꿔 쓰지만,
 * `TransportResponse`가 임의 응답 헤더를 싣지 않아 읽지 않는다. 대기 토큰 수명이 1시간(기록)이라 120초 상한 안에서는 만료되지 않아 문제가 되지 않는다.
 * 또 `waiting.js`는 예상 대기 시간이 10초보다 짧으면 그 시간만큼만 쉬고 다시 묻지만 이 어댑터는 언제나 10초다(스펙).
 * `POST /api/waiting`은 본문이 없는 요청인데 HTTP 층이 문자열 본문에 form `Content-Type`을 붙여 보낸다(기록과 페이지 JS는 `Content-Type` 없이 보냈다). 서버가 가리는지는 확인하지 못했다.
 */
async function waitForTurn(ctx: AdapterContext, uri: string, waitingToken: string): Promise<string> {
  const started = ctx.clock.now().getTime();
  for (;;) {
    const res = await send("대기 확인", () =>
      ctx.http.get(gateUrl("waiting", uri), { unpaced: true, followRedirects: false, headers: gateHeaders(uri, { [WAITING_TOKEN_NAME]: waitingToken }) }),
    );
    if (res.status === 200) return enteringTokenOf(res.body, "대기 확인");
    if (res.status !== 425) throw gateStatusError(res.status, "대기 확인");
    if (ctx.clock.now().getTime() - started + POLL_MS > MAX_WAIT_MS) throw new AdapterError("transient", "게이트 대기가 상한(120초)을 넘었다");
    await ctx.clock.sleep(POLL_MS, ctx.signal);
  }
}

/** 게이트를 지나 입장 토큰(`gateToken`)을 받는다. 새 방문자는 401 → 대기 토큰 → 대기 → 입장 순서를 지난다. */
async function passGate(ctx: AdapterContext, uri: string): Promise<string> {
  let res = await entering(ctx, uri);
  if (res.status === 401) {
    const token = await waitForTurn(ctx, uri, await takeWaitingToken(ctx, uri));
    // 쿠키 단지에도 심는다(페이지 JS가 쿠키에 두고 헤더로 싣는 것과 같다).
    ctx.http.setCookie(GATE_HOST, ENTERING_TOKEN_NAME, token);
    res = await entering(ctx, uri, token);
  }
  if (res.status !== 200) throw gateStatusError(res.status, "게이트 입장");
  return enteringTokenOf(res.body, "게이트 입장");
}

interface CalendarDay {
  /** 칸에 `click` 클래스가 있다. 예약할 수 있는 날이다. */
  open: boolean;
  /** 구역 이름 → 남은 수. */
  zones: Map<string, number>;
}

interface Calendar {
  month: string;
  days: Map<string, CalendarDay>;
}

/**
 * 봇 탐지 장치·captcha 표지는 `BOT_DETECTION`이다. 천동의 조회 흐름에는 없었고(기록한 화면·스크립트 어디에도 없다) 나타나면 새 신호로 보고 멈춘다.
 * 로그인 화면의 원문은 기록이 없다. 비밀번호 입력란이나 `login.do`로 보내는 이동 스크립트가 달력 자리에 오면 로그인 요구로 본다
 * (기록한 예약 화면은 머리말에 로그인 링크·폼(`logoutForm`)을 달지만 비밀번호 입력란과 이동 스크립트는 없다).
 */
const LOGIN_SCREEN = /type\s*=\s*["']?password|(?:location(?:\.href)?\s*=|location\.(?:replace|assign)\s*\()\s*['"][^'"]*login\.do|http-equiv\s*=\s*["']?refresh["']?[^>]*login\.do/i;

/**
 * 예약 화면의 이번 달 달력을 읽는다. 날짜 칸 `div.td.pignose-calendar-unit-date`(`id="YYYY-MM-DD"`)에 `click` 클래스가 있으면 예약할 수 있는 날이고,
 * 안의 `dl.schedule`마다 `dd`가 구역 이름, `dt`가 남은 수다. 격자는 앞 달의 칸도 그리지만 그 칸은 `click`도 `dl`도 없어서 달에 속한 칸만 읽는다.
 * 칸이 없거나 달 표시·구역 이름·남은 수가 읽히지 않으면 구조 변경이다.
 */
function parseCalendar(html: string, where = "예약 화면", unknownValues?: { zone: string; value: string }[]): Calendar {
  if (BOT_DETECTION.test(html)) throw new AdapterError("blocked", `${where}: 봇 탐지·captcha 표지가 왔다`);
  const $ = cheerio.load(html);
  const cells = $("div.td.pignose-calendar-unit-date");
  if (cells.length === 0) {
    if (LOGIN_SCREEN.test(html)) throw new AdapterError("blocked", `${where}: 달력 대신 로그인 요구가 왔다`);
    throw new AdapterError("unrecognized", `${where}: 달력 칸(div.td.pignose-calendar-unit-date)이 없다`);
  }
  const monthNumber = /^(\d{1,2})월$/.exec($(".pignose-calendar-top-month").first().text().trim())?.[1];
  const year = /^\d{4}$/.exec($(".pignose-calendar-top-year").first().text().trim())?.[0];
  if (!monthNumber || !year) throw new AdapterError("unrecognized", `${where}: 달력의 달 표시(.pignose-calendar-top-month·year)를 읽지 못했다`);
  const month = `${year}-${monthNumber.padStart(2, "0")}`;
  const days = new Map<string, CalendarDay>();
  cells.each((_, el) => {
    const cell = $(el);
    const id = cell.attr("id") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(id)) throw new AdapterError("unrecognized", `${where}: 날짜 칸의 id(YYYY-MM-DD)를 읽지 못했다(${JSON.stringify(id)})`);
    if (!id.startsWith(`${month}-`)) return;
    const zones = new Map<string, number>();
    cell.find("dl.schedule").each((_, dl) => {
      const name = $(dl).find("dd").first().text().trim();
      const count = $(dl).find("dt").first().text().trim();
      if (name === "") throw new AdapterError("unrecognized", `${where}: ${id} 칸의 구역 이름(dd)이 없다`);
      if (!/^\d+$/.test(count) && unknownValues) {
        // catalog --live는 모르는 값을 실패로 치지 않고 구역 이름과 함께 보고한다. 바퀴는 이 인자를 주지 않아 구조 변경으로 던진다.
        unknownValues.push({ zone: name, value: count });
        zones.set(name, 0);
        return;
      }
      if (!/^\d+$/.test(count)) throw new AdapterError("unrecognized", `${where}: ${id} 칸 ${name}의 남은 수가 숫자가 아니다(${JSON.stringify(count)})`);
      zones.set(name, Number(count));
    });
    days.set(id, { open: cell.hasClass("click"), zones });
  });
  if (days.size === 0) throw new AdapterError("unrecognized", `${where}: ${month}에 속한 날짜 칸이 없다`);
  return { month, days };
}

/** 쓰지 않는 구역이 사라지거나 새 구역이 생긴 것은 경고만 남긴다. 감시하는 구역이 사라진 것은 조회 단위 판정이 실패로 처리한다. */
function warnZoneDrift(facility: string, calendar: Calendar, ctx: AdapterContext): void {
  const seen = new Set<string>();
  for (const day of calendar.days.values()) if (day.open) for (const name of day.zones.keys()) seen.add(name);
  if (seen.size === 0) return; // 예약할 수 있는 날이 하나도 없으면 구역을 볼 수 없다
  const known = resolveFacility(INFO, facility).zones.map((z) => z.code);
  for (const name of seen) if (!known.includes(name)) warnDriftOnce(ctx, `${facility}:new:${name}`, "mirihae zone drift", { facility, change: "new", zone: name });
  for (const name of known) if (!seen.has(name)) warnDriftOnce(ctx, `${facility}:gone:${name}`, "mirihae zone drift", { facility, change: "gone", zone: name });
}

/** 입장 토큰(`gateToken`)의 수명. 받은 시각에서 300초다(기록 #84: 토큰 `exp`와 받은 시각의 차이, 만료 20초 뒤 요청은 302로 게이트에 되돌려 보냈다). */
const GATE_TOKEN_LIFETIME_MS = 300_000;
/** 수명이 끝나기 이만큼 전부터는 쓰지 않는다. 예약 화면 요청이 간격 큐에서 기다리는 시간과 시계 차이를 덮는다. 거절은 어차피 새로 지나므로 이 값은 헛된 요청을 줄일 뿐이다. */
const GATE_TOKEN_MARGIN_MS = 20_000;

interface HeldToken {
  token: string;
  uri: string;
  receivedAt: number;
}

/**
 * 받은 입장 토큰을 시설마다 들고 있는다(게이트를 시설마다 따로 지나야 하는지 확인하지 못했다. 다른 시설의 토큰을 쓰지 않는다).
 * 폴러 하나가 쓰는 HTTP 클라이언트마다 따로 둔다. 어댑터 모듈에 전역으로 두면 폴러 사이에 샌다.
 */
const heldTokens = new WeakMap<HttpClient, Map<string, HeldToken>>();
const heldOf = (ctx: AdapterContext): Map<string, HeldToken> => {
  let held = heldTokens.get(ctx.http);
  if (!held) heldTokens.set(ctx.http, (held = new Map()));
  return held;
};

/** 열어 본 예약 화면. `html`은 이번 달 달력이 든 본문이고 `uri`는 그 화면 주소(게이트가 알려 준 것)다. */
interface ReservationPage {
  html: string;
  uri: string;
}

/**
 * `?gateToken=`을 붙여 예약 화면을 연다. 리다이렉트는 따라가지 않는다. 로그인으로 가면 `blocked`다.
 * 서버가 토큰을 받지 않으면(게이트로 302하거나 401) 거절한 응답을 돌려준다. 그 밖의 3xx는 구조 변경이고 나머지 상태는 `assertOk`가 가른다.
 */
async function fetchReservationPage(ctx: AdapterContext, uri: string, token: string): Promise<{ html: string } | { rejected: TransportResponse }> {
  const res = await send("예약 화면", () => ctx.http.get(`${uri}?gateToken=${encodeURIComponent(token)}`, { followRedirects: false, headers: { Referer: `${GATE_PAGES}/` } }));
  const to = redirectOf(res, uri, "예약 화면");
  if (to) {
    if (to.hostname === GATE_HOST) return { rejected: res };
    throw unknownRedirect(to, "예약 화면");
  }
  if (res.status === 401) return { rejected: res };
  assertOk(res, "예약 화면");
  return { html: res.body };
}

/**
 * 시설 예약 화면을 연다. 수명 안의 입장 토큰을 들고 있으면 게이트를 지나지 않고 그 토큰으로 바로 연다(토큰 값은 바꾸지 않는다).
 * 서버가 그 토큰을 받지 않으면 실패로 치지 않고 같은 바퀴에서 게이트를 새로 지난다. 새로 받은 토큰이 곧바로 거절되면 `unrecognized`다.
 * 쿠키는 바퀴마다 비운다. 지난 바퀴의 쿠키(세션, 게이트 토큰)를 들고 가지 않고 입장 토큰만 이어 쓴다.
 */
async function openReservationPage(ctx: AdapterContext, facility: string): Promise<ReservationPage> {
  ctx.http.clearSession();
  const pageUrl = pageUrlOf(facility);
  const held = heldOf(ctx);
  const now = () => ctx.clock.now().getTime();
  let uri: string | undefined;
  const kept = held.get(facility);
  if (kept && now() - kept.receivedAt < GATE_TOKEN_LIFETIME_MS - GATE_TOKEN_MARGIN_MS) {
    ctx.log?.("mirihae gateToken reused", { facility, ageSeconds: Math.round((now() - kept.receivedAt) / 1000) });
    const reused = await fetchReservationPage(ctx, kept.uri, kept.token);
    if ("html" in reused) return { html: reused.html, uri: kept.uri };
    held.delete(facility);
    ctx.log?.("mirihae gateToken rejected", { facility, status: reused.rejected.status });
    // 302는 게이트 주소(`uri`)를 알려 준다. 401은 알려 주지 않으므로 아래에서 예약 화면의 302로 읽는다.
    if (reused.rejected.status !== 401) uri = gateUriOf(reused.rejected, pageUrl);
  } else {
    held.delete(facility);
  }
  uri ??= await readGateUri(ctx, pageUrl);
  const token = await passGate(ctx, uri);
  held.set(facility, { token, uri, receivedAt: now() });
  const fresh = await fetchReservationPage(ctx, uri, token);
  if ("rejected" in fresh) {
    held.delete(facility);
    throw new AdapterError("unrecognized", "게이트가 새로 받은 입장 토큰을 곧바로 거절하고 게이트 화면으로 되돌려 보냈다");
  }
  return { html: fresh.html, uri };
}

/** `jQuery.serialize()`처럼 form 본문을 인코딩한다(`encodeURIComponent`, 공백은 `+`). */
const formEncode = (fields: [string, string][]): string => fields.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`.replace(/%20/g, "+")).join("&");

/**
 * 예약 화면의 `searchForm`을 페이지 JS(`fn_select_month`)처럼 직렬화하고 `selectMonth`만 바꾼다. 이름 있는 입력란을 문서 순서대로 싣는다(비어 있는 값도 싣는다).
 * `tocken`은 화면을 열 때마다 바뀌는 값이라 이 바퀴에서 받은 화면에서 읽는다. 기록한 `searchForm`은 `input`뿐이라 `select`·`textarea`는 읽지 않는다.
 */
function searchFormBody(html: string, month: string): string {
  const form = cheerio.load(html)("form[name=searchForm]").first();
  if (form.length === 0) throw new AdapterError("unrecognized", "예약 화면: searchForm이 없다");
  const fields: [string, string][] = [];
  form.find("input[name]").each((_, el) => {
    const type = (el.attribs.type ?? "text").toLowerCase();
    if (["submit", "button", "image", "reset", "file"].includes(type) || "disabled" in el.attribs) return;
    if ((type === "checkbox" || type === "radio") && !("checked" in el.attribs)) return;
    fields.push([el.attribs.name!, el.attribs.value ?? ""]);
  });
  const at = fields.findIndex(([k]) => k === "selectMonth");
  if (at === -1) throw new AdapterError("unrecognized", "예약 화면: searchForm에 selectMonth가 없다");
  fields[at] = ["selectMonth", month];
  return formEncode(fields);
}

/**
 * 다른 달의 달력을 읽는다(`POST /camping/calendar.do`). 달력만 바꾸는 호출이고 날짜·구역을 고르는 호출이 아니다. 예약 화면과 같은 간격 큐 안에서 보내고 리다이렉트는 따라가지 않는다.
 * 응답은 `<div class="calendar-in">` 조각이고 이번 달 화면과 같은 파서로 읽는다. 다른 달이 오면 구조 변경이다.
 */
async function readMonth(ctx: AdapterContext, page: ReservationPage, month: string): Promise<Calendar> {
  const where = `달력 ${month}`;
  const res = await send(where, () =>
    ctx.http.post(`${ORIGIN}/camping/calendar.do`, searchFormBody(page.html, month), {
      followRedirects: false,
      headers: { Referer: page.uri, Origin: ORIGIN, "X-Requested-With": "XMLHttpRequest", Accept: "text/html, */*; q=0.01" },
    }),
  );
  const to = redirectOf(res, ORIGIN, where);
  if (to) throw unknownRedirect(to, where);
  assertOk(res, where);
  const calendar = parseCalendar(res.body, where);
  if (calendar.month !== month) throw new AdapterError("unrecognized", `${where}: ${calendar.month} 달력이 왔다`);
  return calendar;
}

type Results = Map<AvailabilityQuery, AvailableSite[] | AdapterError>;

const monthOf = (date: string) => date.slice(0, 7);

/** 입실일부터 밤마다의 날짜(입실일 포함, 퇴실일 제외). */
const nightDates = (q: AvailabilityQuery): string[] => Array.from({ length: q.nights }, (_, i) => addDays(q.checkIn, i));

/**
 * 조회 단위 하나를 달력으로 판정한다. 밤마다 칸에 `click`이 있고 구역의 남은 수가 1 이상이어야 빈자리이며 남은 수는 밤마다의 최솟값이다(같은 자리가 이어진다는 보장은 없다).
 * 어느 밤이든 `click`이 없으면 빈자리 없음이다. 밤이 속한 달의 달력을 받지 못했으면 그 달을 읽다 난 오류(`monthFailure`)가 이 단위의 결과다.
 */
function judge(q: AvailabilityQuery, calendars: Map<string, Calendar>, monthFailure: AdapterError | undefined): AvailableSite[] | AdapterError {
  let remaining = Infinity;
  for (const night of nightDates(q)) {
    const calendar = calendars.get(monthOf(night));
    if (!calendar) return monthFailure ?? new UnitStructureError(`예약 화면: ${night}가 속한 달의 달력이 없다`);
    const day = calendar.days.get(night);
    if (!day) return new UnitStructureError(`예약 화면: ${night} 날짜 칸이 달력에 없다`);
    if (!day.open) return [];
    const count = day.zones.get(q.zone);
    if (count === undefined) return new UnitStructureError(`예약 화면: ${night} 칸에 감시하는 구역 ${q.zone}이(가) 없다`);
    remaining = Math.min(remaining, count);
  }
  return remaining >= 1 ? [{ id: q.zone, name: q.zone, remaining }] : [];
}

/**
 * 예약처 전체의 문제인가. 그렇다면 다른 시설을 조회해도 같은 오류를 받을 것이라 남은 시설은 요청 없이 같은 오류로 처리한다.
 * - `blocked`: 차단·로그인 요구·captcha. 예약처가 막은 것이고 ADR 0002에 따라 더 두드리지 않는다.
 * - 연결 실패(`ConnectionFailure`): 게이트(`cdn.mirihae.com`)든 예약 화면(`mirihae.com`)이든 호스트에 닿지 못했다.
 * - `unavailable`: 게이트 403(사전 대기)은 스펙이 "예약처가 일부러 막은 것"으로 보고 30분 뒤에 다시 보라는 신호다. 시설마다 따로인지 확인하지 못했고
 *   헬스 상태(점검 중, 30분 휴식)는 예약처 단위라 보수적으로 사이트 전체로 본다. 사전 대기 중인 게이트를 다른 시설로 더 두드리지 않는다.
 * 그 밖의 실패(`unrecognized`: 404·구조 변경·calendar.do 실패, `transient`: 게이트 5xx·대기 상한 초과·토큰 미수신)는 그 시설에 국한된 것으로 본다.
 */
const isSiteWide = (e: AdapterError): boolean => e.kind === "blocked" || e.kind === "unavailable" || e instanceof ConnectionFailure;

/**
 * 한 바퀴. 시설마다 게이트를 지나 예약 화면(이번 달 달력)을 한 번 읽고, 조회 단위의 밤이 속한 다른 달은 달마다 `calendar.do`를 한 번씩 읽어 그 시설의 조회 단위를 모두 판정한다.
 * 게이트·화면·달력 요청이 실패하면 사이트 전체의 문제(`isSiteWide`)는 남은 시설의 조회 단위까지 그 실패를 받고(요청을 더 보내지 않는다), 그 밖의 실패는 그 시설의 조회 단위만 받고 다음 시설을 이어서 조회한다.
 * 다른 달 요청이 실패하면 같은 시설 안에서는 그 달을 읽지 못해 판정할 수 없는 단위만 그 실패를 받고 화면의 달만 쓰는 단위는 판정한다. 그 시설의 남은 달은 더 요청하지 않는다.
 * 한 단위만의 구조 변경(감시 구역이 칸에서 사라짐)은 그 단위만 실패다.
 */
async function runBatch(units: AvailabilityQuery[], ctx: AdapterContext): Promise<Results> {
  const results: Results = new Map();
  const byFacility = new Map<string, AvailabilityQuery[]>();
  for (const q of units) {
    const max = resolveFacility(INFO, q.facility).maxNights ?? INFO.maxNights;
    if (q.nights > max) throw new Error(`mirihae ${q.facility}는 최대 ${max}박만 읽는다(${q.nights}박)`);
    byFacility.set(q.facility, [...(byFacility.get(q.facility) ?? []), q]);
  }
  let siteWideFailure: AdapterError | undefined;
  for (const [facility, group] of byFacility) {
    if (siteWideFailure) {
      for (const q of group) results.set(q, siteWideFailure);
      continue;
    }
    try {
      const page = await openReservationPage(ctx, facility);
      const first = parseCalendar(page.html);
      warnZoneDrift(facility, first, ctx);
      const calendars = new Map([[first.month, first]]);
      let monthFailure: AdapterError | undefined;
      for (const month of new Set(group.flatMap((q) => nightDates(q).map(monthOf)))) {
        if (calendars.has(month)) continue;
        try {
          calendars.set(month, await readMonth(ctx, page, month));
        } catch (e) {
          if (!(e instanceof AdapterError)) throw e;
          monthFailure = e;
          if (isSiteWide(e)) siteWideFailure = e;
          break;
        }
      }
      for (const q of group) results.set(q, judge(q, calendars, monthFailure));
    } catch (e) {
      if (!(e instanceof AdapterError)) throw e;
      if (isSiteWide(e)) siteWideFailure = e;
      for (const q of group) results.set(q, e);
    }
  }
  return results;
}

export const mirihaeAdapter: ProviderAdapter = {
  id: "mirihae",

  describe: () => INFO,

  async queryAvailability(q, ctx) {
    const found = (await runBatch([q], ctx)).get(q);
    if (found instanceof Error) throw found;
    return found ?? [];
  },

  queryAvailabilityBatch: runBatch,

  /**
   * catalog --live용. 게이트를 지나 예약 화면을 한 번 열고 달력의 구역 이름 집합과 모르는 값(숫자가 아닌 남은 수)을 돌려준다. 바퀴와 같은 파서를 쓴다.
   * 닫힌 날짜 칸은 `dl`이 없으므로 이번 달 칸 가운데 `dl`이 있는 칸의 구역을 모은다. 하나도 없으면(예: 휴장) 비교할 수 없다고 알린다.
   */
  async listZones(q, ctx): Promise<ZoneObservation> {
    const unknown: ZoneObservation["unknown"] = [];
    const page = await openReservationPage(ctx, q.facility);
    const calendar = parseCalendar(page.html, undefined, unknown);
    const zones = new Set<string>();
    for (const day of calendar.days.values()) for (const name of day.zones.keys()) zones.add(name);
    if (zones.size === 0) {
      return { zones: [], unknown, nothingToCompare: `${calendar.month} 달력에 구역이 하나도 보이지 않아 카탈로그와 비교할 수 없다(예약할 수 있는 날이 없거나 휴장일 수 있다)` };
    }
    return { zones: [...zones], unknown };
  },

  deepLink: (q) => pageUrlOf(q.facility),
};
