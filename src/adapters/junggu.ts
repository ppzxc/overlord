import {
  AdapterError,
  type AdapterContext,
  type AvailabilityQuery,
  type AvailableSite,
  type ProviderAdapter,
  type ProviderInfo,
  type TransportResponse,
} from "../types.js";
import { facilities } from "../catalogs/junggu.js";
import { resolveFacility } from "../facility.js";
import { BlockedPathError } from "../http.js";
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
  // 서버가 정한 최대 박수는 못 봤다. 이 조각은 1박만 읽는다(카탈로그 머리 주석).
  maxNights: 1,
  // 날짜가 열렸는지는 월 지도(isAbleDate)가 알려 주므로 규칙으로는 거르지 않는다. 열리는 시각과 당일 마감 시각은 미확인이다.
  openingRule: { openDaysBefore: 365, openTime: "00:00", sameDayCutoff: "23:59" },
  // 오픈 경쟁 시간 기본값은 없다. 선착순 접수 개시 시각이 미확인이다.
  defaultPollIntervalSeconds: 150,
  // 자리 선택·숙박기간 변경·예약 제출, 회원 메뉴(로그인 5010000, 회원가입 5020000, 아이디/비밀번호 찾기 5030000, 마이페이지·취소 5040100, 이용약관 5070000).
  blockedPaths: [
    "/camping/ajaxSelecteSite.do",
    "/camping/ajaxChangeStayGigan.do",
    "/camping/iphwa_auto2/insert.do",
    "/camping/pageCont.do?menuNo=5",
  ],
  // 서버 세션 쿠키(JSESSIONID)가 있고, NetFunnel 키는 `NetFunnel_ID` 쿠키로 싣는다.
  cookieSession: true,
  // 시설이 셋으로 늘어난다(#79). 시설을 꼭 골라야 한다.
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
    throw new AdapterError("transient", `${where}: ${e instanceof Error ? e.message : String(e)}`);
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

/**
 * 자리 목록을 읽어 열린 자리를 가린다. 화면 JS(예약 화면의 `fAjaxSiteList`)를 따른다.
 * - `appProcess`에 `L1`이 있으면 추첨 접수 중이다. 선착순이 아니므로 열린 자리가 아니다. `L1`도 `L0`도 없으면 구조 변경이다.
 * - `DISABLED`는 화면이 그리지 않는다. `ctIsBookable == "Y"`이고 `ctIsIng != "Y"`면 "예약하기"(열림), `ctIsIng == "Y"`는 다른 사람이 예약 진행 중이다.
 * - 모르는 `ctState`와 Y/N이 아닌 플래그는 구조 변경이다. 조용히 빈자리 없음으로 치면 빈자리를 놓친다.
 */
function openSites(res: TransportResponse): AvailableSite[] {
  const where = "ajaxGetSiteList.do";
  assertOk(res, where);
  const body = parseJson(res, where);
  const { siteList, currentAppVO } = body;
  if (!Array.isArray(siteList)) throw new AdapterError("unrecognized", `${where}: siteList가 없다`);
  const appProcess = isRecord(currentAppVO) ? currentAppVO.appProcess : undefined;
  if (typeof appProcess !== "string") throw new AdapterError("unrecognized", `${where}: currentAppVO.appProcess가 없다`);
  if (appProcess.includes("L1")) return [];
  if (!appProcess.includes("L0")) throw new AdapterError("unrecognized", `${where}: 모르는 appProcess ${JSON.stringify(appProcess)}`);
  const sites: AvailableSite[] = [];
  for (const s of siteList) {
    if (!isRecord(s) || typeof s.ctName !== "string") throw new AdapterError("unrecognized", `${where}: siteList 행에 ctName이 없다`);
    if (typeof s.ctState !== "string" || !KNOWN_STATES.has(s.ctState)) throw new AdapterError("unrecognized", `${where}: 모르는 ctState ${JSON.stringify(s.ctState)}`);
    if (s.ctState === "DISABLED") continue;
    for (const flag of ["ctIsBookable", "ctIsIng"] as const) {
      if (s[flag] !== "Y" && s[flag] !== "N") throw new AdapterError("unrecognized", `${where}: ${flag}가 Y/N이 아니다(${JSON.stringify(s[flag])})`);
    }
    if (s.ctIsBookable === "Y" && s.ctIsIng === "N") sites.push({ id: s.ctName, name: s.ctName });
  }
  return sites;
}

type Results = Map<AvailabilityQuery, AvailableSite[] | AdapterError>;

/**
 * 한 바퀴. 시설마다 NetFunnel `main`을 지나(키는 `NetFunnel_ID` 쿠키, 5004는 보내지 않는다) 예약 화면을 열고,
 * 필요한 달의 월 지도로 고를 수 없는 날(중구민 전용일 포함)을 거른 뒤 (구역, 밤)마다 자리 목록을 읽는다.
 * 요청 하나가 실패하면 남은 요청은 보내지 않고 남은 조회 단위가 그 실패를 값으로 받는다. 이미 읽은 단위의 결과는 그대로 둔다.
 */
async function runBatch(units: AvailabilityQuery[], ctx: AdapterContext): Promise<Results> {
  const results: Results = new Map();
  const byFacility = new Map<string, AvailabilityQuery[]>();
  for (const q of units) {
    if (q.nights > INFO.maxNights) throw new Error(`junggu는 최대 ${INFO.maxNights}박만 읽는다(${q.nights}박)`);
    byFacility.set(q.facility, [...(byFacility.get(q.facility) ?? []), q]);
  }
  let failure: AdapterError | undefined;
  for (const [facility, queries] of byFacility) {
    const { cpId, menuNo } = ref(facility);
    const headers = { Referer: pageUrl(menuNo), Origin: ORIGIN, "X-Requested-With": "XMLHttpRequest", Accept: "application/json, text/javascript, */*; q=0.01" };
    const months = new Map<string, Map<string, Day>>();
    let opened = false;
    for (const q of queries) {
      if (failure) {
        results.set(q, failure);
        continue;
      }
      try {
        if (!opened) {
          const pass = await enterQueue(ctx, MAIN);
          setNetFunnelCookie(ctx.http, HOST, pass.result);
          const page = await send("pageCont.do", () => ctx.http.get(pageUrl(menuNo)));
          assertOk(page, "pageCont.do");
          opened = true;
        }
        const month = q.checkIn.slice(0, 7);
        let days = months.get(month);
        if (!days) {
          const res = await send("ajaxGetMonthlyMap.do", () => ctx.http.post(MONTHLY, { searchDate: `${month}-01`, cpId }, { headers }));
          days = parseMonthly(res);
          months.set(month, days);
        }
        const day = days.get(q.checkIn);
        if (!day) throw new AdapterError("unrecognized", `ajaxGetMonthlyMap.do: 월 지도에 ${q.checkIn}이 없다`);
        if (!day.isAbleDate || day.isExclusive) {
          results.set(q, []); // 고를 수 없는 날, 중구민 전용일: 자리 조회를 보내지 않는다.
          continue;
        }
        // 중구민 전용일이 아닌 날은 화면 JS처럼 isExclusive를 빈 값으로 보낸다.
        const res = await send("ajaxGetSiteList.do", () => ctx.http.post(SITE_LIST, { searchDate: q.checkIn, cpId, csId: q.zone, isExclusive: "" }, { headers }));
        results.set(q, openSites(res));
      } catch (e) {
        if (!(e instanceof AdapterError)) throw e;
        failure = e;
        results.set(q, e);
      }
    }
  }
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

  /** 같은 시설은 조회 단위가 몇 개든 대기열과 예약 화면, 월 지도를 한 번씩만 거친다. */
  queryAvailabilityBatch: (units, ctx) => runBatch(units, ctx),

  deepLink: (q) => pageUrl(ref(q.facility).menuNo),
};
