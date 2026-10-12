import { describe, expect, it } from "vitest";
import { adapters } from "../src/adapters/index.js";
import { runCatalog } from "../src/commands.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { ENV, XTICKET_DALSEO, XTICKET_NAJEONG, configWith, settle, startPoller, xticketPlayDates, xticketProducts, xticketServer } from "./harness.js";
import type { XticketPlayDate, XticketProduct } from "./harness.js";
import type { TransportRequest } from "../src/types.js";

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

describe("catalog xticket", () => {
  const run = async (facility?: string, live = false) => {
    const out: string[] = [];
    const err: string[] = [];
    const requests: TransportRequest[] = [];
    const code = await runCatalog(
      { kind: "catalog", provider: "xticket", ...(facility ? { facility } : {}), live },
      {
        adapters,
        transport: async (r) => (requests.push(r), { status: 404, body: "" }),
        version: "0.1.0",
        now: () => new Date("2026-10-12T08:00:00Z"),
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
    expect(r.out).not.toMatch(/chilgokbo/);
    expect(r.requests).toEqual([]);
  });

  it("나정은 상품군 0101 카라반사이트와 0201 오토사이트를 구역으로 보여 준다", async () => {
    const r = await run("najeong");
    expect(r.out).toMatch(/^0101\s+카라반사이트/m);
    expect(r.out).toMatch(/^0201\s+오토사이트/m);
  });

  it("시설을 고르면 상품군 코드와 이름을 구역으로 보여 준다", async () => {
    const r = await run("dalseo");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^0001\s+카라반\s+카라반\s+-\s+\(고정 목록 없음\)$/m);
    expect(r.out).toMatch(/^0004\s+데크캠핑장/m);
  });
});
