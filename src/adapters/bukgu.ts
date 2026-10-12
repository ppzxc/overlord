import * as cheerio from "cheerio";
import {
  AdapterError,
  type AdapterContext,
  type AvailabilityQuery,
  type AvailableSite,
  type FacilityObservation,
  type ProviderAdapter,
  type ProviderInfo,
  type TransportResponse,
} from "../types.js";
import { facilities, rowClassZones } from "../catalogs/bukgu.js";
import { resolveFacility } from "../facility.js";
import { BlockedPathError } from "../http.js";
import { warnDriftOnce } from "../netfunnel.js";
import { addDays, kstDate, weekdayKey } from "../schedule.js";
import { tlsRound } from "../tls-streak.js";

const ORIGIN = "https://camping.ubimc.or.kr";
const PAGE_URL = `${ORIGIN}/Pmreservation.do`;
const TABLE_URL = `${ORIGIN}/ajax/reservationCntAjax.do`;

const INFO: ProviderInfo = {
  id: "bukgu",
  facilities,
  // 예약 하나가 한 밤이다(화면 폼이 날짜 하나와 자리 하나만 넘기고 어디에도 연박 규정이 없다. 카탈로그 머리 주석). 연박은 날짜를 따로 건다.
  maxNights: 1,
  // 조례는 "사용일이 속한 월의 전월부터 예약"이라고 한다. 두 달 안(약 62일)으로 잡은 자리 채움이다. 다음 달 날짜가 열리는 때(선착순 월요일 10시, 달마다 다름)와 추첨 기간은 이 규칙으로 못 가리므로 예약 화면의 달력 상한과 결제 마감일로 `openForFirstCome`이 가린다.
  // 당일 입실은 화면 JS가 18시에 닫는다(`nowHour < 18`).
  openingRule: { openDaysBefore: 62, openTime: "00:00", sameDayCutoff: "18:00" },
  // 오픈 경쟁 시간은 두지 않는다. 선착순 개시일이 달마다 다르다.
  defaultPollIntervalSeconds: 150,
  // 자리 선점, 예약 제출 폼, 로그인(회원가입은 외부 `/logins`), 예약확인·취소, 추첨 신청.
  blockedPaths: ["/ajax/preReservationAjax", "/Pmreservation2.do", "/login", "/PmmySubscription", "/Pmbukgusubscription", "/Pmsubscription"],
  // 쿠키 없이 응답한다(기록).
  cookieSession: false,
  // 시설이 둘(강동, 당사)이라 시설을 꼭 골라야 한다.
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
function assertOk(status: number, where = "reservationCntAjax.do"): void {
  if (status === 401 || status === 403 || status === 429) throw new AdapterError("blocked", `${where}: HTTP ${status}`);
  if (status >= 500) throw new AdapterError("transient", `${where}: HTTP ${status}`);
  if (status !== 200) throw new AdapterError("unrecognized", `${where}: 예상 밖 HTTP ${status}`);
}

/** 표를 읽는다. 사이트명 칸의 색 클래스로 구역을, 예약현황 칸으로 빈자리를 가른다. 모르는 모양과 값은 구조 변경이다. */
function parseTable(html: string, facility: string, lenient = false): Row[] {
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
      // `catalog --live`는 모르는 색 클래스를 새로 생긴 구역으로 보고한다(구조 변경이 아니라 비교할 내용이다).
      if (zone === undefined && !lenient) throw new AdapterError("unrecognized", `${where}: ${name}의 시설종류 색 클래스(${span.attr("class") ?? ""})를 모른다`);
      const unknownClass = (span.attr("class") ?? "").split(/\s+/).find((c) => c.startsWith("line_")) ?? "(없음)";
      if (status !== "예약가능" && status !== "예약종료") throw new AdapterError("unrecognized", `${where}: ${name}의 예약현황이 예약가능/예약종료가 아니다(${JSON.stringify(status)})`);
      return { zone: zone ?? `색 클래스 ${unknownClass}`, name, open: status === "예약가능" };
    });
  if (rows.length === 0) throw new AdapterError("unrecognized", `${where}: 표에 행이 없다`);
  return rows;
}

/** 요청 하나를 보낸다. 접근 금지 경로(로그인으로 리다이렉트 포함)는 차단, 연결 실패·시간 초과(TLS 검증 실패 포함)는 일시 오류다. */
async function send(where: string, request: () => Promise<TransportResponse>): Promise<TransportResponse> {
  try {
    return await request();
  } catch (e) {
    if (e instanceof BlockedPathError) throw new AdapterError("blocked", `${where}: 로그인·접근 금지 경로로 보내졌다(${e.message})`);
    if (e instanceof AdapterError) throw e;
    throw new AdapterError("transient", `${where}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

async function fetchTable(facility: string, date: string, ctx: AdapterContext, lenient = false): Promise<Row[]> {
  const res = await send("reservationCntAjax.do", () =>
    ctx.http.post(
      TABLE_URL,
      // 페이지 `addTable()`과 같은 본문. `priceCode`는 페이지 기본값인 빈 값(시설 전체)이다.
      { resDate: date, siteKindCode: siteKindCodeOf(facility), priceCode: "" },
      // 페이지의 jQuery ajax(`dataType: "html"`)가 싣는 헤더.
      { headers: { Referer: PAGE_URL, Origin: ORIGIN, "X-Requested-With": "XMLHttpRequest", Accept: "text/html, */*; q=0.01" } },
    ),
  );
  assertOk(res.status);
  const rows = parseTable(res.body, facility, lenient);
  if (lenient) return rows;
  // 카탈로그의 구역이 표에 하나도 없으면(그 구역을 감시하지 않아도) 경고만 남긴다. 감시하는 구역이 없는 것은 조회 단위 판정이 실패로 친다.
  const seen = new Set(rows.map((r) => r.zone));
  for (const z of resolveFacility(INFO, facility).zones) {
    if (!seen.has(z.code)) warnDriftOnce(ctx, `${facility}:gone:${z.code}`, "bukgu zone drift", { facility, change: "gone", zone: z.code });
  }
  return rows;
}

/** 요청 없이 그 단위만 보고 나온 구조 변경. 그 단위만 실패로 치고 다른 단위의 조회는 막지 않는다. */
class UnitStructureError extends AdapterError {
  constructor(message: string) {
    super("unrecognized", message);
  }
}

/**
 * 추첨 대상 날짜를 가리는 기준. 예약 화면에서 읽는다.
 * - `limit`: 달력 상한 `d2`의 한국 날짜. 페이지 달력은 `date > d2`인 날만 막아서(`d2`는 그 날 00:00 + 요청 시각의 밀리초) 상한 날짜 자체는 눌리지만 열린 날이 아니다(기록한 11/01).
 * - `firstComeStart`: 다음 달 날짜의 선착순 개시 시각. 결제 마감일(`resEndDay`) 다음 월요일 10:00 KST(공지 두 건에서 확인).
 */
interface LotteryGate {
  limit: string;
  firstComeStart: number;
}

const pageVar = (html: string, name: string): string | undefined => new RegExp(`var\\s+${name}\\s*=\\s*'?(\\d+)'?\\s*;`).exec(html)?.[1];

/** 예약 화면에서 추첨 대상 날짜를 가리는 기준을 읽는다. 없거나 모양이 다르면 구조 변경이다. */
function parseGate(html: string, now: Date): LotteryGate {
  const where = "Pmreservation.do";
  if (BOT_DETECTION.test(html)) throw new AdapterError("blocked", `${where}: 봇 탐지·captcha 표지가 왔다`);
  const d2 = pageVar(html, "d2");
  if (d2 === undefined || d2.length !== 13) throw new UnitStructureError(`${where}: 달력 상한(var d2 = <ms>)을 찾지 못했다`);
  const resEndDay = Number(pageVar(html, "resEndDay"));
  const [year, month] = kstDate(now).split("-").map(Number) as [number, number];
  if (!Number.isInteger(resEndDay) || resEndDay < 1 || new Date(Date.UTC(year, month - 1, resEndDay)).getUTCMonth() !== month - 1) {
    throw new UnitStructureError(`${where}: 결제 마감일(var resEndDay)이 이달 날짜가 아니다`);
  }
  const payDeadline = `${kstDate(now).slice(0, 7)}-${String(resEndDay).padStart(2, "0")}`;
  let monday = addDays(payDeadline, 1);
  while (weekdayKey(monday) !== "mon") monday = addDays(monday, 1);
  return { limit: kstDate(new Date(Number(d2))), firstComeStart: Date.parse(`${monday}T10:00:00+09:00`) };
}

/**
 * 이 밤이 선착순으로 열려 있는가. 이달 날짜는 지난달에 선착순이 열렸으니 열려 있다. 다음 달 날짜는 선착순 개시 시각 뒤이고 달력 상한보다 앞일 때만 열려 있다.
 * 그 앞(추첨 접수·추첨·당첨자 결제 기간)의 표는 추첨 대상이라도 25자리가 모두 "예약가능"으로 보인다. 두 달 뒤 날짜는 조례상 아직 예약을 받지 않는다.
 */
function openForFirstCome(date: string, today: string, gate: LotteryGate, now: Date): boolean {
  const month = today.slice(0, 7);
  const next = addDays(`${month}-28`, 4).slice(0, 7);
  if (date.slice(0, 7) === next) return now.getTime() >= gate.firstComeStart && date < gate.limit;
  return date.slice(0, 7) <= month;
}

type Results = Map<AvailabilityQuery, AvailableSite[] | AdapterError>;

/**
 * 한 바퀴. 같은 (시설, 밤)은 구역이 여럿이어도 한 번만 조회한다. 요청 하나가 실패하면 남은 요청은 보내지 않고
 * 남은 조회 단위가 그 실패를 값으로 받는다(울주·knps와 같다). 이미 읽은 단위의 결과는 그대로 둔다.
 * 요청 없이 그 단위만 보고 나온 구조 변경(표에서 사라진 구역, 읽을 수 없는 예약 화면 변수)은 그 단위만 실패로 치고 다른 단위는 계속 읽는다.
 * TLS 검증 실패는 일시 오류지만 두 바퀴 연속이면 구조 변경으로 친다(인증서가 바뀌었을 수 있다).
 * 추첨 대상 날짜: 다음 달 이후 날짜가 걸린 단위가 있으면 예약 화면을 한 번 받아(시설과 무관) 선착순으로 열린 밤만 조회한다. 열리지 않은 밤이 낀 단위는 요청 없이 빈자리 없음이다.
 */
async function runBatch(units: AvailabilityQuery[], ctx: AdapterContext): Promise<Results> {
  const results: Results = new Map();
  const tables = new Map<string, Row[]>();
  const tls = tlsRound(ctx.http);
  const now = ctx.clock.now();
  const today = kstDate(now);
  let gate: LotteryGate | UnitStructureError | undefined;
  const gateOf = async (): Promise<LotteryGate> => {
    if (gate === undefined) {
      const res = await send("Pmreservation.do", () => ctx.http.get(PAGE_URL));
      assertOk(res.status, "Pmreservation.do");
      try {
        gate = parseGate(res.body, now);
      } catch (e) {
        if (!(e instanceof UnitStructureError)) throw e;
        gate = e;
      }
    }
    if (gate instanceof UnitStructureError) throw gate;
    return gate;
  };
  let stopped: AdapterError | undefined;
  for (const q of units) {
    const max = resolveFacility(INFO, q.facility).maxNights ?? INFO.maxNights;
    if (q.nights > max) throw new Error(`bukgu ${q.facility}는 최대 ${max}박만 읽는다(${q.nights}박)`);
    if (stopped) {
      results.set(q, stopped);
      continue;
    }
    try {
      const dates = Array.from({ length: q.nights }, (_, i) => addDays(q.checkIn, i));
      // 이달 안의 밤만 걸린 단위는 예약 화면을 받지 않는다.
      if (dates.some((d) => d.slice(0, 7) > today.slice(0, 7))) {
        const g = await gateOf();
        if (!dates.every((d) => openForFirstCome(d, today, g, now))) {
          results.set(q, []); // 추첨 대상(또는 아직 예약을 받지 않는) 밤이 낀 단위: 표를 조회하지 않는다.
          continue;
        }
      }
      const perNight: Row[][] = [];
      for (const date of dates) {
        const key = `${q.facility}|${date}`;
        if (!tables.has(key)) tables.set(key, await fetchTable(q.facility, date, ctx)); // 직렬: 요청은 HTTP 층이 한 줄로 보낸다.
        perNight.push(tables.get(key)!);
      }
      // 응답이 왔는데 감시하는 구역의 행이 없으면 화면 모양이 바뀐 것이다. 빈자리 없음으로 넘기지 않는다.
      if (perNight.some((rows) => !rows.some((r) => r.zone === q.zone))) {
        throw new UnitStructureError(`reservationCntAjax.do: 표에 감시하는 구역 ${q.zone}의 행이 없다`);
      }
      // 여러 박이면 같은 사이트명이 밤마다 예약가능일 때만 빈자리다.
      const open = perNight.map((rows) => new Set(rows.filter((r) => r.zone === q.zone && r.open).map((r) => r.name)));
      results.set(q, [...open[0]!].filter((n) => open.every((s) => s.has(n))).map((name) => ({ id: name, name })));
    } catch (e) {
      if (e instanceof UnitStructureError) {
        results.set(q, e); // 이 단위만의 구조 변경이다. 요청은 실패하지 않았으니 다른 단위는 계속 읽는다.
        continue;
      }
      const failure = tls.classify(e) ?? e;
      if (!(failure instanceof AdapterError)) throw failure;
      stopped = failure;
      results.set(q, failure);
    }
  }
  tls.finish();
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

  /**
   * `catalog --live`: 내일(KST) 밤의 시설 전체 표를 한 번 받아 구역과 자리를 읽는다. 예약 화면은 받지 않고 추첨 대상 날짜도 가리지 않는다(표의 모양만 본다).
   * 구역 코드는 예약처가 응답에 싣지 않으므로(이름이 코드다) 비운다.
   */
  async observeFacility(facility, ctx): Promise<FacilityObservation> {
    const rows = await fetchTable(facility, addDays(kstDate(ctx.clock.now()), 1), ctx, true);
    const zones: FacilityObservation["zones"] = [];
    for (const r of rows) {
      const found = zones.find((z) => z.name === r.zone);
      if (found) found.seats.push(r.name);
      else zones.push({ name: r.zone, codes: [], seats: [r.name] });
    }
    return { zones };
  },

  deepLink: () => PAGE_URL,
};
