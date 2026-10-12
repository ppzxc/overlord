import { addDays, kstDate } from "../schedule.js";
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
import { facilities } from "../catalogs/xticket.js";
import { BlockedPathError, RedirectLimitError } from "../http.js";

const ORIGIN = "https://camp.xticket.kr";

const INFO: ProviderInfo = {
  id: "xticket",
  facilities,
  // 박수 상한은 시설 페이지의 shopInfo.book_days다(달서 3, 나정 2). 시설마다 카탈로그의 maxNights가 덮어쓰고 이 값은 가장 큰 값이다.
  maxNights: 3,
  // 날짜는 GetBookPlayDate.json이 준 것만 열린 날로 친다. 열림 시각은 달마다 달라 어댑터가 목록으로 가른다.
  // 입실일 D−90일부터 조회 단위로 만들고(목록은 약 2달 앞까지다), 당일 입실은 18:00 KST에 마감된다(2026-10-12 기록).
  openingRule: { openDaysBefore: 90, openTime: "00:00", sameDayCutoff: "18:00" },
  // 접근 금지: 예약 확정, captcha, 회원(로그인·비밀번호), 예약내역(결제·취소), 가입·정보·본인확인. 대소문자는 가리지 않는다.
  blockedPaths: [
    "/Web/Book/Book010001.json",
    "/Web/jcaptcha",
    "/Web/Member/",
    "/web/books",
    "/web/profile",
    "/web/join",
    "/web/findId",
    "/web/ciRequest",
    "/web/ipinRequest",
  ],
  // 시설은 쿠키 세션(JSESSIONID)에 묶인다.
  cookieSession: true,
  // 시설이 여럿인 예약처다. 시설이 하나뿐인 동안에도 facility를 골라야 한다.
  facilityRequired: true,
};

const ymd = (date: string) => date.replaceAll("-", "");

const shopEncodeOf = (facility: string): string => {
  const ref = facilities.find((f) => f.code === facility)?.ref;
  if (typeof ref !== "string") throw new AdapterError("unrecognized", `xticket 시설 ${facility}에 shopEncode가 없다`);
  return ref;
};

const mainUrl = (shopEncode: string) => `${ORIGIN}/web/main?shopEncode=${shopEncode}`;

const failure = (res: TransportResponse, what: string): AdapterError | undefined => {
  if (res.status === 403 || res.status === 429) return new AdapterError("blocked", `${what}: HTTP ${res.status}`);
  if (res.status >= 500) return new AdapterError("transient", `${what}: HTTP ${res.status}`);
  if (res.status !== 200) return new AdapterError("unrecognized", `${what}: 예상 밖 HTTP ${res.status}`);
  return undefined;
};

/**
 * 로그인 폼·차단 안내·봇 탐지가 JSON 자리에 온 것을 알아보는 구체 표지(로그인 경로, 로그인 폼 입력 이름, 차단 안내 문구, 봇 탐지·captcha 경로).
 * "로그인", "차단", "captcha" 같은 낱말만으로는 판정하지 않는다. 메뉴나 안내문에도 나오므로 일반 HTML 구조 변경이 blocked로 오인된다.
 * 표지가 없는 JSON 아님은 unrecognized다.
 */
const LOGIN_OR_BLOCK_PAGE = /MemberLogin|login_id|login_passwd|접근이 (차단|제한)|비정상적인 접근|botmanager|crawlingCheck|dynapath|\/jcaptcha/i;
/** 시설 화면에 있으면 안 되는 봇 탐지 장치. captcha는 예약 폼이 원래 싣고 있어 여기서는 보지 않는다. */
const BOT_DETECTION = /botmanager|crawlingCheck|dynapath/i;

/**
 * 시설 화면 요청이 리다이렉트 상한을 넘은 횟수(시설별, 연속). 세션을 열 때마다 바퀴를 넘어 이어져야 하므로 HTTP 클라이언트(예약처 수명)에 매단다.
 * 첫 바퀴는 일시 오류, 2바퀴 연속이면 구조 변경이다. 성공하면 다시 센다.
 */
const redirectStreaks = new WeakMap<HttpClient, Map<string, number>>();

/** 네트워크 층이 던진 오류를 분류한다. 로그인·차단 경로로의 리다이렉트는 blocked다(그 경로로는 요청이 나가지 않았다). */
function classifyThrown(e: unknown, what: string): unknown {
  if (e instanceof BlockedPathError) return new AdapterError("blocked", `${what}: 로그인·접근 금지 경로로 보내졌다(${e.message})`);
  return e;
}

/** 시설의 쿠키 세션을 열고 그 시설의 shopEncode를 돌려준다. 앞 시설의 쿠키는 버린다. /web/main이 302 두 번으로 쿠키를 심고 200을 준다. */
async function openSession(facility: string, ctx: AdapterContext): Promise<string> {
  const shopEncode = shopEncodeOf(facility);
  ctx.http.clearSession();
  const streaks = redirectStreaks.get(ctx.http) ?? new Map<string, number>();
  redirectStreaks.set(ctx.http, streaks);
  let res: TransportResponse;
  try {
    res = await ctx.http.get(mainUrl(shopEncode));
  } catch (e) {
    if (e instanceof RedirectLimitError) {
      const n = (streaks.get(facility) ?? 0) + 1;
      streaks.set(facility, n);
      throw new AdapterError(n >= 2 ? "unrecognized" : "transient", `시설 화면: 세션이 열리지 않는다(${e.message}, 연속 ${n}번째)`);
    }
    throw classifyThrown(e, "시설 화면");
  }
  const bad = failure(res, "시설 화면");
  if (bad) throw bad;
  // 사후 검사다: 시설 화면 요청은 이미 나갔고 본문을 받은 뒤에야 본다. 봇 탐지를 피하는 장치가 아니라, 보이면 다음 요청부터 멈추기 위한 것이다.
  if (BOT_DETECTION.test(res.body)) throw new AdapterError("blocked", "시설 화면에 봇 탐지 장치가 보인다");
  streaks.delete(facility);
  return shopEncode;
}

/** 이번 바퀴에서 이어 갈 수 있는 오류(차단이 아닌 AdapterError)는 돌려주고, 차단이나 예상 밖 오류는 그대로 던져 전체를 멈춘다. */
function recoverable(e: unknown): AdapterError {
  if (!(e instanceof AdapterError) || e.kind === "blocked") throw e;
  return e;
}

/** data.bookProductList를 배열로 읽는다. 없거나 배열이 아니면 구조 변경이다. */
function productListOf(data: Record<string, unknown>): unknown[] {
  const list = data.bookProductList;
  if (!Array.isArray(list)) throw new AdapterError("unrecognized", "data.bookProductList가 없다");
  return list;
}

/** 한 요청을 보내고 data 객체를 돌려준다. 응답은 JSON이어야 하고 error가 없어야 한다. */
async function postJson(path: string, form: Record<string, string>, shopEncode: string, ctx: AdapterContext): Promise<Record<string, unknown>> {
  // 브라우저처럼 Referer·Origin을 싣는다. 빼면 서버가 `{}`를 준다.
  let res: TransportResponse;
  try {
    res = await ctx.http.post(`${ORIGIN}${path}`, form, {
      headers: { Referer: mainUrl(shopEncode), Origin: ORIGIN, "X-Requested-With": "XMLHttpRequest" },
    });
  } catch (e) {
    throw classifyThrown(e, path);
  }
  const bad = failure(res, path);
  if (bad) throw bad;
  let body: unknown;
  try {
    body = JSON.parse(res.body);
  } catch {
    // 로그인·차단 화면이면 막힌 것이고, 그 밖의 JSON 아님은 구조 변경이다.
    if (LOGIN_OR_BLOCK_PAGE.test(res.body)) throw new AdapterError("blocked", `${path}: JSON이 아니라 로그인·차단 화면이 왔다`);
    throw new AdapterError("unrecognized", `${path}: JSON이 아니다`);
  }
  const obj = body as { data?: unknown; error?: { message?: string }; error1?: { message?: string }; redirect?: boolean } | null;
  // 페이지(main.js)는 error1을 알림으로 띄우고 redirect면 returnUrl로 보낸다. 로그인·권한을 요구하는 응답이다.
  if (obj?.error1) throw new AdapterError("blocked", `${path}: ${obj.error1.message ?? "로그인 또는 권한을 요구하는 응답"}`);
  if (obj?.error) {
    // 쿠키가 없거나 만료되면 HTTP 200에 error와 redirect가 온다. 세션을 다시 열면 되는 일시 오류다.
    throw new AdapterError(obj.redirect ? "transient" : "unrecognized", `${path}: ${obj.error.message ?? "오류 응답"}`);
  }
  if (typeof obj?.data !== "object" || obj.data === null) throw new AdapterError("unrecognized", `${path}: data가 없다`);
  return obj.data as Record<string, unknown>;
}

interface PlayDate {
  remain: number;
  advance: boolean;
}

async function fetchPlayDates(month: string, shopEncode: string, ctx: AdapterContext): Promise<Map<string, PlayDate>> {
  const data = await postJson("/Web/Book/GetBookPlayDate.json", { play_month: month }, shopEncode, ctx);
  const list = data.bookPlayDateList;
  if (!Array.isArray(list)) throw new AdapterError("unrecognized", "data.bookPlayDateList가 없다");
  const days = new Map<string, PlayDate>();
  for (const d of list as { play_date?: unknown; book_remain_count?: unknown; advance_yn?: unknown }[]) {
    if (typeof d?.play_date !== "string" || typeof d.book_remain_count !== "number") {
      throw new AdapterError("unrecognized", "bookPlayDateList 항목을 읽지 못했다");
    }
    days.set(d.play_date, { remain: d.book_remain_count, advance: d.advance_yn === "1" });
  }
  return days;
}

/** 자리 목록에서 선택가능한 자리만 읽는다. 판정은 페이지(main.js getProductAlt)와 같다: status_code 0이고 select_yn 1. */
async function fetchOpenSites(q: AvailabilityQuery, shopEncode: string, ctx: AdapterContext): Promise<AvailableSite[]> {
  const data = await postJson(
    "/Web/Book/GetBookProduct010001.json",
    {
      product_group_code: q.zone,
      start_date: ymd(q.checkIn),
      end_date: ymd(lastNight(q)),
      book_days: String(q.nights),
      two_stay_days: "0",
    },
    shopEncode,
    ctx,
  );
  const list = productListOf(data);
  // 응답은 예약 여부와 관계없이 상품군의 모든 자리를 준다(기록: 14·40·15곳). 빈 목록은 그 상품군이 없어졌다는 뜻이다.
  if (list.length === 0) throw new AdapterError("unrecognized", `상품군 ${q.zone}이(가) 응답에서 사라졌다`);
  const sites: AvailableSite[] = [];
  for (const p of list as { product_name?: unknown; status_code?: unknown; select_yn?: unknown }[]) {
    if (typeof p?.product_name !== "string") throw new AdapterError("unrecognized", "bookProductList 항목에 product_name이 없다");
    warnStatusCode(q.facility, p.status_code, ctx);
    if (p.status_code === "0" && p.select_yn === "1") sites.push({ id: p.product_name, name: p.product_name });
  }
  return sites;
}

/** 페이지 JS(getProductAlt)가 따로 다루는 status_code와 기록으로 본 값. 그 밖의 값은 예약완료로 치고 한 번만 경고한다. */
const KNOWN_STATUS_CODES = new Set(["0", "1", "2", "4"]);
const warnedStatus = new WeakMap<HttpClient, Set<string>>();

function warnStatusCode(facility: string, code: unknown, ctx: AdapterContext): void {
  const value = String(code);
  if (KNOWN_STATUS_CODES.has(value)) return;
  const warned = warnedStatus.get(ctx.http) ?? new Set<string>();
  warnedStatus.set(ctx.http, warned);
  if (warned.has(`${facility}:${value}`)) return;
  warned.add(`${facility}:${value}`);
  ctx.log?.("xticket status_code drift", { facility, status_code: value });
}

/** 박수만큼 이어지는 밤의 날짜(YYYY-MM-DD). */
const nightsOf = (q: AvailabilityQuery) => Array.from({ length: q.nights }, (_, i) => addDays(q.checkIn, i));
const lastNight = (q: AvailabilityQuery) => addDays(q.checkIn, q.nights - 1);
const monthOf = (date: string) => ymd(date).slice(0, 6);

async function queryFacility(facility: string, units: AvailabilityQuery[], ctx: AdapterContext, results: Map<AvailabilityQuery, AvailableSite[] | AdapterError>) {
  // 시설마다 세션을 새로 연다.
  let shopEncode: string;
  try {
    shopEncode = await openSession(facility, ctx);
  } catch (e) {
    const error = recoverable(e);
    for (const q of units) results.set(q, error);
    return;
  }
  const months = [...new Set(units.flatMap((q) => nightsOf(q).map(monthOf)))].sort();
  const calendars = new Map<string, Map<string, PlayDate>>();
  const failedMonths = new Map<string, AdapterError>();
  for (const month of months) {
    try {
      calendars.set(month, await fetchPlayDates(month, shopEncode, ctx));
    } catch (e) {
      // 한 달이 실패해도 다른 달은 계속 본다. 차단은 전체가 멈춘다.
      failedMonths.set(month, recoverable(e));
    }
  }
  for (const q of units) {
    const nights = nightsOf(q);
    const failed = nights.map((d) => failedMonths.get(monthOf(d))).find((e) => e !== undefined);
    if (failed) {
      results.set(q, failed);
      continue;
    }
    // 선필터: 밤 가운데 하나라도 목록에 없거나 남은 수가 0이거나 우선예약 날짜면 빈 결과다.
    const open = nights.every((d) => {
      const day = calendars.get(monthOf(d))?.get(ymd(d));
      return day !== undefined && day.remain > 0 && !day.advance;
    });
    if (!open) {
      results.set(q, []);
      continue;
    }
    try {
      results.set(q, await fetchOpenSites(q, shopEncode, ctx));
    } catch (e) {
      results.set(q, recoverable(e));
    }
  }
}

async function queryBatch(units: AvailabilityQuery[], ctx: AdapterContext) {
  const results = new Map<AvailabilityQuery, AvailableSite[] | AdapterError>();
  const byFacility = new Map<string, AvailabilityQuery[]>();
  for (const q of units) byFacility.set(q.facility, [...(byFacility.get(q.facility) ?? []), q]);
  let halted: AdapterError | undefined;
  for (const [facility, list] of byFacility) {
    // 앞 시설이 실패했으면 남은 시설 요청은 보내지 않고 같은 오류로 실패 처리한다. 이미 받은 결과는 그대로 둔다.
    if (halted) {
      for (const q of list) results.set(q, halted);
      continue;
    }
    await queryFacility(facility, list, ctx, results);
    halted = list.map((q) => results.get(q)).find((r): r is AdapterError => r instanceof AdapterError);
  }
  return results;
}

export const xticketAdapter: ProviderAdapter = {
  id: "xticket",

  describe: () => INFO,

  async queryAvailability(q: AvailabilityQuery, ctx: AdapterContext): Promise<AvailableSite[]> {
    const found = (await queryBatch([q], ctx)).get(q);
    if (found instanceof AdapterError) throw found;
    return found ?? [];
  },

  /** 시설마다 세션을 열고 달마다 날짜 목록을 읽어 자리가 남은 조회 단위만 자리 조회로 넘어간다. */
  queryAvailabilityBatch: queryBatch,

  /**
   * `catalog --live`: 시설 하나의 세션을 열고 내일(KST) 날짜로 상품군 목록을 한 번, 상품군마다 자리 목록을 한 번씩 읽는다.
   * 바퀴와 같은 요청 원칙(한 줄, 5초+지터)이다. 조회가 실패하면 AdapterError로 던진다.
   */
  async observeFacility(facility: string, ctx: AdapterContext): Promise<FacilityObservation> {
    const tomorrow = ymd(addDays(kstDate(ctx.clock.now()), 1));
    try {
      const shopEncode = await openSession(facility, ctx);
      const data = await postJson("/Web/Book/GetBookProductGroup.json", { start_date: tomorrow, end_date: tomorrow }, shopEncode, ctx);
      const groups = data.bookProductGroupList;
      if (!Array.isArray(groups)) throw new AdapterError("unrecognized", "data.bookProductGroupList가 없다");
      const zones: FacilityObservation["zones"] = [];
      for (const g of groups as { product_group_code?: unknown; product_group_name?: unknown }[]) {
        if (typeof g?.product_group_code !== "string" || typeof g.product_group_name !== "string") {
          throw new AdapterError("unrecognized", "bookProductGroupList 항목을 읽지 못했다");
        }
        const products = await postJson(
          "/Web/Book/GetBookProduct010001.json",
          { product_group_code: g.product_group_code, start_date: tomorrow, end_date: tomorrow, book_days: "1", two_stay_days: "0" },
          shopEncode,
          ctx,
        );
        // 바퀴(fetchOpenSites)와 달리 빈 목록을 상품군 소실로 보지 않는다. 여기서는 상품군 목록이 있다고 한 상품군을 그대로 관찰해 자리 0곳으로 보고하고,
        // 카탈로그와의 차이는 catalog --live가 사람에게 보여 준다. 바퀴는 감시 중인 상품군이 사라진 것을 알려야 해서 다르게 판정한다.
        const list = productListOf(products);
        zones.push({
          name: g.product_group_name,
          codes: [g.product_group_code],
          seats: (list as { product_name?: unknown }[]).flatMap((p) => (typeof p?.product_name === "string" ? [p.product_name] : [])),
        });
      }
      return { zones };
    } catch (e) {
      // 연결 실패처럼 분류되지 않은 오류는 일시 오류로 보고한다. 알려진 AdapterError는 그대로 둔다.
      if (e instanceof AdapterError) throw e;
      throw new AdapterError("transient", e instanceof Error ? e.message : String(e));
    }
  },

  deepLink: (q: AvailabilityQuery) => mainUrl(shopEncodeOf(q.facility)),
};
