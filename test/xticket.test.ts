import { describe, expect, it } from "vitest";
import { adapters } from "../src/adapters/index.js";
import { runCatalog } from "../src/commands.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { ENV, XTICKET_DALSEO, XTICKET_NAJEONG, configWith, settle, startPoller, xticketGroups, xticketPlayDates, xticketProducts, xticketServer } from "./harness.js";
import type { XticketPlayDate, XticketProduct } from "./harness.js";
import type { TransportRequest, TransportResponse } from "../src/types.js";

// 달서별빛캠프(dalseo)의 기록한 응답(2026-10-12, research/raw/xticket)을 fixture로 쓴다.
// 1015(목)은 book_remain_count 3, 카라반(0001)은 카라반-11과 카라반-13이 (status 0, select 1)이다.
const ZONE = "0001"; // 카라반

const watch = (checkIn: string, extra = "", zone = ZONE, nights = 1, facility = "dalseo") => `
  - name: ${facility} ${zone} ${nights}박
    provider: xticket
    facility: ${facility}
    zones: ["${zone}"]
    checkIn: { from: ${checkIn}, to: ${checkIn} }
    nights: ${nights}
    notify: [default]${extra}`;

const run = (checkIn: string, opts: { server?: ReturnType<typeof xticketServer>; extra?: string; random?: () => number; zone?: string; nights?: number } = {}) =>
  startPoller(() => ({ status: 404, body: "" }), {
    yaml: configWith(watch(checkIn, opts.extra, opts.zone, opts.nights)),
    server: opts.server ?? xticketServer(),
    random: opts.random,
  });

const path = (r: TransportRequest) => new URL(r.url).pathname;
const label = (r: TransportRequest) => `${r.method} ${path(r)}`;
const form = (r: TransportRequest) => Object.fromEntries(new URLSearchParams(r.body));

/** 기록한 자리 목록의 모든 자리를 (status, select)로 바꾼다. */
const allProducts = (status_code: string, select_yn: string) => () => xticketProducts().map((p): XticketProduct => ({ ...p, status_code, select_yn }));

describe("xticket 폴러", () => {
  it("선택가능 자리는 상품군 이름, 자리 이름, 딥링크가 담긴 메시지 한 건으로 알린다", async () => {
    const p = run("2026-10-15");
    await settle();
    expect(p.sent).toHaveLength(1);
    const text = p.sent[0]!.text;
    expect(text).toContain("카라반");
    expect(text).toContain("카라반-11");
    expect(text).toContain("카라반-13");
    expect(text).not.toContain("카라반-01"); // (1,0): 예약완료
    expect(text).not.toContain("카라반-02"); // (0,0): 판매됨
    expect(JSON.stringify(p.sent[0]!.reply_markup)).toContain(`https://camp.xticket.kr/web/main?shopEncode=${XTICKET_DALSEO}`);
    await p.stop();
  });

  it.each([
    ["(0,0)", "0", "0"],
    ["(2,0) 수리중", "2", "0"],
    ["(2,1) 수리중", "2", "1"],
    ["(3,1) 뜻을 모르는 코드", "3", "1"],
    ["(4,1) 대기 그림", "4", "1"],
  ])("%s 자리는 빈자리로 알리지 않는다", async (_name, status, select) => {
    const p = run("2026-10-15", { server: xticketServer({ products: allProducts(status, select) }) });
    await settle();
    expect(p.requests.some((r) => path(r) === "/Web/Book/GetBookProduct010001.json")).toBe(true); // 조회는 했다.
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("book_remain_count가 0이거나 목록에 없거나 우선예약(advance_yn 1)인 날짜는 자리를 조회하지 않는다", async () => {
    const withDate = (change: (d: XticketPlayDate) => XticketPlayDate | undefined) => (month: string) =>
      xticketPlayDates(month).flatMap((d) => (d.play_date === "20261015" ? [change(d)].filter((x) => x !== undefined) : [d]));
    const cases = {
      "남은 수 0": withDate((d) => ({ ...d, book_remain_count: 0 })),
      "목록에 없음": withDate(() => undefined),
      "우선예약": withDate((d) => ({ ...d, advance_yn: "1" })),
    };
    for (const [name, playDates] of Object.entries(cases)) {
      const p = run("2026-10-15", { server: xticketServer({ playDates }) });
      await settle();
      expect(p.allRequests.some((r) => path(r) === "/Web/Book/GetBookPlayDate.json"), name).toBe(true);
      expect(p.allRequests.some((r) => path(r) === "/Web/Book/GetBookProduct010001.json"), name).toBe(false);
      expect(p.sent, name).toHaveLength(0);
      expect(p.logs.some((l) => l.msg === "query failed"), name).toBe(false);
      await p.stop();
    }
  });

  it("목록이 주지 않는 달의 날짜(아직 열리지 않음)는 실패가 아니라 빈자리 없음이다", async () => {
    const p = run("2026-12-20"); // 기록 시점에 12월은 빈 목록이다.
    await settle();
    expect(p.sent).toHaveLength(0);
    expect(p.allRequests.some((r) => path(r) === "/Web/Book/GetBookProduct010001.json")).toBe(false);
    expect(p.logs.some((l) => l.msg === "query failed")).toBe(false);
    await p.stop();
  });

  it("같은 빈자리가 연속 두 바퀴 잡혀도 첫 바퀴에만 알린다", async () => {
    const server = xticketServer();
    const p = run("2026-10-15", { server });
    await settle();
    expect(p.sent).toHaveLength(1);
    await p.clock.advance(300_000);
    await settle();
    expect(p.allRequests.filter((r) => path(r) === "/Web/Book/GetBookProduct010001.json")).toHaveLength(2);
    expect(p.sent).toHaveLength(1);
    await p.stop();
  });

  it("바퀴는 main(302 두 번) -> 필요한 달의 GetBookPlayDate -> GetBookProduct010001 순서이고 GetBookProductGroup은 부르지 않는다", async () => {
    const p = run("2026-10-15");
    await settle();
    expect(p.allRequests.slice(0, 5).map(label)).toEqual([
      "GET /web/main",
      "GET /Web/Reservation",
      "GET /web/main",
      "POST /Web/Book/GetBookPlayDate.json",
      "POST /Web/Book/GetBookProduct010001.json",
    ]);
    expect(p.allRequests.some((r) => path(r).endsWith("GetBookProductGroup.json"))).toBe(false);
    expect(new URL(p.allRequests[0]!.url).searchParams.get("shopEncode")).toBe(XTICKET_DALSEO);
    expect(form(p.allRequests[3]!)).toEqual({ play_month: "202610" });
    expect(form(p.allRequests[4]!)).toEqual({ product_group_code: "0001", start_date: "20261015", end_date: "20261015", book_days: "1", two_stay_days: "0" });
    await p.stop();
  });

  it("쿠키가 리다이렉트와 다음 POST에 이어지고 POST는 브라우저처럼 Referer·Origin을 싣는다", async () => {
    const p = run("2026-10-15");
    await settle();
    expect(p.allRequests[0]!.headers.Cookie).toBeUndefined();
    expect(p.allRequests[1]!.headers.Cookie).toBe("JSESSIONID=sess1");
    expect(p.allRequests[2]!.headers.Cookie).toBe("JSESSIONID=sess1");
    for (const r of p.allRequests.slice(3, 5)) {
      expect(r.headers.Cookie).toBe("JSESSIONID=sess1");
      expect(r.headers.Referer).toBe(`https://camp.xticket.kr/web/main?shopEncode=${XTICKET_DALSEO}`);
      expect(r.headers.Origin).toBe("https://camp.xticket.kr");
      expect(r.headers["X-Requested-With"]).toBe("XMLHttpRequest");
      expect(r.headers["Content-Type"]).toBe("application/x-www-form-urlencoded; charset=UTF-8");
    }
    await p.stop();
  });

  it("main, PlayDate, Product 요청 사이는 5초 + 지터 간격이다", async () => {
    const p = run("2026-10-15"); // random 0.5: 6.5초
    await settle();
    // 리다이렉트 두 홉은 앞 요청과 한 칸을 쓴다(HTTP 층 규칙). 논리 요청 사이를 본다.
    const at = (i: number) => p.requestTimes[i]!;
    expect(at(3) - at(0)).toBe(6_500);
    expect(at(4) - at(3)).toBe(6_500);
    await p.stop();
    const low = run("2026-10-15", { random: () => 0 });
    await settle();
    expect(low.requestTimes[3]! - low.requestTimes[0]!).toBe(5_000);
    await low.stop();
  });

  it("모든 요청에 정직한 UA만 붙고 접근 금지 경로로는 요청이 나가지 않는다", async () => {
    const p = run("2026-10-15");
    await settle();
    for (const r of p.allRequests) expect(r.headers["User-Agent"]).toBe("overlord-availability-poller/0.1.0 (ops)");
    const forbidden = ["/web/book/book010001.json", "/web/jcaptcha", "/web/member/", "/web/books", "/web/profile", "/web/join", "/web/findid", "/web/cirequest", "/web/ipinrequest"];
    for (const r of p.allRequests) expect(forbidden.some((f) => path(r).toLowerCase().startsWith(f))).toBe(false);
    await p.stop();
  });

  it("접근 금지 경로는 대소문자가 달라도 막는다", async () => {
    const info = (await import("../src/adapters/xticket.js")).xticketAdapter.describe();
    const { createHttpClient } = await import("../src/http.js");
    const sent: string[] = [];
    const http = createHttpClient({
      transport: async (r) => (sent.push(r.url), { status: 200, body: "" }),
      version: "0.1.0",
      userAgentSuffix: "",
      blockedPaths: info.blockedPaths,
      cookieSession: true,
    });
    for (const blocked of ["/Web/Book/Book010001.json", "/web/book/book010001.json", "/Web/jcaptcha?r=1", "/Web/Member/MemberLogin.json", "/web/member/memberlogin.json", "/web/books?shopEncode=x"]) {
      await expect(http.get(`https://camp.xticket.kr${blocked}`), blocked).rejects.toThrow(/접근 금지/);
    }
    expect(sent).toEqual([]);
  });

  it("JSON이 아니거나 data.bookPlayDateList가 없으면 구조 변경(unrecognized)으로 센다", async () => {
    // Referer를 빼면 `{}`가 온다. 어댑터가 이를 빈자리 없음으로 삼키지 않아야 한다.
    const p = run("2026-10-15", { server: xticketServer({ intercept: (r) => (path(r) === "/Web/Book/GetBookPlayDate.json" ? { status: 200, body: "{}" } : undefined) }) });
    await settle();
    expect(p.sent).toHaveLength(0);
    expect(p.logs.some((l) => l.msg === "query failed" && l.fields?.kind === "unrecognized")).toBe(true);
    await p.stop();
  });
});

describe("xticket 여러 박·여러 시설", () => {
  const dates = (change: (d: XticketPlayDate) => XticketPlayDate) => (month: string) => xticketPlayDates(month).map((d) => (["20261015", "20261016"].includes(d.play_date) ? change(d) : d));
  const productRequests = (p: { allRequests: TransportRequest[] }) => p.allRequests.filter((r) => path(r) === "/Web/Book/GetBookProduct010001.json");

  it("2박 조회 단위는 밤마다 남은 수가 1 이상일 때 book_days 2와 end_date로 한 번 조회한다", async () => {
    const p = run("2026-10-15", { nights: 2 });
    await settle();
    expect(productRequests(p)).toHaveLength(1);
    expect(form(productRequests(p)[0]!)).toEqual({ product_group_code: "0001", start_date: "20261015", end_date: "20261016", book_days: "2", two_stay_days: "0" });
    expect(p.sent).toHaveLength(1);
    await p.stop();
  });

  it("2박 조회 단위의 둘째 밤 남은 수가 0이면 자리 조회 없이 빈 결과다", async () => {
    const server = xticketServer({ playDates: dates((d) => (d.play_date === "20261016" ? { ...d, book_remain_count: 0 } : d)) });
    const p = run("2026-10-15", { nights: 2, server });
    await settle();
    expect(p.allRequests.some((r) => path(r) === "/Web/Book/GetBookPlayDate.json")).toBe(true);
    expect(productRequests(p)).toHaveLength(0);
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("3박도 한 번 조회하고 서버가 고르지 못한다고 한 자리는 알리지 않는다", async () => {
    const server = xticketServer({ products: allProducts("0", "0") });
    const p = run("2026-10-15", { nights: 3, server });
    await settle();
    expect(form(productRequests(p)[0]!)).toMatchObject({ start_date: "20261015", end_date: "20261017", book_days: "3" });
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  const two = (aFirst = true) => {
    const a = watch("2026-10-15", "", ZONE, 1, "dalseo");
    const b = watch("2026-10-16", "", "0101", 1, "najeong");
    return configWith(aFirst ? a + b : b + a);
  };

  it("두 시설을 감시하면 시설마다 새 세션을 열고 앞 시설의 쿠키는 다음 시설 첫 요청에 실리지 않는다", async () => {
    const p = startPoller(() => ({ status: 404, body: "" }), { yaml: two(), server: xticketServer() });
    await settle();
    const mains = p.allRequests.filter((r) => path(r) === "/web/main" && !r.headers.Cookie);
    expect(mains.map((r) => new URL(r.url).searchParams.get("shopEncode"))).toEqual([XTICKET_DALSEO, XTICKET_NAJEONG]);
    const second = p.allRequests.indexOf(mains[1]!);
    expect(p.allRequests[second]!.headers.Cookie).toBeUndefined();
    // 각 시설의 POST는 그 시설의 main 뒤에, 그 시설의 세션 쿠키와 Referer로 나간다.
    const after = p.allRequests.slice(second);
    for (const r of after.filter((x) => x.method === "POST")) {
      expect(r.headers.Cookie).toBe("JSESSIONID=sess2");
      expect(r.headers.Referer).toContain(XTICKET_NAJEONG);
    }
    for (const r of p.allRequests.slice(0, second).filter((x) => x.method === "POST")) {
      expect(r.headers.Cookie).toBe("JSESSIONID=sess1");
      expect(r.headers.Referer).toContain(XTICKET_DALSEO);
    }
    expect(p.allRequests.slice(second).filter((r) => path(r) === "/Web/Book/GetBookProduct010001.json").map((r) => form(r).product_group_code)).toEqual(["0101"]);
    await p.stop();
  });

  it("첫 시설이 transient로 실패하면 두 번째 시설 요청은 나가지 않는다", async () => {
    const server = xticketServer({ intercept: (r) => (path(r) === "/Web/Book/GetBookPlayDate.json" ? { status: 503, body: "" } : undefined) });
    const p = startPoller(() => ({ status: 404, body: "" }), { yaml: two(), server });
    await settle();
    expect(p.allRequests.some((r) => r.url.includes(XTICKET_NAJEONG) || r.headers.Referer?.includes(XTICKET_NAJEONG))).toBe(false);
    expect(server.opened).toEqual([XTICKET_DALSEO]);
    expect(p.logs.some((l) => l.msg === "query failed" && l.fields?.kind === "transient")).toBe(true);
    await p.stop();
  });

  it("뒤 시설이 실패해도 앞 시설에서 이미 받은 빈자리는 알린다", async () => {
    const server = xticketServer({ intercept: (r) => (path(r) === "/Web/Book/GetBookPlayDate.json" && (r.headers.Referer ?? "").includes(XTICKET_NAJEONG) ? { status: 503, body: "" } : undefined) });
    const p = startPoller(() => ({ status: 404, body: "" }), { yaml: two(), server });
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("카라반-11");
    await p.stop();
  });
});

describe("xticket 신호 분류", () => {
  const failedKinds = (p: { logs: { msg: string; fields?: Record<string, unknown> }[] }) => p.logs.filter((l) => l.msg === "query failed").map((l) => l.fields?.kind);
  const onPath = (target: string, response: TransportResponse | ((r: TransportRequest) => TransportResponse)) => (r: TransportRequest) =>
    path(r) === target ? (typeof response === "function" ? response(r) : response) : undefined;
  const PLAY_DATE = "/Web/Book/GetBookPlayDate.json";
  const PRODUCT = "/Web/Book/GetBookProduct010001.json";
  const html = (body: string): TransportResponse => ({ status: 200, body });
  const PLAIN_ROUNDS = 300_000;

  it.each([
    ["error1 + redirect(로그인 요구)", html(JSON.stringify({ error1: { message: "로그인이 필요합니다." }, redirect: true, returnUrl: "/web/main" }))],
    ["로그인 화면 HTML", html('<html><form action="/Web/Member/MemberLogin.json"><input id="login_id"><input id="login_passwd"></form></html>')],
    ["HTTP 403", { status: 403, body: "" }],
    ["HTTP 429", { status: 429, body: "" }],
    ["차단 화면", html("<html><title>접근이 차단되었습니다</title><body>비정상적인 접근이 감지되어 차단되었습니다.</body></html>")],
    ["봇 탐지 스크립트", html('<html><script src="/botmanager/stclab.js"></script></html>')],
    ["captcha 요구", html('<html><img src="/Web/jcaptcha"></html>')],
  ])("%s는 곧바로 blocked로 멈추고 알린다", async (_name, response) => {
    const p = run("2026-10-15", { server: xticketServer({ intercept: onPath(PLAY_DATE, response) }) });
    await settle();
    expect(failedKinds(p)).toEqual(["blocked"]);
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toMatch(/차단|blocked/);
    const before = p.allRequests.length;
    await p.clock.advance(PLAIN_ROUNDS);
    await settle();
    expect(p.allRequests.length).toBe(before); // 멈췄으니 더 보내지 않는다.
    await p.stop();
  });

  it("시설 화면 리다이렉트가 로그인 경로로 가면 그 경로로 요청을 보내지 않고 blocked다", async () => {
    const server = xticketServer({ intercept: (r) => (path(r) === "/web/main" ? { status: 302, body: "", location: "/Web/Member/MemberLogin" } : undefined) });
    const p = run("2026-10-15", { server });
    await settle();
    expect(failedKinds(p)).toEqual(["blocked"]);
    expect(p.allRequests.some((r) => path(r).toLowerCase().startsWith("/web/member/"))).toBe(false);
    await p.stop();
  });

  it.each([
    ["HTML(로그인 표지 없음)", PLAY_DATE, html("<html><body>점검 중입니다</body></html>")],
    ["HTML(로그인·차단·captcha 단어만 있고 로그인 폼은 없음)", PLAY_DATE, html("<html><nav>로그인 | 회원가입</nav><p>차단 규정과 captcha 안내</p></html>")],
    ["자리 목록 자리에 온 일반 HTML(로그인 단어만 있음)", PRODUCT, html("<html><a href=\"/web/main\">로그인</a> 화면이 바뀌었습니다</html>")],
    ["data.bookPlayDateList 없음", PLAY_DATE, html(JSON.stringify({ data: {} }))],
    ["data.bookProductList 없음", PRODUCT, html(JSON.stringify({ data: { other: [] } }))],
    ["감시 상품군이 응답에서 사라짐(빈 자리 목록)", PRODUCT, html(JSON.stringify({ data: { bookProductList: [] } }))],
  ])("%s는 첫 바퀴에는 알리지 않고 2바퀴 연속이면 unrecognized로 멈추고 알린다", async (_name, target, response) => {
    const p = run("2026-10-15", { server: xticketServer({ intercept: onPath(target, response) }) });
    await settle();
    expect(failedKinds(p)).toEqual(["unrecognized"]);
    expect(p.sent).toHaveLength(0);
    await p.clock.advance(PLAIN_ROUNDS);
    await settle();
    expect(failedKinds(p)).toEqual(["unrecognized", "unrecognized"]);
    expect(p.sent).toHaveLength(1);
    const before = p.allRequests.length;
    await p.clock.advance(PLAIN_ROUNDS);
    await settle();
    expect(p.allRequests.length).toBe(before);
    await p.stop();
  });

  it("구조 변경이 한 바퀴로 끝나면 알림 없이 다음 바퀴에 정상으로 돌아온다", async () => {
    let broken = true;
    const server = xticketServer({ intercept: (r) => (broken && path(r) === PLAY_DATE ? html("{}") : undefined) });
    const p = run("2026-10-15", { server });
    await settle();
    broken = false;
    await p.clock.advance(PLAIN_ROUNDS);
    await settle();
    expect(failedKinds(p)).toEqual(["unrecognized"]);
    expect(p.sent).toHaveLength(1); // 정상으로 돌아와 선택가능 자리를 알린다.
    expect(p.sent[0]!.text).toContain("카라반-11");
    await p.stop();
  });

  it("세션 만료(error + redirect)는 구조 변경이 아니라 transient다", async () => {
    const expired = html(JSON.stringify({ error: { message: "세션이 만료되었습니다." }, returnUrl: "main?shopEncode=", redirect: true }));
    const p = run("2026-10-15", { server: xticketServer({ intercept: onPath(PLAY_DATE, expired) }) });
    await settle();
    expect(failedKinds(p)).toEqual(["transient"]);
    await p.stop();
  });

  it.each([
    ["GetBookPlayDate 5xx", PLAY_DATE, { status: 500, body: "" }],
    ["GetBookProduct 502", PRODUCT, { status: 502, body: "" }],
    ["시설 화면 503", "/web/main", { status: 503, body: "" }],
  ])("%s는 transient이고 알리지 않으며 기다렸다 다시 시도한다", async (_name, target, response) => {
    const p = run("2026-10-15", { server: xticketServer({ intercept: onPath(target, response) }) });
    await settle();
    expect(failedKinds(p)).toEqual(["transient"]);
    expect(p.sent).toHaveLength(0);
    await p.clock.advance(2 * PLAIN_ROUNDS);
    await settle();
    expect(failedKinds(p).length).toBeGreaterThanOrEqual(2); // 멈추지 않고 다시 시도했다.
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("연결 실패는 알리지 않고 멈추지 않는다", async () => {
    const server = xticketServer({
      intercept: (r) => {
        if (path(r) === PLAY_DATE) throw new Error("connect ECONNREFUSED");
        return undefined;
      },
    });
    const p = run("2026-10-15", { server });
    await settle();
    expect(failedKinds(p)).toHaveLength(1);
    expect(p.sent).toHaveLength(0);
    await p.clock.advance(2 * PLAIN_ROUNDS);
    await settle();
    expect(failedKinds(p).length).toBeGreaterThanOrEqual(2);
    await p.stop();
  });

  it("시설 세션이 열리지 않으면(리다이렉트 상한 초과) 첫 바퀴는 transient, 2바퀴 연속이면 unrecognized다", async () => {
    const loop = { status: 302, body: "", location: "/Web/Reservation?shop_encode=x" };
    const server = xticketServer({ intercept: (r) => (path(r) === "/web/main" || path(r) === "/Web/Reservation" ? loop : undefined) });
    const p = run("2026-10-15", { server });
    await settle();
    expect(failedKinds(p)).toEqual(["transient"]);
    expect(p.allRequests.some((r) => path(r).startsWith("/Web/Book/"))).toBe(false);
    await p.clock.advance(2 * PLAIN_ROUNDS); // transient 백오프 뒤
    await settle();
    expect(failedKinds(p)).toEqual(["transient", "unrecognized"]);
    await p.stop();
  });

  it("세션 열기가 한 번 성공하면 리다이렉트 상한 초과 횟수를 다시 센다", async () => {
    let looping = true;
    const loop = { status: 302, body: "", location: "/Web/Reservation?shop_encode=x" };
    const server = xticketServer({ intercept: (r) => (looping && (path(r) === "/web/main" || path(r) === "/Web/Reservation") ? loop : undefined) });
    const p = run("2026-10-15", { server });
    await settle();
    looping = false;
    await p.clock.advance(2 * PLAIN_ROUNDS);
    await settle();
    looping = true;
    await p.clock.advance(4 * PLAIN_ROUNDS);
    await settle();
    expect(failedKinds(p)).toEqual(["transient", "transient"]);
    await p.stop();
  });

  it("모르는 status_code는 로그 경고만 남기고 예약완료로 치며 같은 값은 다시 경고하지 않는다", async () => {
    const p = run("2026-10-15", { server: xticketServer({ products: allProducts("3", "1") }) });
    await settle();
    await p.clock.advance(PLAIN_ROUNDS);
    await settle();
    expect(p.sent).toHaveLength(0);
    expect(failedKinds(p)).toEqual([]);
    const warns = p.logs.filter((l) => l.msg === "xticket status_code drift");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.fields).toMatchObject({ facility: "dalseo", status_code: "3" });
    await p.stop();
  });

  it("아는 status_code(0, 1, 2)는 경고하지 않는다", async () => {
    const p = run("2026-10-15");
    await settle();
    expect(p.logs.some((l) => l.msg === "xticket status_code drift")).toBe(false);
    await p.stop();
  });
});

describe("xticket 설정", () => {
  const yaml = (watchBlock: string) => configWith(watchBlock);
  const problems = (text: string): string => {
    try {
      loadConfig(text, ENV);
    } catch (e) {
      if (e instanceof ConfigError) return e.message;
      throw e;
    }
    return "";
  };

  it("facility 없는 xticket 감시 조건은 위치와 쓸 수 있는 시설 코드와 함께 거부된다", () => {
    const msg = problems(yaml(`
  - name: 시설 빠짐
    provider: xticket
    zones: ["0001"]
    checkIn: { from: 2026-10-15, to: 2026-10-15 }
    notify: [default]`));
    expect(msg).toMatch(/\d+번째 줄 watches\.0\.facility: 시설을 골라야 한다\. 쓸 수 있는 값: dalseo/);
  });

  it("seats는 자리 목록이 없는 시설에서 위치와 함께 거부된다", () => {
    const msg = problems(yaml(`
  - name: 자리 지정
    provider: xticket
    facility: dalseo
    zones: ["0001"]
    seats: ["A01"]
    checkIn: { from: 2026-10-15, to: 2026-10-15 }
    notify: [default]`));
    expect(msg).toMatch(/\d+번째 줄 watches\.0\.seats: 0001은\(는\) 자리를 볼 수 없어 seats를 쓸 수 없다/);
  });

  it("상품군 코드로 구역을 고르고 없는 구역은 쓸 수 있는 값을 보이며 거부된다", () => {
    expect(problems(yaml(watch("2026-10-15", "", "0004")))).toBe("");
    expect(problems(yaml(watch("2026-10-15", "", "9999")))).toMatch(/없는 구역 "9999"다\. 쓸 수 있는 값: 0001, 0002, 0003, 0004/);
  });

  it("최대 박수는 시설마다 다르다: 달서는 3박, 나정은 2박이고 넘으면 위치와 함께 거부된다", () => {
    expect(problems(yaml(watch("2026-10-15", "", ZONE, 3)))).toBe("");
    expect(problems(yaml(watch("2026-10-15", "", ZONE, 4)))).toMatch(/\d+번째 줄 watches\.0\.nights: xticket는 최대 3박까지 예약할 수 있다\(설정값 4\)/);
    expect(problems(yaml(watch("2026-10-15", "", "0101", 2, "najeong")))).toBe("");
    expect(problems(yaml(watch("2026-10-15", "", "0101", 3, "najeong")))).toMatch(/\d+번째 줄 watches\.0\.nights: xticket는 최대 2박까지 예약할 수 있다\(설정값 3\)/);
  });
});

describe("xticket 시설별 최대 박수(기록한 shopInfo.book_days)", () => {
  const first = (facility: string, zone: string, nights: number) => {
    try {
      loadConfig(configWith(watch("2026-10-15", "", zone, nights, facility)), ENV);
    } catch (e) {
      if (e instanceof ConfigError) return e.message;
      throw e;
    }
    return "";
  };
  it.each([
    ["gyeongju-caravan", "0101", 2],
    ["gangdong", "0001", 3],
    ["aengbongsan", "0001", 2],
    ["gangnaru", "0002", 2],
  ])("%s는 %i박까지 받고 한 박 더는 거부한다", (facility, zone, max) => {
    expect(first(facility, zone, max)).toBe("");
    expect(first(facility, zone, max + 1)).toMatch(new RegExp(`최대 ${max}박까지`));
  });
});

describe("catalog xticket", () => {
  const run = async (facility?: string, live = false, server: (r: TransportRequest) => TransportResponse = () => ({ status: 404, body: "" }), now = "2026-10-12T08:00:00Z") => {
    const out: string[] = [];
    const err: string[] = [];
    const requests: TransportRequest[] = [];
    const code = await runCatalog(
      { kind: "catalog", provider: "xticket", ...(facility ? { facility } : {}), live },
      {
        adapters,
        transport: async (r) => (requests.push(r), server(r)),
        version: "0.1.0",
        now: () => new Date(now),
        sleep: async () => {},
        random: () => 0.5,
        out: (s) => void out.push(s),
        err: (s) => void err.push(s),
      },
    );
    return { code, out: out.join(""), err: err.join(""), requests };
  };

  it("시설이 하나여도 시설 목록을 먼저 보여 주고 요청은 보내지 않는다", async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^dalseo\s+달서별빛캠프 캠핑장\s+4곳$/m);
    expect(r.out).toMatch(/^najeong\s+나정고운모래해변 오토캠핑장\s+2곳$/m);
    expect(r.out).toMatch(/^gyeongju-caravan\s+경주시종합자원화단지 별빛카라반\s+3곳$/m);
    expect(r.out).toMatch(/^gangdong\s+강동그린웨이 가족캠핑장\s+3곳$/m);
    expect(r.out).toMatch(/^aengbongsan\s+앵봉산 가족캠핑장\s+2곳$/m);
    expect(r.out).toMatch(/^gangnaru\s+강나루 오토캠핑장\s+2곳$/m);
    expect(r.out).not.toMatch(/chilgokbo/);
    expect(r.requests).toEqual([]);
  });

  it.each([
    ["dalseo", 3],
    ["najeong", 2],
    ["gyeongju-caravan", 2],
    ["gangdong", 3],
  ])("%s 구역 표 머리글은 시설의 최대 박수 %i박을 보인다", async (facility, max) => {
    const r = await run(facility);
    expect(r.out).toMatch(new RegExp(`^xticket \\(최대 ${max}박\\)$`, "m"));
  });

  it("나정은 상품군 0101 카라반사이트와 0201 오토사이트를 구역으로 보여 준다", async () => {
    const r = await run("najeong");
    expect(r.out).toMatch(/^0101\s+카라반사이트/m);
    expect(r.out).toMatch(/^0201\s+오토사이트/m);
  });

  it.each([
    ["gyeongju-caravan", ["0101 카라반", "0401 글램핑", "0701 캠핑사이트"]],
    ["gangdong", ["0001 가족캠핑장", "0002 오토캠핑장", "0003 매화나무캠핑장"]],
    ["aengbongsan", ["0001 데크캠핑장", "0002 글램핑"]],
    ["gangnaru", ["0002 1캠핑장(오토캠핑60면)", "0003 2캠핑장(오토캠핑77면)"]],
  ])("%s는 기록한 상품군을 구역으로 보여 준다", async (facility, zones) => {
    const r = await run(facility);
    expect(r.code).toBe(0);
    for (const z of zones) expect(r.out.replace(/ +/g, " ")).toContain(z);
  });

  it("시설을 고르면 상품군 코드와 이름을 구역으로 보여 준다", async () => {
    const r = await run("dalseo");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^0001\s+카라반\s+카라반\s+-\s+\(고정 목록 없음\)$/m);
    expect(r.out).toMatch(/^0004\s+데크캠핑장/m);
  });
  describe("--live", () => {
    const live = (opts: Parameters<typeof xticketServer>[0] = {}, facility = "dalseo", now?: string) => run(facility, true, xticketServer(opts), now);

    it("시설 하나의 상품군과 자리를 카탈로그와 대조해 일치하면 종료 코드 0이다", async () => {
      const r = await live();
      expect(r.code).toBe(0);
      expect(r.out).toContain("실제 예약처와 비교");
      expect(r.out).toMatch(/0001: 고정 목록이 없다\. 실제 \d+자리/);
      expect(r.out).toContain("차이 없음");
      expect(r.err).toBe("");
    });

    it("내일(KST) 날짜로 세션을 열고 GetBookProductGroup 한 번, 상품군마다 GetBookProduct010001 한 번만 보낸다", async () => {
      const r = await live({}, "dalseo", "2026-10-12T16:30:00Z"); // KST 10/13 01:30 -> 내일은 10/14
      expect(r.requests.map(label)).toEqual([
        "GET /web/main",
        "GET /Web/Reservation",
        "GET /web/main",
        "POST /Web/Book/GetBookProductGroup.json",
        ...["0001", "0002", "0003", "0004"].map(() => "POST /Web/Book/GetBookProduct010001.json"),
      ]);
      expect(new URL(r.requests[0]!.url).searchParams.get("shopEncode")).toBe(XTICKET_DALSEO);
      expect(form(r.requests[3]!)).toEqual({ start_date: "20261014", end_date: "20261014" });
      const products = r.requests.filter((q) => path(q) === "/Web/Book/GetBookProduct010001.json").map(form);
      expect(products.map((f) => f.product_group_code)).toEqual(["0001", "0002", "0003", "0004"]);
      for (const f of products) expect(f).toEqual({ product_group_code: f.product_group_code, start_date: "20261014", end_date: "20261014", book_days: "1", two_stay_days: "0" });
      for (const q of r.requests) expect(q.headers["User-Agent"]).toMatch(/^overlord-availability-poller\//);
    });

    it("카탈로그에 있는 상품군이 예약처에서 사라지면 보고하고 종료 코드는 0이다(조회는 성공했다)", async () => {
      const r = await live({ groups: (f, shop) => xticketGroups(f, shop).filter((g) => g.product_group_code !== "0003") });
      expect(r.out).toContain("0003: 예약처 응답에 구역이 없다(숲속캠핑장)");
      expect(r.out).toContain("차이 있는 구역 1곳");
      expect(r.code).toBe(0);
    });

    it("예약처에 새로 생긴 상품군을 보고한다", async () => {
      const r = await live({
        groups: (f, shop) => [...xticketGroups(f, shop), { product_group_code: "0005", product_group_name: "글램핑" }],
      });
      expect(r.out).toContain("예약처에 새로 생긴 구역 글램핑(0005)");
      expect(r.code).toBe(0);
    });

    it("상품군 이름은 같고 코드가 바뀌면 코드 차이를 보고한다", async () => {
      const r = await live({
        groups: (f, shop) => xticketGroups(f, shop).map((g) => (g.product_group_code === "0004" ? { ...g, product_group_code: "0009" } : g)),
      });
      expect(r.out).toContain("구역 코드가 다르다(카탈로그 0004, 예약처 0009)");
    });

    it("조회가 실패하면 종료 코드 1이다", async () => {
      const r = await live({ intercept: (q) => (path(q) === "/Web/Book/GetBookProductGroup.json" ? { status: 503, body: "" } : undefined) });
      expect(r.code).toBe(1);
      expect(r.out).toContain("조회 실패(transient)");
    });

    it("로그인·차단 신호가 오면 조회 실패로 보고하고 더 보내지 않는다", async () => {
      const r = await live({ intercept: (q) => (path(q) === "/Web/Book/GetBookProductGroup.json" ? { status: 403, body: "" } : undefined) });
      expect(r.code).toBe(1);
      expect(r.out).toContain("조회 실패(blocked)");
      expect(r.requests.filter((q) => path(q) === "/Web/Book/GetBookProduct010001.json")).toHaveLength(0);
    });

    it("연결이 끊겨도 조회 실패로 보고한다", async () => {
      const r = await live({
        intercept: (q) => {
          if (path(q) === "/Web/Book/GetBookProductGroup.json") throw new Error("connect ECONNREFUSED");
          return undefined;
        },
      });
      expect(r.code).toBe(1);
      expect(r.out).toContain("조회 실패");
    });

    it("나정은 자기 상품군(0101, 0201)으로 대조한다", async () => {
      const r = await live({}, "najeong");
      expect(r.code).toBe(0);
      expect(r.out).toContain("차이 없음");
      expect(new URL(r.requests[0]!.url).searchParams.get("shopEncode")).toBe(XTICKET_NAJEONG);
    });
  });
});
