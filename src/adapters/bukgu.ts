import * as cheerio from "cheerio";
import {
  AdapterError,
  type AdapterContext,
  type AvailabilityQuery,
  type AvailableSite,
  type FacilityObservation,
  type ProviderAdapter,
  type ProviderInfo,
} from "../types.js";
import { facilities, rowClassZones } from "../catalogs/bukgu.js";
import { resolveFacility, zoneName } from "../facility.js";
import { BOT_DETECTION, UnitStructureError, assertOk, send } from "../adapter-signals.js";
import { warnDriftOnce } from "../netfunnel.js";
import { addDays, kstDate, nextMonthOf, weekdayKey } from "../schedule.js";
import { tlsStreakRound } from "../tls-streak.js";

const ORIGIN = "https://camping.ubimc.or.kr";
const PAGE_URL = `${ORIGIN}/Pmreservation.do`;
const TABLE_URL = `${ORIGIN}/ajax/reservationCntAjax.do`;

const INFO: ProviderInfo = {
  id: "bukgu",
  facilities,
  // 예약 하나가 한 밤이다(화면 폼이 날짜 하나와 자리 하나만 넘기고 어디에도 연박 규정이 없다. 카탈로그 머리 주석). 연박은 날짜를 따로 건다.
  maxNights: 1,
  // 오픈 경쟁 시간(`openingRush`)은 두지 않는다(스펙). 아래 세 값은 타입상 필수인 날짜 창이고 열리는 때를 주장하지 않는다.
  // - openDaysBefore 62, openTime 00:00: 조례("사용일이 속한 월의 전월부터 예약")상 열릴 수 있는 가장 먼 날짜는 오늘로부터 61일(이달 1일 → 다음 달 말일)이다. 62는 그보다 느슨한 걸러내기이고 개시 시각이 아니다.
  //   이보다 먼 날짜는 요청 없이 건너뛰어 예약 화면 요청도 아낀다. 다음 달 날짜가 열렸는지(추첨 기간 가리기)는 시각이 아니라 예약 화면의 달력 상한(`d2`)이 말하는 대로 `openForFirstCome`이 정한다.
  // - sameDayCutoff 18:00: 화면 JS가 당일 입실을 18시에 닫는다(`nowHour < 18`, 기록).
  openingRule: { openDaysBefore: 62, openTime: "00:00", sameDayCutoff: "18:00" },
  defaultPollIntervalSeconds: 150,
  // 자리 선점(`preReservationAjax2.do`), 예약 제출 폼(`Pmreservation2.do`, 결제는 이 제출 뒤 로그인 후 단계라 경로를 못 봤다), 로그인·로그아웃(회원가입은 외부 `/logins`; 경로 접두어는 호스트를 가리지 않아 같이 막힌다),
  // 예약확인·취소(`PmmySubscription.do`; 기록한 것은 이 하나지만 `Pmmy` 접두 이름은 같은 계열로 보고 접두어로 막는다. 막는 쪽으로만 넓힌 것이라 조회는 영향이 없다), 추첨 신청. 예약 화면 `Pmreservation.do`와 조회 경로는 막지 않는다.
  blockedPaths: ["/ajax/preReservationAjax", "/Pmreservation2", "/login", "/logout", "/Pmmy", "/Pmbukgusubscription", "/Pmsubscription"],
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


/** 표의 한 행. 구역은 사이트명 칸의 색 클래스에서 읽는다. */
interface RawRow {
  name: string;
  /** 사이트명 칸의 `line_…` 색 클래스. 없으면 `(없음)`. */
  cls: string;
  status: string;
}

interface Row {
  /** 구역 코드(`priceCode`). 색 클래스에서 카탈로그가 가른 값이다. */
  zone: string;
  name: string;
  open: boolean;
}

/** 구역을 가릴 수 없는 행(모르는 색 클래스). 감시하는 구역과 무관할 수 있어 구조 변경으로 치지 않고 따로 든다. */
interface UnattributedRow {
  name: string;
  cls: string;
}

/**
 * 봇 탐지 장치·captcha 표지는 `BOT_DETECTION`이다. 북구의 조회 흐름에는 없었고(기록한 화면·스크립트·조회 응답 어디에도 없다), 나타나면 새 신호로 보고 멈춘다.
 * 로그인 요구: 조회 응답의 로그인 요구 원문은 기록이 없다. 확인한 것은 화면 JS(`subIdx`)가 로그인 안 한 방문자를 `/login.do`로 보내는 모양(`location.href="/login.do"`)뿐이라,
 * 표 없이 그런 이동 스크립트(또는 meta refresh)가 오면 로그인 요구다. 기록한 사이트 전체 화면은 머리말에 `<a class="login_btn" href="/login.do">` 링크를 달고 예약 화면은 위 스크립트도 함께 가진다.
 * 그래서 로그인 링크나 이동 스크립트가 있어도 사이트 틀(`login_btn`)이 보이면 로그인 요구가 아니라 알 수 없는 화면(`unrecognized`)이다. 로그인 경로로의 리다이렉트(Location)는 HTTP 층이 접근 금지로 막는다.
 */
const LOGIN_REDIRECT = /(?:location(?:\.href)?\s*=|location\.(?:replace|assign)\s*\()\s*['"]\/?login\.do|http-equiv\s*=\s*["']?refresh["']?[^>]*login\.do/i;
const SITE_FRAME = /class="login_btn"/;

/** 표를 읽는다. 표 구조(표, 사이트명·예약현황 열, 사이트명, 행)가 깨지면 구조 변경이다. 값의 뜻(구역, 예약현황)은 보지 않는다. */
function parseTable(html: string): RawRow[] {
  const where = "reservationCntAjax.do";
  if (BOT_DETECTION.test(html)) throw new AdapterError("blocked", `${where}: 봇 탐지·captcha 표지가 왔다`);
  const $ = cheerio.load(html);
  const table = $("table#tableSite");
  if (table.length === 0) {
    if (LOGIN_REDIRECT.test(html) && !SITE_FRAME.test(html)) throw new AdapterError("blocked", `${where}: 표 대신 로그인 요구가 왔다`);
    throw new AdapterError("unrecognized", `${where}: 표(table#tableSite)가 없다`);
  }
  const headers = table.find("thead th").toArray().map((th) => $(th).text().trim());
  const nameCol = headers.indexOf("사이트명");
  const statusCol = headers.indexOf("예약현황");
  if (nameCol < 0 || statusCol < 0) throw new AdapterError("unrecognized", `${where}: 사이트명·예약현황 열이 없다(${headers.join(", ")})`);
  const rows = table
    .find("tbody tr")
    .toArray()
    .map((tr): RawRow => {
      const cells = $(tr).children("td");
      const span = cells.eq(nameCol).find("span.link");
      const name = span.text().trim();
      if (!name) throw new AdapterError("unrecognized", `${where}: 행에 사이트명이 없다`);
      const cls = (span.attr("class") ?? "").split(/\s+/).find((c) => c.startsWith("line_")) ?? "(없음)";
      return { name, cls, status: cells.eq(statusCol).text().trim() };
    });
  if (rows.length === 0) throw new AdapterError("unrecognized", `${where}: 표에 행이 없다`);
  return rows;
}

/** 행을 구역으로 가른다. 색 클래스가 카탈로그에 없는 행은 구역을 가릴 수 없는 행으로 따로 둔다. */
function attribute(facility: string, raw: RawRow[]): { rows: Row[]; unattributed: UnattributedRow[] } {
  const classes = rowClassZones[facility] ?? {};
  const rows: Row[] = [];
  const unattributed: UnattributedRow[] = [];
  for (const r of raw) {
    const zone = classes[r.cls];
    if (zone === undefined) unattributed.push({ name: r.name, cls: r.cls });
    else rows.push({ zone, name: r.name, open: r.status === "예약가능" });
  }
  return { rows, unattributed };
}

async function fetchTable(facility: string, date: string, ctx: AdapterContext): Promise<RawRow[]> {
  const res = await send("reservationCntAjax.do", () =>
    ctx.http.post(
      TABLE_URL,
      // 페이지 `addTable()`과 같은 본문. `priceCode`는 페이지 기본값인 빈 값(시설 전체)이다.
      { resDate: date, siteKindCode: siteKindCodeOf(facility), priceCode: "" },
      // 페이지의 jQuery ajax(`dataType: "html"`)가 싣는 헤더.
      { headers: { Referer: PAGE_URL, Origin: ORIGIN, "X-Requested-With": "XMLHttpRequest", Accept: "text/html, */*; q=0.01" } },
    ),
  );
  assertOk(res, "reservationCntAjax.do");
  return parseTable(res.body);
}

/** 한 (시설, 밤)의 표 읽기 결과. 구역을 가린 행과, 가리지 못한 행의 수(감시 구역이 사라졌을 때 이유를 밝히는 데 쓴다). */
interface Table {
  rows: Row[];
  unattributed: number;
}

/**
 * 폴링용으로 표를 읽는다. 예약현황이 "예약가능"/"예약종료" 밖이면 어느 행이든 구조 변경이다(스펙).
 * 색 클래스가 낯선 행(구역을 가릴 수 없음)과 카탈로그의 구역이 표에 하나도 없는 것은 경고만 남기고, 감시하는 구역의 행이 없는 것은 조회 단위 판정이 실패로 친다.
 */
async function readTable(facility: string, date: string, ctx: AdapterContext): Promise<Table> {
  const raw = await fetchTable(facility, date, ctx);
  const odd = raw.find((r) => r.status !== "예약가능" && r.status !== "예약종료");
  if (odd) throw new AdapterError("unrecognized", `reservationCntAjax.do: ${odd.name}의 예약현황이 예약가능/예약종료가 아니다(${JSON.stringify(odd.status)})`);
  const { rows, unattributed } = attribute(facility, raw);
  for (const cls of new Set(unattributed.map((u) => u.cls))) {
    const seats = unattributed.filter((u) => u.cls === cls).map((u) => u.name);
    warnDriftOnce(ctx, `${facility}:class:${cls}`, "bukgu zone drift", { facility, change: "unknown-class", class: cls, seats });
  }
  const seen = new Set(rows.map((r) => r.zone));
  for (const z of resolveFacility(INFO, facility).zones) {
    if (!seen.has(z.code)) warnDriftOnce(ctx, `${facility}:gone:${z.code}`, "bukgu zone drift", { facility, change: "gone", zone: z.code });
  }
  return { rows, unattributed: unattributed.length };
}

/**
 * 추첨 대상 날짜를 가리는 기준. 예약 화면에서 읽는다.
 * - `limitDate`: 달력 상한 `d2`의 한국 날짜. 페이지 달력은 `d > d2 || d < now`인 날을 막는다(`d2`는 서버가 요청마다 채우는 epoch ms: 상한 날짜 00:00 KST + 요청 시각의 밀리초).
 *   그래서 상한 날짜 자체는 눌리지만 열린 날이 아니다(기록한 11/01은 추첨 대상인데 표가 25자리 모두 예약가능이었다). 열린 날은 `date < limitDate`다.
 * - `firstComeAtMs`: 선착순 개시 시각(epoch ms)의 힌트. 결제 마감일(`resEndDay`) 다음 월요일 10:00 KST(공지 두 건에서 확인). 알림 판정에는 쓰지 않고 `d2`가 움직이지 않을 때의 경고에만 쓴다.
 *   `resEndDay`를 읽을 수 없으면 없다(경고만 못 한다. 알림 판정은 그대로다).
 */
interface LotteryGate {
  limitDate: string;
  firstComeAtMs: number | undefined;
}

const pageVar = (html: string, name: string): string | undefined => new RegExp(`var\\s+${name}\\s*=\\s*'?(\\d+)'?\\s*;`).exec(html)?.[1];

/** 선착순 개시 시각 힌트: 이달 결제 마감일(`resEndDay`) 다음 월요일 10:00 KST. 읽을 수 없으면 undefined. */
function firstComeHint(html: string, now: Date): number | undefined {
  const resEndDay = Number(pageVar(html, "resEndDay"));
  const [year, month] = kstDate(now).split("-").map(Number) as [number, number];
  if (!Number.isInteger(resEndDay) || resEndDay < 1 || new Date(Date.UTC(year, month - 1, resEndDay)).getUTCMonth() !== month - 1) return undefined;
  let monday = addDays(`${kstDate(now).slice(0, 7)}-${String(resEndDay).padStart(2, "0")}`, 1);
  while (weekdayKey(monday) !== "mon") monday = addDays(monday, 1);
  return Date.parse(`${monday}T10:00:00+09:00`);
}

/** 예약 화면에서 추첨 대상 날짜를 가리는 기준을 읽는다. 달력 상한이 없거나 모양이 다르면 구조 변경이다. */
function parseGate(html: string, now: Date): LotteryGate {
  const where = "Pmreservation.do";
  if (BOT_DETECTION.test(html)) throw new AdapterError("blocked", `${where}: 봇 탐지·captcha 표지가 왔다`);
  const d2 = pageVar(html, "d2");
  if (d2 === undefined || d2.length !== 13) throw new UnitStructureError(`${where}: 달력 상한(var d2 = <ms>)을 찾지 못했다`);
  return { limitDate: kstDate(new Date(Number(d2))), firstComeAtMs: firstComeHint(html, now) };
}

/**
 * 이 밤이 선착순으로 열려 있는가. 이달 날짜는 지난달에 선착순이 열렸으니 열려 있다. 다음 달 이후 날짜는 예약 화면의 달력이 열어 준 날(`date < limitDate`)만 열려 있다.
 * 달력이 닫아 둔 동안(추첨 접수·추첨·당첨자 결제 기간)의 표는 추첨 대상이라도 25자리가 모두 "예약가능"으로 보인다. 시각 규칙은 두지 않고 달력이 말하는 대로만 따른다.
 */
function openForFirstCome(date: string, today: string, gate: LotteryGate): boolean {
  return date.slice(0, 7) <= today.slice(0, 7) || date < gate.limitDate;
}

/**
 * 선착순 개시 시각이 지났는데도 달력 상한이 다음 달 1일 이하(추첨 기간의 한계)에 머물면 다음 달 날짜의 알림이 나가지 않는다. 안전한 쪽으로 실패하지만 선착순 알림을 놓는 일이라 경고를 남긴다.
 * 경고는 로그 한 줄이다(같은 달에 한 번). 헬스 상태는 바꾸지 않는다(예약처가 응답하고 있고 이달 날짜는 정상이라 멈추거나 구조 변경으로 알릴 일이 아니다).
 */
function warnIfGateStuck(gate: LotteryGate, nextMonth: string, ctx: AdapterContext, now: Date): void {
  if (gate.firstComeAtMs === undefined || now.getTime() < gate.firstComeAtMs || gate.limitDate > `${nextMonth}-01`) return;
  warnDriftOnce(ctx, `gate:stuck:${nextMonth}`, "bukgu lottery gate stuck", { limitDate: gate.limitDate, firstComeAt: new Date(gate.firstComeAtMs + 9 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "+09:00") });
}

type Results = Map<AvailabilityQuery, AvailableSite[] | AdapterError>;

/**
 * 한 바퀴. 같은 (시설, 밤)은 구역이 여럿이어도 한 번만 조회한다. 요청 하나가 실패하면 남은 요청은 보내지 않고
 * 남은 조회 단위가 그 실패를 값으로 받는다(울주·knps와 같다). 이미 읽은 단위의 결과는 그대로 둔다.
 * 요청 없이 그 단위만 보고 나온 구조 변경(표에서 사라진 구역, 읽을 수 없는 예약 화면 변수)은 그 단위만 실패로 치고 다른 단위는 계속 읽는다.
 * TLS 검증 실패는 일시 오류지만 두 바퀴 연속이면 구조 변경으로 친다(인증서가 바뀌었을 수 있다).
 * 추첨 대상 날짜: 다음 달 이후 날짜가 걸린 단위가 있으면 예약 화면을 한 번 받아(시설과 무관) 달력 상한(`d2`)이 열어 준 밤(`date < d2의 한국 날짜`)만 조회한다. 열리지 않은 밤이 낀 단위는 요청 없이 빈자리 없음이다.
 * 상한이 선착순 개시 힌트(결제 마감일 다음 월요일 10시) 뒤에도 다음 달 1일 이하에 머물면 경고 로그를 남긴다(`warnIfGateStuck`).
 */
async function runBatch(units: AvailabilityQuery[], ctx: AdapterContext): Promise<Results> {
  const results: Results = new Map();
  const tables = new Map<string, Table>();
  const tls = tlsStreakRound(ctx.http);
  const now = ctx.clock.now();
  const today = kstDate(now);
  const nextMonth = nextMonthOf(today);
  let gate: LotteryGate | UnitStructureError | undefined;
  const gateOf = async (): Promise<LotteryGate> => {
    if (gate === undefined) {
      const res = await send("Pmreservation.do", () => ctx.http.get(PAGE_URL));
      assertOk(res, "Pmreservation.do");
      try {
        gate = parseGate(res.body, now);
        if (gate.firstComeAtMs === undefined) warnDriftOnce(ctx, "gate:resEndDay", "bukgu lottery gate drift", { change: "resEndDay-unreadable" });
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
    // 최대 박수는 1이라 설정이 2박 이상을 거부한다. 아래 여러 박 처리는 최대 박수를 올리면 그대로 쓰인다.
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
        if (dates.some((d) => d.slice(0, 7) === nextMonth)) warnIfGateStuck(g, nextMonth, ctx, now);
        if (!dates.every((d) => openForFirstCome(d, today, g))) {
          results.set(q, []); // 추첨 대상(또는 아직 예약을 받지 않는) 밤이 낀 단위: 표를 조회하지 않는다.
          continue;
        }
      }
      const perNight: Table[] = [];
      for (const date of dates) {
        const key = `${q.facility}|${date}`;
        if (!tables.has(key)) tables.set(key, await readTable(q.facility, date, ctx)); // 직렬: 요청은 HTTP 층이 한 줄로 보낸다.
        perNight.push(tables.get(key)!);
      }
      // 응답이 왔는데 감시하는 구역의 행이 없으면 화면 모양이 바뀐 것이다. 빈자리 없음으로 넘기지 않는다.
      const missing = perNight.find((t) => !t.rows.some((r) => r.zone === q.zone));
      if (missing) {
        const why = missing.unattributed > 0 ? `(구역을 알 수 없는 행 ${missing.unattributed}개)` : "";
        throw new UnitStructureError(`reservationCntAjax.do: 표에 감시하는 구역 ${zoneName(INFO, q.facility, q.zone)}(${q.zone})의 행이 없다${why}`);
      }
      // 여러 박이면 같은 사이트명이 밤마다 예약가능일 때만 빈자리다.
      const open = perNight.map((t) => new Set(t.rows.filter((r) => r.zone === q.zone && r.open).map((r) => r.name)));
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
   * 표의 행은 구역 코드(`priceCode`)를 싣지 않고 색 클래스로만 구역을 가르므로 코드는 비운다(카탈로그의 코드를 되돌려 보이면 대조가 되지 않는다). 구역은 카탈로그의 이름으로 맞춘다.
   * 예약현황 값은 구역·자리 대조에 쓰지 않아 보지 않는다.
   * 표를 읽지 못한 것(표·열·사이트명 없음, 조회 실패)만 실패다. 모르는 색 클래스의 행은 구역 이름 없이 따로 보고해 차이로 친다(실패가 아니다).
   * 카탈로그에는 자리 목록이 없어 자리는 참고로만 보인다.
   */
  async observeFacility(facility, ctx): Promise<FacilityObservation> {
    const { rows, unattributed } = attribute(facility, await fetchTable(facility, addDays(kstDate(ctx.clock.now()), 1), ctx));
    const nameOf = (code: string) => zoneName(INFO, facility, code);
    const zones: FacilityObservation["zones"] = [];
    for (const r of rows) {
      const found = zones.find((z) => z.name === nameOf(r.zone));
      if (found) found.seats.push(r.name);
      else zones.push({ name: nameOf(r.zone), codes: [], seats: [r.name] });
    }
    const unknown: NonNullable<FacilityObservation["unattributed"]> = [];
    for (const u of unattributed) {
      const reason = `색 클래스 ${u.cls}`;
      const found = unknown.find((x) => x.reason === reason);
      if (found) found.seats.push(u.name);
      else unknown.push({ reason, seats: [u.name] });
    }
    return { zones, unattributed: unknown, note: "자리는 참고로만 보인다(카탈로그에 자리 목록이 없어 비교하지 않는다). 대조하는 것은 구역이다." };
  },

  deepLink: () => PAGE_URL,
};
