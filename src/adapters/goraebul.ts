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

const BASE = "https://stay.yd.go.kr/pages";
const NAV_CODE = "gor1501675800";

/** 자리 id의 접두어. 숲속야영장(DKA)은 A02처럼 끝 글자만, 나머지는 CAA11처럼 구역 코드를 쓴다. */
const seatPrefix = (zone: string) => (zone.startsWith("DK") ? zone.slice(-1) : zone);
const seatNumber = (prefix: string, n: number) => `${prefix}${String(n).padStart(2, "0")}`;
/** 구역 코드와 번호로 자리 id 목록을 만든다. 예: ("DKA", [1, 2]) → A01, A02 */
const seatIds = (zone: string, numbers: number[]) => numbers.map((n) => seatNumber(seatPrefix(zone), n));
const sequence = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

// 자리 목록은 2026-09-29 조회(catalog --live)로 확인한 값이다. 예약된 자리도 목록에 있다(class에 ban). 폐쇄된 자리가 어떻게 나오는지는 확인하지 못했다. 정원은 확인한 구역만 적는다.
const ZONES: ZoneInfo[] = [
  { code: "CAA", name: "카라반 4인실", type: "카라반", capacity: 4, seats: seatIds("CAA", [1, 2, 6, 7, 11, 12, 20, 21, 22]) },
  { code: "CAB", name: "카라반 6인실", type: "카라반", capacity: 6, seats: seatIds("CAB", [3, 4, 5, 8, 9, 10, 13, 14, 15, 16, 17, 18, 19, 23, 24, 25]) },
  { code: "DKA", name: "숲속야영장 A", type: "숲속야영장", seats: seatIds("DKA", sequence(38)) },
  { code: "DKB", name: "숲속야영장 B", type: "숲속야영장", seats: seatIds("DKB", sequence(52)) },
  { code: "DKC", name: "숲속야영장 C", type: "숲속야영장", seats: seatIds("DKC", sequence(20)) },
  { code: "AUA", name: "캠핑카존", type: "캠핑카", seats: seatIds("AUA", [4, 5, 6, 7, 10, 11, 12]) },
  { code: "PEA", name: "펜션형 A", type: "펜션형", capacity: 6, seats: seatIds("PEA", [1]) },
  { code: "PEB", name: "펜션형 B", type: "펜션형", capacity: 8, seats: seatIds("PEB", [1]) },
  { code: "PEC", name: "펜션형 C", type: "펜션형", capacity: 10, seats: seatIds("PEC", [1, 2]) },
];

const INFO: ProviderInfo = {
  id: "goraebul",
  facility: "goraebul",
  zones: ZONES,
  maxNights: 2,
  openingRule: { openDaysBefore: 30, openTime: "10:00", sameDayCutoff: "18:00" },
  // robots.txt가 막은 경로다.
  blockedPaths: ["/bbs/"],
};

// 예약처가 차단 페이지를 HTTP 200으로 준다.
const BLOCK_MARKER = "영덕군 전산팀";

/** 요소 id(dka_2, caa_11)로 자리 id를 만든다. 숲속야영장은 A02처럼, 나머지는 CAA11처럼 쓴다. */
function seatId(zone: string, elementId: string): string {
  const n = /_(\d+)$/.exec(elementId)?.[1];
  if (!n) throw new AdapterError("unrecognized", `자리 요소 id를 읽지 못했다: ${elementId}`);
  return seatNumber(seatPrefix(zone), +n);
}

function layoutOf(html: string, zone: string) {
  const $ = cheerio.load(html);
  const container = $(`div#zone_${zone.toLowerCase()}.select_room`);
  if (container.length === 0) {
    throw new AdapterError("unrecognized", `자리 배치 컨테이너(zone_${zone.toLowerCase()})가 없다`);
  }
  return { $, seats: container.find("a.num") };
}

function parseAllSeats(html: string, zone: string): string[] {
  const { $, seats } = layoutOf(html, zone);
  return seats.map((_, el) => seatId(zone, $(el).attr("id") ?? "")).get();
}

function parseOpenSites(html: string, zone: string): AvailableSite[] {
  const { $, seats } = layoutOf(html, zone);
  const sites: AvailableSite[] = [];
  seats.each((_, el) => {
    const classes = ($(el).attr("class") ?? "").split(/\s+/).filter(Boolean);
    const onclick = $(el).attr("onclick") ?? "";
    const match = /zone_area_select\('[^']*','[^']*','([^']*)'\)/.exec(onclick);
    // 빈 자리는 class가 num뿐이고 zone_area_select onclick이 있는 자리다.
    if (classes.length === 1 && classes[0] === "num" && match?.[1]) {
      sites.push({ id: seatId(zone, $(el).attr("id") ?? ""), name: match[1] });
    }
  });
  return sites;
}

async function fetchPage(url: string, ctx: AdapterContext): Promise<string> {
  const res = await ctx.http.get(url);
  if (res.body.includes(BLOCK_MARKER)) throw new AdapterError("blocked", "차단 페이지를 받았다");
  if (res.status >= 500) throw new AdapterError("transient", `HTTP ${res.status}`);
  if (res.status !== 200) throw new AdapterError("unrecognized", `예상 밖 HTTP ${res.status}`);
  return res.body;
}

const fetchLayout = (q: AvailabilityQuery, ctx: AdapterContext) =>
  fetchPage(`${BASE}/zoneAreaAjax.htm?res_Day=${q.checkIn}&room_Code=${q.zone}&site_date=${q.nights}`, ctx);

const calendarUrl = (month: string) => {
  const [year, mm] = month.split("-");
  return `${BASE}/sub.htm?nav_code=${NAV_CODE}&view_cate=${year}&view_cate2=${Number(mm)}`;
};

/**
 * 월 캘린더에서 날짜별로 1박 잔여가 1 이상인 구역 코드를 읽는다.
 * 매진((마감))과 아직 안 열렸거나 지난 날짜(td.not)는 빈 집합이다.
 */
/** 정상 캘린더는 한 달 28~31칸이다. 이보다 적으면 구조가 바뀐 것으로 본다. */
const MIN_CALENDAR_CELLS = 28;
const monthOf = (date: string) => date.slice(0, 7);

function parseCalendar(html: string, month: string): Map<string, Set<string>> {
  const $ = cheerio.load(html);
  const cells = $("table.t_calendar td").filter((_, td) => $(td).find("span.day").length > 0);
  if (cells.length < MIN_CALENDAR_CELLS) throw new AdapterError("unrecognized", `캘린더 날짜 칸이 ${cells.length}개뿐이다`);
  const days = new Map<string, Set<string>>();
  cells.each((_, td) => {
    const day = $(td).find("span.day").first().text().trim();
    const zones = new Set<string>();
    days.set(`${month}-${day.padStart(2, "0")}`, zones);
    if ($(td).hasClass("not")) return;
    const items = $(td).find("ul.list li");
    if (items.length === 0) throw new AdapterError("unrecognized", `캘린더 ${day}일 칸에 구역 목록이 없다`);
    items.each((_, li) => {
      const remaining = /^\((\d+)\)$/.exec($(li).find("em").text().trim())?.[1];
      if (remaining === undefined) {
        // 잔여 수가 없으면 (마감)이어야 한다. 아니면 마크업이 바뀐 것이다.
        if (!$(li).text().includes("(마감)")) throw new AdapterError("unrecognized", `캘린더 ${day}일 구역 칸을 읽지 못했다`);
        return;
      }
      const zone = new URL($(li).find("a").attr("href") ?? "", BASE).searchParams.get("type");
      if (!zone) throw new AdapterError("unrecognized", `캘린더 ${day}일 구역 링크에 type이 없다`);
      if (+remaining >= 1) zones.add(zone);
    });
  });
  return days;
}

export const goraebulAdapter: ProviderAdapter = {
  id: "goraebul",

  describe: () => INFO,

  async queryAvailability(q: AvailabilityQuery, ctx: AdapterContext): Promise<AvailableSite[]> {
    return parseOpenSites(await fetchLayout(q, ctx), q.zone);
  },

  /** 캘린더를 월마다 한 번 읽어 1박 잔여가 있는 (구역, 입실일)만 자세히 조회한다. 나머지는 빈 결과다. */
  async queryAvailabilityBatch(units, ctx) {
    const results = new Map<AvailabilityQuery, AvailableSite[] | AdapterError>();
    const months = [...new Set(units.map((u) => monthOf(u.checkIn)))].sort();
    const calendars = new Map<string, Map<string, Set<string>>>();
    const failedMonths = new Map<string, AdapterError>();
    for (const month of months) {
      try {
        calendars.set(month, parseCalendar(await fetchPage(calendarUrl(month), ctx), month));
      } catch (e) {
        // 한 달이 실패해도 다른 달은 계속 본다. 차단은 전체가 멈춘다.
        if (!(e instanceof AdapterError) || e.kind === "blocked") throw e;
        failedMonths.set(month, e);
      }
    }
    for (const q of units) {
      const failed = failedMonths.get(monthOf(q.checkIn));
      if (failed) {
        results.set(q, failed);
        continue;
      }
      // N박 연속으로 비려면 입실일 1박은 비어 있어야 하므로 1박 잔여로 거를 수 있다.
      if (!calendars.get(monthOf(q.checkIn))?.get(q.checkIn)?.has(q.zone)) {
        results.set(q, []);
        continue;
      }
      try {
        results.set(q, parseOpenSites(await fetchLayout(q, ctx), q.zone));
      } catch (e) {
        if (!(e instanceof AdapterError) || e.kind === "blocked") throw e;
        results.set(q, e);
      }
    }
    return results;
  },

  async listSeats(q: AvailabilityQuery, ctx: AdapterContext): Promise<string[]> {
    return parseAllSeats(await fetchLayout(q, ctx), q.zone);
  },

  deepLink(q: AvailabilityQuery): string {
    const col = new Date(`${q.checkIn}T00:00:00Z`).getUTCDay();
    return `${BASE}/sub.htm?nav_code=${NAV_CODE}&mode=step01&type=${q.zone}&today=${q.checkIn}&col=${col}`;
  },
};
