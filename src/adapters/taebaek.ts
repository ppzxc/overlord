import * as cheerio from "cheerio";
import { AdapterError, type AdapterContext, type AvailabilityQuery, type AvailableSite, type ProviderAdapter, type ProviderInfo } from "../types.js";
import { facilities } from "../catalogs/taebaek.js";
import { fieldsRef, zoneName } from "../facility.js";
import { BOT_DETECTION, UnitStructureError, assertOk, send } from "../adapter-signals.js";
import { kstDate, nextMonthOf, nightsOf } from "../schedule.js";
import { tlsStreakRound } from "../tls-streak.js";

/**
 * 태백시시설관리공단 예약처(고원힐링캠핑장). 달력은 서버가 그린 HTML이다. 접근 원칙의 예외(robots.txt 금지)는 ADR 0003이 정한다.
 * - 이번 달 기본 탭(자동차야영장, `man=2`)은 `GET /reservation.asp?location=002&wloc=<wloc>`, 다른 달·다른 구역은 달력 조회 POST(`wh_year, wh_month, man, wloc`)다. 구역과 달마다 한 번씩 읽는다.
 * - 날짜 칸은 `예약가능`, `예약종료`, `예약완료`뿐이다. 남은 수와 자리 번호가 없어, 알림은 `remaining` 없이 "예약가능"만 싣는다.
 * - 여러 박은 입실일부터 연속한 N일의 칸이 모두 `예약가능`일 때만 빈자리다(같은 자리가 이어진다는 보장은 없다).
 * - 쿠키 없이 응답한다(2026-10-14 기록). 서버가 ASP 세션 쿠키를 줘도 받아 두지 않는다.
 */
const ORIGIN = "https://tfmc.huyang.co.kr:452";
const CALENDAR_PATH = "/reservation.asp?location=002";

const INFO: ProviderInfo = {
  id: "taebaek",
  facilities,
  // 화면의 1~4박 라디오에 맞춘 값이다. 서버가 실제로 받는 최대 박수는 보지 못했다(미확인).
  maxNights: 4,
  maxNightsUnconfirmed: true,
  // 오픈은 "이용 월 전월 1일 오전 10시"다. 일 단위 규칙(`openDaysBefore`)으로 쓸 수 없어 `isQueryable`이 달 단위로 가른다.
  // 62일은 이달 1일에 열리는 다음 달 말일까지를 덮는 느슨한 걸러내기이고 개시 시각이 아니다. 당일 입실은 화면이 종일 예약종료로 보여 주지만 요청 없이 건너뛰지는 않는다(23:59).
  openingRule: { openDaysBefore: 62, openTime: "00:00", sameDayCutoff: "23:59" },
  // 취소분이 중심이라 지연을 감수한다. 다른 예약처(60초)보다 느린 하한은 ADR 0003의 조건이다.
  openingRush: { from: "09:55", to: "10:30", dayOfMonth: 1 },
  defaultPollIntervalSeconds: 600,
  minPollIntervalSeconds: 300,
  // 예약 제출·자리 목록(`location=002_01`), 예약확인·취소·결제(`location=003`), 로그인·회원 경로. 달력(`location=002`)과 안내(`location=001`)는 막지 않는다.
  blockedPaths: ["/reservation.asp?location=002_01", "/reservation.asp?location=003", "/login", "/member", "/join", "/mypage"],
  cookieSession: false,
  facilityRequired: true,
};

const wlocOf = (facility: string): string => fieldsRef(INFO, facility, ["wloc"]).wloc;
const deepLinkOf = (facility: string): string => `${ORIGIN}${CALENDAR_PATH}&wloc=${wlocOf(facility)}`;

const OPEN = "예약가능";
const KNOWN_STATUS = new Set([OPEN, "예약종료", "예약완료"]);

/** 대기열 표지. 나타나면 ADR 0001·0002에 따라 차단으로 본다. */
const QUEUE = /netfunnel|대기\s*순번|대기\s*인원|접속\s*대기/i;
const LOGIN = /로그인|login/i;

/** 달력 한 장: 날짜(일) -> 예약가능 여부. */
type Month = Map<number, boolean>;

function parseCalendar(html: string, month: string, zone: string, tab: string): Month {
  const where = "reservation.asp(달력)";
  if (BOT_DETECTION.test(html)) throw new AdapterError("blocked", `${where}: 봇 탐지·captcha 표지가 왔다`);
  if (QUEUE.test(html)) throw new AdapterError("blocked", `${where}: 대기열 표지가 왔다`);
  const $ = cheerio.load(html);
  const table = $("table.calendar_list_table");
  if (table.length === 0) {
    if (LOGIN.test(html)) throw new AdapterError("blocked", `${where}: 달력 대신 로그인 요구가 왔다`);
    throw new AdapterError("unrecognized", `${where}: 달력(table.calendar_list_table)이 없다`);
  }
  const [year, mm] = month.split("-").map(Number) as [number, number];
  const heading = $("li.month").first().text().trim();
  if (heading !== `${year}년 ${mm}월`) throw new AdapterError("unrecognized", `${where}: 달력의 달이 ${month}가 아니다(${JSON.stringify(heading)})`);
  // 켜진 탭 버튼(`.btn-box button.on`)이 요청한 구역의 이름이어야 한다. 서버가 요청한 구역(탭)과 다른 달력을 주면 구조 변경이다.
  const shown = $(".btn-box button.on").first().text().trim();
  if (shown !== tab) throw new AdapterError("unrecognized", `${where}: 요청한 구역(${tab}, man=${zone})이 아닌 달력이다(켜진 탭 ${JSON.stringify(shown)})`);
  const days: Month = new Map();
  table.find("td").each((_, td) => {
    const day = $(td).children("span.day").first();
    if (day.length === 0) return; // 달 앞뒤의 빈 칸(`&nbsp;`)
    const status = $(td).find("span.commit_end, span.commit, span.possible").first().text().trim();
    const n = Number(day.text().trim());
    if (!Number.isInteger(n) || !KNOWN_STATUS.has(status)) throw new AdapterError("unrecognized", `${where}: 날짜 칸을 읽을 수 없다(${JSON.stringify(day.text().trim())}, ${JSON.stringify(status)})`);
    days.set(n, status === OPEN);
  });
  if (days.size === 0) throw new AdapterError("unrecognized", `${where}: 날짜 칸이 없다`);
  return days;
}

/** 이 달의 달력을 지금 조회할 수 있는가. 이번 달과, 이번 달 1일 오전 10시 이후의 다음 달이다. */
function monthOpen(month: string, now: Date): boolean {
  const today = kstDate(now);
  const current = today.slice(0, 7);
  if (month <= current) return true;
  return month === nextMonthOf(today) && now.getTime() >= Date.parse(`${current}-01T10:00:00+09:00`);
}

const monthsOf = (q: AvailabilityQuery): string[] => [...new Set(nightsOf(q).map((d) => d.slice(0, 7)))];

async function fetchMonth(facility: string, zone: string, month: string, today: string, ctx: AdapterContext): Promise<Month> {
  const wloc = wlocOf(facility);
  const where = "reservation.asp(달력)";
  const [year, mm] = month.split("-").map(Number) as [number, number];
  const res = await send(where, () =>
    zone === "2" && month === today.slice(0, 7)
      ? ctx.http.get(`${ORIGIN}${CALENDAR_PATH}&wloc=${wloc}`)
      : ctx.http.post(
          `${ORIGIN}${CALENDAR_PATH}`,
          { wh_year: String(year), wh_month: String(mm), man: zone, wloc },
          { headers: { Referer: `${ORIGIN}${CALENDAR_PATH}&wloc=${wloc}`, Origin: ORIGIN } },
        ),
  );
  assertOk(res, where);
  return parseCalendar(res.body, month, zone, zoneName(INFO, facility, zone));
}

async function runBatch(units: AvailabilityQuery[], ctx: AdapterContext): Promise<Map<AvailabilityQuery, AvailableSite[] | AdapterError>> {
  const results = new Map<AvailabilityQuery, AvailableSite[] | AdapterError>();
  const months = new Map<string, Month>();
  const tls = tlsStreakRound(ctx.http);
  const now = ctx.clock.now();
  const today = kstDate(now);
  let stopped: AdapterError | undefined;
  for (const q of units) {
    if (stopped) {
      results.set(q, stopped);
      continue;
    }
    try {
      // 열리지 않은 달이 낀 단위는 요청 없이 빈자리 없음이다.
      if (!monthsOf(q).every((m) => monthOpen(m, now))) {
        results.set(q, []);
        continue;
      }
      let allOpen = true;
      for (const date of nightsOf(q)) {
        const month = date.slice(0, 7);
        const key = `${q.facility}|${q.zone}|${month}`;
        if (!months.has(key)) months.set(key, await fetchMonth(q.facility, q.zone, month, today, ctx)); // 직렬: 요청은 HTTP 층이 한 줄로 보낸다.
        const open = months.get(key)!.get(Number(date.slice(8)));
        if (open === undefined) throw new UnitStructureError(`reservation.asp(달력): ${date} 날짜 칸이 없다`);
        if (!open) allOpen = false;
      }
      results.set(q, allOpen ? [{ id: OPEN, name: OPEN }] : []);
    } catch (e) {
      if (e instanceof UnitStructureError) {
        results.set(q, e);
        continue;
      }
      // TLS 검증 실패는 일시 오류지만 두 바퀴 연속이면 구조 변경으로 친다(인증서가 바뀌었을 수 있다).
      const failure = tls.classify(e) ?? e;
      if (!(failure instanceof AdapterError)) throw failure;
      stopped = failure;
      results.set(q, failure);
    }
  }
  tls.finish();
  return results;
}

export const taebaekAdapter: ProviderAdapter = {
  id: "taebaek",
  describe: () => INFO,
  queryAvailabilityBatch: runBatch,
  /**
   * 예약 화면(이번 달 기본 탭) 한 장을 읽어 탭 버튼의 이름 집합을 돌려준다. 달력 칸은 읽지 않는다. 탭은 켜진 탭과 다른 탭의 폼 버튼으로 나뉘어 있다.
   */
  async listZones(q, ctx) {
    const where = "reservation.asp(예약 화면)";
    const res = await send(where, () => ctx.http.get(deepLinkOf(q.facility)));
    assertOk(res, where);
    if (BOT_DETECTION.test(res.body)) throw new AdapterError("blocked", `${where}: 봇 탐지·captcha 표지가 왔다`);
    if (QUEUE.test(res.body)) throw new AdapterError("blocked", `${where}: 대기열 표지가 왔다`);
    const $ = cheerio.load(res.body);
    const tabs = $(".btn-box button").map((_, b) => $(b).text().trim()).get().filter((t) => t !== "");
    if (tabs.length === 0) {
      if (LOGIN.test(res.body) && $("table.calendar_list_table").length === 0) throw new AdapterError("blocked", `${where}: 예약 화면 대신 로그인 요구가 왔다`);
      throw new AdapterError("unrecognized", `${where}: 탭(.btn-box button)이 없다`);
    }
    return { zones: [...new Set(tabs)], unknown: [] };
  },
  isQueryable: (q, now) => monthsOf(q).every((m) => monthOpen(m, now)),
  deepLink: (q) => deepLinkOf(q.facility),
};

