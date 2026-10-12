import * as cheerio from "cheerio";
import {
  AdapterError,
  type AdapterContext,
  type AvailabilityQuery,
  type AvailableSite,
  type HttpClient,
  type ProviderAdapter,
  type ProviderInfo,
  type ZoneObservation,
} from "../types.js";

import { facilities } from "../catalogs/donghae.js";
import { resolveFacility } from "../facility.js";
import { acquireKey, forgetKey, releaseKey, type NetFunnelQueue, type QueuePass } from "../netfunnel.js";

const WWW = "https://www.campingkorea.or.kr";
const RESERVATION = `${WWW}/user/reservation`;
const NF: NetFunnelQueue = { tsUrl: "https://nf.campingkorea.or.kr/ts.wseq", sid: "service_1", aid: "reserve" };

/** 동해시 예약처의 관광지 코드는 카탈로그가 시설 ref로 갖고 있다. 카탈로그에 없는 시설은 요청 전에 던진다. */
function trrsrtCodeOf(facility: string): string {
  const { ref } = resolveFacility(INFO, facility);
  if (typeof ref === "object" && ref.trrsrtCode) return ref.trrsrtCode;
  throw new Error(`donghae 시설 ${facility}에 trrsrtCode가 없다`);
}

/** 예약처가 정한 키 수명. 이 안에서만 같은 세션이 키를 다시 쓴다. */
const KEY_TTL_MS = 2 * 60 * 60 * 1000;
/** 페이지의 5분 타이머. 진입 뒤 이 시간이 지난 첫 시점에 setComplete(5004)를 한 번 보낸다. */
const COMPLETE_AFTER_MS = 5 * 60 * 1000;

const INFO: ProviderInfo = {
  id: "donghae",
  facilities,
  maxNights: 3,
  // 하루 뒤 입실부터 받으므로 당일 마감은 00:00이다.
  openingRule: { openDaysBefore: 30, openTime: "11:00", sameDayCutoff: "00:00" },
  openingRush: { from: "10:55", to: "11:30" },
  // 예약·결제·취소·회원정보 경로와 captcha·선점 경로. 빈자리 조회에 필요 없다.
  blockedPaths: [
    "/user/reservation/ND_ncaptcha.do",
    "/user/reservation/ND_chkAnswer.do",
    "/user/reservation/BD_reservationReq.do",
    "/user/reservation/ND_deletePreOcpcInfo.do",
    "/login/",
    "/user/join/",
    "/user/myPage/",
    "/user/bbs/",
  ],
  // 대기열 키를 서버 세션에 등록하고 이후 요청이 그 세션을 쓴다.
  cookieSession: true,
};

/**
 * 예약 화면은 브라우저 요청만 받는다. Referer·Origin 없이 진입 POST를 보내면 예약 화면 대신 대기 페이지(달력 없음)를 돌려준다(실측).
 * 브라우저가 www POST마다 보내는 값을 그대로 싣는다.
 */
const PAGE_HEADERS = { Referer: `${RESERVATION}/BD_reservation.do`, Origin: WWW };

const NETFUNNEL_JS = `${WWW}/resources/user/js/netfunnel.js`;
// 2026-09-29에 확인한 값. 달라지면 경고만 남긴다.
const NETFUNNEL_VERSION = "2.2.25_hotfix";
const NETFUNNEL_TS_HOST = "nf.campingkorea.or.kr";

const CLOSED_VALUES = new Set(["예약완료", "예약불가", "준비중"]);
const AUTH_MARKER = /로그인|인증/;

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const nightsOf = (q: AvailabilityQuery) => Array.from({ length: q.nights }, (_, i) => addDays(q.checkIn, i));

/** 조회 단위 하나의 실패로 담을 오류인지. NOPASS는 바퀴 전체를 다시 진입해야 하므로 던져 올린다. */
const isUnitFailure = (e: unknown): e is AdapterError => e instanceof AdapterError && !(e instanceof NoPassError);

/** 예약처가 `NOPASS:`로 키·세션을 거절했다. 바퀴가 한 번만 다시 진입한다. */
class NoPassError extends AdapterError {
  constructor(what: string) {
    super("unrecognized", `${what}: NOPASS 응답`);
  }
}

async function fetchOk(res: Promise<{ status: number; body: string }>, what: string): Promise<string> {
  const r = await res;
  if (r.body.startsWith("NOPASS:")) throw new NoPassError(what);
  if (r.status >= 500) throw new AdapterError("transient", `${what}: HTTP ${r.status}`);
  if (r.status !== 200) {
    const common404 = r.status === 404 && r.body.includes("mError1") ? "(공통 404 화면) " : "";
    throw new AdapterError("unrecognized", `${what}: ${common404}예상 밖 HTTP ${r.status}`);
  }
  return r.body;
}

/**
 * 대기열을 통과한 진입 응답이 갖춰야 하는 표식. 브라우저로 기록한 실제 응답은 이번 달 달력 화면이다(실측).
 * 표식이 없으면 대기 페이지가 돌아온 것이거나 예약처 구조가 바뀐 것이다.
 */
const ENTRY_MARKERS: { pattern: RegExp; label: string }[] = [
  { pattern: /name="netfunnel_key"/, label: "netfunnel_key 필드" },
  { pattern: /class="mCalendar1"/, label: "월 달력" },
];

/** `netfunnel.js` 경고 확인을 이미 한 세션. 새 키로 진입할 때마다 다시 확인한다. */
const scriptChecked = new WeakSet<HttpClient>();

/**
 * `netfunnel.js`의 버전과 `TS_HOST`가 확인한 값과 다르면 경고만 남긴다. 페이지와 같은 요청 순서를 지키려고 첫 조회가 끝난 뒤 세션당 한 번 받는다.
 * 받지 못해도 감시는 그대로다.
 */
async function warnNetfunnelDrift(ctx: AdapterContext): Promise<void> {
  if (scriptChecked.has(ctx.http) || ctx.signal?.aborted) return;
  scriptChecked.add(ctx.http);
  try {
    const res = await ctx.http.get(NETFUNNEL_JS);
    if (res.status !== 200) return;
    const version = /Version\s+(\S+)/.exec(res.body)?.[1];
    const host = /^NetFunnel\.TS_HOST\s*=\s*'([^']*)'/m.exec(res.body)?.[1];
    if (version !== NETFUNNEL_VERSION) ctx.log?.("donghae netfunnel.js version changed", { expected: NETFUNNEL_VERSION, actual: version });
    if (host !== NETFUNNEL_TS_HOST) ctx.log?.("donghae TS_HOST changed", { expected: NETFUNNEL_TS_HOST, actual: host });
  } catch {
    // 경고 전용이라 실패해도 감시는 그대로다.
  }
}

/** `ND_checkNfKeyAvail.do`로 서버가 키를 아직 받아 주는지 묻는다. */
async function keyAvailable(ctx: AdapterContext, key: string): Promise<boolean> {
  const body = await fetchOk(ctx.http.post(`${RESERVATION}/ND_checkNfKeyAvail.do`, { netfunnel_key: key }, { headers: PAGE_HEADERS }), "키 확인");
  let message: unknown;
  try {
    message = (JSON.parse(body) as { message?: unknown }).message;
  } catch {
    throw new AdapterError("unrecognized", "키 확인 응답이 JSON이 아니다");
  }
  if (typeof message !== "string") throw new AdapterError("unrecognized", "키 확인 응답에 message가 없다");
  return !message.includes("NOT Available");
}

/** 키를 서버 세션에 등록하고 예약 화면에 진입해 임시 중단 호실 표를 읽는다. */
async function enterSession(ctx: AdapterContext, pass: QueuePass): Promise<Map<string, number>> {
  await fetchOk(
    ctx.http.post(`${RESERVATION}/ND_setNfKey.do`, pass.key, { contentType: "application/json", headers: PAGE_HEADERS }),
    "키 등록",
  );
  const entry = await fetchOk(
    ctx.http.post(`${RESERVATION}/BD_reservation.do`, {
      q_complete: "Y",
      q_trrsrtCd: "",
      trrsrtCode: "",
      q_year: "",
      q_month: "",
      netfunnel_key: pass.key,
    }, { headers: PAGE_HEADERS }),
    "예약 화면 진입",
  );
  for (const { pattern, label } of ENTRY_MARKERS) {
    if (!pattern.test(entry)) throw new AdapterError("unrecognized", `예약 화면 흐름 문자열이 사라졌다: ${label}`);
  }
  const reduced = parseReduced(entry);
  scriptChecked.delete(ctx.http);
  return reduced;
}

/** 이 세션이 쓸 키를 정한다. 키 재사용·재확인·5004 흐름은 공용 모듈이 맡는다. */
const acquireSession = (ctx: AdapterContext) =>
  acquireKey(ctx, NF, {
    ttlMs: KEY_TTL_MS,
    completeAfterMs: COMPLETE_AFTER_MS,
    confirm: (key) => keyAvailable(ctx, key),
    enter: (pass) => enterSession(ctx, pass),
  });

/** 진입 응답의 `temporaryReducedCounts = { '이름' : 20 }`을 읽는다. 상수가 없으면 구조 변경이다. */
function parseReduced(html: string): Map<string, number> {
  const m = /temporaryReducedCounts\s*=\s*\{([^}]*)\}/.exec(html);
  if (!m) throw new AdapterError("unrecognized", "temporaryReducedCounts를 찾지 못했다");
  const reduced = new Map<string, number>();
  for (const pair of m[1]!.matchAll(/['"]([^'"]+)['"]\s*:\s*(\d+)/g)) reduced.set(pair[1]!, Number(pair[2]));
  return reduced;
}

const KNOWN_ZONES = new Set(facilities.flatMap((f) => f.zones).map((z) => z.name));
/** 세션(HttpClient)마다 이미 경고한 구역 차이. 같은 차이는 한 번만 남긴다. */
const warnedDrift = new WeakMap<HttpClient, Set<string>>();

/** 쓰지 않는 구역이 사라지거나 새 구역이 생긴 것은 경고만 남긴다. 감시 조건이 쓰는 구역이 사라진 것은 조회 단위 판정이 실패로 처리한다. */
function warnZoneDrift(counts: Map<string, number>, ctx: AdapterContext): void {
  const warned = warnedDrift.get(ctx.http) ?? new Set<string>();
  warnedDrift.set(ctx.http, warned);
  const drift = [
    ...[...counts.keys()].filter((n) => !KNOWN_ZONES.has(n)).map((n) => `new:${n}`),
    ...[...KNOWN_ZONES].filter((n) => !counts.has(n)).map((n) => `gone:${n}`),
  ];
  for (const d of drift) {
    if (warned.has(d)) continue;
    warned.add(d);
    ctx.log?.("donghae zone drift", { change: d.startsWith("new:") ? "new" : "gone", zone: d.slice(d.indexOf(":") + 1) });
  }
}

/** 하룻밤 응답을 구역 이름과 값 문자열로 나눈다. 응답 구조가 깨졌으면 던진다. */
function splitNight(body: string): { name: string; value: string }[] {
  let json: { result?: unknown; value?: unknown; message?: unknown };
  try {
    json = JSON.parse(body);
  } catch {
    throw new AdapterError("unrecognized", "날짜 조회 응답이 JSON이 아니다");
  }
  if (json.result !== true) {
    const message = String(json.message ?? "");
    // 날짜 조회는 NOPASS를 본문 앞머리가 아니라 JSON message로 알린다(실측). 메시지에 "인증"이 들어 있어도 로그인 요구가 아니라 키 거절이다.
    if (message.startsWith("NOPASS:")) throw new NoPassError("날짜 조회");
    if (AUTH_MARKER.test(message)) throw new AdapterError("blocked", `로그인·인증을 요구한다: ${message}`);
    throw new AdapterError("unrecognized", `날짜 조회가 실패했다: ${message}`);
  }
  if (typeof json.value !== "string") throw new AdapterError("unrecognized", "날짜 조회 응답에 value가 없다");
  return json.value.split("|^|").map((item) => {
    const i = item.lastIndexOf(":");
    if (i <= 0) throw new AdapterError("unrecognized", `날짜 조회 값 구조가 깨졌다: ${item}`);
    return { name: item.slice(0, i), value: item.slice(i + 1) };
  });
}

/** 값이 숫자이거나 닫힘을 뜻하는 알려진 문자열이면 남은 수, 아니면 undefined. */
const countOf = (value: string): number | undefined => (/^\d+$/.test(value) ? Number(value) : CLOSED_VALUES.has(value) ? 0 : undefined);

/** 하룻밤 응답에서 구역 이름 → 남은 수. 임시 중단 호실은 이름이 정확히 같을 때만 뺀다. */
function parseNight(body: string, reduced: Map<string, number>, ctx: AdapterContext): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { name, value } of splitNight(body)) {
    const n = countOf(value);
    if (n === undefined) throw new AdapterError("unrecognized", `모르는 값: ${name}=${value}`);
    const cut = reduced.get(name);
    counts.set(name, cut === undefined ? n : Math.max(0, n - cut));
  }
  warnZoneDrift(counts, ctx);
  return counts;
}

/** 월 달력 칸 하나의 상태. 열리지 않았거나 지난 날짜는 칸이 있어도 넣지 않는다. */
type CalendarDay = "open" | "closed";

/** 월 달력 화면에서 날짜 → 상태. 알아볼 수 있는 칸이 하나도 없으면 구조 변경이다. */
function parseCalendar(html: string): { month: string; days: Map<string, CalendarDay> } {
  const $ = cheerio.load(html);
  const y = $("#q_year").attr("value");
  const m = $("#q_month").attr("value");
  const cells = $("div.mCalendar1 td");
  if (!y || !m || cells.length === 0) throw new AdapterError("unrecognized", "월 달력 구조를 찾지 못했다");
  const month = `${y}-${m.padStart(2, "0")}`;
  const days = new Map<string, CalendarDay>();
  cells.each((_, td) => {
    const day = $(td).find("div.da").first().text().trim();
    if (!/^\d+$/.test(day)) return;
    const date = `${month}-${day.padStart(2, "0")}`;
    if ($(td).find("a.reserve").length > 0) days.set(date, "open");
    else if ($(td).find("li.end").text().includes("예약마감")) days.set(date, "closed");
  });
  if (days.size === 0) throw new AdapterError("unrecognized", `월 달력 ${month}에서 열림·마감 칸을 하나도 읽지 못했다`);
  return { month, days };
}

/**
 * 항목을 차례로 읽는다. 첫 실패에서 멈추고 그때까지 읽은 결과와 실패를 함께 돌려준다.
 * 중단 신호가 오면 transient 실패로 멈춘다. NOPASS는 던져 올려 바퀴가 다시 진입하게 한다.
 */
async function readEach<K, V>(
  keys: Iterable<K>,
  ctx: AdapterContext,
  read: (key: K) => Promise<V>,
): Promise<{ read: Map<K, V>; failure?: AdapterError }> {
  const done = new Map<K, V>();
  for (const key of keys) {
    if (ctx.signal?.aborted) return { read: done, failure: new AdapterError("transient", "중단되었다") };
    try {
      done.set(key, await read(key));
    } catch (e) {
      if (isUnitFailure(e)) return { read: done, failure: e };
      throw e;
    }
  }
  return { read: done };
}

/** 월 달력 하나를 BD_reservationOrigin으로 읽는다. 진입 응답에는 달력이 없다(기록 확인). */
async function readCalendar(trrsrtCode: string, month: string, ctx: AdapterContext, pass: QueuePass): Promise<Map<string, CalendarDay>> {
  const [year, mm] = month.split("-");
  const body = await fetchOk(
    ctx.http.post(`${RESERVATION}/BD_reservationOrigin.do`, {
      trrsrtCode,
      q_year: year!,
      q_month: mm!,
      netfunnel_key: pass.key,
    }, { headers: PAGE_HEADERS }),
    `월 달력 ${month}`,
  );
  const cal = parseCalendar(body);
  if (cal.month !== month) throw new AdapterError("unrecognized", `월 달력 ${month}을(를) 요청했는데 ${cal.month}이(가) 왔다`);
  return cal.days;
}

/** 하룻밤 조회 응답 본문. 바퀴와 catalog --live가 같은 요청을 보낸다. */
function fetchNight(trrsrtCode: string, date: string, ctx: AdapterContext, pass: QueuePass): Promise<string> {
  const [year, month, day] = date.split("-");
  return fetchOk(
    ctx.http.post(`${RESERVATION}/ND_selectFcltyCalendarDetail.do`, {
      trrsrtCode,
      q_year: year!,
      q_month: month!,
      qDay: String(Number(day)),
      passResv1: "",
      passNfTime: String(pass.waitedMs),
      netfunnel_key: pass.key,
    }, { headers: PAGE_HEADERS }),
    `날짜 조회 ${date}`,
  );
}

/** 대기열 진입부터 밤 조회까지 한 바퀴. NOPASS는 NoPassError로 던져 호출자가 재진입하게 한다. */
async function runBatch(
  units: AvailabilityQuery[],
  ctx: AdapterContext,
): Promise<Map<AvailabilityQuery, AvailableSite[] | AdapterError>> {
  const results = new Map<AvailabilityQuery, AvailableSite[] | AdapterError>();
  // 한 바퀴는 한 시설만 읽는다. 시설이 하나뿐이라 호출자도 한 시설만 보낸다.
  const trrsrtCodes = new Set(units.map((q) => trrsrtCodeOf(q.facility)));
  if (trrsrtCodes.size > 1) throw new Error("한 번에 시설 하나만 조회할 수 있다");
  const [trrsrtCode] = trrsrtCodes;
  if (trrsrtCode === undefined) return results;
  const { lease, pass } = await acquireSession(ctx);
  const reduced = lease.extra;

  const allDates = [...new Set(units.flatMap(nightsOf))].sort();
  const months = new Set(allDates.map((d) => d.slice(0, 7)));
  const calendars = await readEach(months, ctx, (month) => readCalendar(trrsrtCode, month, ctx, pass));
  const calendar = { days: new Map([...calendars.read.values()].flatMap((m) => [...m])), failure: calendars.failure };
  // 필요한 밤 하나라도 예약마감이면 날짜 조회 없이 빈 결과다.
  const closed = (q: AvailabilityQuery) => nightsOf(q).some((d) => calendar.days.get(d) === "closed");
  for (const q of units) if (closed(q)) results.set(q, []);
  const live = units.filter((q) => !closed(q));

  // 달력에서 실패했으면 그게 바퀴의 첫 실패이므로 날짜 조회는 보내지 않는다.
  const liveDates = calendar.failure ? [] : [...new Set(live.flatMap(nightsOf))].sort();
  const { read: nights, failure: nightFailure } = await readEach(liveDates, ctx, async (date) =>
    parseNight(await fetchNight(trrsrtCode, date, ctx, pass), reduced, ctx),
  );
  const failure = calendar.failure ?? nightFailure;
  await warnNetfunnelDrift(ctx);

  for (const q of live) {
    const needed = nightsOf(q);
    const counts = needed.map((d) => nights.get(d));
    if (counts.some((c) => !c)) {
      results.set(q, failure ?? new AdapterError("transient", "밤 조회가 끝나지 않았다"));
      continue;
    }
    const perNight = counts.map((c) => c!.get(q.zone));
    if (perNight.some((n) => n === undefined)) {
      results.set(q, new AdapterError("unrecognized", `응답에서 구역 ${q.zone}이(가) 사라졌다`));
      continue;
    }
    const remaining = Math.min(...(perNight as number[]));
    results.set(q, remaining >= 1 ? [{ id: q.zone, name: q.zone, remaining }] : []);
  }
  return results;
}

/** NOPASS: 키와 쿠키 세션을 버리고 같은 바퀴에서 한 번만 다시 진입한다. */
async function withNoPassRetry<T>(ctx: AdapterContext, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof NoPassError)) throw e;
  }
  ctx.log?.("donghae NOPASS, re-entering", {});
  forgetKey(ctx);
  ctx.http.clearSession();
  try {
    return await run();
  } catch (e) {
    if (e instanceof NoPassError) forgetKey(ctx);
    throw e;
  }
}

export const donghaeAdapter: ProviderAdapter = {
  id: "donghae",

  describe: () => INFO,

  async queryAvailability(q, ctx) {
    const result = (await this.queryAvailabilityBatch!([q], ctx)).get(q);
    if (result instanceof Error) throw result;
    return result ?? [];
  },

  /**
   * 같은 세션의 키가 2시간 안이고 서버가 받아 주면 다시 쓰고, 아니면 새로 대기열에 들어가 필요한 밤을 한 번씩 읽는다. 첫 실패에서 멈추고,
   * 이미 읽은 밤만으로 판정되는 조회 단위는 결과를 돌려준다.
   */
  queryAvailabilityBatch: (units, ctx) => withNoPassRetry(ctx, () => runBatch(units, ctx)),

  /** 내일(query의 입실일) 하룻밤만 읽어 구역 이름 집합과 모르는 값을 돌려준다. 달력은 읽지 않는다. */
  async listZones(q, ctx): Promise<ZoneObservation> {
    return withNoPassRetry(ctx, async () => {
      const trrsrtCode = trrsrtCodeOf(q.facility);
      const { pass } = await acquireSession(ctx);
      const items = splitNight(await fetchNight(trrsrtCode, q.checkIn, ctx, pass));
      return {
        zones: items.map((i) => i.name),
        unknown: items.filter((i) => countOf(i.value) === undefined).map((i) => ({ zone: i.name, value: i.value })),
      };
    });
  },

  async close(ctx) {
    await releaseKey(ctx, NF);
  },

  deepLink: () => `${RESERVATION}/BD_reservation.do`,
};
