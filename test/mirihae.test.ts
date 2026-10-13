import { describe, expect, it } from "vitest";
import { adapters } from "../src/adapters/index.js";
import { runCatalog } from "../src/commands.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { createHttpClient } from "../src/http.js";
import type { TransportRequest } from "../src/types.js";
import { ENV, MIRIHAE_ENTERING_TOKEN, MIRIHAE_WAITING_TOKEN, configWith, mirihaePageWith, mirihaeServer, settle, startPoller } from "./harness.js";

// 천동 오토캠핑장(danyang-cheondong, /dytc/camping/V39628874)의 기록한 응답(2026-10-13 09:24 ~ 09:31 KST, research/raw/mirihae)을 fixture로 쓴다.
// 기록한 이번 달(2026-10) 화면은 10/14 ~ 10/31 칸이 모두 click이고 10/14는 야영장A 18, 야영장B 18, 야영장C 29다. 10/13(오늘)과 그 앞 칸에는 click이 없다.
// 게이트의 425(대기 중)는 기록하지 못했다. waiting.js를 읽은 모양으로 만든 응답이고 기록이 아니다.
// 가짜 시계는 기록한 때(2026-10-13 09:30 KST)다.
const NOW = "2026-10-13T09:30:00+09:00";
const PAGE = "https://mirihae.com/dytc/camping/V39628874";

const watch = (checkIn: { from: string; to?: string }, zones: string[] = ["야영장A"], facility = "danyang-cheondong") => `
  - name: 천동 ${checkIn.from}
    provider: mirihae
    facility: ${facility}
    zones: [${zones.join(", ")}]
    checkIn: { from: ${checkIn.from}, to: ${checkIn.to ?? checkIn.from} }
    nights: 1
    notify: [default]`;

const run = (
  checkIn: { from: string; to?: string },
  opts: { server?: ReturnType<typeof mirihaeServer>; zones?: string[]; random?: () => number; now?: string } = {},
) =>
  startPoller(() => ({ status: 404, body: "" }), {
    yaml: configWith(watch(checkIn, opts.zones)),
    server: opts.server ?? mirihaeServer(),
    random: opts.random,
    now: opts.now ?? NOW,
  });

describe("미리해 폴러", () => {
  it("남은 수가 있는 구역·날짜는 구역 이름, 남은 수, 딥링크가 담긴 메시지 한 건으로 알린다", async () => {
    const p = run({ from: "2026-10-14" });
    await settle();
    expect(p.sent).toHaveLength(1);
    const text = p.sent[0]!.text;
    expect(text).toContain("2026-10-14(수) 1박 · 야영장A · 남은 18");
    expect(text).not.toContain("야영장B"); // 감시 구역이 아니다
    expect(JSON.stringify(p.sent[0]!.reply_markup)).toContain(PAGE);
    expect(JSON.stringify(p.sent[0]!.reply_markup)).not.toContain("gateToken"); // 게이트는 사람이 거친다
    await p.stop();
  });

  describe("알림 규칙", () => {
    /** 화면이 돌려주는 10/14 야영장A 남은 수를 바꿀 수 있는 서버. */
    const changing = (state: { remaining: number }) =>
      mirihaeServer({ page: () => ({ status: 200, body: mirihaePageWith({ "2026-10-14": { 야영장A: state.remaining } }) }) });

    it("남은 수가 바뀌어도 다시 알리지 않는다", async () => {
      const state = { remaining: 18 };
      const p = run({ from: "2026-10-14" }, { server: changing(state) });
      await settle();
      expect(p.sent).toHaveLength(1);
      state.remaining = 17;
      await p.clock.advance(300_000);
      await settle();
      expect(p.allRequests.filter((r) => r.url.includes("gateToken"))).toHaveLength(2); // 둘째 바퀴도 읽었다
      expect(p.sent).toHaveLength(1);
      await p.stop();
    });

    it("남은 수가 0이 된 뒤 다시 생기면 다시 알린다", async () => {
      const state = { remaining: 18 };
      const p = run({ from: "2026-10-14" }, { server: changing(state) });
      await settle();
      expect(p.sent).toHaveLength(1);
      state.remaining = 0;
      await p.clock.advance(300_000);
      await settle();
      expect(p.sent).toHaveLength(1); // 0이 된 것은 알리지 않는다
      state.remaining = 3;
      await p.clock.advance(300_000);
      await settle();
      expect(p.sent).toHaveLength(2);
      expect(p.sent[1]!.text).toContain("2026-10-14(수) 1박 · 야영장A · 남은 3");
      await p.stop();
    });

    it("남은 수가 0인 구역과 click이 없는 날짜는 알리지 않고 실패로 치지 않는다", async () => {
      // 10/20 칸에서 click만 뺀다(남은 수는 그대로 있다). click이 없는 날짜는 모든 구역이 빈자리 없음이다.
      const noClick = mirihaeServer({ page: () => ({ status: 200, body: mirihaePageWith({}, ($) => void $('div.td[id="2026-10-20"]').removeClass("click")) }) });
      const closed = run({ from: "2026-10-20" }, { server: noClick });
      await settle();
      expect(closed.allRequests).toHaveLength(6);
      expect(closed.sent).toHaveLength(0);
      expect(closed.logs.filter((l) => l.msg === "query failed")).toEqual([]);
      await closed.stop();
      const soldOut = run({ from: "2026-10-14" }, { server: changing({ remaining: 0 }) });
      await settle();
      expect(soldOut.sent).toHaveLength(0);
      expect(soldOut.logs.filter((l) => l.msg === "query failed")).toEqual([]);
      await soldOut.stop();
    });
  });

  describe("게이트 요청 흐름", () => {
    const line = (r: { method: string; url: string }) => {
      const u = new URL(r.url);
      return `${r.method} ${u.host}${u.pathname}`;
    };

    it("예약 화면 302 → /api/entering 401 → POST /api/waiting → GET /api/waiting 200 → /api/entering 200 → gateToken을 붙인 예약 화면 순서이고 리다이렉트는 따라가지 않는다", async () => {
      const p = run({ from: "2026-10-14" });
      await settle();
      expect(p.allRequests.map(line)).toEqual([
        "GET mirihae.com/dytc/camping/V39628874",
        "GET cdn.mirihae.com/api/entering",
        "POST cdn.mirihae.com/api/waiting",
        "GET cdn.mirihae.com/api/waiting",
        "GET cdn.mirihae.com/api/entering",
        "GET mirihae.com/dytc/camping/V39628874",
      ]); // 게이트 화면(cdn.mirihae.com:9443/entering.html)은 부르지 않는다
      const urls = p.allRequests.map((r) => r.url);
      const uri = encodeURIComponent(PAGE);
      expect(urls[0]).toBe(PAGE);
      expect(urls[1]).toBe(`https://cdn.mirihae.com/api/entering?uri=${uri}`);
      expect(urls[2]).toBe(`https://cdn.mirihae.com/api/waiting?uri=${uri}`);
      expect(urls[3]).toBe(`https://cdn.mirihae.com/api/waiting?uri=${uri}`);
      expect(urls[4]).toBe(`https://cdn.mirihae.com/api/entering?uri=${uri}`);
      expect(urls[5]).toBe(`${PAGE}?gateToken=${MIRIHAE_ENTERING_TOKEN}`);
      await p.stop();
    });

    it("대기 토큰과 입장 토큰은 페이지 JS처럼 헤더로 싣고, 입장 토큰은 쿠키에도 심는다", async () => {
      const p = run({ from: "2026-10-14" });
      await settle();
      const [, entering1, waitingPost, waitingGet, entering2, page] = p.allRequests;
      expect(entering1!.headers["X-Mirihae-Waiting-Token"]).toBeUndefined();
      expect(entering1!.headers["X-Mirihae-Reservation-Token"]).toBeUndefined();
      expect(waitingPost!.body).toBe("");
      expect(waitingGet!.headers["X-Mirihae-Waiting-Token"]).toBe(MIRIHAE_WAITING_TOKEN);
      expect(entering2!.headers["X-Mirihae-Reservation-Token"]).toBe(MIRIHAE_ENTERING_TOKEN);
      expect(entering2!.headers.Cookie).toContain(`X-Mirihae-Reservation-Token=${MIRIHAE_ENTERING_TOKEN}`);
      expect(page!.headers.Cookie ?? "").not.toContain("X-Mirihae-Reservation-Token"); // 쿠키는 게이트(cdn.mirihae.com)에만 간다
      await p.stop();
    });

    it("모든 요청에 정직한 UA만 붙는다", async () => {
      const p = run({ from: "2026-10-14" });
      await settle();
      expect(p.allRequests).not.toHaveLength(0);
      for (const r of p.allRequests) expect(r.headers["User-Agent"]).toBe("overlord-availability-poller/0.1.0 (ops)");
      await p.stop();
    });

    it("게이트 요청은 간격 큐 밖에서 보내고 예약 화면 요청 둘 사이만 5초 + 지터 간격이다", async () => {
      const p = run({ from: "2026-10-14" }); // random 0.5: 6.5초
      await settle();
      const t = p.requestTimes;
      expect(t[1]! - t[0]!).toBe(0); // 302 직후 게이트 요청은 기다리지 않는다
      expect(t[2]! - t[1]!).toBe(0);
      expect(t[3]! - t[2]!).toBe(0);
      expect(t[4]! - t[3]!).toBe(0);
      expect(t[5]! - t[0]!).toBe(6_500); // 예약 화면 두 요청 사이
      await p.stop();
    });

    it("바퀴마다 게이트를 새로 지난다", async () => {
      const p = run({ from: "2026-10-14" });
      await settle();
      expect(p.allRequests).toHaveLength(6);
      await p.clock.advance(300_000);
      await settle();
      expect(p.allRequests.map(line).slice(6)).toEqual(p.allRequests.map(line).slice(0, 6));
      // 둘째 바퀴 첫 입장 요청에 지난 바퀴의 토큰이 실리지 않는다.
      expect(p.allRequests[7]!.headers["X-Mirihae-Reservation-Token"]).toBeUndefined();
      expect(p.allRequests[7]!.headers.Cookie ?? "").not.toContain("X-Mirihae-Reservation-Token");
      await p.stop();
    });
  });

  describe("게이트 신호 분류", () => {
    const failedKinds = (p: ReturnType<typeof run>) => p.logs.filter((l) => l.msg === "query failed").map((l) => l.fields?.kind);
    const gateToken = (p: ReturnType<typeof run>) => p.allRequests.some((r) => r.url.includes("gateToken"));
    const status = (code: number, body = "") => ({ status: code, body });

    it.each([
      { title: "/api/entering이 500", code: 500, kind: "transient" },
      { title: "/api/entering이 403(사전 대기, 예약 개시 전 막는 구간)", code: 403, kind: "unavailable" },
      { title: "/api/entering이 404", code: 404, kind: "unrecognized" },
      { title: "/api/entering이 200·401·403·404 밖의 응답(502)", code: 502, kind: "transient" },
      { title: "/api/entering이 200·401·403·404 밖의 응답(418)", code: 418, kind: "transient" },
    ])("$title 이면 임의 토큰으로 넘어가지 않고 예약 화면 요청 없이 그 바퀴가 $kind 다", async ({ code, kind }) => {
      const server = mirihaeServer({ entering: (n) => (n === 0 ? status(code) : undefined) });
      const p = run({ from: "2026-10-14" }, { server });
      await settle();
      expect(failedKinds(p)).toEqual([kind]);
      expect(gateToken(p)).toBe(false); // `entering.js`가 실패 때 붙이는 임의 UUID gateToken 경로는 없다
      expect(p.allRequests.filter((r) => r.url.startsWith(PAGE))).toHaveLength(1); // 첫 302 요청 하나뿐이다
      expect(p.sent.filter((m) => m.text.includes("빈자리"))).toHaveLength(0);
      await p.stop();
    });

    it("게이트 403(사전 대기)은 예약처가 일부러 막은 것이라 30분 뒤에 다시 본다", async () => {
      const p = run({ from: "2026-10-14" }, { server: mirihaeServer({ entering: (n) => (n === 0 || n === 1 ? status(403) : undefined) }) });
      await settle();
      expect(failedKinds(p)).toEqual(["unavailable"]);
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0]!.text).toContain("점검 중");
      const before = p.allRequests.length;
      await p.clock.advance(29 * 60_000);
      await settle();
      expect(p.allRequests).toHaveLength(before); // 기본 폴링 간격(300초)이 아니라 30분이다
      await p.clock.advance(61_000);
      await settle();
      expect(p.allRequests.length).toBeGreaterThan(before);
      await p.stop();
    });

    it("/api/entering이 302를 주어도 따라가지 않고 transient다", async () => {
      const server = mirihaeServer({ entering: (n) => (n === 0 ? { status: 302, body: "", location: `${PAGE}?gateToken=${crypto.randomUUID()}` } : undefined) });
      const p = run({ from: "2026-10-14" }, { server });
      await settle();
      expect(failedKinds(p)).toEqual(["transient"]);
      expect(gateToken(p)).toBe(false);
      await p.stop();
    });

    it.each([
      { title: "POST /api/waiting이 403(사전 대기)", opts: { waitingPost: () => status(403) }, kind: "unavailable" },
      { title: "POST /api/waiting이 500", opts: { waitingPost: () => status(500) }, kind: "transient" },
      { title: "POST /api/waiting이 대기 토큰 없이 200", opts: { waitingPost: () => status(200, "") }, kind: "transient" },
      { title: "GET /api/waiting이 403(사전 대기)", opts: { waiting: () => status(403) }, kind: "unavailable" },
      { title: "GET /api/waiting이 500", opts: { waiting: () => status(500) }, kind: "transient" },
      { title: "GET /api/waiting이 예상 밖 401", opts: { waiting: () => status(401) }, kind: "transient" },
      { title: "GET /api/waiting 200의 본문에 입장 토큰이 없음", opts: { waiting: () => status(200, "{}") }, kind: "unrecognized" },
      { title: "대기를 마친 뒤 /api/entering이 다시 401", opts: { entering: (n: number) => (n === 1 ? status(401) : undefined) }, kind: "transient" },
      { title: "대기를 마친 뒤 /api/entering이 500", opts: { entering: (n: number) => (n === 1 ? status(500) : undefined) }, kind: "transient" },
      { title: "대기를 마친 뒤 /api/entering 200의 본문에 입장 토큰이 없음", opts: { entering: (n: number) => (n === 1 ? status(200, "{}") : undefined) }, kind: "unrecognized" },
    ])("$title 이면 예약 화면 요청 없이 그 바퀴가 $kind 다", async ({ opts, kind }) => {
      const p = run({ from: "2026-10-14" }, { server: mirihaeServer(opts) });
      await settle();
      expect(failedKinds(p)).toEqual([kind]);
      expect(gateToken(p)).toBe(false);
      expect(p.sent.filter((m) => m.text.includes("빈자리"))).toHaveLength(0);
      await p.stop();
    });

    it("게이트 연결 실패는 transient이고 예약 화면 요청이 나가지 않는다", async () => {
      const server = mirihaeServer({
        intercept: (req) => {
          if (req.url.startsWith("https://cdn.mirihae.com/api/entering")) throw new TypeError("fetch failed");
          return undefined;
        },
      });
      const p = run({ from: "2026-10-14" }, { server });
      await settle();
      expect(failedKinds(p)).toEqual(["transient"]);
      expect(gateToken(p)).toBe(false);
      await p.stop();
    });

    it("예약 화면의 첫 요청이 게이트로 보내지 않으면(302가 아님) unrecognized다", async () => {
      const server = mirihaeServer({ intercept: (req) => (req.url === PAGE ? { status: 200, body: "<html></html>" } : undefined) });
      const p = run({ from: "2026-10-14" }, { server });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      expect(p.allRequests).toHaveLength(1);
      await p.stop();
    });

    describe("대기(425)", () => {
      const waiting425 = (order: number) => ({
        status: 425,
        body: JSON.stringify({ timestamp: 1791851162424, status: 425, message: JSON.stringify({ order, estimatedWaitSeconds: 25, throughput: 2 }) }),
      });

      it("425이면 10초 뒤 다시 확인하고 200이 오면 입장한다", async () => {
        const p = run({ from: "2026-10-14" }, { server: mirihaeServer({ waiting: (n) => (n < 2 ? waiting425(5 - n) : undefined) }) });
        await settle();
        const waits = () => p.allRequests.filter((r) => r.method === "GET" && r.url.startsWith("https://cdn.mirihae.com/api/waiting"));
        expect(waits()).toHaveLength(1);
        await p.clock.advance(9_999);
        expect(waits()).toHaveLength(1);
        await p.clock.advance(1);
        await settle();
        expect(waits()).toHaveLength(2);
        expect(p.requestTimes[p.allRequests.indexOf(waits()[1]!)]! - p.requestTimes[p.allRequests.indexOf(waits()[0]!)]!).toBe(10_000);
        await p.clock.advance(10_000);
        await settle();
        expect(waits()).toHaveLength(3);
        // 대기 토큰은 같은 것을 계속 싣고, 입장 뒤에 게이트 요청이 이어진다.
        for (const w of waits()) expect(w.headers["X-Mirihae-Waiting-Token"]).toBe(MIRIHAE_WAITING_TOKEN);
        expect(p.sent).toHaveLength(1);
        expect(p.allRequests.some((r) => r.url.includes(`gateToken=${MIRIHAE_ENTERING_TOKEN}`))).toBe(true);
        await p.stop();
      });

      it("425가 120초 넘게 이어지면 그 바퀴는 transient로 끝나고 예약 화면 요청이 나가지 않는다", async () => {
        const p = run({ from: "2026-10-14" }, { server: mirihaeServer({ waiting: () => waiting425(9) }) });
        await settle();
        for (let i = 0; i < 13; i++) {
          await p.clock.advance(10_000);
          await settle();
        }
        expect(failedKinds(p)).toEqual(["transient"]);
        expect(p.logs.find((l) => l.msg === "query failed")!.fields?.message).toMatch(/120초/);
        expect(gateToken(p)).toBe(false);
        const polls = p.allRequests.filter((r) => r.method === "GET" && r.url.startsWith("https://cdn.mirihae.com/api/waiting")).length;
        expect(polls).toBeLessThanOrEqual(13); // 120초 안에 10초 간격이다
        expect(p.sent).toHaveLength(0);
        await p.stop();
      });
    });
  });

  describe("예약 화면 신호 분류", () => {
    const failedKinds = (p: ReturnType<typeof run>) => p.logs.filter((l) => l.msg === "query failed").map((l) => l.fields?.kind);
    const failedMessages = (p: ReturnType<typeof run>) => p.logs.filter((l) => l.msg === "query failed").map((l) => String(l.fields?.message));
    const pageServer = (res: (() => { status: number; body: string; location?: string }) | string) =>
      mirihaeServer({ page: () => (typeof res === "string" ? { status: 200, body: res } : res()) });
    const edited = (edit: ($: Parameters<NonNullable<Parameters<typeof mirihaePageWith>[1]>>[0]) => void) => mirihaePageWith({}, edit);

    it.each([
      { title: "HTTP 403", status: 403, kind: "blocked" },
      { title: "HTTP 429", status: 429, kind: "blocked" },
      { title: "HTTP 503", status: 503, kind: "transient" },
      { title: "예상 밖 HTTP 404", status: 404, kind: "unrecognized" },
    ])("예약 화면이 $title 이면 $kind 다", async ({ status, kind }) => {
      const p = run({ from: "2026-10-14" }, { server: pageServer(() => ({ status, body: "" })) });
      await settle();
      expect(failedKinds(p)).toEqual([kind]);
      await p.stop();
    });

    it("예약 화면이 로그인 경로로 리다이렉트하면 로그인 경로로 요청을 보내지 않고 blocked다", async () => {
      const p = run({ from: "2026-10-14" }, { server: pageServer(() => ({ status: 302, body: "", location: "https://mirihae.com/dytc/login.do" })) });
      await settle();
      expect(failedKinds(p)).toEqual(["blocked"]);
      expect(p.allRequests.some((r) => r.url.includes("login"))).toBe(false);
      expect(p.sent[0]!.text).toMatch(/차단/);
      await p.stop();
    });

    it("받은 입장 토큰을 서버가 게이트로 되돌려 보내면(거절) 그 화면을 따라가지 않고 transient다", async () => {
      const p = run({ from: "2026-10-14" }, { server: pageServer(() => ({ status: 302, body: "", location: `https://cdn.mirihae.com:9443/entering.html?uri=${PAGE}` })) });
      await settle();
      expect(failedKinds(p)).toEqual(["transient"]);
      expect(p.allRequests.some((r) => r.url.includes(":9443"))).toBe(false);
      await p.stop();
    });

    it("달력 대신 로그인 화면이 오면 blocked다", async () => {
      const login = '<html><body><form action="/dytc/login.do" method="post"><input type="text" name="id"><input type="password" name="pw"></form></body></html>';
      const p = run({ from: "2026-10-14" }, { server: pageServer(login) });
      await settle();
      expect(failedKinds(p)).toEqual(["blocked"]);
      await p.stop();
    });

    it("예약 화면에 봇 탐지 장치·captcha 표지가 보이면 blocked로 멈춘다", async () => {
      const page = edited(($) => void $("body").append('<script src="https://cdn-botmanager.example/agent.js"></script>'));
      const p = run({ from: "2026-10-14" }, { server: pageServer(page) });
      await settle();
      expect(failedKinds(p)).toEqual(["blocked"]);
      expect(p.sent[0]!.text).toMatch(/차단/);
      await p.stop();
    });

    it("달력 칸이 없으면 unrecognized이고 두 바퀴 연속이면 멈추고 알린다", async () => {
      const p = run({ from: "2026-10-14" }, { server: pageServer("<html><body>점검 중</body></html>") });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      expect(p.sent).toHaveLength(0); // 첫 바퀴는 아직 알리지 않는다
      await p.clock.advance(300_000);
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized", "unrecognized"]);
      expect(p.sent.map((m) => m.text).join("\n")).toMatch(/구조가 바뀌/);
      await p.stop();
    });

    it.each([
      { title: "달 표시(10월)가 사라짐", edit: ($: Parameters<Parameters<typeof edited>[0]>[0]) => void $(".pignose-calendar-top-month").remove() },
      { title: "날짜 칸의 id가 사라짐", edit: ($: Parameters<Parameters<typeof edited>[0]>[0]) => void $("div.td.pignose-calendar-unit-date").removeAttr("id") },
      { title: "남은 수(dt)가 숫자가 아님", edit: ($: Parameters<Parameters<typeof edited>[0]>[0]) => void $('div.td[id="2026-10-14"] dl.schedule dt').first().text("매진") },
      { title: "남은 수(dt)가 비어 있음", edit: ($: Parameters<Parameters<typeof edited>[0]>[0]) => void $('div.td[id="2026-10-20"] dl.schedule dt').first().text("") },
      { title: "구역 이름(dd)이 사라짐", edit: ($: Parameters<Parameters<typeof edited>[0]>[0]) => void $('div.td[id="2026-10-20"] dl.schedule dd').first().remove() },
    ])("$title 이면 빈자리 없음이 아니라 unrecognized이고 알리지 않는다", async ({ edit }) => {
      const p = run({ from: "2026-10-14" }, { server: pageServer(edited(edit)) });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      expect(p.sent).toHaveLength(0);
      await p.stop();
    });

    it("감시하는 구역이 감시하는 날짜의 칸에서 사라지면 unrecognized다", async () => {
      const page = edited(($) => void $('div.td[id="2026-10-14"] dl.schedule').filter((_, el) => $(el).find("dd").text().trim() === "야영장A").remove());
      const p = run({ from: "2026-10-14" }, { server: pageServer(page) });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      expect(failedMessages(p)[0]).toMatch(/야영장A/);
      expect(p.sent).toHaveLength(0);
      await p.stop();
    });

    it("한 조회 단위의 구조 변경은 그 단위만 실패로 치고 같은 화면에서 읽은 다른 날짜의 알림은 나간다", async () => {
      const page = edited(($) => void $('div.td[id="2026-10-15"] dl.schedule').filter((_, el) => $(el).find("dd").text().trim() === "야영장A").remove());
      const p = run({ from: "2026-10-14", to: "2026-10-15" }, { server: pageServer(page) });
      await settle();
      expect(p.allRequests.filter((r) => r.url.includes("gateToken"))).toHaveLength(1); // 화면은 한 번만 받는다
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      expect(p.sent.map((m) => m.text).join("\n")).toContain("2026-10-14(수) 1박 · 야영장A · 남은 18");
      await p.stop();
    });

    it("쓰지 않는 구역이 사라지거나 새 구역이 생긴 것은 실패가 아니라 로그 경고만 남기고 한 번만 남긴다", async () => {
      const page = edited(($) => {
        $("div.td.click dl.schedule").filter((_, el) => $(el).find("dd").text().trim() === "야영장C").remove(); // 야영장C가 사라짐
        $('div.td[id="2026-10-14"] div.district').append('<dl class="schedule color4 "><dt>5</dt><dd>야영장D</dd></dl>'); // 새 구역
      });
      const p = run({ from: "2026-10-14" }, { server: pageServer(page) });
      await settle();
      expect(failedKinds(p)).toEqual([]);
      expect(p.sent).toHaveLength(1);
      expect(p.logs.filter((l) => l.msg === "mirihae zone drift").map((l) => l.fields)).toEqual([
        { facility: "danyang-cheondong", change: "new", zone: "야영장D" },
        { facility: "danyang-cheondong", change: "gone", zone: "야영장C" },
      ]);
      await p.clock.advance(300_000);
      await settle();
      expect(p.logs.filter((l) => l.msg === "mirihae zone drift")).toHaveLength(2);
      await p.stop();
    });
  });

  describe("이번 달만 읽는다", () => {
    it("이번 달 밖의 입실일은 빈자리 없음이고 이번 달 날짜와 함께 걸려도 예약 화면은 한 번만 받으며 calendar.do를 부르지 않는다", async () => {
      const p = run({ from: "2026-10-30", to: "2026-11-02" });
      await settle();
      expect(p.allRequests.filter((r) => r.url.includes("gateToken"))).toHaveLength(1);
      expect(p.allRequests.some((r) => r.url.includes("calendar.do"))).toBe(false);
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0]!.text).toContain("2026-10-30(금)");
      expect(p.sent[0]!.text).not.toContain("2026-11-0");
      expect(p.logs.filter((l) => l.msg === "query failed")).toEqual([]);
      await p.stop();
    });

    it("이번 달 밖의 날짜만 걸린 감시 조건은 게이트도 예약 화면도 요청하지 않는다", async () => {
      const p = run({ from: "2026-11-02", to: "2026-11-03" });
      await settle();
      expect(p.allRequests).toHaveLength(0);
      expect(p.sent).toHaveLength(0);
      await p.stop();
    });
  });

  describe("요청 매너", () => {
    // 접근 금지 경로(스펙): 날짜·구역을 고른 뒤의 호출, 예약확인/취소, 로그인, 결제·회원.
    const forbidden = [
      "/camping/tokenCheck.do",
      "/camping/initSelectReservation.do",
      "/camping/updateSelctItemticketCntChange.do",
      "/camping/deSelectTicket.do",
      "/camping/nightCheck.do",
      "/camping/selectItemList.do",
      "/camping/selectItemForm.do",
      "/camping/reservationForm.do",
      "/camping/selectAjaxDatePinInfo.do",
      "/camping/paymentForm.do",
      "/dytc/camping/reservation/",
      "/login.do",
      "/dytc/login.do",
      "/logout.do",
      "/mypage.do",
    ];

    it("접근 금지 경로로는 요청이 나가지 않고 게이트 호스트에서는 /api/entering과 /api/waiting만 부른다", async () => {
      const p = run({ from: "2026-10-14", to: "2026-10-31" });
      await settle();
      expect(p.allRequests.length).toBeGreaterThan(0);
      for (const r of p.allRequests) {
        const u = new URL(r.url);
        expect(forbidden.some((f) => u.pathname.toLowerCase().startsWith(f.toLowerCase())), r.url).toBe(false);
        if (u.hostname === "cdn.mirihae.com") expect(["/api/entering", "/api/waiting"], r.url).toContain(u.pathname);
        else expect(u.hostname).toBe("mirihae.com");
      }
      await p.stop();
    });

    it("날짜·구역 선택 뒤 호출, 예약확인/취소, 로그인, 결제 경로는 HTTP 층이 막고 예약 화면과 달력 조회는 막지 않는다", async () => {
      const sent: string[] = [];
      const http = createHttpClient({
        transport: async (r: TransportRequest) => (sent.push(r.url), { status: 200, body: "" }),
        version: "0.1.0",
        userAgentSuffix: "",
        blockedPaths: adapters.mirihae!.describe().blockedPaths,
        cookieSession: true,
      });
      const origin = "https://mirihae.com";
      for (const blocked of [...forbidden, "/CAMPING/tokenCheck.do", "/camping/tokenCheck.do?x=1", "/dytc/camping/reservation/list.do"]) {
        await expect(http.post(`${origin}${blocked}`, "a=1"), blocked).rejects.toThrow(/접근 금지/);
      }
      expect(sent).toEqual([]);
      await http.get(`${origin}/dytc/camping/V39628874`);
      await http.get("https://cdn.mirihae.com/api/entering?uri=x");
      await http.post("https://cdn.mirihae.com/api/waiting?uri=x", "");
      await http.post(`${origin}/camping/calendar.do`, "selectMonth=2026-11");
      expect(sent).toHaveLength(4);
    });

    it("기본 폴링 간격은 300초이고 오픈 경쟁 시간 기본값은 없다", async () => {
      expect(adapters.mirihae!.describe().defaultPollIntervalSeconds).toBe(300);
      expect(adapters.mirihae!.describe().openingRush).toBeUndefined();
      const p = run({ from: "2026-10-14" });
      await settle();
      expect(p.allRequests).toHaveLength(6);
      await p.clock.advance(299_000);
      expect(p.allRequests).toHaveLength(6);
      await p.clock.advance(8_000); // 간격에 지터(±20%)가 붙는다
      await settle();
      expect(p.allRequests).toHaveLength(12);
      await p.stop();
    });

    it("설정의 providers.mirihae.pollIntervalSeconds가 기본 간격을 덮어쓴다", async () => {
      const yaml = configWith(watch({ from: "2026-10-14" })).replace("providers:\n", "providers:\n  mirihae: { pollIntervalSeconds: 600 }\n");
      const p = startPoller(() => ({ status: 404, body: "" }), { yaml, server: mirihaeServer(), now: NOW });
      await settle();
      await p.clock.advance(400_000);
      await settle();
      expect(p.allRequests).toHaveLength(6);
      await p.clock.advance(250_000);
      await settle();
      expect(p.allRequests).toHaveLength(12);
      await p.stop();
    });
  });
});

describe("mirihae 설정", () => {
  const problems = (text: string): string => {
    try {
      loadConfig(text, ENV);
    } catch (e) {
      if (e instanceof ConfigError) return e.message;
      throw e;
    }
    return "";
  };
  const block = (lines: string) =>
    configWith(`
  - name: 천동
    provider: mirihae
${lines}
    checkIn: { from: 2026-10-14, to: 2026-10-14 }
    notify: [default]`);

  it("provider: mirihae, facility: danyang-cheondong, 구역 이름, 1박 감시 조건을 받는다", () => {
    expect(problems(block("    facility: danyang-cheondong\n    zones: [야영장A, 야영장B, 야영장C]\n    nights: 1"))).toBe("");
  });

  it("facility 없는 감시 조건은 시설이 하나뿐이어도 위치와 쓸 수 있는 시설 코드와 함께 거부된다", () => {
    expect(problems(block("    zones: [야영장A]"))).toMatch(/\d+번째 줄 watches\.0\.facility: 시설을 골라야 한다\. 쓸 수 있는 값: danyang-cheondong$/);
  });

  it("없는 시설은 쓸 수 있는 값과 함께 거부된다", () => {
    expect(problems(block("    facility: danyang-darian\n    zones: [야영장A]"))).toMatch(/\d+번째 줄 watches\.0\.facility: 없는 시설 "danyang-darian"다\. 쓸 수 있는 값: danyang-cheondong/);
  });

  it("seats는 위치와 함께 거부된다(자리 목록이 없다)", () => {
    expect(problems(block("    facility: danyang-cheondong\n    zones: [야영장A]\n    seats: [A01]"))).toMatch(
      /\d+번째 줄 watches\.0\.seats: 야영장A은\(는\) 자리를 볼 수 없어 seats를 쓸 수 없다/,
    );
  });

  it("없는 구역은 쓸 수 있는 구역 이름과 함께 거부된다(구역 이름이 코드다)", () => {
    expect(problems(block("    facility: danyang-cheondong\n    zones: [야영장Z]"))).toMatch(
      /\d+번째 줄 watches\.0\.zones: 없는 구역 "야영장Z"다\. 쓸 수 있는 값: 야영장A, 야영장B, 야영장C/,
    );
  });

  it("2박은 최대 박수와 함께 위치를 짚어 거부한다", () => {
    expect(problems(block("    facility: danyang-cheondong\n    zones: [야영장A]\n    nights: 2"))).toMatch(
      /\d+번째 줄 watches\.0\.nights: mirihae는 최대 1박까지 예약할 수 있다\(설정값 2\)/,
    );
  });
});

describe("catalog mirihae", () => {
  const catalog = async (facility?: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const requests: TransportRequest[] = [];
    const code = await runCatalog(
      { kind: "catalog", provider: "mirihae", ...(facility ? { facility } : {}), live: false },
      {
        adapters,
        transport: async (r) => (requests.push(r), { status: 404, body: "" }),
        version: "0.1.0",
        now: () => new Date("2026-10-13T00:30:00Z"),
        sleep: async () => {},
        random: () => 0.5,
        out: (s) => void out.push(s),
        err: (s) => void err.push(s),
      },
    );
    return { code, out: out.join(""), err: err.join(""), requests };
  };

  it("시설을 안 고르면 시설이 하나여도 시설 목록을 보이고 요청은 보내지 않는다", async () => {
    const r = await catalog();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^danyang-cheondong\s+단양 천동 오토캠핑장\s+3곳$/m);
    expect(r.requests).toEqual([]);
  });

  it("천동은 최대 1박과 구역 셋(이름이 코드)을 요청 없이 보인다", async () => {
    const r = await catalog("danyang-cheondong");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^mirihae \(최대 1박\)$/m);
    for (const z of ["야영장A 야영장A", "야영장B 야영장B", "야영장C 야영장C"]) expect(r.out.replace(/ +/g, " ")).toContain(z);
    expect(r.out).toContain("(고정 목록 없음)");
    expect(r.requests).toEqual([]);
  });

  it("없는 시설은 쓸 수 있는 값을 보이며 거부한다", async () => {
    const r = await catalog("danyang-nowhere");
    expect(r.code).toBe(1);
    expect(r.err).toContain("danyang-cheondong");
  });
});

describe("catalog mirihae <시설> --live", () => {
  // 가짜 시계는 기록한 때(2026-10-13 09:30 KST)다. --live는 바퀴와 같은 게이트와 예약 화면 한 번을 지나고 달력의 구역 이름 집합을 카탈로그와 대조한다.
  const setup = (server = mirihaeServer()) => {
    const out: string[] = [];
    const err: string[] = [];
    const requests: TransportRequest[] = [];
    const sleeps: number[] = [];
    const run = (facility?: string) =>
      runCatalog(
        { kind: "catalog", provider: "mirihae", ...(facility ? { facility } : {}), live: true },
        {
          adapters,
          transport: async (r) => (requests.push(r), server(r)),
          version: "0.1.0",
          now: () => new Date(NOW),
          sleep: async (ms) => void sleeps.push(ms),
          random: () => 0.5,
          out: (s) => void out.push(s),
          err: (s) => void err.push(s),
        },
      );
    return { run, out: () => out.join(""), err: () => err.join(""), requests, sleeps };
  };
  const edited = (edit: ($: Parameters<NonNullable<Parameters<typeof mirihaePageWith>[1]>>[0]) => void) =>
    mirihaeServer({ page: () => ({ status: 200, body: mirihaePageWith({}, edit) }) });

  it("게이트를 지나 예약 화면을 한 번 열고 카탈로그와 같으면 구역 일치(3곳)이고 종료 코드 0이다", async () => {
    const s = setup();
    expect(await s.run("danyang-cheondong")).toBe(0);
    expect(s.requests.map((r) => `${r.method} ${new URL(r.url).host}${new URL(r.url).pathname}`)).toEqual([
      "GET mirihae.com/dytc/camping/V39628874",
      "GET cdn.mirihae.com/api/entering",
      "POST cdn.mirihae.com/api/waiting",
      "GET cdn.mirihae.com/api/waiting",
      "GET cdn.mirihae.com/api/entering",
      "GET mirihae.com/dytc/camping/V39628874",
    ]);
    expect(s.requests[5]!.url).toBe(`${PAGE}?gateToken=${MIRIHAE_ENTERING_TOKEN}`);
    expect(s.out()).toContain("실제 예약처와 비교");
    expect(s.out()).toContain("구역 일치 (3곳)");
    expect(s.err()).toBe("");
    expect(s.sleeps).toEqual([6_500]); // 예약 화면 두 요청 사이만 5초 + 지터, 게이트 요청은 기다리지 않는다
    for (const r of s.requests) expect(r.headers["User-Agent"]).toBe("overlord-availability-poller/0.1.0");
  });

  it("시설 없이 --live를 걸면 요청 없이 쓸 수 있는 시설 코드와 함께 1이다", async () => {
    const s = setup();
    expect(await s.run(undefined)).toBe(1);
    expect(s.err()).toContain("시설을 골라야 한다");
    expect(s.err()).toContain("danyang-cheondong");
    expect(s.requests).toEqual([]);
  });

  it("예약처에서 구역이 사라지거나 새로 생기면 차이로 보고하고 종료 코드는 0이다", async () => {
    const s = setup(
      edited(($) => {
        $("div.td dl.schedule").filter((_, el) => $(el).find("dd").text().trim() === "야영장C").remove();
        $('div.td[id="2026-10-20"] div.district').append('<dl class="schedule color4 "><dt>5</dt><dd>야영장D</dd></dl>');
      }),
    );
    expect(await s.run("danyang-cheondong")).toBe(0);
    expect(s.out()).toContain("예약처에서 사라진 구역 야영장C");
    expect(s.out()).toContain("예약처에 새로 생긴 구역 야영장D");
    expect(s.out()).not.toContain("구역 일치");
  });

  it("남은 수가 숫자가 아니면 모르는 값: 구역=값으로 보고하고 구조 변경으로 실패하지 않는다", async () => {
    const s = setup(edited(($) => void $('div.td[id="2026-10-14"] dl.schedule dt').first().text("매진")));
    expect(await s.run("danyang-cheondong")).toBe(0);
    expect(s.out()).toContain("모르는 값: 야영장A=매진");
    expect(s.err()).toBe("");
  });

  it("달력에 구역이 하나도 없으면(예: 휴장) 비교할 것이 없다고 알리고 구역이 모두 사라졌다고 보고하지 않는다", async () => {
    const s = setup(edited(($) => void $("div.td dl.schedule").remove()));
    expect(await s.run("danyang-cheondong")).toBe(0);
    expect(s.out()).toContain("구역이 하나도 보이지 않아");
    expect(s.out()).not.toContain("사라진");
    expect(s.out()).not.toContain("구역 일치");
  });

  it.each([
    { title: "게이트가 500", server: () => mirihaeServer({ entering: (n) => (n === 0 ? { status: 500, body: "" } : undefined) }), kind: "transient" },
    { title: "게이트가 403(사전 대기)", server: () => mirihaeServer({ entering: (n) => (n === 0 ? { status: 403, body: "" } : undefined) }), kind: "unavailable" },
    { title: "달력 칸이 없음", server: () => mirihaeServer({ page: () => ({ status: 200, body: "<html><body>점검 중</body></html>" }) }), kind: "unrecognized" },
    { title: "예약 화면이 403", server: () => mirihaeServer({ page: () => ({ status: 403, body: "" }) }), kind: "blocked" },
  ])("$title 이면 조회 실패($kind)로 보고하고 종료 코드 1이다", async ({ server, kind }) => {
    const s = setup(server());
    expect(await s.run("danyang-cheondong")).toBe(1);
    expect(s.out()).toContain(`조회 실패(${kind})`);
  });
});
