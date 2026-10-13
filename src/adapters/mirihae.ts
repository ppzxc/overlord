// 미리해(mirihae.com, 소스팜) 예약처 어댑터. 입점 기관(단양관광공사, 여주 등)의 캠핑장이 같은 예약 화면과 같은 게이트를 쓴다. 시설·구역 목록과 기록으로 확인한 값은 카탈로그(`src/catalogs/mirihae.ts`)에 있다.
//
// 읽는 방법(#84, 천동 `/dytc/camping/V39628874`, research/raw/mirihae):
// - 예약 화면은 항상 자체 게이트(`cdn.mirihae.com`) 뒤에 있다. 게이트는 예약 화면 요청이 302로 알려 주는 `uri`로 시작한다(ADR 0002: 자체 게이트도 대기열로 보고 페이지 JS(`entering.js`, `waiting.js`)대로 참여한다).
//   `/api/entering` 401 → `POST /api/waiting` → `GET /api/waiting` 10초 간격(425면 계속) → `/api/entering` 200 → `?gateToken=`을 붙인 예약 화면 200.
//   게이트 요청은 간격 큐 밖에서 보내고 예약 화면 요청은 큐 안에서 보낸다. 요청 사이 간격은 HTTP 층이 맡는다.
// - `entering.js`가 `/api/entering`이 200·401·403·404 밖의 응답일 때 쓰는 임의 UUID `gateToken`(실패 시 열림)은 키 위조라서 어떤 경우에도 쓰지 않는다. 그런 경로를 두지 않는다.
// - 달력은 서버가 그린다. 날짜 칸 `div.td.pignose-calendar-unit-date`에 `click` 클래스가 있으면 예약할 수 있는 날이고 `dl.schedule`의 `dt`가 구역(`dd`)별 남은 수다.
//   감시 단위는 구역이다. 자리 번호는 보지 않는다. 날짜를 고르는 순간부터는 자리를 잡는 호출(`tokenCheck.do`, `initSelectReservation.do` 등)이 나가므로 첫 화면에서 멈춘다.
// - 바퀴마다 게이트를 새로 지난다. 이번 달만 읽고 다른 달 입실일은 빈자리 없음으로 둔다(`calendar.do`는 다음 조각 #85).
import * as cheerio from "cheerio";
import {
  AdapterError,
  type AdapterContext,
  type AvailabilityQuery,
  type AvailableSite,
  type ProviderAdapter,
  type ProviderInfo,
} from "../types.js";
import { facilities } from "../catalogs/mirihae.js";
import { resolveFacility } from "../facility.js";
import { BOT_DETECTION, UnitStructureError, assertOk, send } from "../adapter-signals.js";
import { warnDriftOnce } from "../netfunnel.js";
import { kstDate } from "../schedule.js";

const ORIGIN = "https://mirihae.com";
/** 게이트의 정적 화면(`entering.html`, `waiting.html`)이 있는 곳. API는 이 화면의 JS가 `https://cdn.mirihae.com`으로 보낸다. */
const GATE_PAGES = "https://cdn.mirihae.com:9443";
const GATE_API = "https://cdn.mirihae.com/api";
const GATE_HOST = "cdn.mirihae.com";
const ENTERING_TOKEN_NAME = "X-Mirihae-Reservation-Token";
const WAITING_TOKEN_NAME = "X-Mirihae-Waiting-Token";

const INFO: ProviderInfo = {
  id: "mirihae",
  facilities,
  // 입점 기관마다 다를 수 있고 확인하지 못했다(카탈로그 머리 주석). 이 조각은 1박만 읽는다.
  maxNights: 1,
  // 오픈 규칙은 확인하지 못했다. 아래 세 값은 타입상 필수인 날짜 창이고 열리는 때를 주장하지 않는다.
  // - openDaysBefore 62, openTime 00:00: 이번 달만 읽으므로 넉넉히 건 걸러내기다. 이보다 먼 날짜는 요청 없이 건너뛴다.
  // - sameDayCutoff 00:00: 화면이 오늘 칸에 "당일예약 불가"를 달고 `click`을 주지 않는다(2026-10-13 09:28 기록). 당일 입실 마감 시각은 모른다.
  openingRule: { openDaysBefore: 62, openTime: "00:00", sameDayCutoff: "00:00" },
  // 오픈 경쟁 시간(`openingRush`)은 두지 않는다. 입점 기관마다 여는 시각을 모른다.
  // 게이트를 바퀴마다 지나고 시설이 늘 수 있어 150초보다 길게 잡는다. `gateToken` 재사용(#85)이 되면 줄이는 것을 검토한다.
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
    "/dytc/camping/reservation/",
    "/login.do",
    "/dytc/login.do",
    "/logout.do",
    "/mypage.do",
    "/api/camping/",
  ],
  // 예약 화면이 `mirihae` 쿠키를 주고(다음 조각의 `calendar.do`가 쓴다), 입장 토큰을 쿠키 단지에도 심는다.
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
  const res = await send("예약 화면", () => ctx.http.get(pageUrl, { followRedirects: false }));
  if (!(res.status >= 300 && res.status < 400 && res.location)) {
    assertOk(res, "예약 화면");
    throw new AdapterError("unrecognized", "예약 화면이 게이트로 보내지 않았다(HTTP 200)");
  }
  const to = new URL(res.location, pageUrl);
  if (/\/login/i.test(to.pathname)) throw new AdapterError("blocked", `예약 화면이 로그인(${to.pathname})으로 보냈다`);
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
function parseCalendar(html: string): Calendar {
  const where = "예약 화면";
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

/**
 * 게이트를 지나 시설 예약 화면을 연다. 게이트는 항상 새로 지난다(`gateToken` 재사용은 다음 조각).
 * 요청 주소는 `?gateToken=…`뿐이고 리다이렉트는 따라가지 않는다. 로그인으로 가면 `blocked`, 게이트로 되돌려 보내면(토큰 거절) `transient`다.
 */
async function openReservationPage(ctx: AdapterContext, facility: string): Promise<string> {
  // 바퀴마다 새 방문자로 게이트를 지난다. 지난 바퀴의 입장 토큰 쿠키를 들고 가지 않는다.
  ctx.http.clearSession();
  const uri = await readGateUri(ctx, pageUrlOf(facility));
  const gateToken = await passGate(ctx, uri);
  const res = await send("예약 화면", () =>
    ctx.http.get(`${uri}?gateToken=${encodeURIComponent(gateToken)}`, { followRedirects: false, headers: { Referer: `${GATE_PAGES}/` } }),
  );
  if (res.status >= 300 && res.status < 400 && res.location) {
    const to = new URL(res.location, uri);
    if (/\/login/i.test(to.pathname)) throw new AdapterError("blocked", `예약 화면이 로그인(${to.pathname})으로 보냈다`);
    if (to.hostname === GATE_HOST) throw new AdapterError("transient", "게이트가 입장 토큰을 거절하고 게이트 화면으로 되돌려 보냈다");
    throw new AdapterError("unrecognized", `예약 화면이 알 수 없는 곳(${to.host}${to.pathname})으로 보냈다`);
  }
  assertOk(res, "예약 화면");
  return res.body;
}

type Results = Map<AvailabilityQuery, AvailableSite[] | AdapterError>;

const monthOf = (date: string) => date.slice(0, 7);

/** 조회 단위 하나를 달력으로 판정한다. 화면의 달 밖이거나 `click`이 없는 날짜는 빈자리 없음이다. */
function judge(q: AvailabilityQuery, calendar: Calendar): AvailableSite[] | UnitStructureError {
  if (monthOf(q.checkIn) !== calendar.month) return [];
  const day = calendar.days.get(q.checkIn);
  if (!day) return new UnitStructureError(`예약 화면: ${q.checkIn} 날짜 칸이 달력에 없다`);
  if (!day.open) return [];
  const remaining = day.zones.get(q.zone);
  if (remaining === undefined) return new UnitStructureError(`예약 화면: ${q.checkIn} 칸에 감시하는 구역 ${q.zone}이(가) 없다`);
  return remaining >= 1 ? [{ id: q.zone, name: q.zone, remaining }] : [];
}

/**
 * 한 바퀴. 시설마다 게이트를 지나 예약 화면의 이번 달 달력을 한 번 읽고, 그 시설의 조회 단위를 모두 그 화면으로 판정한다.
 * 이번 달 밖의 입실일은 빈자리 없음이다(다른 달은 다음 조각이 연다). 이번 달 날짜가 없는 시설은 게이트도 지나지 않는다.
 * 게이트·화면 요청이 실패하면 그 시설과 남은 시설의 조회 단위가 그 실패를 받는다(요청을 더 보내지 않는다). 한 단위만의 구조 변경(감시 구역이 칸에서 사라짐)은 그 단위만 실패다.
 */
async function runBatch(units: AvailabilityQuery[], ctx: AdapterContext): Promise<Results> {
  const results: Results = new Map();
  const thisMonth = monthOf(kstDate(ctx.clock.now()));
  const byFacility = new Map<string, AvailabilityQuery[]>();
  for (const q of units) {
    const max = resolveFacility(INFO, q.facility).maxNights ?? INFO.maxNights;
    if (q.nights > max) throw new Error(`mirihae ${q.facility}는 최대 ${max}박만 읽는다(${q.nights}박)`);
    if (monthOf(q.checkIn) !== thisMonth) {
      results.set(q, []);
      continue;
    }
    byFacility.set(q.facility, [...(byFacility.get(q.facility) ?? []), q]);
  }
  let stopped: AdapterError | undefined;
  for (const [facility, group] of byFacility) {
    if (stopped) {
      for (const q of group) results.set(q, stopped);
      continue;
    }
    try {
      const calendar = parseCalendar(await openReservationPage(ctx, facility));
      warnZoneDrift(facility, calendar, ctx);
      for (const q of group) results.set(q, judge(q, calendar));
    } catch (e) {
      if (!(e instanceof AdapterError)) throw e;
      stopped = e;
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

  deepLink: (q) => pageUrlOf(q.facility),
};
