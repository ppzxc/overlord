import {
  AdapterError,
  type AdapterContext,
  type AvailabilityQuery,
  type AvailableSite,
  type FacilityObservation,
  type HttpClient,
  type ProviderAdapter,
  type ProviderInfo,
  type TransportResponse,
} from "../types.js";
import { facilities } from "../catalogs/junggu.js";
import { resolveFacility } from "../facility.js";
import { BlockedPathError } from "../http.js";
import { addDays, kstDate } from "../schedule.js";
import { enterQueue, setNetFunnelCookie, type NetFunnelQueue } from "../netfunnel.js";

const HOST = "camping.junggu.ulsan.kr";
const ORIGIN = `https://${HOST}`;
const PAGE_PATH = "/camping/pageCont.do";
const MONTHLY = `${ORIGIN}/camping/ajaxGetMonthlyMap.do`;
const SITE_LIST = `${ORIGIN}/camping/ajaxGetSiteList.do`;
/** 대기열 서버는 `netfunnel.js` 2.2.19의 `TS_HOST`, `sid`는 `TS_SERVICE_ID`다. 예약 화면 버튼은 `action_id:"main"`으로 들어간다. */
const MAIN: NetFunnelQueue = { tsUrl: "https://campwait.junggu.ulsan.kr/ts.wseq", sid: "service_1", aid: "main" };

const INFO: ProviderInfo = {
  id: "junggu",
  facilities,
  // 서버가 정한 최대 박수는 못 봤다. 화면 JS(`rsStay` 1, 2)가 근거인 2박까지만 읽는다(카탈로그 머리 주석).
  maxNights: 2,
  // 날짜가 열렸는지는 월 지도(isAbleDate)가 알려 주므로 규칙으로는 거르지 않는다. 열리는 시각과 당일 마감 시각은 미확인이다.
  openingRule: { openDaysBefore: 365, openTime: "00:00", sameDayCutoff: "23:59" },
  // 오픈 경쟁 시간 기본값은 없다. 선착순 접수 개시 시각이 미확인이다.
  defaultPollIntervalSeconds: 150,
  // 자리 선택·숙박기간 변경·예약 제출, 회원 메뉴(로그인 5010000, 회원가입 5020000, 아이디/비밀번호 찾기 5030000, 마이페이지·취소 5040100, 이용약관 5070000).
  blockedPaths: [
    "/camping/ajaxSelecteSite.do",
    "/camping/ajaxChangeStayGigan.do",
    "/camping/iphwa_auto2/insert.do",
    "/camping/hwangbang/insert.do",
    "/camping/taehwa/insert.do",
    "/camping/pageCont.do?menuNo=5",
  ],
  // 서버 세션 쿠키(JSESSIONID)가 있고, NetFunnel 키는 `NetFunnel_ID` 쿠키로 싣는다.
  cookieSession: true,
  // 시설이 셋이다. 시설을 꼭 골라야 한다.
  facilityRequired: true,
};

const ref = (facility: string): { cpId: string; menuNo: string } => {
  const r = resolveFacility(INFO, facility).ref;
  if (typeof r !== "object" || !r.cpId || !r.menuNo) throw new Error(`junggu 시설 ${facility}에 cpId·menuNo가 없다`);
  return { cpId: r.cpId, menuNo: r.menuNo };
};

const pageUrl = (menuNo: string) => `${ORIGIN}${PAGE_PATH}?menuNo=${menuNo}`;

/** 로그인 화면·차단 안내·봇 탐지·captcha가 JSON 자리에 온 것을 알아보는 표지. 표지가 없는 JSON 아님은 unrecognized다. */
// `menuNo=5010000`(로그인 링크)은 사이트 공통 머리말에 있어 모든 화면에 나오므로 표지로 쓰지 않는다. 로그인으로 가는 리다이렉트는 HTTP 층이 접근 금지로 막는다.
const LOGIN_OR_BLOCK_PAGE = /로그인\s*(?:이|을|후에?)?\s*(?:필요|해\s*주)|접근이 (차단|제한)|비정상적인 접근|botmanager|crawlingCheck|dynapath|captcha/i;

/** 응답 상태를 판정한다. 403·429는 차단, 5xx는 일시 오류, 그 밖의 200 아님은 구조 변경이다. */
function assertOk(res: TransportResponse, where: string): void {
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new AdapterError("blocked", `${where}: HTTP ${res.status}`);
  if (res.status >= 500) throw new AdapterError("transient", `${where}: HTTP ${res.status}`);
  if (res.status !== 200) throw new AdapterError("unrecognized", `${where}: 예상 밖 HTTP ${res.status}`);
}

/** 요청 하나를 보낸다. 접근 금지 경로(로그인으로 리다이렉트 포함)는 차단, 연결 실패·시간 초과는 일시 오류다. */
async function send<T extends TransportResponse>(where: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (e) {
    if (e instanceof BlockedPathError) throw new AdapterError("blocked", `${where}: 로그인·접근 금지 경로로 보내졌다(${e.message})`);
    if (e instanceof AdapterError) throw e;
    // 원인(예: TLS 검증 실패의 cause.code)을 runBatch가 읽을 수 있게 cause로 남긴다.
    throw new AdapterError("transient", `${where}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseJson(res: TransportResponse, where: string): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(res.body);
  } catch {
    if (LOGIN_OR_BLOCK_PAGE.test(res.body)) throw new AdapterError("blocked", `${where}: JSON이 아니라 로그인·차단 화면이 왔다`);
    throw new AdapterError("unrecognized", `${where}: JSON이 아니다`);
  }
  if (!isRecord(body)) throw new AdapterError("unrecognized", `${where}: JSON 객체가 아니다`);
  // 화면 JS는 ajax 응답의 msg가 "login"이면 로그인 요구로 다룬다(조회 응답에는 오지 않았다).
  if (body.msg === "login") throw new AdapterError("blocked", `${where}: 로그인을 요구했다`);
  return body;
}

/** 화면 JS가 아는 `ctState`. `DISABLED`는 화면이 그리지 않고, `RESERVED`는 예약완료, 그 밖의 닫힌 값은 예약불가로 그린다. */
const KNOWN_STATES = new Set(["ACTIVE", "CLOSED", "RESERVED", "DISABLED"]);

interface Day {
  isAbleDate: boolean;
  isExclusive: boolean;
}

/** 월 지도를 읽는다. 다른 달 칸(`isOtherMonth: "Y"`)은 그 달의 날짜가 아니므로 뺀다. */
function parseMonthly(res: TransportResponse): Map<string, Day> {
  const where = "ajaxGetMonthlyMap.do";
  assertOk(res, where);
  const body = parseJson(res, where);
  const list = isRecord(body.monthlyMap) ? body.monthlyMap.calendarList : undefined;
  if (!Array.isArray(list)) throw new AdapterError("unrecognized", `${where}: monthlyMap.calendarList가 없다`);
  const days = new Map<string, Day>();
  for (const c of list) {
    if (!isRecord(c) || typeof c.date !== "string" || typeof c.isAbleDate !== "boolean" || typeof c.isExclusive !== "boolean") {
      throw new AdapterError("unrecognized", `${where}: calendarList 칸에 date·isAbleDate·isExclusive가 없다`);
    }
    if (c.isOtherMonth === "Y") continue;
    days.set(c.date, { isAbleDate: c.isAbleDate, isExclusive: c.isExclusive });
  }
  return days;
}


/** 한 (구역, 밤)의 자리 목록. `open`은 화면이 "예약하기"로 그리는 자리다. */
interface Night {
  csName: string | undefined;
  /** ctId → 자리. 구역의 모든 자리가 들어 있고(닫힌 자리 포함) 순서는 응답 순서다. */
  sites: Map<string, { name: string; open: boolean }>;
}

/**
 * 자리 목록을 읽는다. 화면 JS(예약 화면의 `fAjaxSiteList`)를 따른다.
 * - `appProcess`에 `L1`이 있으면 추첨 접수 중이다. 선착순이 아니므로 열린 자리가 아니다. `L1`도 `L0`도 없으면 구조 변경이다.
 * - `DISABLED`는 화면이 그리지 않는다. `ctIsBookable == "Y"`이고 `ctIsIng != "Y"`면 "예약하기"(열림), `ctIsIng == "Y"`는 다른 사람이 예약 진행 중이다.
 * - 모르는 `ctState`와 Y/N이 아닌 플래그는 구조 변경이다. 조용히 빈자리 없음으로 치면 빈자리를 놓친다.
 * - 자리가 하나도 없거나 다른 구역의 자리가 오면 감시하는 구역이 사라진 것이다(카탈로그의 구역은 모두 자리가 있다). 구조 변경이다.
 * - `ctId`(예약처가 주는 자리 id)가 없으면 밤을 이을 수 없어 구조 변경이다. 알림에는 사람이 읽는 `ctName`을 쓴다.
 */
function parseNight(res: TransportResponse, zone: string): Night {
  const where = "ajaxGetSiteList.do";
  assertOk(res, where);
  const body = parseJson(res, where);
  const { siteList, currentAppVO } = body;
  if (!Array.isArray(siteList)) throw new AdapterError("unrecognized", `${where}: siteList가 없다`);
  if (siteList.length === 0) throw new AdapterError("unrecognized", `${where}: 구역 ${zone}의 자리가 하나도 없다`);
  const appProcess = isRecord(currentAppVO) ? currentAppVO.appProcess : undefined;
  if (typeof appProcess !== "string") throw new AdapterError("unrecognized", `${where}: currentAppVO.appProcess가 없다`);
  const lottery = appProcess.includes("L1");
  if (!lottery && !appProcess.includes("L0")) throw new AdapterError("unrecognized", `${where}: 모르는 appProcess ${JSON.stringify(appProcess)}`);
  const sites: Night["sites"] = new Map();
  for (const s of siteList) {
    if (!isRecord(s) || typeof s.ctName !== "string") throw new AdapterError("unrecognized", `${where}: siteList 행에 ctName이 없다`);
    if (typeof s.ctId !== "string") throw new AdapterError("unrecognized", `${where}: siteList 행에 ctId가 없다`);
    if (typeof s.csId === "string" && s.csId !== zone) throw new AdapterError("unrecognized", `${where}: 구역 ${zone}을 물었는데 ${s.csId}의 자리가 왔다`);
    if (typeof s.ctState !== "string" || !KNOWN_STATES.has(s.ctState)) throw new AdapterError("unrecognized", `${where}: 모르는 ctState ${JSON.stringify(s.ctState)}`);
    for (const flag of ["ctIsBookable", "ctIsIng"] as const) {
      if (s[flag] !== "Y" && s[flag] !== "N") throw new AdapterError("unrecognized", `${where}: ${flag}가 Y/N이 아니다(${JSON.stringify(s[flag])})`);
    }
    const open = !lottery && s.ctState !== "DISABLED" && s.ctIsBookable === "Y" && s.ctIsIng === "N";
    sites.set(s.ctId, { name: s.ctName, open });
  }
  return { csName: typeof body.csName === "string" ? body.csName : undefined, sites };
}

/** 예약 화면의 구역 선택 목록(`changeCp('<csId>')` 링크)에서 구역 코드와 이름을 읽는다. 없으면 구조 변경이다. */
function parsePageZones(html: string): Map<string, string> {
  const zones = new Map<string, string>();
  for (const m of html.matchAll(/onclick="changeCp\('([^']+)'\);?">([^<]*)<\/a>/g)) zones.set(m[1]!, m[2]!.trim());
  if (zones.size === 0) throw new AdapterError("unrecognized", "pageCont.do: 구역 선택 목록(changeCp)이 없다");
  return zones;
}

/** 인증서 검증 실패를 가리키는 OpenSSL 오류 코드(Node가 `cause.code`에 싣는다). */
const TLS_VERIFY_CODE = /^(UNABLE_TO_|CERT_|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED|ERR_TLS_CERT_|HOSTNAME_MISMATCH|INVALID_CA|INVALID_PURPOSE|PATH_LENGTH_EXCEEDED)/;

/** 오류와 그 `cause` 사슬에서 TLS 검증 실패 코드를 찾는다. */
function tlsVerifyCode(e: unknown): string | undefined {
  for (let cur = e, depth = 0; cur instanceof Error && depth < 5; cur = cur.cause, depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && TLS_VERIFY_CODE.test(code)) return code;
  }
  return undefined;
}

/** 세션(HttpClient)마다 TLS 검증이 연속으로 실패한 바퀴 수. 검증 실패 없이 끝난 바퀴가 있으면 지운다. */
const tlsStreak = new WeakMap<HttpClient, number>();
/** `netfunnel.js` 확인을 이미 한 세션. */
const scriptChecked = new WeakSet<HttpClient>();
/** 세션마다 이미 경고한 구역 차이. 같은 차이는 한 번만 남긴다. */
const warnedDrift = new WeakMap<HttpClient, Set<string>>();

const NETFUNNEL_JS = `${ORIGIN}/camping/js/netfunnel.js`;
// 2026-10-12에 기록으로 확인한 값(research/raw/junggu/netfunnel.excerpt.js). 달라지면 경고만 남긴다.
const NETFUNNEL_VERSION = "2.2.19";
const NETFUNNEL_TS_HOST = "campwait.junggu.ulsan.kr";

/** `netfunnel.js`의 버전과 `TS_HOST`가 기록한 값과 다르면 경고만 남긴다. 첫 조회가 끝난 뒤 세션당 한 번 받고, 받지 못해도 감시는 그대로다. */
async function warnNetfunnelDrift(ctx: AdapterContext): Promise<void> {
  if (scriptChecked.has(ctx.http) || ctx.signal?.aborted) return;
  scriptChecked.add(ctx.http);
  try {
    const res = await ctx.http.get(NETFUNNEL_JS);
    if (res.status !== 200) return;
    const version = /Version\s+(\S+)/.exec(res.body)?.[1];
    const host = /^NetFunnel\.TS_HOST\s*=\s*'([^']*)'/m.exec(res.body)?.[1];
    if (version !== NETFUNNEL_VERSION) ctx.log?.("junggu netfunnel.js version changed", { expected: NETFUNNEL_VERSION, actual: version });
    if (host !== NETFUNNEL_TS_HOST) ctx.log?.("junggu TS_HOST changed", { expected: NETFUNNEL_TS_HOST, actual: host });
  } catch {
    // 경고 전용이라 실패해도 감시는 그대로다.
  }
}

/** 카탈로그와 다른 구역(예약 화면에만 있거나 화면에서 빠진 구역)은 경고만 남긴다. 감시 조건이 쓰는 구역이 빠진 것은 조회 단위 판정이 실패로 처리한다. */
function warnZoneDrift(facility: string, onPage: Map<string, string>, ctx: AdapterContext): void {
  const known = new Set(resolveFacility(INFO, facility).zones.map((z) => z.code));
  const warned = warnedDrift.get(ctx.http) ?? new Set<string>();
  warnedDrift.set(ctx.http, warned);
  const drift = [
    ...[...onPage.keys()].filter((c) => !known.has(c)).map((c) => ["new", c] as const),
    ...[...known].filter((c) => !onPage.has(c)).map((c) => ["gone", c] as const),
  ];
  for (const [change, zone] of drift) {
    const key = `${facility}:${change}:${zone}`;
    if (warned.has(key)) continue;
    warned.add(key);
    ctx.log?.("junggu zone drift", { facility, change, zone });
  }
}

const nightsOf = (q: AvailabilityQuery) => Array.from({ length: q.nights }, (_, i) => addDays(q.checkIn, i));

/** 시설 하나를 연 방문. 예약 화면에서 읽은 구역과, 방문 안에서 이미 읽은 월 지도·자리 목록(같은 (구역, 밤)은 한 번만 조회)을 든다. */
interface Visit {
  cpId: string;
  headers: Record<string, string>;
  zones: Map<string, string>;
  months: Map<string, Map<string, Day>>;
  nights: Map<string, Night>;
}

/** 시설마다 NetFunnel `main`을 지나(키는 `NetFunnel_ID` 쿠키, 5004는 보내지 않는다) 예약 화면을 연다. */
async function openFacility(facility: string, ctx: AdapterContext): Promise<Visit> {
  const { cpId, menuNo } = ref(facility);
  const pass = await enterQueue(ctx, MAIN);
  setNetFunnelCookie(ctx.http, HOST, pass.result);
  const page = await send("pageCont.do", () => ctx.http.get(pageUrl(menuNo)));
  assertOk(page, "pageCont.do");
  const zones = parsePageZones(page.body);
  warnZoneDrift(facility, zones, ctx);
  const headers = { Referer: pageUrl(menuNo), Origin: ORIGIN, "X-Requested-With": "XMLHttpRequest", Accept: "application/json, text/javascript, */*; q=0.01" };
  return { cpId, headers, zones, months: new Map(), nights: new Map() };
}

/** 날짜 하나의 월 지도 칸. 달마다 한 번만 받는다. */
async function dayOf(v: Visit, date: string, ctx: AdapterContext): Promise<Day> {
  const month = date.slice(0, 7);
  let days = v.months.get(month);
  if (!days) {
    const res = await send("ajaxGetMonthlyMap.do", () => ctx.http.post(MONTHLY, { searchDate: `${month}-01`, cpId: v.cpId }, { headers: v.headers }));
    days = parseMonthly(res);
    v.months.set(month, days);
  }
  const day = days.get(date);
  if (!day) throw new AdapterError("unrecognized", `ajaxGetMonthlyMap.do: 월 지도에 ${date}이 없다`);
  return day;
}

/** 한 (구역, 밤)의 자리 목록. 같은 방문 안에서 한 번만 받는다. 중구민 전용일이 아닌 날은 화면 JS처럼 isExclusive를 빈 값으로 보낸다. */
async function nightOf(v: Visit, zone: string, date: string, ctx: AdapterContext): Promise<Night> {
  const key = `${zone}|${date}`;
  let night = v.nights.get(key);
  if (!night) {
    const res = await send("ajaxGetSiteList.do", () => ctx.http.post(SITE_LIST, { searchDate: date, cpId: v.cpId, csId: zone, isExclusive: "" }, { headers: v.headers }));
    night = parseNight(res, zone);
    v.nights.set(key, night);
  }
  return night;
}

type Results = Map<AvailabilityQuery, AvailableSite[] | AdapterError>;

/**
 * 한 바퀴. 시설마다 NetFunnel `main`을 지나 예약 화면을 열고, 필요한 달의 월 지도로 고를 수 없는 날(중구민 전용일 포함)을 거른 뒤
 * (구역, 밤)마다 자리 목록을 읽는다. 여러 박이면 같은 `ctId`가 밤마다 열려 있을 때만 빈자리다.
 * 요청 하나가 실패하면 남은 요청은 보내지 않고 남은 조회 단위가 그 실패를 값으로 받는다. 이미 읽은 단위의 결과는 그대로 둔다.
 * TLS 검증 실패는 일시 오류지만 두 바퀴 연속이면 구조 변경으로 친다(인증서가 바뀌었을 수 있다).
 */
async function runBatch(units: AvailabilityQuery[], ctx: AdapterContext): Promise<Results> {
  const results: Results = new Map();
  const byFacility = new Map<string, AvailabilityQuery[]>();
  for (const q of units) {
    const max = resolveFacility(INFO, q.facility).maxNights ?? INFO.maxNights;
    if (q.nights > max) throw new Error(`junggu ${q.facility}는 최대 ${max}박만 읽는다(${q.nights}박)`);
    byFacility.set(q.facility, [...(byFacility.get(q.facility) ?? []), q]);
  }
  const priorTls = tlsStreak.get(ctx.http) ?? 0;
  let tlsFailed = false;
  let failure: AdapterError | undefined;
  /** 실패를 어댑터 오류로 바꾼다. TLS 검증 실패는 연속 바퀴 수로 종류를 정한다. */
  const classify = (e: unknown): AdapterError => {
    const code = tlsVerifyCode(e);
    if (code === undefined) {
      if (e instanceof AdapterError) return e;
      throw e;
    }
    tlsFailed = true;
    const kind = priorTls + 1 >= 2 ? "unrecognized" : "transient";
    return new AdapterError(kind, `TLS 인증서 검증에 실패했다(${code}, 연속 ${priorTls + 1}바퀴): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  };
  for (const [facility, queries] of byFacility) {
    let visit: Visit | undefined;
    for (const q of queries) {
      if (failure) {
        results.set(q, failure);
        continue;
      }
      try {
        visit ??= await openFacility(facility, ctx);
        // 감시하는 구역이 예약 화면의 구역 목록에서 사라졌으면 화면 모양이 바뀐 것이다. 빈자리 없음으로 넘기지 않는다.
        if (!visit.zones.has(q.zone)) throw new AdapterError("unrecognized", `pageCont.do: 구역 선택 목록에 감시하는 구역 ${q.zone}이 없다`);
        const dates = nightsOf(q);
        const days: Day[] = [];
        for (const d of dates) days.push(await dayOf(visit, d, ctx));
        if (days.some((d) => !d.isAbleDate || d.isExclusive)) {
          results.set(q, []); // 고를 수 없는 밤, 중구민 전용일이 하나라도 낀 단위: 자리 조회를 보내지 않는다.
          continue;
        }
        const perNight: Night[] = [];
        for (const d of dates) perNight.push(await nightOf(visit, q.zone, d, ctx));
        // 같은 ctId가 모든 밤에 열려 있을 때만 빈자리다. 이름은 첫 밤의 ctName이다.
        const sites: AvailableSite[] = [];
        for (const [id, first] of perNight[0]!.sites) {
          if (first.open && perNight.every((n) => n.sites.get(id)?.open)) sites.push({ id: first.name, name: first.name });
        }
        results.set(q, sites);
      } catch (e) {
        failure = classify(e);
        results.set(q, failure);
      }
    }
  }
  if (tlsFailed) tlsStreak.set(ctx.http, priorTls + 1);
  else tlsStreak.delete(ctx.http);
  if (!failure) await warnNetfunnelDrift(ctx);
  return results;
}

export const jungguAdapter: ProviderAdapter = {
  id: "junggu",

  describe: () => INFO,

  async queryAvailability(q, ctx) {
    const result = (await runBatch([q], ctx)).get(q);
    if (result instanceof Error) throw result;
    return result ?? [];
  },

  /** 같은 시설은 조회 단위가 몇 개든 대기열과 예약 화면, 월 지도를 한 번씩만 거치고 같은 (구역, 밤)은 한 번만 조회한다. */
  queryAvailabilityBatch: (units, ctx) => runBatch(units, ctx),

  /**
   * `catalog --live`: 바퀴와 같은 흐름(대기열, 예약 화면, 월 지도)으로 내일(KST) 밤의 구역마다 자리 목록을 한 번씩 받아 구역과 자리를 읽는다(netfunnel.js 확인 없이).
   * 내일을 고를 수 없으면(월 지도의 isAbleDate false, 중구민 전용일) 비교할 응답이 없다고 알린다. 실패가 아니다.
   * 예약 화면의 구역 목록에 있는 구역만 조회한다(화면에서 사라진 구역은 응답에 없는 구역으로 보인다).
   */
  async observeFacility(facility: string, ctx: AdapterContext): Promise<FacilityObservation> {
    const date = addDays(kstDate(ctx.clock.now()), 1);
    const visit = await openFacility(facility, ctx);
    const day = await dayOf(visit, date, ctx);
    if (!day.isAbleDate || day.isExclusive) {
      return { zones: [], nothingToCompare: `대조할 날짜가 없다(내일 ${date}은 ${day.isExclusive ? "중구민 전용일이다" : "고를 수 없는 날이다"})` };
    }
    const zones: FacilityObservation["zones"] = [];
    for (const [code, pageName] of visit.zones) {
      const night = await nightOf(visit, code, date, ctx);
      zones.push({ name: night.csName ?? pageName, codes: [code], seats: [...night.sites.values()].map((s) => s.name) });
    }
    return { zones }; // netfunnel.js 확인은 바퀴에서만 한다. --live는 요청을 늘리지 않는다.
  },

  deepLink: (q) => pageUrl(ref(q.facility).menuNo),
};
