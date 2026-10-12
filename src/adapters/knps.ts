import * as cheerio from "cheerio";
import {
  AdapterError,
  type AdapterContext,
  type HttpClient,
  type AvailabilityQuery,
  type AvailableSite,
  type ProviderAdapter,
  type ProviderInfo,
} from "../types.js";
import { facilities } from "../catalogs/knps.js";
import { resolveFacility } from "../facility.js";
import { completeQueue, enterQueue, setNetFunnelCookie, type NetFunnelQueue } from "../netfunnel.js";

const HOST = "reservation.knps.or.kr";
const ORIGIN = `https://${HOST}`;
const PAGE = `${ORIGIN}/reservation/searchSimpleCampReservation.do`;
const LIST = `${ORIGIN}/reservation/campsiteList.do`;
/** 대기열 서버는 `netfunnel.js` 2.2.19의 `TS_HOST`다. `sid`는 `TS_SERVICE_ID`다. */
const NF_URL = "https://netfunnel.knps.or.kr/ts.wseq";
const LANDING: NetFunnelQueue = { tsUrl: NF_URL, sid: "service_1", aid: "landingCamp" };
const RESERVATION2: NetFunnelQueue = { tsUrl: NF_URL, sid: "service_1", aid: "reservation2" };
/** 브라우저의 ajax 요청이 싣는 값. */
const PAGE_HEADERS = { Referer: PAGE, Origin: ORIGIN, "X-Requested-With": "XMLHttpRequest" };

const INFO: ProviderInfo = {
  id: "knps",
  facilities,
  // 예약 화면은 1박 2일과 2박 3일을 고르게 한다. 2박은 다음 조각에서 연다.
  maxNights: 1,
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

const CELL_CLASS = /(?:^|\s)(\d{4})(\d{2})(\d{2})_(\w+)(?:\s|$)/;
/** 상태 접미: 예약가능, 대기가능, 예약만료, 예약불가. 이 밖은 구조 변경이다. */
const KNOWN_SUFFIXES = new Set(["N", "W", "C", "R"]);
/** 로그인 화면을 가리는 문구. 실제로 본 적이 없어 보수적으로 잡았다. 기록한 응답에는 없다. */
const AUTH_MARKER = /로그인/;

const NETFUNNEL_JS = `${ORIGIN}/assets/js/lib/netfunnel.js`;
// 2026-10-12에 기록으로 확인한 값. 달라지면 경고만 남긴다.
const NETFUNNEL_VERSION = "2.2.19";
const NETFUNNEL_TS_HOST = "netfunnel.knps.or.kr";
const KNOWN_ZONES = new Set(facilities.flatMap((f) => f.zones).map((z) => z.name));

/** `netfunnel.js` 경고 확인을 이미 한 세션. */
const scriptChecked = new WeakSet<HttpClient>();
/** 세션마다 이미 경고한 구역 차이. 같은 차이는 한 번만 남긴다. */
const warnedDrift = new WeakMap<HttpClient, Set<string>>();

/** `netfunnel.js`의 버전과 `TS_HOST`가 기록한 값과 다르면 경고만 남긴다. 첫 조회가 끝난 뒤 세션당 한 번 받고, 받지 못해도 감시는 그대로다. */
async function warnNetfunnelDrift(ctx: AdapterContext): Promise<void> {
  if (scriptChecked.has(ctx.http) || ctx.signal?.aborted) return;
  scriptChecked.add(ctx.http);
  try {
    const res = await ctx.http.get(NETFUNNEL_JS);
    if (res.status !== 200) return;
    const version = /Version\s+(\S+)/.exec(res.body)?.[1];
    const host = /^NetFunnel\.TS_HOST\s*=\s*'([^']*)'/m.exec(res.body)?.[1];
    if (version !== NETFUNNEL_VERSION) ctx.log?.("knps netfunnel.js version changed", { expected: NETFUNNEL_VERSION, actual: version });
    if (host !== NETFUNNEL_TS_HOST) ctx.log?.("knps TS_HOST changed", { expected: NETFUNNEL_TS_HOST, actual: host });
  } catch {
    // 경고 전용이라 실패해도 감시는 그대로다.
  }
}

/** 카탈로그와 다른 구역은 경고만 남긴다. 감시 조건이 쓰는 구역이 사라진 것은 조회 단위 판정이 실패로 처리한다. */
function warnZoneDrift(grid: Grid, ctx: AdapterContext): void {
  const warned = warnedDrift.get(ctx.http) ?? new Set<string>();
  warnedDrift.set(ctx.http, warned);
  const drift = [
    ...[...grid.keys()].filter((n) => !KNOWN_ZONES.has(n)).map((n) => ["new", n] as const),
    ...[...KNOWN_ZONES].filter((n) => !grid.has(n)).map((n) => ["gone", n] as const),
  ];
  for (const [change, zone] of drift) {
    if (warned.has(`${change}:${zone}`)) continue;
    warned.add(`${change}:${zone}`);
    ctx.log?.("knps zone drift", { change, zone });
  }
}

/**
 * 응답의 자리×날짜 표를 읽는다. 왼쪽 표(`table-sticky-body`)의 구역 머리(rowspan)와 자리 행이 오른쪽 표(`table-body`)의 행과 같은 순서로 맞물린다.
 * 닫힌 칸(`_C`, `_R`)에는 구역 표시가 없어서 구역은 이 표 구조로 정한다. 칸이 하나도 없으면 구조 변경이다.
 */
function parseGrid(html: string): Grid {
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
  let cells = 0;
  rows.each((i, tr) => {
    const { zone: z, seat } = names[i]!;
    const bySeat = grid.get(z) ?? new Map<string, Map<string, CellStatus>>();
    grid.set(z, bySeat);
    const dates = new Map<string, CellStatus>();
    bySeat.set(seat, dates);
    $(tr)
      .find("i")
      .each((_, cell) => {
        const m = CELL_CLASS.exec($(cell).attr("class") ?? "");
        if (!m) return;
        if (!KNOWN_SUFFIXES.has(m[4]!)) throw new AdapterError("unrecognized", `모르는 칸 상태 접미: ${m[4]}`);
        dates.set(`${m[1]}-${m[2]}-${m[3]}`, m[4]!);
        cells++;
      });
  });
  if (cells === 0) throw new AdapterError("unrecognized", "자리×날짜 칸을 하나도 읽지 못했다");
  return grid;
}

/** 시설 하나를 대기열 `reservation2`로 들어가 `campsiteList.do`로 읽는다. 성공하면 5004를 보낸다. */
async function readFacility(facility: string, ctx: AdapterContext): Promise<Grid> {
  const { ref } = resolveFacility(INFO, facility);
  if (typeof ref !== "object" || !ref.dept_id) throw new Error(`knps 시설 ${facility}에 dept_id가 없다`);
  const pass = await enterQueue(ctx, RESERVATION2);
  setNetFunnelCookie(ctx.http, HOST, pass.result ?? pass.key);
  const res = await ctx.http.post(
    LIST,
    { dept_id: ref.dept_id, dept_name: ref.dept_name ?? "", parent_dept_name: ref.parent_dept_name ?? "", prd_ctg_id: "", isGreenpoint: "N" },
    { headers: PAGE_HEADERS },
  );
  if (res.status >= 500) throw new AdapterError("transient", `campsiteList.do: HTTP ${res.status}`);
  if (res.status !== 200) throw new AdapterError("unrecognized", `campsiteList.do: 예상 밖 HTTP ${res.status}`);
  if (AUTH_MARKER.test(res.body)) throw new AdapterError("blocked", "campsiteList.do가 로그인 화면을 돌려줬다");
  const grid = parseGrid(res.body);
  await completeQueue(ctx, RESERVATION2, pass.key);
  return grid;
}

/** 한 바퀴. 화면을 열고(`landingCamp`) 시설마다 한 번씩 읽는다. 첫 실패는 그대로 던진다. */
async function runBatch(units: AvailabilityQuery[], ctx: AdapterContext): Promise<Map<AvailabilityQuery, AvailableSite[] | AdapterError>> {
  const results = new Map<AvailabilityQuery, AvailableSite[] | AdapterError>();
  const byFacility = new Map<string, AvailabilityQuery[]>();
  for (const q of units) {
    if (q.nights !== 1) throw new Error(`knps는 아직 1박만 읽는다(${q.nights}박)`);
    byFacility.set(q.facility, [...(byFacility.get(q.facility) ?? []), q]);
  }
  if (byFacility.size === 0) return results;
  const page = await ctx.http.get(PAGE);
  if (page.status >= 500) throw new AdapterError("transient", `예약 화면: HTTP ${page.status}`);
  if (page.status !== 200) throw new AdapterError("unrecognized", `예약 화면: 예상 밖 HTTP ${page.status}`);
  // 페이지 `load`가 보내는 landingCamp 5101. 페이지는 이 키의 5004를 보내지 않는다.
  const landing = await enterQueue(ctx, LANDING);
  setNetFunnelCookie(ctx.http, HOST, landing.result ?? landing.key);
  for (const [facility, queries] of byFacility) {
    const grid = await readFacility(facility, ctx);
    warnZoneDrift(grid, ctx);
    await warnNetfunnelDrift(ctx);
    const zones = resolveFacility(INFO, facility).zones;
    for (const q of queries) {
      const zone = zones.find((z) => z.code === q.zone);
      const seats = zone && grid.get(zone.name);
      if (!seats) {
        results.set(q, new AdapterError("unrecognized", `응답에서 구역 ${q.zone}이(가) 사라졌다`));
        continue;
      }
      // 응답 범위 밖의 입실일은 어느 자리에도 칸이 없어 빈자리 없음이 된다.
      results.set(q, [...seats].filter(([, dates]) => dates.get(q.checkIn) === "N").map(([seat]): AvailableSite => ({ id: seat, name: seat })));
    }
  }
  return results;
}

export const knpsAdapter: ProviderAdapter = {
  id: "knps",

  describe: () => INFO,

  async queryAvailability(q, ctx) {
    const result = (await runBatch([q], ctx)).get(q);
    if (result instanceof Error) throw result;
    return result ?? [];
  },

  /** 같은 시설은 조회 단위가 몇 개든 응답 하나로 판정한다. */
  queryAvailabilityBatch: (units, ctx) => runBatch(units, ctx),

  deepLink: () => PAGE,
};
