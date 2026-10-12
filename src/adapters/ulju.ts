import { addDays, kstDate } from "../schedule.js";
import {
  AdapterError,
  type AdapterContext,
  type AvailabilityQuery,
  type AvailableSite,
  type ProviderAdapter,
  type ProviderInfo,
  type TransportResponse,
} from "../types.js";
import { facilities } from "../catalogs/ulju.js";
import { BlockedPathError } from "../http.js";

const ORIGIN = "https://camping.ulju.ulsan.kr";
const DAY_PATH = "/ujcamping/campsite/get_cal_day_data_list";
const BOOKING_URL = `${ORIGIN}/ujcamping/campsite/booking`;

const INFO: ProviderInfo = {
  id: "ulju",
  facilities,
  // 즉시결제는 한 번에 한 밤이다(FAQ "추첨 이외의 연박은 즉시결제로 1박씩 예약"). 추첨은 최대 2박 3일이나 감시하지 않는다.
  maxNights: 1,
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
  // 시설이 넷으로 늘 예약처다. 지금은 하나여도 facility를 골라야 한다.
  facilityRequired: true,
};

const classesOf = (facility: string): string => {
  const ref = facilities.find((f) => f.code === facility)?.ref;
  if (typeof ref !== "string") throw new AdapterError("unrecognized", `ulju 시설 ${facility}에 classes 값이 없다`);
  return ref;
};

/** 로그인 화면·차단 안내·봇 탐지·captcha가 JSON 자리에 온 것을 알아보는 표지. 표지가 없는 JSON 아님은 unrecognized다. */
const LOGIN_OR_BLOCK_PAGE = /memberIntro\/login|접근이 (차단|제한)|비정상적인 접근|botmanager|crawlingCheck|dynapath|captcha/i;

/** 이번 달과 다음 달만 조회시킨다. 다음 달 날짜는 이번 달 11일 10:00 KST부터 선착순이고 그 전은 추첨 기간이다. */
const FCFS_DAY = 11;
const FCFS_TIME = "10:00";

/** now(KST) 기준으로 이 밤을 조회할 수 있는가. */
function isQueryable(date: string, now: Date): boolean {
  const today = kstDate(now);
  const month = (d: string) => d.slice(0, 7);
  if (month(date) === month(today)) return true;
  const next = month(addDays(`${month(today)}-28`, 4)); // 28일에 4일을 더하면 늘 다음 달이다.
  if (month(date) !== next) return false;
  return now.getTime() >= Date.parse(`${month(today)}-${String(FCFS_DAY).padStart(2, "0")}T${FCFS_TIME}:00+09:00`);
}

const failure = (res: TransportResponse): AdapterError | undefined => {
  if (res.status === 403 || res.status === 429) return new AdapterError("blocked", `${DAY_PATH}: HTTP ${res.status}`);
  if (res.status >= 500) return new AdapterError("transient", `${DAY_PATH}: HTTP ${res.status}`);
  if (res.status !== 200) return new AdapterError("unrecognized", `${DAY_PATH}: 예상 밖 HTTP ${res.status}`);
  return undefined;
};

interface Row {
  CAMP_ID: string;
  NAME: string;
  FACILITY_ID: string;
  ISRESERVABLE: "Y" | "N";
}

/** 한 시설의 한 밤을 조회해 행을 돌려준다. booking_ended와 no_list는 빈 목록이다. */
async function fetchNight(classes: string, date: string, ctx: AdapterContext): Promise<Row[]> {
  let res: TransportResponse;
  try {
    res = await ctx.http.post(
      `${ORIGIN}${DAY_PATH}`,
      JSON.stringify({ sql_state: "GetData", select_date: date, classes, facility: "", use_only: "N" }),
      // 페이지(mscommon.js getPostData)와 같은 헤더. X-CSRF-TOKEN은 페이지에 #csrf_token 요소가 없어 빈 값이다.
      { contentType: "application/json", headers: { "X-HTTP-Method-Override": "POST", "X-CSRF-TOKEN": "" } },
    );
  } catch (e) {
    if (e instanceof BlockedPathError) throw new AdapterError("blocked", `${DAY_PATH}: 로그인·접근 금지 경로로 보내졌다(${e.message})`);
    throw e;
  }
  const bad = failure(res);
  if (bad) throw bad;
  let body: unknown;
  try {
    body = JSON.parse(res.body);
  } catch {
    if (LOGIN_OR_BLOCK_PAGE.test(res.body)) throw new AdapterError("blocked", `${DAY_PATH}: JSON이 아니라 로그인·차단 화면이 왔다`);
    throw new AdapterError("unrecognized", `${DAY_PATH}: JSON이 아니다`);
  }
  const { result, list } = (body ?? {}) as { result?: unknown; list?: unknown };
  if (result === "booking_ended" || result === "no_list") return [];
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

const nightsOf = (q: AvailabilityQuery) => Array.from({ length: q.nights }, (_, i) => addDays(q.checkIn, i));

/** 이번 바퀴에서 이어 갈 수 있는 오류는 돌려주고, 차단이나 예상 밖 오류는 그대로 던져 전체를 멈춘다. */
function recoverable(e: unknown): AdapterError {
  if (!(e instanceof AdapterError) || e.kind === "blocked") throw e;
  return e;
}

async function queryBatch(units: AvailabilityQuery[], ctx: AdapterContext) {
  const results = new Map<AvailabilityQuery, AvailableSite[] | AdapterError>();
  const now = ctx.clock.now();
  // (시설, 밤)마다 한 번만 조회한다. 응답이 그 시설의 모든 구역·자리를 주므로 구역마다 따로 부르지 않는다.
  const nights = new Map<string, Promise<Row[] | AdapterError>>();
  const night = (facility: string, date: string) => {
    const key = `${facility}|${date}`;
    let found = nights.get(key);
    if (!found) {
      found = fetchNight(classesOf(facility), date, ctx).catch((e: unknown) => recoverable(e));
      nights.set(key, found);
    }
    return found;
  };
  for (const q of units) {
    const dates = nightsOf(q);
    if (!dates.every((d) => isQueryable(d, now))) {
      results.set(q, []);
      continue;
    }
    const perNight: Row[][] = [];
    let failed: AdapterError | undefined;
    for (const d of dates) {
      const rows = await night(q.facility, d); // 직렬: 요청은 HTTP 층이 한 줄로 보낸다.
      if (rows instanceof AdapterError) {
        failed = rows;
        break;
      }
      perNight.push(rows);
    }
    if (failed) {
      results.set(q, failed);
      continue;
    }
    // 여러 박이면 같은 CAMP_ID가 밤마다 Y일 때만 빈자리다.
    const open = perNight.map((rows) => new Map(rows.filter((r) => r.FACILITY_ID === q.zone && r.ISRESERVABLE === "Y").map((r) => [r.CAMP_ID, r.NAME])));
    const sites: AvailableSite[] = [];
    for (const [id, name] of open[0] ?? []) {
      if (open.every((m) => m.has(id))) sites.push({ id: name, name });
    }
    results.set(q, sites);
  }
  return results;
}

export const uljuAdapter: ProviderAdapter = {
  id: "ulju",

  describe: () => INFO,

  async queryAvailability(q: AvailabilityQuery, ctx: AdapterContext): Promise<AvailableSite[]> {
    const found = (await queryBatch([q], ctx)).get(q);
    if (found instanceof AdapterError) throw found;
    return found ?? [];
  },

  /** 같은 (시설, 밤)은 구역이 여럿이어도 한 번만 조회한다. */
  queryAvailabilityBatch: queryBatch,

  deepLink: () => BOOKING_URL,
};
