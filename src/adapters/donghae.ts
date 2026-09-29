import * as cheerio from "cheerio";
import {
  AdapterError,
  type AdapterContext,
  type AvailabilityQuery,
  type AvailableSite,
  type ProviderAdapter,
  type ProviderInfo,
  type ZoneInfo,
} from "../types.js";

const WWW = "https://www.campingkorea.or.kr";
const RESERVATION = `${WWW}/user/reservation`;
const NF_URL = "https://nf.campingkorea.or.kr/ts.wseq";
const TRRSRT_CODE = "1000";

/** 5002 재확인을 서버가 준 간격대로 반복하되, 이만큼 넘게 기다리면 그 바퀴를 포기한다. */
const MAX_WAIT_MS = 120_000;

// 구역 코드와 이름은 모두 응답의 표시 이름이다(2026-09-29 확인). 유형은 넓은 분류이고 든바다·난바다·허허바다는 확인하지 못했다. 정원은 확인한 구역만 적는다.
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

const CLOSED_VALUES = new Set(["예약완료", "예약불가", "준비중"]);
const AUTH_MARKER = /로그인|인증/;

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const nightsOf = (q: AvailabilityQuery) => Array.from({ length: q.nights }, (_, i) => addDays(q.checkIn, i));

async function fetchOk(res: Promise<{ status: number; body: string }>, what: string): Promise<string> {
  const r = await res;
  if (r.status >= 500) throw new AdapterError("transient", `${what}: HTTP ${r.status}`);
  if (r.status !== 200) throw new AdapterError("unrecognized", `${what}: 예상 밖 HTTP ${r.status}`);
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

/** 진입 응답의 `temporaryReducedCounts = { '이름' : 20 }`을 읽는다. 상수가 없으면 구조 변경이다. */
function parseReduced(html: string): Map<string, number> {
  const m = /temporaryReducedCounts\s*=\s*\{([^}]*)\}/.exec(html);
  if (!m) throw new AdapterError("unrecognized", "temporaryReducedCounts를 찾지 못했다");
  const reduced = new Map<string, number>();
  for (const pair of m[1]!.matchAll(/['"]([^'"]+)['"]\s*:\s*(\d+)/g)) reduced.set(pair[1]!, Number(pair[2]));
  return reduced;
}

/** 하룻밤 응답에서 구역 이름 → 남은 수. 임시 중단 호실은 이름이 정확히 같을 때만 뺀다. */
function parseNight(body: string, reduced: Map<string, number>): Map<string, number> {
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
  const counts = new Map<string, number>();
  for (const item of json.value.split("|^|")) {
    const i = item.lastIndexOf(":");
    const name = item.slice(0, i);
    const value = item.slice(i + 1);
    if (i <= 0) throw new AdapterError("unrecognized", `날짜 조회 값 구조가 깨졌다: ${item}`);
    let n: number;
    if (/^\d+$/.test(value)) n = Number(value);
    else if (CLOSED_VALUES.has(value)) n = 0;
    else throw new AdapterError("unrecognized", `모르는 값: ${name}=${value}`);
    const cut = reduced.get(name);
    counts.set(name, cut === undefined ? n : Math.max(0, n - cut));
  }
  return counts;
}

/** 월 달력 화면에서 날짜 → 열림 여부. 열림도 예약마감도 아닌 칸(지난 날짜, 열리지 않은 날짜)은 넣지 않는다. */
function parseCalendar(html: string): { month: string; days: Map<string, boolean> } | undefined {
  const $ = cheerio.load(html);
  const y = $("#q_year").attr("value");
  const m = $("#q_month").attr("value");
  const cells = $("div.mCalendar1 td");
  if (!y || !m || cells.length === 0) return undefined;
  const month = `${y}-${m.padStart(2, "0")}`;
  const days = new Map<string, boolean>();
  cells.each((_, td) => {
    const day = $(td).find("div.da").first().text().trim();
    if (!/^\d+$/.test(day)) return;
    const date = `${month}-${day.padStart(2, "0")}`;
    if ($(td).find("a.reserve").length > 0) days.set(date, true);
    else if ($(td).find("li.end").text().includes("예약마감")) days.set(date, false);
  });
  return { month, days };
}

/**
 * 필요한 밤이 있는 달마다 월 달력을 읽는다. 진입한 달은 진입 응답을 쓰고, 그 밖의 달은 BD_reservationOrigin이다.
 * 첫 실패에서 멈추고 그때까지 읽은 날짜와 실패를 함께 돌려준다.
 */
async function readCalendars(
  dates: string[],
  entry: string,
  ctx: AdapterContext,
  pass: QueuePass,
): Promise<{ days: Map<string, boolean>; failure?: AdapterError }> {
  const days = new Map<string, boolean>();
  const seen = parseCalendar(entry);
  if (seen) for (const [d, open] of seen.days) days.set(d, open);
  const months = [...new Set(dates.map((d) => d.slice(0, 7)))].filter((m) => m !== seen?.month);
  for (const month of months) {
    if (ctx.signal?.aborted) return { days, failure: new AdapterError("transient", "중단되었다") };
    const [year, mm] = month.split("-");
    try {
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
      if (!cal || cal.month !== month) throw new AdapterError("unrecognized", `월 달력 ${month}을(를) 읽지 못했다`);
      for (const [d, open] of cal.days) days.set(d, open);
    } catch (e) {
      if (e instanceof AdapterError) return { days, failure: e };
      throw e;
    }
  }
  return { days };
}

/** 필요한 밤을 차례로 읽는다. 첫 실패에서 멈추고, 그때까지 읽은 밤과 실패를 함께 돌려준다. */
async function readNights(
  dates: string[],
  ctx: AdapterContext,
  reduced: Map<string, number>,
  pass: QueuePass,
): Promise<{ nights: Map<string, Map<string, number>>; failure?: AdapterError }> {
  const nights = new Map<string, Map<string, number>>();
  for (const date of dates) {
    if (ctx.signal?.aborted) return { nights, failure: new AdapterError("transient", "중단되었다") };
    const [year, month, day] = date.split("-");
    try {
      const body = await fetchOk(
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
      nights.set(date, parseNight(body, reduced));
    } catch (e) {
      if (e instanceof AdapterError) return { nights, failure: e };
      throw e;
    }
  }
  return { nights };
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
   * 바퀴마다 새로 대기열에 들어가 필요한 밤을 한 번씩 읽는다. 첫 실패에서 멈추고,
   * 이미 읽은 밤만으로 판정되는 조회 단위는 결과를 돌려준다.
   */
  async queryAvailabilityBatch(units, ctx) {
    const results = new Map<AvailabilityQuery, AvailableSite[] | AdapterError>();
    const pass = await enterQueue(ctx);
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
    const reduced = parseReduced(entry);

    const allDates = [...new Set(units.flatMap(nightsOf))].sort();
    const calendar = await readCalendars(allDates, entry, ctx, pass);
    // 필요한 밤 하나라도 예약마감이면 날짜 조회 없이 빈 결과다.
    const closed = (q: AvailabilityQuery) => nightsOf(q).some((d) => calendar.days.get(d) === false);
    for (const q of units) if (closed(q)) results.set(q, []);
    const live = units.filter((q) => !closed(q));

    const dates = calendar.failure ? [] : [...new Set(live.flatMap(nightsOf))].sort();
    const read = await readNights(dates, ctx, reduced, pass);
    const nights = read.nights;
    const failure = calendar.failure ?? read.failure;

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
  },

  deepLink: () => `${RESERVATION}/BD_reservation.do`,
};
