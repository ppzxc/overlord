import * as cheerio from "cheerio";
import { AdapterError, UnitSkipped, type AdapterContext, type AvailabilityQuery, type AvailableSite, type HttpClient, type ProviderAdapter, type ProviderInfo, type TransportResponse } from "../types.js";
import { facilities } from "../catalogs/foresttrip.js";
import { fieldsRef } from "../facility.js";
import { BOT_DETECTION, ConnectionFailure, assertOk, send } from "../adapter-signals.js";
import { completeQueue, enterQueue, setNetFunnelCookie, type NetFunnelQueue } from "../netfunnel.js";
import { kstDate } from "../schedule.js";

/**
 * 숲나들e 예약처. 로그인 조회만 예외로 허용한다(ADR 0004). 봇 판별(`crawlingCheck.do`)은 우회하지 않고 거부되면 멈춘다. 이 파일은 워킹 스켈레톤(#143)이다.
 * 흐름(research/forest-login-probe.md): 로그인 화면(`_csrf`) → `crawlingCheck.do`(`param=noData`) → 로그인 POST(302면 성공, 변경 화면은 따라가지 않는다)
 * → 월별 현황 화면(NetFunnel `action3`, 화면의 `_csrf`가 AJAX의 `X-CSRF-TOKEN`) → 시설 정책 → 상품 목록(NetFunnel `action8`) → 잔여(상품 5개씩).
 * 빈자리는 상태가 `Y`이고 `rsrvtCnt`가 0인 칸이다. 지난 날짜·기간 밖·마감·대기·공사·휴무·추첨·우선예약과 모르는 상태는 빈자리가 아니다.
 * 이 티켓은 1박, 주별(`WEEK`) 시설, 구역의 모든 상품만 읽는다. 자리 이름 필터, 연박, 월별 시설, 재로그인(`-5`), 로그인 실패 파일 기록, 시설별 오픈 경쟁 시간, `catalog --live`는 후속 티켓이다.
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
const callsFor = (goodsCount: number): number => Math.ceil(goodsCount / GOODS_PER_CALL);

const USERNAME = "FORESTTRIP_USERNAME";
const PASSWORD = "FORESTTRIP_PASSWORD";

const INFO: ProviderInfo = {
  id: "foresttrip",
  facilities,
  // 유명산의 최대 연박은 3이지만 연박 판정은 후속 티켓이라 1박만 받는다.
  maxNights: 1,
  // 예약 가능 마지막 날은 응답(`weekLastDay`)이 정한다. 조회 창은 느슨하게 두고 그 밖의 날짜는 빈자리 없음으로 둔다.
  openingRule: { openDaysBefore: 60, openTime: "00:00", sameDayCutoff: "23:59" },
  // 개시 시각(`rsrvtBgnTm`) 앞뒤로 쉬는 시설별 오픈 경쟁 시간은 후속 티켓이다. 지금은 `openingRush`를 두지 않는다.
  defaultPollIntervalSeconds: 600,
  minPollIntervalSeconds: 300,
  // `/pot/mc/`는 회원정보(비밀번호 변경 화면 `/pot/mc/pu/updatePssrdChngExpiredView.do` 포함), `/com/alert.do`는 그 화면으로 보내는 안내라 따라가지 않는다.
  // 예약·결제·취소 경로는 스파이크가 기록하지 않았다. 아래 세 접두어는 추정이며 실제 경로를 확인하면 바로잡는다. 조회 경로(`/rep/or/sssn/`, `/rep/or/select…`)와 로그인(`/com/login`, `/com/crawlingCheck.do`)은 막지 않는다.
  blockedPaths: ["/pot/mc/", "/com/alert.do", "/rep/or/rsrvt", "/rep/or/pay", "/rep/or/cncl"],
  cookieSession: true,
  facilityRequired: true,
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

/** 시설 정책: 주기와 예약 가능 마지막 날(YYYYMMDD). 월별 주기 시설은 아직 읽지 않는다. */
async function policyOf(ctx: AdapterContext, session: Session, insttId: string): Promise<{ lastDay: string }> {
  const where = "시설 정책";
  const body = await postJson(ctx, session, "/rep/or/selectSthngListForMonthRsrvt.do", { insttId }, where);
  const policy = body.rsrvtPolcy;
  if (typeof policy !== "object" || policy === null) throw unrecognized(`${where}: rsrvtPolcy가 없다`);
  const p = policy as Record<string, unknown>;
  if (p.rsrvtCycleTpeCd !== "WEEK") throw unrecognized(`${where}: 주별(WEEK)이 아닌 시설(${str(p.rsrvtCycleTpeCd) ?? "주기 없음"})은 아직 읽지 않는다`);
  const lastDay = [str(p.weekLastDay), str(p.monthLastDay)].filter((d): d is string => d !== undefined && /^\d{8}$/.test(d)).sort().at(-1);
  if (!lastDay) throw unrecognized(`${where}: 예약 가능 마지막 날(weekLastDay)이 없다`);
  return { lastDay };
}

/** 구역의 상품 목록. 대기열(action8) 키를 본문과 쿠키에 싣는 유일한 호출이다. */
async function goodsOf(ctx: AdapterContext, session: Session, insttId: string, zone: string, today: string, lastDay: string): Promise<Goods[]> {
  const where = "상품 목록";
  const pass = await enterQueue(ctx, GOODS_QUEUE);
  try {
    setNetFunnelCookie(ctx.http, "www.foresttrip.go.kr", pass.result);
    const body = await postJson(
      ctx,
      session,
      "/rep/or/sssn/selectRsrvtGoodsListForMonthRsrvt.do",
      { insttId, upperGoodsClsscCd: upperOf(zone), goodsClsscCd: zone, inqurSctin: "02", srchDate: today, lastDay, netfunnelKey: pass.key },
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
  stale: boolean;
}

/** 구역 상품의 날짜별 빈자리 여부(`goodsId` → 날짜 YYYY-MM-DD → 빈자리). 상품 5개씩 묶어 호출한다. `fresh`는 목록을 방금 받았다는 뜻이다. */
async function availabilityOf(
  ctx: AdapterContext,
  session: Session,
  insttId: string,
  zone: string,
  goods: Goods[],
  today: string,
  lastDay: string,
  fresh: boolean,
): Promise<Availability> {
  const where = "잔여";
  const out = new Map<string, Map<string, boolean>>();
  const known = new Set(goods.map((g) => g.id));
  let stale = false;
  const noted = new Map<string, number>();
  for (let i = 0; i < goods.length; i += GOODS_PER_CALL) {
    const chunk = goods.slice(i, i + GOODS_PER_CALL);
    const body = await postJson(
      ctx,
      session,
      "/rep/or/selectRsrvtAvailInfoListForMonthRsrvt.do",
      { insttId, upperGoodsClsscCd: upperOf(zone), goodsIdList: chunk.map((g) => g.id), srchDate: today, lastDay, inqurSctin: "02" },
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
    }
  }
  for (const [status, count] of noted) {
    ctx.log?.(KNOWN_STATUS.has(status) ? "foresttrip status not treated as opening" : "foresttrip unknown status", { zone, status, count });
  }
  return { open: out, stale };
}

/** 세션(HttpClient)마다 구역의 상품 목록 캐시. 재시작하면 비고, 세션 사이로 옮기지 않는다. */
const goodsCaches = new WeakMap<HttpClient, Map<string, { at: number; goods: Goods[] }>>();

/** 구역의 상품 목록. 캐시가 24시간 안이면 그대로 쓰고(대기열 키도 받지 않는다), 아니면 받는다. `force`면 캐시를 버리고 받는다. */
async function cachedGoods(ctx: AdapterContext, session: Session, insttId: string, zone: string, today: string, lastDay: string, force = false): Promise<{ goods: Goods[]; fresh: boolean }> {
  const caches = goodsCaches.get(ctx.http) ?? new Map<string, { at: number; goods: Goods[] }>();
  goodsCaches.set(ctx.http, caches);
  const key = `${insttId}|${zone}`;
  const now = ctx.clock.now().getTime();
  const hit = caches.get(key);
  if (!force && hit && now - hit.at < GOODS_TTL_MS) return { goods: hit.goods, fresh: false };
  const goods = await goodsOf(ctx, session, insttId, zone, today, lastDay);
  caches.set(key, { at: now, goods });
  return { goods, fresh: true };
}

const totalCalls = (lists: Map<string, { goods: Goods[] }>): number => [...lists.values()].reduce((sum, l) => sum + callsFor(l.goods.length), 0);

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

async function runBatch(units: AvailabilityQuery[], ctx: AdapterContext): Promise<Map<AvailabilityQuery, AvailableSite[] | AdapterError | UnitSkipped>> {
  const results = new Map<AvailabilityQuery, AvailableSite[] | AdapterError | UnitSkipped>();
  let session = sessions.get(ctx.http);
  const seen: string[] = []; // 이번 바퀴에 본 `_csrf` 값. 오류 문구에서 가린다.
  try {
    session ??= await login(ctx, seen);
    seen.push(session.csrf);
    sessions.set(ctx.http, session);
    const today = kstDate(ctx.clock.now());
    for (const [facility, facilityUnits] of groupBy(units, (q) => q.facility)) {
      const insttId = insttIdOf(facility);
      const { lastDay } = await policyOf(ctx, session, insttId);
      const lastDate = `${lastDay.slice(0, 4)}-${lastDay.slice(4, 6)}-${lastDay.slice(6)}`;
      const zones = [...groupBy(facilityUnits, (q) => q.zone)];
      // 호출 수를 알려면 구역의 상품 목록이 모두 필요하다. 먼저 목록을 모으고(캐시를 쓴다) 상한 안일 때만 잔여를 묻는다.
      const lists = new Map<string, { goods: Goods[]; fresh: boolean }>();
      for (const [zone] of zones) lists.set(zone, await cachedGoods(ctx, session, insttId, zone, compact(today), lastDay));
      const skip = (): void => {
        const reason = budgetNotice(facility, [...lists].map(([zone, l]) => ({ zone, calls: callsFor(l.goods.length) })));
        for (const q of facilityUnits) results.set(q, new UnitSkipped(reason));
      };
      if (totalCalls(lists) > MAX_CALLS_PER_FACILITY) {
        skip();
        continue;
      }
      for (const [zone, zoneUnits] of zones) {
        let list = lists.get(zone)!;
        let read = list.goods.length > 0 ? await availabilityOf(ctx, session, insttId, zone, list.goods, compact(today), lastDay, list.fresh) : undefined;
        if (read?.stale && !list.fresh) {
          // 모르는 `goodsId`가 보이거나 감시하던 `goodsId`가 빠졌다. 목록을 바로 다시 받고 한 번 더 읽는다.
          list = await cachedGoods(ctx, session, insttId, zone, compact(today), lastDay, true);
          lists.set(zone, list);
          if (totalCalls(lists) > MAX_CALLS_PER_FACILITY) {
            for (const q of zoneUnits) results.set(q, new UnitSkipped(budgetNotice(facility, [...lists].map(([z, l]) => ({ zone: z, calls: callsFor(l.goods.length) })))));
            continue;
          }
          read = list.goods.length > 0 ? await availabilityOf(ctx, session, insttId, zone, list.goods, compact(today), lastDay, true) : undefined;
        }
        const goods = list.goods;
        const open = read?.open ?? new Map<string, Map<string, boolean>>();
        for (const q of zoneUnits) {
          // 마지막 날 밖과 지난 날짜는 빈자리가 아니다. 박수는 1박만 받는다.
          const sites = q.checkIn > lastDate || q.checkIn < today ? [] : goods.filter((g) => open.get(g.id)?.get(q.checkIn) === true);
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
  deepLink: (q) => deepLinkOf(q),
};
