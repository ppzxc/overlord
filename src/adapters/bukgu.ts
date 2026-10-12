import * as cheerio from "cheerio";
import {
  AdapterError,
  type AdapterContext,
  type AvailabilityQuery,
  type AvailableSite,
  type ProviderAdapter,
  type ProviderInfo,
} from "../types.js";
import { facilities, rowClassZones } from "../catalogs/bukgu.js";
import { resolveFacility } from "../facility.js";
import { BlockedPathError } from "../http.js";
import { warnDriftOnce } from "../netfunnel.js";
import { addDays } from "../schedule.js";

const ORIGIN = "https://camping.ubimc.or.kr";
const PAGE_URL = `${ORIGIN}/Pmreservation.do`;
const TABLE_URL = `${ORIGIN}/ajax/reservationCntAjax.do`;

const INFO: ProviderInfo = {
  id: "bukgu",
  facilities,
  // 서버가 정한 최대 박수는 못 봤다. 화면 폼이 날짜 하나와 자리 하나만 넘긴다(카탈로그 머리 주석). 이 조각은 1박으로 읽는다.
  maxNights: 1,
  // 조례는 "사용일이 속한 월의 전월부터 예약"이라고 한다. 두 달 안(약 62일)으로 잡은 자리 채움이다. 다음 달 날짜가 열리는 때(선착순 월요일 10시, 달마다 다름)와 추첨 기간은 규칙으로 쓸 수 없어 어댑터가 가리지 않는다(#82).
  // 당일 입실은 화면 JS가 18시에 닫는다(`nowHour < 18`).
  openingRule: { openDaysBefore: 62, openTime: "00:00", sameDayCutoff: "18:00" },
  // 오픈 경쟁 시간은 두지 않는다. 선착순 개시일이 달마다 다르다.
  defaultPollIntervalSeconds: 150,
  // 자리 선점, 예약 제출 폼, 로그인(회원가입은 외부 `/logins`), 예약확인·취소, 추첨 신청.
  blockedPaths: ["/ajax/preReservationAjax", "/Pmreservation2.do", "/login", "/PmmySubscription", "/Pmbukgusubscription", "/Pmsubscription"],
  // 쿠키 없이 응답한다(기록).
  cookieSession: false,
  // 시설이 둘이 되므로(당사현대차오션캠프, #82) 시설을 꼭 골라야 한다.
  facilityRequired: true,
};

const siteKindCodeOf = (facility: string): string => {
  const ref = resolveFacility(INFO, facility).ref;
  if (typeof ref !== "object" || !ref.siteKindCode) throw new Error(`bukgu 시설 ${facility}에 siteKindCode가 없다`);
  return ref.siteKindCode;
};

interface Row {
  zone: string;
  name: string;
  open: boolean;
}

/**
 * 봇 탐지 장치·captcha 표지. ADR 0002가 넘지 않는 선으로 꼽은 장치의 이름이다. 북구의 조회 흐름에는 없었고(기록한 화면·스크립트·조회 응답 어디에도 없다), 나타나면 새 신호로 보고 멈춘다.
 * 로그인 요구의 조회 응답 원문은 기록이 없다. 화면 JS(`subIdx`)가 로그인 안 한 방문자를 `/login.do`로 보내므로 표 없이 `/login.do`가 오면 로그인 요구로 본다.
 */
const BOT_DETECTION = /botmanager|crawlingCheck|dynapath|captcha/i;
const LOGIN_REQUIRED = /\/login\.do/i;

/** 응답 상태를 판정한다. 401·403·429는 차단, 5xx는 일시 오류, 그 밖의 200 아님은 구조 변경이다. */
function assertOk(status: number): void {
  const where = "reservationCntAjax.do";
  if (status === 401 || status === 403 || status === 429) throw new AdapterError("blocked", `${where}: HTTP ${status}`);
  if (status >= 500) throw new AdapterError("transient", `${where}: HTTP ${status}`);
  if (status !== 200) throw new AdapterError("unrecognized", `${where}: 예상 밖 HTTP ${status}`);
}

/** 표를 읽는다. 사이트명 칸의 색 클래스로 구역을, 예약현황 칸으로 빈자리를 가른다. 모르는 모양과 값은 구조 변경이다. */
function parseTable(html: string, facility: string): Row[] {
  const where = "reservationCntAjax.do";
  if (BOT_DETECTION.test(html)) throw new AdapterError("blocked", `${where}: 봇 탐지·captcha 표지가 왔다`);
  const $ = cheerio.load(html);
  const table = $("table#tableSite");
  if (table.length === 0) {
    if (LOGIN_REQUIRED.test(html)) throw new AdapterError("blocked", `${where}: 표 대신 로그인 요구가 왔다`);
    throw new AdapterError("unrecognized", `${where}: 표(table#tableSite)가 없다`);
  }
  const headers = table.find("thead th").toArray().map((th) => $(th).text().trim());
  const nameCol = headers.indexOf("사이트명");
  const statusCol = headers.indexOf("예약현황");
  if (nameCol < 0 || statusCol < 0) throw new AdapterError("unrecognized", `${where}: 사이트명·예약현황 열이 없다(${headers.join(", ")})`);
  const classes = rowClassZones[facility] ?? {};
  const rows = table
    .find("tbody tr")
    .toArray()
    .map((tr): Row => {
      const cells = $(tr).children("td");
      const span = cells.eq(nameCol).find("span.link");
      const name = span.text().trim();
      const zone = Object.entries(classes).find(([cls]) => span.hasClass(cls))?.[1];
      const status = cells.eq(statusCol).text().trim();
      if (!name) throw new AdapterError("unrecognized", `${where}: 행에 사이트명이 없다`);
      if (zone === undefined) throw new AdapterError("unrecognized", `${where}: ${name}의 시설종류 색 클래스(${span.attr("class") ?? ""})를 모른다`);
      if (status !== "예약가능" && status !== "예약종료") throw new AdapterError("unrecognized", `${where}: ${name}의 예약현황이 예약가능/예약종료가 아니다(${JSON.stringify(status)})`);
      return { zone, name, open: status === "예약가능" };
    });
  if (rows.length === 0) throw new AdapterError("unrecognized", `${where}: 표에 행이 없다`);
  return rows;
}

/** 요청 하나를 보낸다. 접근 금지 경로(로그인으로 리다이렉트 포함)는 차단, 연결 실패·시간 초과(TLS 검증 실패 포함)는 일시 오류다. */
async function fetchTable(facility: string, date: string, ctx: AdapterContext): Promise<Row[]> {
  let res;
  try {
    res = await ctx.http.post(
      TABLE_URL,
      // 페이지 `addTable()`과 같은 본문. `priceCode`는 페이지 기본값인 빈 값(시설 전체)이다.
      { resDate: date, siteKindCode: siteKindCodeOf(facility), priceCode: "" },
      // 페이지의 jQuery ajax(`dataType: "html"`)가 싣는 헤더.
      { headers: { Referer: PAGE_URL, Origin: ORIGIN, "X-Requested-With": "XMLHttpRequest", Accept: "text/html, */*; q=0.01" } },
    );
  } catch (e) {
    if (e instanceof BlockedPathError) throw new AdapterError("blocked", `reservationCntAjax.do: 로그인·접근 금지 경로로 보내졌다(${e.message})`);
    if (e instanceof AdapterError) throw e;
    throw new AdapterError("transient", `reservationCntAjax.do: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  assertOk(res.status);
  const rows = parseTable(res.body, facility);
  // 카탈로그의 구역이 표에 하나도 없으면(그 구역을 감시하지 않아도) 경고만 남긴다. 감시하는 구역이 없는 것은 조회 단위 판정이 실패로 친다.
  const seen = new Set(rows.map((r) => r.zone));
  for (const z of resolveFacility(INFO, facility).zones) {
    if (!seen.has(z.code)) warnDriftOnce(ctx, `${facility}:gone:${z.code}`, "bukgu zone drift", { facility, change: "gone", zone: z.code });
  }
  return rows;
}

type Results = Map<AvailabilityQuery, AvailableSite[] | AdapterError>;

/**
 * 한 바퀴. 같은 (시설, 밤)은 구역이 여럿이어도 한 번만 조회한다. 요청 하나가 실패하면 남은 요청은 보내지 않고
 * 남은 조회 단위가 그 실패를 값으로 받는다(울주·knps와 같다). 이미 읽은 단위의 결과는 그대로 둔다.
 * 요청 없이 그 단위만 보고 나온 구조 변경(표에서 사라진 구역)은 그 단위만 실패로 치고 다른 단위는 계속 읽는다.
 */
async function runBatch(units: AvailabilityQuery[], ctx: AdapterContext): Promise<Results> {
  const results: Results = new Map();
  const tables = new Map<string, Row[]>();
  let stopped: AdapterError | undefined;
  for (const q of units) {
    const max = resolveFacility(INFO, q.facility).maxNights ?? INFO.maxNights;
    if (q.nights > max) throw new Error(`bukgu ${q.facility}는 최대 ${max}박만 읽는다(${q.nights}박)`);
    if (stopped) {
      results.set(q, stopped);
      continue;
    }
    try {
      const perNight: Row[][] = [];
      for (const date of Array.from({ length: q.nights }, (_, i) => addDays(q.checkIn, i))) {
        const key = `${q.facility}|${date}`;
        if (!tables.has(key)) tables.set(key, await fetchTable(q.facility, date, ctx)); // 직렬: 요청은 HTTP 층이 한 줄로 보낸다.
        perNight.push(tables.get(key)!);
      }
      // 응답이 왔는데 감시하는 구역의 행이 없으면 화면 모양이 바뀐 것이다. 빈자리 없음으로 넘기지 않는다.
      if (perNight.some((rows) => !rows.some((r) => r.zone === q.zone))) {
        results.set(q, new AdapterError("unrecognized", `reservationCntAjax.do: 표에 감시하는 구역 ${q.zone}의 행이 없다`));
        continue;
      }
      // 여러 박이면 같은 사이트명이 밤마다 예약가능일 때만 빈자리다.
      const open = perNight.map((rows) => new Set(rows.filter((r) => r.zone === q.zone && r.open).map((r) => r.name)));
      results.set(q, [...open[0]!].filter((n) => open.every((s) => s.has(n))).map((name) => ({ id: name, name })));
    } catch (e) {
      if (!(e instanceof AdapterError)) throw e;
      stopped = e;
      results.set(q, e);
    }
  }
  return results;
}

export const bukguAdapter: ProviderAdapter = {
  id: "bukgu",

  describe: () => INFO,

  async queryAvailability(q, ctx) {
    const found = (await runBatch([q], ctx)).get(q);
    if (found instanceof Error) throw found;
    return found ?? [];
  },

  /** 같은 (시설, 밤)은 구역이 여럿이어도 한 번만 조회한다. */
  queryAvailabilityBatch: runBatch,

  deepLink: () => PAGE_URL,
};
