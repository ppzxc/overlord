import { addDays, kstDate, nextMonthOf, nightsOf } from "../schedule.js";
import {
  AdapterError,
  type AdapterContext,
  type AvailabilityQuery,
  type AvailableSite,
  type FacilityObservation,
  type ProviderAdapter,
  type ProviderInfo,
} from "../types.js";
import { facilities } from "../catalogs/ulju.js";
import { stringRef } from "../facility.js";
import { assertOk, queryOneViaBatch, send, warnDriftOnce } from "../adapter-signals.js";

const ORIGIN = "https://camping.ulju.ulsan.kr";
const DAY_PATH = "/ujcamping/campsite/get_cal_day_data_list";
const BOOKING_URL = `${ORIGIN}/ujcamping/campsite/booking`;

const INFO: ProviderInfo = {
  id: "ulju",
  facilities,
  // 서버에는 최대 박수가 없다. 즉시결제는 한 번에 한 밤이라 연박은 같은 자리를 밤마다 따로 예약한다(FAQ). 상한 2는 우리가 정한 정책이다(카탈로그 머리 주석).
  maxNights: 2,
  // 서버가 현재 달과 다음 달만 조회시키므로 입실일 D는 많아야 약 61일 앞에서 열린다. 다음 달 날짜가 그 달 11일 10:00에 열리는 것은 날짜로 정해져 이 규칙으로 쓸 수 없어 어댑터가 가린다.
  // 당일 입실은 서버가 17시에 마감한다(booking_ended).
  openingRule: { openDaysBefore: 61, openTime: "00:00", sameDayCutoff: "17:00" },
  // 오픈 경쟁 시간은 두지 않는다. 대기열이 없고, 이 도구의 쓸모는 오전 10시·오후 2시 취소분 반영을 잡는 것이다.
  defaultPollIntervalSeconds: 150,
  // 접근 금지: 예약 다음 단계(booking_step1과 뒤), 추첨 신청·당첨자 확인, 로그인·회원, 마이페이지(예약확인·결제·취소), 숲공작 체험 예약.
  blockedPaths: [
    "/ujcamping/campsite/booking_",
    "/ujcamping/campsite/ulju_resident_apply",
    "/ujcamping/campsite/general_apply",
    "/ujcamping/campsite/winnerList",
    "/ujcamping/memberIntro/",
    "/ujcamping/mypage",
    "/ujcamping/camp_exp/",
  ],
  // 쿠키 없이 응답한다(기록).
  cookieSession: false,
  // 시설이 넷이고 FACILITY_ID가 시설 사이에 공유되므로 facility를 꼭 골라야 한다.
  facilityRequired: true,
};

const classesOf = (facility: string): string => stringRef(INFO, facility, "classes 값");

/**
 * 로그인 폼·차단 안내·봇 탐지·captcha 경로가 JSON 자리에 온 것을 알아보는 구체 표지(로그인 폼 action·비밀번호 입력, 차단 안내 문구, 봇 탐지 장치 이름, captcha 경로).
 * 메뉴의 로그인 링크(memberIntro/login)와 맨 낱말 captcha는 기록한 모든 화면에 있어 표지가 아니다. 표지가 없는 JSON 아님은 unrecognized다.
 * 로그인 경로로 가는 리다이렉트는 blockedPaths와 공통 리다이렉트 판정이 잡는다.
 */
const LOGIN_OR_BLOCK_PAGE = /<form[^>]*action=["'][^"']*memberIntro\/login|type=["']?password|접근이 (차단|제한)|비정상적인 접근|botmanager|crawlingCheck|dynapath|\/captcha/i;

/** 이번 달과 다음 달만 조회시킨다. 다음 달 날짜는 이번 달 11일 10:00 KST부터 선착순이고 그 전은 추첨 기간이다. */
const FCFS_DAY = 11;
const FCFS_TIME = "10:00";

/** now(KST) 기준으로 이 밤을 조회할 수 있는가. */
function isQueryable(date: string, now: Date): boolean {
  const today = kstDate(now);
  const month = (d: string) => d.slice(0, 7);
  if (month(date) === month(today)) return true;
  if (month(date) !== nextMonthOf(today)) return false;
  return now.getTime() >= Date.parse(`${month(today)}-${String(FCFS_DAY).padStart(2, "0")}T${FCFS_TIME}:00+09:00`);
}

interface Row {
  CAMP_ID: string;
  NAME: string;
  FACILITY_ID: string;
  FACILITY_NAME?: unknown;
  ISRESERVABLE: "Y" | "N";
}

/** 한 시설의 한 밤을 조회해 행을 돌려준다. booking_ended와 no_list는 행이 없다는 뜻의 null이다. */
async function fetchNight(classes: string, date: string, ctx: AdapterContext): Promise<Row[] | null> {
  // 연결 실패·시간 초과는 일시 오류라 다음 바퀴에 다시 시도한다.
  const res = await send(DAY_PATH, () =>
    ctx.http.post(
      `${ORIGIN}${DAY_PATH}`,
      JSON.stringify({ sql_state: "GetData", select_date: date, classes, facility: "", use_only: "N" }),
      // 페이지(mscommon.js getPostData)와 같은 헤더. X-CSRF-TOKEN은 페이지에 #csrf_token 요소가 없어 빈 값이다.
      { contentType: "application/json", headers: { "X-HTTP-Method-Override": "POST", "X-CSRF-TOKEN": "" } },
    ),
  );
  assertOk(res, DAY_PATH);
  let body: unknown;
  try {
    body = JSON.parse(res.body);
  } catch {
    if (LOGIN_OR_BLOCK_PAGE.test(res.body)) throw new AdapterError("blocked", `${DAY_PATH}: JSON이 아니라 로그인·차단 화면이 왔다`);
    throw new AdapterError("unrecognized", `${DAY_PATH}: JSON이 아니다`);
  }
  const { result, list } = (body ?? {}) as { result?: unknown; list?: unknown };
  if (result === "booking_ended" || result === "no_list") return null;
  if (result !== "ok") throw new AdapterError("unrecognized", `${DAY_PATH}: 모르는 result ${JSON.stringify(result)}`);
  if (!Array.isArray(list)) throw new AdapterError("unrecognized", `${DAY_PATH}: list가 없다`);
  for (const r of list as Partial<Record<keyof Row, unknown>>[]) {
    if (typeof r?.CAMP_ID !== "string" || typeof r.NAME !== "string" || typeof r.FACILITY_ID !== "string") {
      throw new AdapterError("unrecognized", `${DAY_PATH}: list 행에 CAMP_ID·NAME·FACILITY_ID가 없다`);
    }
    if (r.ISRESERVABLE !== "Y" && r.ISRESERVABLE !== "N") {
      throw new AdapterError("unrecognized", `${DAY_PATH}: ISRESERVABLE이 Y/N이 아니다(${JSON.stringify(r.ISRESERVABLE)})`);
    }
  }
  return list as Row[];
}

/**
 * 카탈로그와 다른 구역(응답에만 있거나 응답에서 빠진 구역)과, 자리 목록이 있는 구역의 자리 차이는 경고만 남긴다.
 * 감시 조건이 쓰는 구역이 빠진 것은 조회 단위 판정이 실패로 처리한다. 자리는 실패로 치지 않는다.
 * 자리 목록이 없는 시설·구역은 자리를 비교하지 않고, 응답에서 통째로 빠진 구역은 구역 경고 하나로 갈음한다.
 */
function warnDrift(facility: string, rows: Row[], ctx: AdapterContext): void {
  const zones = facilities.find((f) => f.code === facility)?.zones ?? [];
  const known = new Set(zones.map((z) => z.code));
  const seen = new Set(rows.map((r) => r.FACILITY_ID));
  const once = (msg: string, fields: { change: string; zone: string; seat?: string }) =>
    warnDriftOnce(ctx, `${msg}:${facility}:${fields.change}:${fields.zone}:${fields.seat ?? ""}`, msg, { facility, ...fields });
  for (const z of seen) if (!known.has(z)) once("ulju zone drift", { change: "new", zone: z });
  for (const z of known) if (!seen.has(z)) once("ulju zone drift", { change: "gone", zone: z });
  for (const zone of zones) {
    if (!zone.seats || !seen.has(zone.code)) continue;
    const listed = new Set(zone.seats);
    const actual = new Set(rows.filter((r) => r.FACILITY_ID === zone.code).map((r) => r.NAME));
    for (const seat of actual) if (!listed.has(seat)) once("ulju seat drift", { change: "new", zone: zone.code, seat });
    for (const seat of listed) if (!actual.has(seat)) once("ulju seat drift", { change: "gone", zone: zone.code, seat });
  }
}


/**
 * 조회 단위마다 밤을 조회해 빈자리를 가린다. 바퀴 안에서 첫 실패가 나면 남은 요청은 보내지 않고,
 * 이미 받은 밤으로 끝낼 수 있는 단위의 결과는 그대로 돌려준다. 나머지 단위는 그 실패를 값으로 받는다.
 */
async function queryBatch(units: AvailabilityQuery[], ctx: AdapterContext) {
  const results = new Map<AvailabilityQuery, AvailableSite[] | AdapterError>();
  const now = ctx.clock.now();
  // (시설, 밤)마다 한 번만 조회한다. 응답이 그 시설의 모든 구역·자리를 주므로 구역마다 따로 부르지 않는다.
  const nights = new Map<string, Row[] | null>();
  let stopped: AdapterError | undefined;
  const night = async (facility: string, date: string) => {
    const key = `${facility}|${date}`;
    if (nights.has(key)) return nights.get(key)!;
    if (stopped) throw stopped;
    const rows = await fetchNight(classesOf(facility), date, ctx); // 직렬: 요청은 HTTP 층이 한 줄로 보낸다.
    if (rows) warnDrift(facility, rows, ctx);
    nights.set(key, rows);
    return rows;
  };
  for (const q of units) {
    const dates = nightsOf(q);
    if (!dates.every((d) => isQueryable(d, now))) {
      results.set(q, []);
      continue;
    }
    try {
      const perNight: (Row[] | null)[] = [];
      for (const d of dates) perNight.push(await night(q.facility, d));
      // 응답이 왔는데 감시하는 구역이 없으면 화면 모양이 바뀐 것이다. 빈자리 없음으로 넘기지 않는다.
      for (const rows of perNight) {
        if (rows && !rows.some((r) => r.FACILITY_ID === q.zone)) throw new AdapterError("unrecognized", `${DAY_PATH}: 응답에 감시하는 구역 ${q.zone}이 없다`);
      }
      // 여러 박이면 같은 CAMP_ID가 밤마다 Y일 때만 빈자리다.
      const open = perNight.map((rows) => new Map((rows ?? []).filter((r) => r.FACILITY_ID === q.zone && r.ISRESERVABLE === "Y").map((r) => [r.CAMP_ID, r.NAME])));
      const sites: AvailableSite[] = [];
      for (const [id, name] of open[0] ?? []) {
        if (open.every((m) => m.has(id))) sites.push({ id: name, name });
      }
      results.set(q, sites);
    } catch (e) {
      if (!(e instanceof AdapterError)) throw e;
      stopped ??= e;
      results.set(q, e);
    }
  }
  return results;
}

export const uljuAdapter: ProviderAdapter = {
  id: "ulju",

  describe: () => INFO,

  queryAvailability: (q, ctx) => queryOneViaBatch("ulju", queryBatch, q, ctx),

  /** 밤마다 서버의 조회 창(이번 달, 다음 달은 11일 10:00부터)에 드는 단위만 조회한다. 아닌 단위는 코어가 빼서 요청 없는 바퀴를 성공으로 세지 않는다. */
  isQueryable: (q, now) => nightsOf(q).every((d) => isQueryable(d, now)),

  /** 같은 (시설, 밤)은 구역이 여럿이어도 한 번만 조회한다. */
  queryAvailabilityBatch: queryBatch,

  /**
   * `catalog --live`: 내일(KST) 밤을 시설에 한 번 조회해 구역과 자리를 읽는다. 바퀴와 같은 요청 원칙(한 줄, 5초+지터)이다.
   * 내일이 booking_ended나 no_list면 그 다음 날로 한 번 더 시도하고, 그래도 없으면 비교할 날짜가 없다고 알린다(실패가 아니다).
   * 내일은 늘 이번 달이거나 달의 마지막 날의 다음 달 1일이라 날짜 창 규칙(isQueryable)에 걸리지 않는다.
   */
  async observeFacility(facility: string, ctx: AdapterContext): Promise<FacilityObservation> {
    const classes = classesOf(facility);
    const tomorrow = addDays(kstDate(ctx.clock.now()), 1);
    const tried: string[] = [];
    for (const date of [tomorrow, addDays(tomorrow, 1)]) {
      tried.push(date);
      const rows = await fetchNight(classes, date, ctx);
      if (!rows) continue;
      // 구역 이름은 끝에 공백이 붙는 때가 있어(`카라반(일반) `) 다듬는다. 구역·자리는 응답에 나온 순서대로 모은다.
      const zones = new Map<string, FacilityObservation["zones"][number]>();
      for (const r of rows) {
        if (typeof r.FACILITY_NAME !== "string") throw new AdapterError("unrecognized", `${DAY_PATH}: list 행에 FACILITY_NAME이 없다`);
        const name = r.FACILITY_NAME.trim();
        const zone = zones.get(r.FACILITY_ID) ?? { name, codes: [r.FACILITY_ID], seats: [] };
        zones.set(r.FACILITY_ID, zone);
        zone.seats.push(r.NAME);
      }
      return { zones: [...zones.values()] };
    }
    return { zones: [], nothingToCompare: `대조할 날짜가 없다(${tried.join(", ")} 모두 조회할 수 없다고 응답했다)` };
  },

  deepLink: () => BOOKING_URL,
};
