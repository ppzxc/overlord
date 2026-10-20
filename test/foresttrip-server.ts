import type { TransportRequest, TransportResponse } from "../src/types.js";
import { fixture } from "./harness.js";

/**
 * 가짜 숲나들e 서버(www와 대기열 nf). 응답 모양은 2026-10-20 스파이크 문서(research/forest-login-probe*.md)의 필드 목록으로 다시 만든 것이다.
 * 스파이크가 응답 원문을 남기지 않아 기록본이 없다. 세션 값, `_csrf`, 계정은 모두 가짜다.
 * 가짜 서버가 실제 서버의 요구를 강제한다: 로그인 때 JSESSIONID와 `_csrf`가 바뀌어 옛 값은 거절되고, JSON 조회는 JSON Content-Type과 월별 현황 화면의 `X-CSRF-TOKEN`이 있어야 하며,
 * 상품 목록은 action8 대기열 키(본문과 `NetFunnel_ID` 쿠키)가 있어야 하고, 잔여 호출은 상품 5개만 돌려준다.
 */
export const FOREST_USER = "campuser77";
export const FOREST_PASSWORD = "p@ss$w0rd${HOME}!";
export const FOREST_ENV = { FORESTTRIP_USERNAME: FOREST_USER, FORESTTRIP_PASSWORD: FOREST_PASSWORD };
/** 가짜 서버가 내보내는 비밀 값. 로그·알림 어디에도 없어야 한다. */
export const FOREST_SECRET_VALUES = (server: { state: ForestState }): string[] => [FOREST_PASSWORD, FOREST_USER, ...server.state.csrfs, ...server.state.sessions];

export interface ForestGoods {
  id: string;
  name: string;
  clsscCd: string;
}

export interface ForestState {
  logins: number;
  /** 지금까지 발급한 `_csrf` 값. */
  csrfs: string[];
  /** 지금까지 발급한 JSESSIONID 값. */
  sessions: string[];
  /** 대기열이 발급한 키와 그 aid. */
  keys: { key: string; aid: string }[];
  /** 대기열 5004로 닫힌 키. */
  completed: string[];
  /** 잔여 호출마다 요청한 상품 수. */
  availCalls: { requested: number; returned: number }[];
}

export interface ForestOptions {
  username?: string;
  password?: string;
  /** 오늘(YYYY-MM-DD). 잔여 행은 오늘부터 마지막 날까지 준다. */
  today?: string;
  /** 칸의 상태. 기본은 모두 마감(`Y`, 예약 건수 1)이다. */
  status?: (goods: ForestGoods, date: string) => { rsrvtAvail: string; rsrvtCnt?: number | string };
  /** 가짜 서버가 응답하는 로그인 POST. 기본은 `alert.do`로 가는 302다. */
  login?: (form: URLSearchParams) => TransportResponse | undefined;
  /** crawlingCheck.do의 응답 본문. 기본은 `true`다. */
  crawling?: string;
  /** 시설 정책 JSON을 바꾼다. */
  policy?: (base: Record<string, unknown>, insttId?: string) => Record<string, unknown>;
  /** 유명산(0101) 밖에 응답할 시설 id. 응답은 유명산과 같은 모양이고 정책만 `policy`의 두 번째 인자로 가를 수 있다. */
  extraInstts?: string[];
  /** 모든 요청에 앞서 응답을 가로챈다. */
  intercept?: (req: TransportRequest, state: ForestState) => TransportResponse | undefined;
  /** 잔여 호출 응답을 바꾼다(인자는 기본 응답). */
  avail?: (rows: Record<string, unknown>[], req: TransportRequest) => TransportResponse | undefined;
}

const WWW = "www.foresttrip.go.kr";
const NF = "nf.foresttrip.go.kr";
const unauthorized: TransportResponse = { status: 401, body: '<script>var loginErrorCode = "-5"; // 로그인이 필요한 페이지</script>' };
const json = (body: unknown): TransportResponse => ({ status: 200, body: JSON.stringify(body) });

/** `yyyy-mm-dd`부터 `end`까지의 날짜. */
function datesFrom(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) dates.push(new Date(t).toISOString().slice(0, 10));
  return dates;
}

export function foresttripServer(opts: ForestOptions = {}) {
  const today = opts.today ?? "2026-10-20";
  const goodsRaw = (JSON.parse(fixture("foresttrip/goods-yumyeongsan.json")) as { rsrvtGoodsList: { goodsId: string; goodsNm: string; goodsClsscCd: string }[] }).rsrvtGoodsList;
  const goodsAll = goodsRaw.map((g): ForestGoods => ({ id: g.goodsId, name: g.goodsNm, clsscCd: g.goodsClsscCd }));
  const state: ForestState = { logins: 0, csrfs: [], sessions: [], keys: [], completed: [], availCalls: [] };
  let loginCsrf: string | undefined;
  let session: string | undefined; // 로그인으로 발급한 유효한 세션
  let ajaxCsrf: string | undefined;
  const issue = (kind: "csrfs" | "sessions", prefix: string) => {
    const value = `${prefix}-${state[kind].length + 1}-${"x".repeat(8)}`;
    state[kind].push(value);
    return value;
  };
  const cookieOf = (req: TransportRequest, name: string) => new RegExp(`(?:^|; )${name}=([^;]*)`).exec(req.headers.Cookie ?? "")?.[1];
  const policyBody = (insttId?: string) => {
    const base = JSON.parse(fixture("foresttrip/policy-yumyeongsan.json")) as Record<string, unknown>;
    return opts.policy ? opts.policy(base, insttId) : base;
  };
  const lastDay = () => {
    const p = policyBody().rsrvtPolcy as { weekLastDay?: string; monthLastDay?: string } | undefined;
    return p?.weekLastDay || p?.monthLastDay || "20261124";
  };

  const respond = (req: TransportRequest): TransportResponse => {
    const intercepted = opts.intercept?.(req, state);
    if (intercepted) return intercepted;
    const url = new URL(req.url);
    if (url.hostname === NF) {
      const aid = url.searchParams.get("aid") ?? "";
      if (url.searchParams.get("opcode") === "5004") {
        state.completed.push(url.searchParams.get("key") ?? "");
        return { status: 200, body: "NetFunnel.gRtype=5004;NetFunnel.gControl.result='5004:200:key=done'; NetFunnel.gControl._showResult();" };
      }
      const key = `KEY${state.keys.length + 1}`;
      state.keys.push({ key, aid });
      return { status: 200, body: `NetFunnel.gRtype=5101;NetFunnel.gControl.result='5002:200:key=${key}&nwait=0&nnext=0&tps=0.000000&ttl=0&ip=nf.foresttrip.go.kr&port=443'; NetFunnel.gControl._showResult();` };
    }
    if (url.hostname !== WWW) return { status: 404, body: "" };
    const path = url.pathname;

    if (path === "/com/login.do" && req.method === "GET") {
      loginCsrf = issue("csrfs", "LOGINCSRF");
      return { status: 200, body: fixture("foresttrip/login.htm").replace("{{CSRF}}", loginCsrf), setCookie: [`JSESSIONID=${issue("sessions", "PRE")}; Path=/; Secure; HttpOnly`, "WMONID=wm1; Path=/; Max-Age=31536000"] };
    }
    if (path === "/com/crawlingCheck.do" && req.method === "POST") {
      if (url.searchParams.get("_csrf") !== loginCsrf) return { status: 403, body: "" };
      if (new URLSearchParams(req.body ?? "").get("param") !== "noData") return { status: 400, body: "" };
      return { status: 200, body: opts.crawling ?? "true" };
    }
    if (path === "/com/login" && req.method === "POST") {
      const form = new URLSearchParams(req.body ?? "");
      const custom = opts.login?.(form);
      if (custom) return custom;
      if (form.get("_csrf") !== loginCsrf) return { status: 403, body: "" };
      if (form.get("loginId") !== (opts.username ?? FOREST_USER) || form.get("loginPwd") !== (opts.password ?? FOREST_PASSWORD)) {
        return { status: 403, body: '<script>var loginErrorCode = "-6"; // 아이디 또는 비밀번호가 일치하지 않습니다</script>' };
      }
      state.logins++;
      session = issue("sessions", "SESS");
      ajaxCsrf = undefined; // 로그인 때 `_csrf`도 바뀐다. 새 토큰은 월별 현황 화면이 준다.
      return { status: 302, body: "", location: "/com/alert.do", setCookie: [`JSESSIONID=${session}; Path=/; Secure; HttpOnly`] };
    }
    if (path === "/com/alert.do" || path.startsWith("/pot/mc/")) return { status: 200, body: "<html>비밀번호를 변경하세요</html>" };

    // 아래는 로그인한 세션이 필요하다.
    if (!session || cookieOf(req, "JSESSIONID") !== session) return unauthorized;
    if (path === "/rep/or/sssn/monthRsrvtStatus.do" && req.method === "GET") {
      const nf = state.keys.find((k) => k.aid === "action3" && (cookieOf(req, "NetFunnel_ID") ?? "").includes(`key%3D${k.key}`));
      if (!nf) return { status: 403, body: "" };
      ajaxCsrf = issue("csrfs", "AJAXCSRF");
      return { status: 200, body: fixture("foresttrip/month-screen.htm").replace("{{CSRF}}", ajaxCsrf) };
    }
    if (req.method !== "POST") return { status: 404, body: "" };
    if (!(req.headers["Content-Type"] ?? "").startsWith("application/json")) return { status: 415, body: "" };
    if (!ajaxCsrf || req.headers["X-CSRF-TOKEN"] !== ajaxCsrf) return { status: 403, body: "" };
    const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
    if (body.insttId !== "0101" && !opts.extraInstts?.includes(String(body.insttId))) return { status: 404, body: "" };

    if (path === "/rep/or/selectSthngListForMonthRsrvt.do") return json(policyBody(String(body.insttId)));
    if (path === "/rep/or/sssn/selectRsrvtGoodsListForMonthRsrvt.do") {
      const key = String(body.netfunnelKey ?? "");
      const issued = state.keys.find((k) => k.key === key && k.aid === "action8");
      if (!issued || !(cookieOf(req, "NetFunnel_ID") ?? "").includes(`key%3D${key}`)) return { status: 403, body: "" };
      const list = goodsRaw.filter((g) => g.goodsClsscCd.startsWith(String(body.upperGoodsClsscCd)) && (!body.goodsClsscCd || g.goodsClsscCd === body.goodsClsscCd));
      return json({ rsrvtGoodsList: list, rsrvtPssblDtList: [], hldtInfoList: [] });
    }
    if (path === "/rep/or/selectRsrvtAvailInfoListForMonthRsrvt.do") {
      const asked = body.goodsIdList as string[];
      const served = asked.slice(0, 5); // 서버는 앞의 5개만 돌려준다.
      const rows = served.flatMap((id) => {
        const goods = goodsAll.find((g) => g.id === id);
        if (!goods) return [];
        return datesFrom(today, `${lastDay().slice(0, 4)}-${lastDay().slice(4, 6)}-${lastDay().slice(6)}`).map((date) => {
          const s = opts.status?.(goods, date) ?? { rsrvtAvail: "Y", rsrvtCnt: 1 };
          return { goodsId: id, useDt: date.replaceAll("-", ""), rsrvtAvail: s.rsrvtAvail, rsrvtCnt: s.rsrvtCnt ?? 0, wtngCnt: 0, goodsMxmmWtngCnt: 0, wtngPssblYn: "N", mxmmStngDayCnt: 3 };
        });
      });
      state.availCalls.push({ requested: asked.length, returned: served.length });
      return opts.avail?.(rows, req) ?? json({ rsrvtAvailInfoList: rows });
    }
    return { status: 404, body: "" };
  };
  return Object.assign(respond, { state });
}
