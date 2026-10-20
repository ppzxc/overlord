import * as cheerio from "cheerio";
import { AdapterError, UnitSkipped, type AdapterContext, type AvailabilityQuery, type AvailableSite, type HttpClient, type OpeningRush, type ProviderAdapter, type ProviderInfo, type TransportResponse } from "../types.js";
import { facilities } from "../catalogs/foresttrip.js";
import { fieldsRef } from "../facility.js";
import { BOT_DETECTION, ConnectionFailure, assertOk, send } from "../adapter-signals.js";
import { completeQueue, enterQueue, setNetFunnelCookie, type NetFunnelQueue } from "../netfunnel.js";
import { kstDate, nightsOf } from "../schedule.js";

/**
 * 숲나들e 예약처. 로그인 조회만 예외로 허용한다(ADR 0004). 봇 판별(`crawlingCheck.do`)은 우회하지 않고 거부되면 멈춘다. 이 파일은 워킹 스켈레톤(#143)이다.
 * 흐름(research/forest-login-probe.md): 로그인 화면(`_csrf`) → `crawlingCheck.do`(`param=noData`) → 로그인 POST(302면 성공, 변경 화면은 따라가지 않는다)
 * → 월별 현황 화면(NetFunnel `action3`, 화면의 `_csrf`가 AJAX의 `X-CSRF-TOKEN`) → 시설 정책 → 상품 목록(NetFunnel `action8`) → 잔여(상품 5개씩).
 * 빈자리는 상태가 `Y`이고 `rsrvtCnt`가 0인 칸이다. 지난 날짜·기간 밖·마감·대기·공사·휴무·추첨·우선예약과 모르는 상태는 빈자리가 아니다.
 * 연박은 같은 자리(`goodsId`)가 입실일부터 N일 연속 빈자리일 때만 빈자리다. 월별(`MON`) 시설은 달별(`inqurSctin=01`, `srchDate`=YYYYMM) 응답을 이어 붙여 달 경계를 넘는 연박도 판정한다.
 * 시설의 최대 연박은 잔여 응답의 `mxmmStngDayCnt`이고, 조건의 박 수가 넘으면 그 조건은 더 조회하지 않고 조건·시설마다 한 번 로그로 알린다(`ctx.log`; 알림 채널이 따로 없다).
 * 구역의 모든 상품만 읽는다. 상품 목록은 24시간 캐시하고 한 시설의 한 바퀴 잔여 호출이 20번을 넘으면 조회하지 않고 알린다(`UnitSkipped`). 자리 이름 필터, 재로그인(`-5`), 로그인 실패 파일 기록, 시설별 오픈 경쟁 시간, `catalog --live`는 후속 티켓이다.
 * 잔여 응답의 목록 키(`rsrvtAvailInfoList`)와 `goodsIdList` 형식(배열)은 스파이크 문서가 적지 않아 가정한 값이다. 모양이 다르면 `unrecognized`로 멈춘다.
 */
const ORIGIN = "https://www.foresttrip.go.kr";
const HMPG = "hmpgId=FRIP";
const SCREEN_PATH = `/rep/or/sssn/monthRsrvtStatus.do?${HMPG}&menuId=001004`;
const QUEUE_BASE = { tsUrl: "https://nf.foresttrip.go.kr/ts.wseq", sid: "service_1" } as const;
const SCREEN_QUEUE: NetFunnelQueue = { ...QUEUE_BASE, aid: "action3" };
const GOODS_QUEUE: NetFunnelQueue = { ...QUEUE_BASE, aid: "action8" };
const JSON_TYPE = "application/json; charset=UTF-8";
/** 서버가 잔여 호출 한 번에 돌려주는 상품 수 상한. */
const GOODS_PER_CALL = 5;
/** 한 시설이 한 바퀴에 보낼 수 있는 잔여 호출 수 상한(상품 100개). 넘으면 조회하지 않고 알린다(Decision-9). */
const MAX_CALLS_PER_FACILITY = 20;
/** 상품 목록 캐시 수명. 시작 때 한 번 받고, 이 시간이 지나거나 잔여 응답이 목록과 어긋나면 다시 받는다. */
const GOODS_TTL_MS = 24 * 60 * 60 * 1000;

const USERNAME = "FORESTTRIP_USERNAME";
const PASSWORD = "FORESTTRIP_PASSWORD";

const INFO: ProviderInfo = {
  id: "foresttrip",
  facilities,
  // 시설별 최대 연박은 잔여 응답(`mxmmStngDayCnt`)이 정한다(유명산 3). 설정 검증의 상한은 느슨하게 두고, 넘는 조건은 조회 때 걸러 알린다.
  maxNights: 10,
  maxNightsUnconfirmed: true,
  // 예약 가능 마지막 날은 응답(`weekLastDay`)이 정한다. 조회 창은 느슨하게 두고 그 밖의 날짜는 빈자리 없음으로 둔다.
  openingRule: { openDaysBefore: 60, openTime: "00:00", sameDayCutoff: "23:59" },
  // 오픈 경쟁 시간은 시설마다 다르다. 정적 기본값(`openingRush`) 대신 `facilityOpeningRush`가 시설 정책의 개시 시각(`rsrvtBgnTm`)으로 구한다.
  defaultPollIntervalSeconds: 600,
  minPollIntervalSeconds: 300,
  // `/pot/mc/`는 회원정보(비밀번호 변경 화면 `/pot/mc/pu/updatePssrdChngExpiredView.do` 포함), `/com/alert.do`는 그 화면으로 보내는 안내라 따라가지 않는다.
  // 예약·결제·취소 경로는 스파이크가 기록하지 않았다. 아래 세 접두어는 추정이며 실제 경로를 확인하면 바로잡는다. 조회 경로(`/rep/or/sssn/`, `/rep/or/select…`)와 로그인(`/com/login`, `/com/crawlingCheck.do`)은 막지 않는다.
  blockedPaths: ["/pot/mc/", "/com/alert.do", "/rep/or/rsrvt", "/rep/or/pay", "/rep/or/cncl"],
  cookieSession: true,
  facilityRequired: true,
  // `seats`는 화면에 보이는 상품 이름(`야영데크(101)`, `고라니`) 정확 일치다. 이름이 겹치는 상품은 모두 남는다.
  seatMatch: "name",
  secrets: [USERNAME, PASSWORD],
};

const insttIdOf = (facility: string): string => fieldsRef(INFO, facility, ["insttId"]).insttId;
/** 구역 코드(`02002`)의 상위 구분(`02`). */
const upperOf = (zone: string): string => zone.slice(0, 2);
const deepLinkOf = (q: Pick<AvailabilityQuery, "facility" | "zone">): string =>
  `${ORIGIN}${SCREEN_PATH}&upperGoodsClsscCd=${upperOf(q.zone)}&insttId=${insttIdOf(q.facility)}`;

/** 로그인한 세션. `csrf`는 월별 현황 화면에서 받은 AJAX용 토큰이다. 세션 사이로 옮기지 않으려고 HttpClient에 묶는다. */
interface Session {
  csrf: string;
}
const sessions = new WeakMap<HttpClient, Session>();
/** 구역(`시설|구역 코드`)별로 가장 최근에 받은 상품 이름. 코어가 `seats:` 이름이 실제로 있는지 확인하는 데 쓴다. */
const seatNamesOf = new WeakMap<HttpClient, Map<string, string[]>>();
const zoneKey = (facility: string, zone: string) => `${facility}|${zone}`;
function rememberSeatNames(http: HttpClient, facility: string, zone: string, goods: Goods[]): void {
  const known = seatNamesOf.get(http) ?? new Map<string, string[]>();
  seatNamesOf.set(http, known);
  known.set(zoneKey(facility, zone), goods.map((g) => g.name));
}
/** 최대 연박 초과를 이미 알린 조건(시설|구역|박 수). 같은 연결(프로세스)에서 한 번만 알린다. */
const tooLongNotified = new WeakMap<HttpClient, Set<string>>();

const unrecognized = (message: string) => new AdapterError("unrecognized", message);

/** 화면에서 `_csrf` 값을 읽는다(숨은 입력 또는 메타). */
function csrfOf(html: string, where: string): string {
  const $ = cheerio.load(html);
  const value = $("input[name='_csrf']").first().attr("value") ?? $("meta[name='_csrf']").first().attr("content");
  if (!value) throw unrecognized(`${where}: _csrf를 찾지 못했다`);
  return value;
}

/** 본문의 `loginErrorCode = "-5"` 같은 값. 숫자만 읽어 돌려주므로 본문 원문이 메시지에 들어가지 않는다. */
const loginErrorCodeOf = (body: string): string | undefined => /loginErrorCode\s*[=:]\s*["']?(-?\d+)/.exec(body)?.[1];

const credentials = (ctx: AdapterContext): { id: string; pw: string } => {
  const id = ctx.secrets?.[USERNAME];
  const pw = ctx.secrets?.[PASSWORD];
  if (!id || !pw) throw unrecognized(`foresttrip: 계정 값(${USERNAME}, ${PASSWORD})이 없다`);
  return { id, pw };
};

/** 조회 응답을 판정한다. 401 `-5`(세션 끊김), 403·429, 5xx를 가르고 사유를 문구로 남긴다. 본문은 메시지에 싣지 않는다. */
function assertData(res: TransportResponse, where: string): void {
  if (res.status === 401 && loginErrorCodeOf(res.body) === "-5") throw new AdapterError("blocked", `${where}: 세션이 끊겼다(loginErrorCode -5, HTTP 401). 재로그인은 아직 지원하지 않아 멈춘다`);
  assertOk(res, where);
}

/** JSON 객체 응답을 읽는다. JSON 자리에 봇 탐지 화면(HTML)이 오면 차단, 그 밖의 비JSON은 구조 변경이다. */
function jsonOf(res: TransportResponse, where: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    if (BOT_DETECTION.test(res.body)) throw new AdapterError("blocked", `${where}: JSON 대신 봇 탐지 화면이 왔다`);
    throw unrecognized(`${where}: JSON이 아니다`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw unrecognized(`${where}: JSON 객체가 아니다`);
  return parsed as Record<string, unknown>;
}

const listOf = (obj: Record<string, unknown>, key: string, where: string): Record<string, unknown>[] => {
  const list = obj[key];
  if (!Array.isArray(list) || list.some((r) => typeof r !== "object" || r === null)) throw unrecognized(`${where}: ${key} 목록이 없다`);
  return list as Record<string, unknown>[];
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined);

/** 로그인 화면 → 봇 판별 → 로그인 POST → 월별 현황 화면. 로그인 응답이 302면 성공이고 따라가지 않는다. */
async function login(ctx: AdapterContext, seen: string[]): Promise<Session> {
  const { id, pw } = credentials(ctx);
  const page = await send("로그인 화면", () => ctx.http.get(`${ORIGIN}/com/login.do?targetUrl=/main.do?${HMPG}`));
  assertOk(page, "로그인 화면");
  const loginCsrf = csrfOf(page.body, "로그인 화면");
  seen.push(loginCsrf);

  // 봇 판별은 로그인 화면의 JS가 하는 호출 그대로 한 번만 보낸다. 플러그인 값을 지어내지 않고, 거짓이면 멈춘다.
  const check = await send("crawlingCheck.do", () => ctx.http.post(`${ORIGIN}/com/crawlingCheck.do?_csrf=${encodeURIComponent(loginCsrf)}`, { param: "noData" }));
  assertOk(check, "crawlingCheck.do");
  if (check.body.trim() !== "true") throw new AdapterError("blocked", "crawlingCheck.do가 거부했다(봇 판별 통과 실패)");

  const res = await send("로그인", () =>
    ctx.http.post(
      `${ORIGIN}/com/login`,
      { _csrf: loginCsrf, loginId: id, loginPwd: pw, socialToken: "", passCI: "", simpleCI: "", targetUrl: `/main.do?${HMPG}` },
      { followRedirects: false },
    ),
  ).catch((e: unknown) => {
    // 전송 계층의 오류 문구와 원인에 요청 본문(아이디·비밀번호)이 들어 있을 수 있어 버린다.
    if (e instanceof ConnectionFailure) throw new ConnectionFailure("로그인: 연결 실패");
    throw e;
  });
  if (res.status >= 300 && res.status < 400 && res.location) {
    const to = new URL(res.location, ORIGIN);
    if (/\/login/i.test(to.pathname)) throw new AdapterError("blocked", `로그인: 로그인 화면으로 되돌려 보냈다(HTTP ${res.status})`);
    ctx.log?.(to.pathname === "/com/alert.do" ? "foresttrip login ok: alert.do redirect not followed" : "foresttrip login ok", { user: `${id.slice(0, 2)}***` });
  } else {
    const code = loginErrorCodeOf(res.body);
    if (code !== undefined) throw new AdapterError("blocked", `로그인 실패(loginErrorCode ${code}, HTTP ${res.status}). 재시도하지 않고 멈춘다`);
    assertOk(res, "로그인");
    throw unrecognized(`로그인: 302가 아닌 성공 응답(HTTP ${res.status})`);
  }

  // 월별 현황 화면이 AJAX가 쓰는 `_csrf`를 준다. 화면 이동에는 NetFunnel(action3)이 걸린다.
  const pass = await enterQueue(ctx, SCREEN_QUEUE);
  try {
    setNetFunnelCookie(ctx.http, "www.foresttrip.go.kr", pass.result);
    const screen = await send("월별 현황 화면", () => ctx.http.get(`${ORIGIN}${SCREEN_PATH}`));
    assertData(screen, "월별 현황 화면");
    return { csrf: csrfOf(screen.body, "월별 현황 화면") };
  } finally {
    await completeQueue(ctx, SCREEN_QUEUE, pass.key);
  }
}

async function postJson(ctx: AdapterContext, session: Session, path: string, payload: Record<string, unknown>, where: string): Promise<Record<string, unknown>> {
  const res = await send(where, () =>
    ctx.http.post(`${ORIGIN}${path}`, JSON.stringify(payload), {
      contentType: JSON_TYPE,
      headers: { "X-CSRF-TOKEN": session.csrf, Referer: `${ORIGIN}${SCREEN_PATH}`, Origin: ORIGIN },
    }),
  );
  assertData(res, where);
  return jsonOf(res, where);
}

interface Goods {
  id: string;
  name: string;
}

/** 시설 정책 응답의 `rsrvtPolcy`. 같은 바퀴에 오픈 경쟁 시간 확인과 조회가 두 번 읽지 않도록 잠깐 들고 있는다. */
const POLICY_TTL_MS = 60_000;
const policyCache = new WeakMap<HttpClient, Map<string, { at: number; policy: Record<string, unknown> }>>();

async function rawPolicyOf(ctx: AdapterContext, session: Session, insttId: string): Promise<Record<string, unknown>> {
  const where = "시설 정책";
  const now = ctx.clock.now().getTime();
  const cache = policyCache.get(ctx.http) ?? new Map<string, { at: number; policy: Record<string, unknown> }>();
  policyCache.set(ctx.http, cache);
  const hit = cache.get(insttId);
  if (hit && now - hit.at < POLICY_TTL_MS) return hit.policy;
  const body = await postJson(ctx, session, "/rep/or/selectSthngListForMonthRsrvt.do", { insttId }, where);
  const policy = body.rsrvtPolcy;
  if (typeof policy !== "object" || policy === null) throw unrecognized(`${where}: rsrvtPolcy가 없다`);
  cache.set(insttId, { at: now, policy: policy as Record<string, unknown> });
  return policy as Record<string, unknown>;
}

type Cycle = "WEEK" | "MON";

/** 시설 정책: 주기와 예약 가능 마지막 날(YYYYMMDD). */
async function policyOf(ctx: AdapterContext, session: Session, insttId: string): Promise<{ cycle: Cycle; lastDay: string }> {
  const where = "시설 정책";
  const p = await rawPolicyOf(ctx, session, insttId);
  const cycle = p.rsrvtCycleTpeCd;
  if (cycle !== "WEEK" && cycle !== "MON") throw unrecognized(`${where}: 알 수 없는 예약 주기(${str(cycle) ?? "주기 없음"})`);
  const lastDay = [str(p.weekLastDay), str(p.monthLastDay)].filter((d): d is string => d !== undefined && /^\d{8}$/.test(d)).sort().at(-1);
  if (!lastDay) throw unrecognized(`${where}: 예약 가능 마지막 날(weekLastDay)이 없다`);
  return { cycle, lastDay };
}

/** 잔여를 읽는 단위. 주별은 오늘부터 마지막 날까지 한 번(`02`), 월별은 달마다(`01`, `srchDate`=YYYYMM)다. */
interface View {
  inqurSctin: "01" | "02";
  srchDate: string;
}
function viewsOf(cycle: Cycle, today: string, lastDay: string): View[] {
  if (cycle === "WEEK") return [{ inqurSctin: "02", srchDate: today }];
  const views: View[] = [];
  const end = Number(lastDay.slice(0, 6));
  for (let year = Number(today.slice(0, 4)), month = Number(today.slice(4, 6)); year * 100 + month <= end; year += month === 12 ? 1 : 0, month = (month % 12) + 1) {
    views.push({ inqurSctin: "01", srchDate: `${year}${String(month).padStart(2, "0")}` });
  }
  return views;
}

/** 개시 시각 앞뒤로 쉬는 구간: 5분 전부터 30분 후까지. */
const RUSH_BEFORE_MIN = 5;
const RUSH_AFTER_MIN = 30;
const hhmm = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * 시설 정책의 개시 시각(`rsrvtBgnTm`, HHMM)으로 오픈 경쟁 시간을 구한다. 주별(`WEEK`)은 매일, 월별(`MON`)은 매월 1일이다.
 * 개시 시각이나 주기를 읽을 수 없으면 쉬지 않고(undefined) 조회가 그 시설의 모양 변경을 판정하게 둔다.
 * 월별 구간은 `dayOfMonth` 규칙상 자정을 넘을 수 없어 그날 안으로 자른다.
 */
function rushOf(policy: Record<string, unknown>): OpeningRush | undefined {
  const bgn = str(policy.rsrvtBgnTm);
  const m = bgn !== undefined ? /^([01]\d|2[0-3])([0-5]\d)$/.exec(bgn) : null;
  const cycle = str(policy.rsrvtCycleTpeCd);
  if (!m || (cycle !== "WEEK" && cycle !== "MON")) return undefined;
  const at = Number(m[1]) * 60 + Number(m[2]);
  if (cycle === "WEEK") return { from: hhmm((at - RUSH_BEFORE_MIN + 1440) % 1440), to: hhmm((at + RUSH_AFTER_MIN) % 1440) };
  return { from: hhmm(Math.max(0, at - RUSH_BEFORE_MIN)), to: hhmm(Math.min(1439, at + RUSH_AFTER_MIN)), dayOfMonth: 1 };
}

/** 구역의 상품 목록. 대기열(action8) 키를 본문과 쿠키에 싣는 유일한 호출이다. */
async function goodsOf(ctx: AdapterContext, session: Session, insttId: string, zone: string, view: View, lastDay: string): Promise<Goods[]> {
  const where = "상품 목록";
  const pass = await enterQueue(ctx, GOODS_QUEUE);
  try {
    setNetFunnelCookie(ctx.http, "www.foresttrip.go.kr", pass.result);
    const body = await postJson(
      ctx,
      session,
      "/rep/or/sssn/selectRsrvtGoodsListForMonthRsrvt.do",
      { insttId, upperGoodsClsscCd: upperOf(zone), goodsClsscCd: zone, ...view, lastDay, netfunnelKey: pass.key },
      where,
    );
    return listOf(body, "rsrvtGoodsList", where)
      .filter((g) => str(g.goodsClsscCd) === zone)
      .map((g) => {
        const id = str(g.goodsId);
        const name = str(g.goodsNm);
        if (!id || !name) throw unrecognized(`${where}: 상품에 goodsId·goodsNm이 없다`);
        return { id, name };
      });
  } finally {
    await completeQueue(ctx, GOODS_QUEUE, pass.key);
  }
}

/** 잔여 응답의 상태 코드. 화면 JS(`dispGoodsTr`) 해석이다. */
const KNOWN_STATUS = new Set(["Y", "PRIOR", "DRLTS", "WEEKEND_DRLTS", "REPAIR", "PRNSL_DAY", "BEFORE_DATE", "OVER_DATE"]);
/** 빈자리로 치지 않되 로그에 남기는 상태: 추첨·우선예약(표본에 없어 방법을 정하지 않았다)과 모르는 값. */
const LOGGED_STATUS = new Set(["PRIOR", "DRLTS", "WEEKEND_DRLTS"]);

/** 잔여 읽기 결과. `stale`은 응답이 상품 목록과 어긋났다는 뜻이다(모르는 `goodsId`가 보이거나 요청한 `goodsId`가 빠졌다). */
interface Availability {
  open: Map<string, Map<string, boolean>>;
  maxStay?: number;
  stale: boolean;
}

/**
 * 구역 상품의 날짜별 빈자리 여부(`goodsId` → 날짜 YYYY-MM-DD → 빈자리). 상품 5개씩 묶어 호출하고 월별 시설은 달마다 이어 붙인다.
 * 첫 응답에서 시설의 최대 연박(`maxStay`)을 읽고, 모든 조건이 넘으면(`minNights` 초과) 더 조회하지 않는다. `fresh`는 목록을 방금 받았다는 뜻이다.
 */
async function availabilityOf(
  ctx: AdapterContext,
  session: Session,
  insttId: string,
  zone: string,
  goods: Goods[],
  views: View[],
  lastDay: string,
  minNights: number,
  fresh: boolean,
): Promise<Availability> {
  const where = "잔여";
  const out = new Map<string, Map<string, boolean>>();
  const known = new Set(goods.map((g) => g.id));
  let stale = false;
  const noted = new Map<string, number>();
  let maxStay: number | undefined;
  const calls = views.flatMap((view) => Array.from({ length: Math.ceil(goods.length / GOODS_PER_CALL) }, (_, n) => ({ view, chunk: goods.slice(n * GOODS_PER_CALL, (n + 1) * GOODS_PER_CALL) })));
  for (const { view, chunk } of calls) {
    const body = await postJson(
      ctx,
      session,
      "/rep/or/selectRsrvtAvailInfoListForMonthRsrvt.do",
      { insttId, upperGoodsClsscCd: upperOf(zone), goodsIdList: chunk.map((g) => g.id), ...view, lastDay },
      where,
    );
    const rows = listOf(body, "rsrvtAvailInfoList", where);
    // 방금 받은 목록인데도 잔여 행이 하나도 없으면 구조 변경이다. 캐시한 목록이면 목록이 낡았을 수 있어 다시 받게 한다.
    if (rows.length === 0 && fresh) throw unrecognized(`${where}: 요청한 상품의 잔여 행이 하나도 없다`);
    const seen = new Set(rows.map((r) => str(r.goodsId)));
    if (chunk.some((g) => !seen.has(g.id)) || [...seen].some((id) => id !== undefined && !known.has(id))) stale = true;
    for (const row of rows) {
      const goodsId = str(row.goodsId);
      const useDt = str(row.useDt)?.replaceAll("-", "");
      const status = str(row.rsrvtAvail);
      if (!goodsId || !useDt || !/^\d{8}$/.test(useDt) || !status) throw unrecognized(`${where}: 잔여 행을 읽을 수 없다`);
      if (!KNOWN_STATUS.has(status) || LOGGED_STATUS.has(status)) noted.set(status, (noted.get(status) ?? 0) + 1);
      // 예약가능(Y)이고 예약 건수가 0인 칸만 빈자리다. 건수를 읽지 못하면 빈자리로 치지 않는다.
      const open = status === "Y" && Number(row.rsrvtCnt) === 0;
      const byDate = out.get(goodsId) ?? new Map<string, boolean>();
      out.set(goodsId, byDate);
      byDate.set(`${useDt.slice(0, 4)}-${useDt.slice(4, 6)}-${useDt.slice(6)}`, open);
      const stay = Number(row.mxmmStngDayCnt);
      if (Number.isInteger(stay) && stay > 0) maxStay = Math.max(maxStay ?? 0, stay);
    }
    if (maxStay !== undefined && minNights > maxStay) break;
  }
  for (const [status, count] of noted) {
    ctx.log?.(KNOWN_STATUS.has(status) ? "foresttrip status not treated as opening" : "foresttrip unknown status", { zone, status, count });
  }
  return { open: out, maxStay, stale };
}

/** 세션(HttpClient)마다 구역의 상품 목록 캐시. 재시작하면 비고, 세션 사이로 옮기지 않는다. */
const goodsCaches = new WeakMap<HttpClient, Map<string, { at: number; goods: Goods[] }>>();

/** 구역의 상품 목록. 캐시가 24시간 안이면 그대로 쓰고(대기열 키도 받지 않는다), 아니면 받는다. `force`면 캐시를 버리고 받는다. */
async function cachedGoods(ctx: AdapterContext, session: Session, insttId: string, zone: string, view: View, lastDay: string, force = false): Promise<{ goods: Goods[]; fresh: boolean }> {
  const caches = goodsCaches.get(ctx.http) ?? new Map<string, { at: number; goods: Goods[] }>();
  goodsCaches.set(ctx.http, caches);
  const key = `${insttId}|${zone}`;
  const now = ctx.clock.now().getTime();
  const hit = caches.get(key);
  if (!force && hit && now - hit.at < GOODS_TTL_MS) return { goods: hit.goods, fresh: false };
  const goods = await goodsOf(ctx, session, insttId, zone, view, lastDay);
  caches.set(key, { at: now, goods });
  return { goods, fresh: true };
}

/** 한 구역의 잔여 호출 수: 보는 달 수 × 상품 5개 묶음 수. */
const callsFor = (goodsCount: number, views: number): number => views * Math.ceil(goodsCount / GOODS_PER_CALL);

/** 상한을 넘어 조회하지 않을 때 알리는 문구. 필요한 호출 수와 줄이는 방법을 싣는다. */
function budgetNotice(facility: string, perZone: { zone: string; calls: number }[]): string {
  const name = facilities.find((f) => f.code === facility)?.name ?? facility;
  const total = perZone.reduce((sum, z) => sum + z.calls, 0);
  const detail = perZone.map((z) => `${z.zone} ${z.calls}번`).join(", ");
  return `${name}: 한 바퀴에 잔여 호출이 ${total}번(${detail}) 필요해 상한 ${MAX_CALLS_PER_FACILITY}번을 넘으므로 이 시설은 조회하지 않는다. 줄이려면 자리 필터(seats)를 추가하거나 구역(zones)을 줄여라.`;
}

/** 키별로 묶는다. 처음 나온 순서를 지킨다. */
function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

const compact = (date: string) => date.replaceAll("-", "");

/** 오류 문구에서 비밀 값(비밀번호, 아이디, `_csrf`)을 가린다. 어댑터가 직접 만든 문구에는 들어가지 않지만 전송 계층이 올린 문구를 믿지 않는다. */
function redacted(e: AdapterError, ctx: AdapterContext, seen: string[]): AdapterError {
  let message = e.message;
  const secrets = [ctx.secrets?.[PASSWORD], ctx.secrets?.[USERNAME], ...seen].filter((s): s is string => !!s);
  // 폼 본문에 실린 값은 퍼센트 인코딩되어 있을 수 있다.
  for (const s of secrets.flatMap((v) => [v, encodeURIComponent(v), new URLSearchParams({ v }).toString().slice(2)])) message = message.replaceAll(s, "***");
  return message === e.message ? e : new AdapterError(e.kind, message, { cause: e.cause });
}

/** 이 클라이언트의 로그인 세션. 없으면 로그인한다. */
async function ensureSession(ctx: AdapterContext, seen: string[]): Promise<Session> {
  const session = sessions.get(ctx.http) ?? (await login(ctx, seen));
  seen.push(session.csrf);
  sessions.set(ctx.http, session);
  return session;
}

async function facilityOpeningRush(facility: string, ctx: AdapterContext): Promise<OpeningRush | undefined> {
  const seen: string[] = [];
  try {
    const session = await ensureSession(ctx, seen);
    return rushOf(await rawPolicyOf(ctx, session, insttIdOf(facility)));
  } catch (e) {
    throw e instanceof AdapterError ? redacted(e, ctx, seen) : e;
  }
}

async function runBatch(units: AvailabilityQuery[], ctx: AdapterContext): Promise<Map<AvailabilityQuery, AvailableSite[] | AdapterError | UnitSkipped>> {
  const results = new Map<AvailabilityQuery, AvailableSite[] | AdapterError | UnitSkipped>();
  let session: Session;
  const seen: string[] = []; // 이번 바퀴에 본 `_csrf` 값. 오류 문구에서 가린다.
  try {
    session = await ensureSession(ctx, seen);
    const today = kstDate(ctx.clock.now());
    const tooLong = tooLongNotified.get(ctx.http) ?? new Set<string>();
    tooLongNotified.set(ctx.http, tooLong);
    for (const [facility, facilityUnits] of groupBy(units, (q) => q.facility)) {
      const insttId = insttIdOf(facility);
      const { cycle, lastDay } = await policyOf(ctx, session, insttId);
      const lastDate = `${lastDay.slice(0, 4)}-${lastDay.slice(4, 6)}-${lastDay.slice(6)}`;
      const views = viewsOf(cycle, compact(today), lastDay);
      const zones = [...groupBy(facilityUnits, (q) => q.zone)];
      // 호출 수를 알려면 구역의 상품 목록이 모두 필요하다. 먼저 목록을 모으고(캐시를 쓴다) 상한 안일 때만 잔여를 묻는다.
      const lists = new Map<string, { goods: Goods[]; fresh: boolean }>();
      const budget = (): { zone: string; calls: number }[] => [...lists].map(([zone, l]) => ({ zone, calls: callsFor(l.goods.length, views.length) }));
      const over = (): boolean => budget().reduce((sum, z) => sum + z.calls, 0) > MAX_CALLS_PER_FACILITY;
      for (const [zone] of zones) {
        const list = await cachedGoods(ctx, session, insttId, zone, views[0]!, lastDay);
        lists.set(zone, list);
        rememberSeatNames(ctx.http, facility, zone, list.goods);
      }
      if (over()) {
        const reason = budgetNotice(facility, budget());
        for (const q of facilityUnits) results.set(q, new UnitSkipped(reason));
        continue;
      }
      for (const [zone, zoneUnits] of zones) {
        let list = lists.get(zone)!;
        const minNights = Math.min(...zoneUnits.map((q) => q.nights));
        const read = (l: { goods: Goods[]; fresh: boolean }): Promise<Availability | undefined> =>
          l.goods.length > 0 ? availabilityOf(ctx, session, insttId, zone, l.goods, views, lastDay, minNights, l.fresh) : Promise.resolve(undefined);
        let got = await read(list);
        if (got?.stale && !list.fresh) {
          // 모르는 `goodsId`가 보이거나 감시하던 `goodsId`가 빠졌다. 목록을 바로 다시 받고 한 번 더 읽는다.
          list = await cachedGoods(ctx, session, insttId, zone, views[0]!, lastDay, true);
          lists.set(zone, list);
          rememberSeatNames(ctx.http, facility, zone, list.goods);
          if (over()) {
            const reason = budgetNotice(facility, budget());
            for (const q of zoneUnits) results.set(q, new UnitSkipped(reason));
            continue;
          }
          got = await read(list);
        }
        const goods = list.goods;
        const open = got?.open ?? new Map<string, Map<string, boolean>>();
        const maxStay = got?.maxStay;
        for (const q of zoneUnits) {
          if (maxStay !== undefined && q.nights > maxStay) {
            const key = `${facility}|${zone}|${q.nights}`;
            if (!tooLong.has(key)) ctx.log?.("foresttrip nights over facility max", { facility, zone, nights: q.nights, maxNights: maxStay });
            tooLong.add(key);
            results.set(q, []);
            continue;
          }
          // 마지막 날 밖과 지난 날짜는 빈자리가 아니다. 같은 자리가 입실일부터 박 수만큼 연속으로 비어야 한다.
          const dates = nightsOf(q);
          const sites = q.checkIn > lastDate || q.checkIn < today ? [] : goods.filter((g) => dates.every((d) => open.get(g.id)?.get(d) === true));
          results.set(q, sites.map((g) => ({ id: g.name, name: g.name })));
        }
      }
    }
  } catch (e) {
    if (!(e instanceof AdapterError)) throw e;
    // 어느 단계에서든 실패하면 남은 조회 단위 모두가 같은 오류다. 요청은 한 줄이라 더 보내지 않는다.
    const failure = redacted(e, ctx, seen);
    for (const q of units) if (!results.has(q)) results.set(q, failure);
  }
  return results;
}

export const foresttripAdapter: ProviderAdapter = {
  id: "foresttrip",
  describe: () => INFO,
  queryAvailabilityBatch: runBatch,
  facilityOpeningRush,
  deepLink: (q) => deepLinkOf(q),
  seatNames: (facility, zone, ctx) => seatNamesOf.get(ctx.http)?.get(zoneKey(facility, zone)),
};
