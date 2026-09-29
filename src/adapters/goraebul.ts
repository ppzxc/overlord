import * as cheerio from "cheerio";
import {
  AdapterError,
  type AdapterContext,
  type AvailabilityQuery,
  type AvailableSite,
  type ProviderAdapter,
  type ProviderInfo,
} from "../types.js";

const BASE = "https://stay.yd.go.kr/pages";
const NAV_CODE = "gor1501675800";

const ZONES = [
  { code: "CAA", name: "카라반 4인실" },
  { code: "CAB", name: "카라반 6인실" },
  { code: "DKA", name: "숲속야영장 A" },
  { code: "DKB", name: "숲속야영장 B" },
  { code: "DKC", name: "숲속야영장 C" },
  { code: "AUA", name: "캠핑카존" },
  { code: "PEA", name: "펜션형 A" },
  { code: "PEB", name: "펜션형 B" },
  { code: "PEC", name: "펜션형 C" },
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

function parseOpenSites(html: string, zone: string): AvailableSite[] {
  const $ = cheerio.load(html);
  const container = $(`div#zone_${zone.toLowerCase()}.select_room`);
  if (container.length === 0) {
    throw new AdapterError("unrecognized", `자리 배치 컨테이너(zone_${zone.toLowerCase()})가 없다`);
  }
  const sites: AvailableSite[] = [];
  container.find("a.num").each((_, el) => {
    const classes = ($(el).attr("class") ?? "").split(/\s+/).filter(Boolean);
    const onclick = $(el).attr("onclick") ?? "";
    const match = /zone_area_select\('[^']*','[^']*','([^']*)'\)/.exec(onclick);
    // 빈 자리는 class가 num뿐이고 zone_area_select onclick이 있는 자리다.
    if (classes.length === 1 && classes[0] === "num" && match?.[1]) {
      sites.push({ id: /([A-Za-z]+\d+)호/.exec(match[1])?.[1] ?? match[1], name: match[1] });
    }
  });
  return sites;
}

export const goraebulAdapter: ProviderAdapter = {
  id: "goraebul",

  describe: () => INFO,

  async queryAvailability(q: AvailabilityQuery, ctx: AdapterContext): Promise<AvailableSite[]> {
    const url = `${BASE}/zoneAreaAjax.htm?res_Day=${q.checkIn}&room_Code=${q.zone}&site_date=${q.nights}`;
    const res = await ctx.http.get(url);
    if (res.body.includes(BLOCK_MARKER)) throw new AdapterError("blocked", "차단 페이지를 받았다");
    if (res.status >= 500) throw new AdapterError("transient", `HTTP ${res.status}`);
    if (res.status !== 200) throw new AdapterError("unrecognized", `예상 밖 HTTP ${res.status}`);
    return parseOpenSites(res.body, q.zone);
  },

  deepLink(q: AvailabilityQuery): string {
    const col = new Date(`${q.checkIn}T00:00:00Z`).getUTCDay();
    return `${BASE}/sub.htm?nav_code=${NAV_CODE}&mode=step01&type=${q.zone}&today=${q.checkIn}&col=${col}`;
  },
};
