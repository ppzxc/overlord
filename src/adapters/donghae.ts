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
  type ZoneInfo,
} from "../types.js";

const WWW = "https://www.campingkorea.or.kr";
const RESERVATION = `${WWW}/user/reservation`;
const NF_URL = "https://nf.campingkorea.or.kr/ts.wseq";
const TRRSRT_CODE = "1000";

/** 5002 재확인을 서버가 준 간격대로 반복하되, 이만큼 넘게 기다리면 그 바퀴를 포기한다. */
const MAX_WAIT_MS = 120_000;
/** 예약처가 정한 키 수명. 이 안에서만 같은 세션이 키를 다시 쓴다. */
const KEY_TTL_MS = 2 * 60 * 60 * 1000;
/** 페이지의 5분 타이머. 진입 뒤 이 시간이 지난 첫 시점에 setComplete(5004)를 한 번 보낸다. */
const COMPLETE_AFTER_MS = 5 * 60 * 1000;

// 구역 코드와 이름은 모두 응답의 표시 이름이다(2026-09-29 확인). 구역 이름 앞의 분류는 넓은 분류일 뿐이고 든바다·난바다·허허바다는 확인하지 못했다. 정원은 확인한 구역만 적는다.
const zone = (name: string, type: string, capacity?: number): ZoneInfo => ({
  code: name,
  name,
  type,
  ...(capacity ? { capacity } : {}),
});
const ZONES: ZoneInfo[] = [
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

const INFO: ProviderInfo = {
  id: "donghae",
  facility: "mangsang",
  zones: ZONES,
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

/** `NetFunnel.gControl.result='5002:200:key=…&nwait=0&ttl=0…'`에서 코드와 필드를 읽는다. */
function parseNf(body: string): { code: number; fields: URLSearchParams } {
  const m = /NetFunnel\.gControl\.result='(\d+):(\d+):([^']*)'/.exec(body);
  if (!m) throw new AdapterError("transient", "대기열 응답을 읽지 못했다");
  return { code: Number(m[2]), fields: new URLSearchParams(m[3]) };
}

// 5101은 기록으로 확인했다. 5002의 URL 형태는 기록에 없어 표준 NetFunnel 형식을 따른 것이며 미검증이다.
const nfUrl = (opcode: number, now: number, key?: string) =>
  `${NF_URL}?opcode=${opcode}&nfid=0&prefix=NetFunnel.gRtype=${opcode};&sid=service_1&aid=reserve&js=yes${key ? `&key=${encodeURIComponent(key)}` : ""}&${now}`;

/** 대기열을 통과해 받은 키와 기다린 시간(ms). */
interface QueuePass {
  key: string;
  waitedMs: number;
}

/** 대기열에 참여해 키와 기다린 시간(ms)을 받는다. 대기열 서버 요청은 간격 큐 밖에서 보낸다. */
async function enterQueue(ctx: AdapterContext): Promise<QueuePass> {
  const started = ctx.clock.now().getTime();
  let opcode = 5101;
  let key: string | undefined;
  for (;;) {
    let body: string;
    try {
      const res = await ctx.http.get(nfUrl(opcode, ctx.clock.now().getTime(), key), { unpaced: true });
      if (res.status !== 200) throw new AdapterError("transient", `대기열 HTTP ${res.status}`);
      body = res.body;
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      throw new AdapterError("transient", `대기열 서버에 연결하지 못했다: ${(e as Error).message}`);
    }
    const { code, fields } = parseNf(body);
    if (code === 301 || code === 302) throw new AdapterError("blocked", `대기열이 차단 신호(${code})를 줬다`);
    key = fields.get("key") ?? key;
    if (code === 200) {
      if (!key) throw new AdapterError("transient", "대기열이 키를 주지 않았다");
      return { key, waitedMs: ctx.clock.now().getTime() - started };
    }
    if (code !== 201 || !key) throw new AdapterError("transient", `대기열이 예상 밖 코드(${code})를 줬다`);
    const waited = ctx.clock.now().getTime() - started;
    const ttlMs = Math.max(1, Number(fields.get("ttl")) || 1) * 1000;
    if (waited + ttlMs > MAX_WAIT_MS) throw new AdapterError("transient", "대기가 상한(120초)을 넘었다");
    opcode = 5002;
    await ctx.clock.sleep(ttlMs, ctx.signal);
  }
}

/** 진입 페이지가 대기열 키를 서버에 등록하는 흐름. 하나라도 사라지면 예약처 구조가 바뀐 것이다. */
const ENTRY_MARKERS: { pattern: RegExp; label: string }[] = [
  { pattern: /name="netfunnel_key"/, label: "netfunnel_key 필드" },
  { pattern: /ND_setNfKey\.do/, label: "ND_setNfKey.do 호출" },
  { pattern: /NetFunnel_Action\(\{action_id:"reserve"\}/, label: 'NetFunnel_Action({action_id:"reserve"}' },
];

/** `netfunnel.js` 경고 확인을 이미 한 세션. 세션당 한 번만 한다. */
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

/** 세션(HttpClient)이 들고 있는 대기열 키. 세션 사이로 옮기지 않으려고 HttpClient에 묶는다. */
interface KeyState {
  key: string;
  issuedAt: number;
  enteredAt: number;
  reduced: Map<string, number>;
  completed: boolean;
  /** 이 키를 받으려고 대기열에서 기다린 시간(ms). */
  waitedMs: number;
}
const sessions = new WeakMap<HttpClient, KeyState>();

/** 페이지처럼 setComplete(5004)를 한 번 보낸다. 응답과 실패는 바퀴에 영향을 주지 않는다. */
async function sendComplete(ctx: AdapterContext, state: KeyState, ignoreAbort = false): Promise<void> {
  state.completed = true;
  try {
    await ctx.http.get(nfUrl(5004, ctx.clock.now().getTime(), state.key), { unpaced: true, ignoreAbort });
  } catch {
    // 마무리 알림이라 실패해도 조회는 계속한다.
  }
}

/** `ND_checkNfKeyAvail.do`로 서버가 키를 아직 받아 주는지 묻는다. */
async function keyAvailable(ctx: AdapterContext, key: string): Promise<boolean> {
  const body = await fetchOk(ctx.http.post(`${RESERVATION}/ND_checkNfKeyAvail.do`, { netfunnel_key: key }), "키 확인");
  let message: unknown;
  try {
    message = (JSON.parse(body) as { message?: unknown }).message;
  } catch {
    throw new AdapterError("unrecognized", "키 확인 응답이 JSON이 아니다");
  }
  if (typeof message !== "string") throw new AdapterError("unrecognized", "키 확인 응답에 message가 없다");
  return !message.includes("NOT Available");
}

/** 대기열에 서서 키를 받고 서버 세션에 등록한 뒤 예약 화면에 진입한다. */
async function enterSession(ctx: AdapterContext): Promise<KeyState> {
  const pass = await enterQueue(ctx);
  const issuedAt = ctx.clock.now().getTime();
  await fetchOk(
    ctx.http.post(`${RESERVATION}/ND_setNfKey.do`, pass.key, { contentType: "application/json" }),
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
    }),
    "예약 화면 진입",
  );
  for (const { pattern, label } of ENTRY_MARKERS) {
    if (!pattern.test(entry)) throw new AdapterError("unrecognized", `예약 화면 흐름 문자열이 사라졌다: ${label}`);
  }
  const state: KeyState = {
    key: pass.key,
    issuedAt,
    enteredAt: ctx.clock.now().getTime(),
    reduced: parseReduced(entry),
    completed: false,
    waitedMs: pass.waitedMs,
  };
  sessions.set(ctx.http, state);
  return state;
}

/**
 * 이 세션이 쓸 키를 정한다. 2시간 안의 키는 서버 확인을 거쳐 다시 쓰고, 아니면 새로 진입한다.
 * 다시 쓰려던 키가 거절되면 실패가 아니라 새 진입이다. 새 키까지 곧바로 거절되면 구조 변경이다.
 */
async function acquireSession(ctx: AdapterContext): Promise<{ state: KeyState; pass: QueuePass }> {
  let state = sessions.get(ctx.http);
  const now = ctx.clock.now().getTime();
  if (state && !state.completed && now - state.enteredAt >= COMPLETE_AFTER_MS) await sendComplete(ctx, state);
  if (state && now - state.issuedAt >= KEY_TTL_MS) state = undefined;
  let rejected = false;
  if (state) {
    if (await keyAvailable(ctx, state.key)) return { state, pass: { key: state.key, waitedMs: 0 } };
    rejected = true;
  }
  sessions.delete(ctx.http);
  const fresh = await enterSession(ctx);
  if (rejected && !(await keyAvailable(ctx, fresh.key))) {
    sessions.delete(ctx.http);
    throw new AdapterError("unrecognized", "새로 받은 키를 서버가 곧바로 거절했다(NOT Available)");
  }
  return { state: fresh, pass: { key: fresh.key, waitedMs: fresh.waitedMs } };
}

/** 진입 응답의 `temporaryReducedCounts = { '이름' : 20 }`을 읽는다. 상수가 없으면 구조 변경이다. */
function parseReduced(html: string): Map<string, number> {
  const m = /temporaryReducedCounts\s*=\s*\{([^}]*)\}/.exec(html);
  if (!m) throw new AdapterError("unrecognized", "temporaryReducedCounts를 찾지 못했다");
  const reduced = new Map<string, number>();
  for (const pair of m[1]!.matchAll(/['"]([^'"]+)['"]\s*:\s*(\d+)/g)) reduced.set(pair[1]!, Number(pair[2]));
  return reduced;
}

const KNOWN_ZONES = new Set(ZONES.map((z) => z.name));
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
async function readCalendar(month: string, ctx: AdapterContext, pass: QueuePass): Promise<Map<string, CalendarDay>> {
  const [year, mm] = month.split("-");
  const body = await fetchOk(
    ctx.http.post(`${RESERVATION}/BD_reservationOrigin.do`, {
      trrsrtCode: TRRSRT_CODE,
      q_year: year!,
      q_month: mm!,
      netfunnel_key: pass.key,
    }),
    `월 달력 ${month}`,
  );
  const cal = parseCalendar(body);
  if (cal.month !== month) throw new AdapterError("unrecognized", `월 달력 ${month}을(를) 요청했는데 ${cal.month}이(가) 왔다`);
  return cal.days;
}

/** 하룻밤 조회 응답 본문. 바퀴와 catalog --live가 같은 요청을 보낸다. */
function fetchNight(date: string, ctx: AdapterContext, pass: QueuePass): Promise<string> {
  const [year, month, day] = date.split("-");
  return fetchOk(
    ctx.http.post(`${RESERVATION}/ND_selectFcltyCalendarDetail.do`, {
      trrsrtCode: TRRSRT_CODE,
      q_year: year!,
      q_month: month!,
      qDay: String(Number(day)),
      passResv1: "",
      passNfTime: String(pass.waitedMs),
      netfunnel_key: pass.key,
    }),
    `날짜 조회 ${date}`,
  );
}

/** 대기열 진입부터 밤 조회까지 한 바퀴. NOPASS는 NoPassError로 던져 호출자가 재진입하게 한다. */
async function runBatch(
  units: AvailabilityQuery[],
  ctx: AdapterContext,
): Promise<Map<AvailabilityQuery, AvailableSite[] | AdapterError>> {
  const results = new Map<AvailabilityQuery, AvailableSite[] | AdapterError>();
  const { state, pass } = await acquireSession(ctx);
  const reduced = state.reduced;

  const allDates = [...new Set(units.flatMap(nightsOf))].sort();
  const months = new Set(allDates.map((d) => d.slice(0, 7)));
  const calendars = await readEach(months, ctx, (month) => readCalendar(month, ctx, pass));
  const calendar = { days: new Map([...calendars.read.values()].flatMap((m) => [...m])), failure: calendars.failure };
  // 필요한 밤 하나라도 예약마감이면 날짜 조회 없이 빈 결과다.
  const closed = (q: AvailabilityQuery) => nightsOf(q).some((d) => calendar.days.get(d) === "closed");
  for (const q of units) if (closed(q)) results.set(q, []);
  const live = units.filter((q) => !closed(q));

  // 달력에서 실패했으면 그게 바퀴의 첫 실패이므로 날짜 조회는 보내지 않는다.
  const liveDates = calendar.failure ? [] : [...new Set(live.flatMap(nightsOf))].sort();
  const { read: nights, failure: nightFailure } = await readEach(liveDates, ctx, async (date) =>
    parseNight(await fetchNight(date, ctx, pass), reduced, ctx),
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
  sessions.delete(ctx.http);
  ctx.http.clearSession();
  try {
    return await run();
  } catch (e) {
    if (e instanceof NoPassError) sessions.delete(ctx.http);
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
      const { pass } = await acquireSession(ctx);
      const items = splitNight(await fetchNight(q.checkIn, ctx, pass));
      return {
        zones: items.map((i) => i.name),
        unknown: items.filter((i) => countOf(i.value) === undefined).map((i) => ({ zone: i.name, value: i.value })),
      };
    });
  },

  async close(ctx) {
    const state = sessions.get(ctx.http);
    if (state && !state.completed) await sendComplete(ctx, state, true);
  },

  deepLink: () => `${RESERVATION}/BD_reservation.do`,
};
