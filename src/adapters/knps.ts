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
import { facilities } from "../catalogs/knps.js";
import { assertOk } from "../adapter-signals.js";
import { fieldsRef, resolveFacility } from "../facility.js";
import { filterSeats } from "../seats.js";
import { isLotteryHeld, parseLottery, type LotterySchedule } from "../knps-lottery.js";
import { kstDate } from "../schedule.js";
import { queryOneViaBatch, warnDriftOnce } from "../adapter-signals.js";
import { completeQueue, enterQueue, netfunnelScriptCheck, setNetFunnelCookie, type NetFunnelQueue } from "../netfunnel.js";

const HOST = "reservation.knps.or.kr";
const ORIGIN = `https://${HOST}`;
const PAGE = `${ORIGIN}/reservation/searchSimpleCampReservation.do`;
const LIST = `${ORIGIN}/reservation/campsiteList.do`;
const LOTTERY = `${ORIGIN}/reservation/selectCampLottery.do`;
/** 대기열 서버는 `netfunnel.js` 2.2.19의 `TS_HOST`다. `sid`는 `TS_SERVICE_ID`다. */
const NF_URL = "https://netfunnel.knps.or.kr/ts.wseq";
const LANDING: NetFunnelQueue = { tsUrl: NF_URL, sid: "service_1", aid: "landingCamp" };
const RESERVATION2: NetFunnelQueue = { tsUrl: NF_URL, sid: "service_1", aid: "reservation2" };
/** 브라우저의 ajax 요청이 싣는 값. */
const PAGE_HEADERS = { Referer: PAGE, Origin: ORIGIN, "X-Requested-With": "XMLHttpRequest" };

const INFO: ProviderInfo = {
  id: "knps",
  facilities,
  // 예약 화면은 1박 2일과 2박 3일을 고르게 한다.
  maxNights: 2,
  // 응답이 내일부터 약 80일치를 주고 그 범위 밖은 빈자리 없음으로 친다. 열림 시각은 알 수 없어 넉넉히 잡는다. 오늘 날짜는 응답에 없으므로 당일 마감은 00:00이다.
  openingRule: { openDaysBefore: 365, openTime: "00:00", sameDayCutoff: "00:00" },
  // 빈자리 접수 개시가 10:00이다(스펙의 6차 회차 공지). 매일 10:00에 새 날짜를 여는지는 미확인이다.
  openingRush: { from: "09:55", to: "10:30" },
  // 응답이 시설마다 약 2MB라서 동해시(150초)보다 길게 잡는다.
  defaultPollIntervalSeconds: 300,
  // 예약 확정·captcha·회원·결제·환불 경로. 빈자리 조회에 필요 없다(카탈로그 머리 주석에 근거).
  blockedPaths: [
    "/reservation/auth.do",
    "/reservation/registerCampReservation.do",
    "/reserCaptcha.do",
    "/reservation/campsite/selectOptionList.do",
    "/member/",
    "/mmb/",
    "/mypage/",
    "/pay/",
    "/common/authGpkiForPay.do",
    "/srchrefund/",
  ],
  // 서버 세션 쿠키가 필요하다(`NetFunnel_ID` 쿠키는 따로 심는다).
  cookieSession: true,
};

/** 날짜 칸 하나의 상태. `_N`(예약가능)만 빈자리다. */
type CellStatus = string;

/** 구역 이름 → 자리 이름 → 입실일 → 상태. */
type Grid = Map<string, Map<string, Map<string, CellStatus>>>;

/** 응답을 읽은 결과. `codes`는 구역 이름 → 그 구역의 열린 칸이 실은 구역 코드(`data-prod-ctg-id`)다. */
interface ParsedList {
  grid: Grid;
  codes: Map<string, Set<string>>;
}

const CELL_CLASS = /(?:^|\s)(\d{4})(\d{2})(\d{2})_(\w+)(?:\s|$)/;
/** 상태 접미: 예약가능, 대기가능, 예약만료, 예약불가. 이 밖은 구조 변경이다. */
const KNOWN_SUFFIXES = new Set(["N", "W", "C", "R"]);
/**
 * 로그인 화면 신호. 실제 로그인 화면은 한 번도 기록하지 못했다. 스펙의 "로그인 요구 문구, auth.do로 보냄"을 근거로 잡았다.
 * 2~10MB 본문 어딘가에 "로그인" 링크나 `auth.do` 문자열이 있어도 걸리지 않게 신호를 구체적으로 본다.
 * (1) `auth.do`로 가는 폼, (2) `auth.do`로 보내는 `location` 대입이나 meta refresh, (3) "로그인이 필요" 같은 요구 문구.
 */
const AUTH_MARKER =
  /<form\b[^>]*\baction\s*=\s*["']?[^"'\s>]*auth\.do|location(?:\.href|\.replace)?\s*(?:=|\()\s*["'][^"']*auth\.do|http-equiv\s*=\s*["']?refresh[^>]*auth\.do|로그인\s*(?:이|을|후에?)?\s*(?:필요|해\s*주|하여\s*주|하신\s*후)/i;

/** 응답이 로그인 화면이면 `blocked`다. */
function assertNotLogin(body: string, where: string): void {
  if (AUTH_MARKER.test(body)) throw new AdapterError("blocked", `${where}가 로그인 화면을 돌려줬다`);
}

// 2026-10-12에 기록으로 확인한 값. 달라지면 경고만 남긴다.
const netfunnelScript = netfunnelScriptCheck({ provider: "knps", url: `${ORIGIN}/assets/js/lib/netfunnel.js`, version: "2.2.19", tsHost: "netfunnel.knps.or.kr" });

/** 카탈로그와 다른 구역·자리는 경고만 남긴다. 감시 조건이 쓰는 구역이나 자리가 사라진 것은 조회 단위 판정이 실패로 처리한다. */
function warnDrift(facility: string, zones: ZoneInfo[], grid: Grid, ctx: AdapterContext): void {
  const known = new Set(zones.map((z) => z.name));
  const drift = [
    ...[...grid.keys()].filter((n) => !known.has(n)).map((n) => ["new", n] as const),
    ...[...known].filter((n) => !grid.has(n)).map((n) => ["gone", n] as const),
  ];
  for (const [change, zone] of drift) {
    warnDriftOnce(ctx, `${facility}:${change}:${zone}`, "knps zone drift", { facility, change, zone });
  }
  for (const z of zones) {
    const seats = grid.get(z.name);
    if (!seats || !z.seats) continue;
    const catalog = new Set(z.seats);
    const seatDrift = [
      ...[...seats.keys()].filter((n) => !catalog.has(n)).map((n) => ["new", n] as const),
      ...z.seats.filter((n) => !seats.has(n)).map((n) => ["gone", n] as const),
    ];
    for (const [change, seat] of seatDrift) {
      warnDriftOnce(ctx, `${facility}:${z.name}:${change}:${seat}`, "knps seat drift", { facility, zone: z.name, change, seat });
    }
  }
}

/**
 * 응답의 자리×날짜 표를 읽는다. 왼쪽 표(`table-sticky-body`)의 구역 머리(rowspan)와 자리 행이 오른쪽 표(`table-body`)의 행과 같은 순서로 맞물린다.
 * 닫힌 칸(`_C`, `_R`)에는 구역 표시가 없어서 구역은 이 표 구조로 정한다. 칸이 하나도 없으면 구조 변경이다.
 */
function parseGrid(html: string): ParsedList {
  const $ = cheerio.load(html);
  const names: { zone: string; seat: string }[] = [];
  let zone: string | undefined;
  $("table.table-sticky-body tbody tr").each((_, tr) => {
    const head = $(tr).find("th[rowspan] span.title").first();
    if (head.length > 0) zone = head.text().trim();
    const seat = $(tr).find("th span.title").last().text().trim();
    if (zone === undefined || seat === "") throw new AdapterError("unrecognized", "자리 표의 구역 머리나 자리 이름을 읽지 못했다");
    names.push({ zone, seat });
  });
  const rows = $("table.table-body tbody tr");
  if (names.length === 0 || rows.length !== names.length) {
    throw new AdapterError("unrecognized", `자리 표 구조가 맞지 않는다(자리 ${names.length}행, 날짜 ${rows.length}행)`);
  }
  const grid: Grid = new Map();
  const codes = new Map<string, Set<string>>();
  let cells = 0;
  rows.each((i, tr) => {
    const { zone: z, seat } = names[i]!;
    const bySeat = grid.get(z) ?? new Map<string, Map<string, CellStatus>>();
    grid.set(z, bySeat);
    const dates = new Map<string, CellStatus>();
    bySeat.set(seat, dates);
    const zoneCodes = codes.get(z) ?? new Set<string>();
    codes.set(z, zoneCodes);
    $(tr)
      .find("i")
      .each((_, cell) => {
        const m = CELL_CLASS.exec($(cell).attr("class") ?? "");
        if (!m) return;
        const code = $(cell).attr("data-prod-ctg-id");
        if (code) zoneCodes.add(code);
        if (!KNOWN_SUFFIXES.has(m[4]!)) throw new AdapterError("unrecognized", `모르는 칸 상태 접미: ${m[4]}`);
        dates.set(`${m[1]}-${m[2]}-${m[3]}`, m[4]!);
        cells++;
      });
  });
  if (cells === 0) throw new AdapterError("unrecognized", "자리×날짜 칸을 하나도 읽지 못했다");
  return { grid, codes };
}

/** 시설 하나를 대기열 `reservation2`로 들어가 `campsiteList.do`로 읽는다. 성공하면 5004를 보낸다. */
async function readFacility(facility: string, ctx: AdapterContext): Promise<ParsedList> {
  const ref = fieldsRef(INFO, facility, ["dept_id"]);
  const pass = await enterQueue(ctx, RESERVATION2);
  setNetFunnelCookie(ctx.http, HOST, pass.result);
  const res = await ctx.http.post(
    LIST,
    { dept_id: ref.dept_id!, dept_name: ref.dept_name ?? "", parent_dept_name: ref.parent_dept_name ?? "", prd_ctg_id: "", isGreenpoint: "N" },
    { headers: PAGE_HEADERS },
  );
  assertOk(res, "campsiteList.do");
  assertNotLogin(res.body, "campsiteList.do");
  const parsed = parseGrid(res.body);
  await completeQueue(ctx, RESERVATION2, pass.key);
  return parsed;
}

/**
 * 예약 화면을 열고 페이지 `load`가 보내는 `landingCamp` 5101까지 한다. 페이지는 이 키의 5004를 보내지 않는다.
 * `landingCamp`와 `reservation2`는 바퀴마다 새로 들어간다(페이지 동작, 티켓 #63 "바퀴마다 새로 진입").
 * 키를 세션에 두고 다시 쓰는 ADR 0001의 선호에 대한 의도적 예외다. 두 키는 서로 다른 액션이라 `acquireKey` 하나로 묶이지도 않는다.
 */
async function openPage(ctx: AdapterContext): Promise<void> {
  const page = await ctx.http.get(PAGE);
  assertOk(page, "예약 화면");
  assertNotLogin(page.body, "예약 화면");
  const landing = await enterQueue(ctx, LANDING);
  setNetFunnelCookie(ctx.http, HOST, landing.result);
}

/** 입실일부터 `nights`박 모든 밤이 예약가능(`_N`)인지 본다. 다음날 칸이 없거나 닫혀 있으면 아니다. */
function openForNights(dates: Map<string, CellStatus>, checkIn: string, nights: number): boolean {
  for (let i = 0; i < nights; i++) {
    const d = new Date(`${checkIn}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    if (dates.get(d.toISOString().slice(0, 10)) !== "N") return false;
  }
  return true;
}

/** 추첨 일정을 읽은 날(KST)과 그 결과. 예약처 루프(HTTP 클라이언트) 하나마다 둔다. 읽지 못했으면 일정이 없다. */
const lotteryState = new WeakMap<object, { day: string; schedule?: LotterySchedule }>();

/** KST 날짜가 바뀐 뒤 첫 바퀴에 추첨 화면을 읽는다. 하루에 한 번만 보내고, 실패는 경고만 남기고 일정 없음(달력대로)으로 둔다. */
async function lotteryFor(ctx: AdapterContext): Promise<LotterySchedule | undefined> {
  const day = kstDate(ctx.clock.now());
  const known = lotteryState.get(ctx.http);
  if (known?.day === day) return known.schedule;
  let schedule: LotterySchedule | undefined;
  try {
    const res = await ctx.http.get(LOTTERY);
    // 추첨 화면은 조회 경로가 아니다(#66). 200이 아니면 상태와 무관하게 경고만 남기고 달력대로 조회한다.
    if (res.status !== 200) throw new Error(`selectCampLottery.do: HTTP ${res.status}`);
    assertNotLogin(res.body, "selectCampLottery.do");
    schedule = parseLottery(res.body);
    ctx.log?.("knps lottery schedule", { from: schedule.from, to: schedule.to, openAt: new Date(schedule.openAt).toISOString(), campCount: schedule.campCount });
  } catch (err) {
    // 차단은 경고로 삼키지 않는다. 읽지 못하거나 모양이 바뀐 것만 경고다.
    if (ctx.signal?.aborted || (err instanceof AdapterError && err.kind === "blocked")) throw err;
    ctx.log?.("knps lottery schedule unreadable", { message: err instanceof Error ? err.message : String(err) });
  }
  lotteryState.set(ctx.http, { day, schedule });
  return schedule;
}

/**
 * 한 바퀴. 화면을 열고(`landingCamp`) 시설마다 한 번씩 읽는다. 시설 하나가 실패하면 남은 시설은 보내지 않고
 * 그 시설과 남은 시설의 조회 단위를 같은 오류로 돌려준다. 이미 읽은 시설의 결과는 그대로 둔다.
 */
async function runBatch(units: AvailabilityQuery[], ctx: AdapterContext): Promise<Map<AvailabilityQuery, AvailableSite[] | AdapterError>> {
  const results = new Map<AvailabilityQuery, AvailableSite[] | AdapterError>();
  const byFacility = new Map<string, AvailabilityQuery[]>();
  const lottery = units.length > 0 ? await lotteryFor(ctx) : undefined;
  for (const q of units) {
    if (q.nights > INFO.maxNights) throw new Error(`knps는 최대 ${INFO.maxNights}박만 읽는다(${q.nights}박)`);
    // 추첨 대상 기간이고 빈자리 접수 전이면 조회하지 않고 빈자리 없음으로 친다.
    if (isLotteryHeld(lottery, q, ctx.clock.now())) {
      results.set(q, []);
      continue;
    }
    byFacility.set(q.facility, [...(byFacility.get(q.facility) ?? []), q]);
  }
  if (byFacility.size === 0) return results;
  await openPage(ctx);
  let failure: AdapterError | undefined;
  for (const [facility, queries] of byFacility) {
    const { zones } = resolveFacility(INFO, facility);
    let grid: Grid | undefined;
    if (!failure) {
      try {
        grid = (await readFacility(facility, ctx)).grid;
      } catch (e) {
        failure = e instanceof AdapterError ? e : new AdapterError("transient", e instanceof Error ? e.message : String(e));
      }
    }
    if (!grid) {
      for (const q of queries) results.set(q, failure!);
      continue;
    }
    warnDrift(facility, zones, grid, ctx);
    await netfunnelScript.warn(ctx);
    for (const q of queries) {
      const zone = zones.find((z) => z.code === q.zone);
      const seats = zone && grid.get(zone.name);
      if (!seats) {
        results.set(q, new AdapterError("unrecognized", `응답에서 구역 ${q.zone}이(가) 사라졌다`));
        continue;
      }
      // 감시 조건이 `seats:`로 고른 자리가 응답에서 사라졌으면 구조 변경이다. 자리 이름은 카탈로그 자리 가운데 필터에 맞는 것이다.
      const gone = q.seats && filterSeats((zone.seats ?? []).map((id) => ({ id, name: id })), q.seats).filter((s) => !seats.has(s.id));
      if (gone && gone.length > 0) {
        results.set(q, new AdapterError("unrecognized", `응답에서 자리 ${gone.map((s) => s.id).join(", ")}이(가) 사라졌다`));
        continue;
      }
      // 응답 범위 밖의 입실일은 어느 자리에도 칸이 없어 빈자리 없음이 된다.
      results.set(q, [...seats].filter(([, dates]) => openForNights(dates, q.checkIn, q.nights)).map(([seat]): AvailableSite => ({ id: seat, name: seat })));
    }
  }
  return results;
}

export const knpsAdapter: ProviderAdapter = {
  id: "knps",

  describe: () => INFO,

  queryAvailability: (q, ctx) => queryOneViaBatch("knps", runBatch, q, ctx),

  /** 같은 시설은 조회 단위가 몇 개든 응답 하나로 판정한다. */
  queryAvailabilityBatch: (units, ctx) => runBatch(units, ctx),

  /** `catalog --live`: 시설 하나를 응답 하나로 읽는다(추첨 화면·스크립트 확인 없이 화면, 대기열, 조회 한 번). */
  async observeFacility(facility, ctx) {
    await openPage(ctx);
    const { grid, codes } = await readFacility(facility, ctx);
    return {
      zones: [...grid].map(([name, seats]) => ({ name, codes: [...(codes.get(name) ?? [])], seats: [...seats.keys()] })),
    };
  },

  deepLink: () => PAGE,
};
