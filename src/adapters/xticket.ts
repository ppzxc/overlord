import { addDays } from "../schedule.js";
import {
  AdapterError,
  type AdapterContext,
  type AvailabilityQuery,
  type AvailableSite,
  type ProviderAdapter,
  type ProviderInfo,
  type TransportResponse,
} from "../types.js";
import { facilities } from "../catalogs/xticket.js";

const ORIGIN = "https://camp.xticket.kr";

const INFO: ProviderInfo = {
  id: "xticket",
  facilities,
  // 달서의 페이지 상한은 3박이지만 이 조각은 1박만 본다(research/raw/xticket/README.md).
  maxNights: 1,
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

/** 시설의 쿠키 세션을 연다. 앞 시설의 쿠키는 버린다. /web/main이 302 두 번으로 쿠키를 심고 200을 준다. */
async function openSession(shopEncode: string, ctx: AdapterContext): Promise<void> {
  ctx.http.clearSession();
  const res = await ctx.http.get(mainUrl(shopEncode));
  const bad = failure(res, "시설 화면");
  if (bad) throw bad;
}

/** 한 요청을 보내고 data 객체를 돌려준다. 응답은 JSON이어야 하고 error가 없어야 한다. */
async function postJson(path: string, form: Record<string, string>, shopEncode: string, ctx: AdapterContext): Promise<Record<string, unknown>> {
  // 브라우저처럼 Referer·Origin을 싣는다. 빼면 서버가 `{}`를 준다.
  const res = await ctx.http.post(`${ORIGIN}${path}`, form, {
    headers: { Referer: mainUrl(shopEncode), Origin: ORIGIN, "X-Requested-With": "XMLHttpRequest" },
  });
  const bad = failure(res, path);
  if (bad) throw bad;
  let body: unknown;
  try {
    body = JSON.parse(res.body);
  } catch {
    throw new AdapterError("unrecognized", `${path}: JSON이 아니다`);
  }
  const obj = body as { data?: unknown; error?: { message?: string }; redirect?: boolean } | null;
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
  const list = data.bookProductList;
  if (!Array.isArray(list)) throw new AdapterError("unrecognized", "data.bookProductList가 없다");
  const sites: AvailableSite[] = [];
  for (const p of list as { product_name?: unknown; status_code?: unknown; select_yn?: unknown }[]) {
    if (typeof p?.product_name !== "string") throw new AdapterError("unrecognized", "bookProductList 항목에 product_name이 없다");
    if (p.status_code === "0" && p.select_yn === "1") sites.push({ id: p.product_name, name: p.product_name });
  }
  return sites;
}

/** 박수만큼 이어지는 밤의 날짜(YYYY-MM-DD). */
const nightsOf = (q: AvailabilityQuery) => Array.from({ length: q.nights }, (_, i) => addDays(q.checkIn, i));
const lastNight = (q: AvailabilityQuery) => addDays(q.checkIn, q.nights - 1);
const monthOf = (date: string) => ymd(date).slice(0, 6);

async function queryFacility(facility: string, units: AvailabilityQuery[], ctx: AdapterContext, results: Map<AvailabilityQuery, AvailableSite[] | AdapterError>) {
  const shopEncode = shopEncodeOf(facility);
  // 시설마다 세션을 새로 연다.
  try {
    await openSession(shopEncode, ctx);
  } catch (e) {
    if (!(e instanceof AdapterError) || e.kind === "blocked") throw e;
    for (const q of units) results.set(q, e);
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
      if (!(e instanceof AdapterError) || e.kind === "blocked") throw e;
      failedMonths.set(month, e);
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
      if (!(e instanceof AdapterError) || e.kind === "blocked") throw e;
      results.set(q, e);
    }
  }
}

async function queryBatch(units: AvailabilityQuery[], ctx: AdapterContext) {
  const results = new Map<AvailabilityQuery, AvailableSite[] | AdapterError>();
  const byFacility = new Map<string, AvailabilityQuery[]>();
  for (const q of units) byFacility.set(q.facility, [...(byFacility.get(q.facility) ?? []), q]);
  for (const [facility, list] of byFacility) await queryFacility(facility, list, ctx, results);
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

  deepLink: (q: AvailabilityQuery) => mainUrl(shopEncodeOf(q.facility)),
};
