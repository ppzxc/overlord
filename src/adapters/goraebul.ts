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

async function fetchLayout(q: AvailabilityQuery, ctx: AdapterContext): Promise<string> {
  const url = `${BASE}/zoneAreaAjax.htm?res_Day=${q.checkIn}&room_Code=${q.zone}&site_date=${q.nights}`;
  const res = await ctx.http.get(url);
  if (res.body.includes(BLOCK_MARKER)) throw new AdapterError("blocked", "차단 페이지를 받았다");
  if (res.status >= 500) throw new AdapterError("transient", `HTTP ${res.status}`);
  if (res.status !== 200) throw new AdapterError("unrecognized", `예상 밖 HTTP ${res.status}`);
  return res.body;
}

export const goraebulAdapter: ProviderAdapter = {
  id: "goraebul",

  describe: () => INFO,

  async queryAvailability(q: AvailabilityQuery, ctx: AdapterContext): Promise<AvailableSite[]> {
    return parseOpenSites(await fetchLayout(q, ctx), q.zone);
  },

  async listSeats(q: AvailabilityQuery, ctx: AdapterContext): Promise<string[]> {
    return parseAllSeats(await fetchLayout(q, ctx), q.zone);
  },

  deepLink(q: AvailabilityQuery): string {
    const col = new Date(`${q.checkIn}T00:00:00Z`).getUTCDay();
    return `${BASE}/sub.htm?nav_code=${NAV_CODE}&mode=step01&type=${q.zone}&today=${q.checkIn}&col=${col}`;
  },
};
