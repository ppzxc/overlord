import { describe, expect, it } from "vitest";
import { runCatalog } from "../src/commands.js";
import { adapters } from "../src/adapters/index.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { createHttpClient } from "../src/http.js";
import type { TransportRequest } from "../src/types.js";
import { ENV, configWith, settle, startPoller, taebaekCalendar, taebaekServer } from "./harness.js";

// 태백 고원힐링캠핑장(gowon, wloc=B01)의 기록한 달력(2026-10-14 13시대 KST, research/raw/taebaek)을 fixture로 쓴다.
// 자동차야영장(man=2) 10월: 10/1~14 예약종료, 10/15~31 예약가능. 11월: 11/1~30 예약가능.
// 카라반(man=3) 10월: 15·18~22·25~29 예약가능, 16·17·23·24·30·31 예약완료. 야영데크(man=1) 10월은 예약가능이 하루도 없다.
const NOW = "2026-10-14T13:30:00+09:00";

const watch = (checkIn: { from: string; to?: string }, zones = ["2"], nights = 1) => `
  - name: 고원 감시
    provider: taebaek
    facility: gowon
    zones: [${zones.map((z) => `"${z}"`).join(", ")}]
    checkIn: { from: ${checkIn.from}, to: ${checkIn.to ?? checkIn.from} }
    nights: ${nights}
    notify: [default]`;

const run = (
  checkIn: { from: string; to?: string },
  opts: { server?: ReturnType<typeof taebaekServer>; zones?: string[]; nights?: number; now?: string; random?: () => number } = {},
) =>
  startPoller(() => ({ status: 404, body: "" }), {
    yaml: configWith(watch(checkIn, opts.zones, opts.nights)),
    server: opts.server ?? taebaekServer(),
    random: opts.random,
    now: opts.now ?? NOW,
  });

describe("태백 폴러", () => {
  it("예약가능 날짜만 구역, 날짜, 예약가능, 딥링크가 담긴 메시지 한 건으로 알리고 예약종료 날짜와 남은 수는 적지 않는다", async () => {
    const p = run({ from: "2026-10-14", to: "2026-10-16" }); // 10/14 예약종료, 10/15·16 예약가능
    await settle();
    expect(p.sent).toHaveLength(1);
    const text = p.sent[0]!.text;
    expect(text).toContain("2026-10-15");
    expect(text).toContain("2026-10-16");
    expect(text).not.toContain("2026-10-14");
    expect(text).toContain("자동차야영장");
    expect(text).toContain("예약가능");
    expect(text).not.toContain("남은");
    expect(JSON.stringify(p.sent[0]!.reply_markup)).toContain("https://tfmc.huyang.co.kr:452/reservation.asp?location=002&wloc=B01");
    await p.stop();
  });

  it("예약가능 날짜가 없으면 알리지 않고 실패로 치지 않는다", async () => {
    const p = run({ from: "2026-10-14" }); // 10/14는 예약종료
    await settle();
    expect(p.allRequests).toHaveLength(1);
    expect(p.sent).toHaveLength(0);
    expect(p.logs.filter((l) => l.msg === "query failed")).toEqual([]);
    await p.stop();
  });

  describe("요청 흐름", () => {
    it("이번 달 기본 탭은 GET 한 번이고 다른 구역·다른 달은 달력 조회 POST가 구역·달마다 한 번씩이다", async () => {
      const server = taebaekServer();
      const p = run({ from: "2026-10-15", to: "2026-10-16" }, { server, zones: ["1", "2", "3"] });
      await settle();
      expect(p.allRequests.map((r) => `${r.method} ${new URL(r.url).host}${new URL(r.url).pathname}${new URL(r.url).search}`)).toEqual([
        "POST tfmc.huyang.co.kr:452/reservation.asp?location=002", // 야영데크(1)
        "GET tfmc.huyang.co.kr:452/reservation.asp?location=002&wloc=B01", // 자동차야영장(2): 이번 달 기본 탭
        "POST tfmc.huyang.co.kr:452/reservation.asp?location=002", // 카라반(3)
      ]);
      expect(p.allRequests.filter((r) => r.method === "POST").map((r) => r.body)).toEqual(["wh_year=2026&wh_month=10&man=1&wloc=B01", "wh_year=2026&wh_month=10&man=3&wloc=B01"]);
      await p.stop();
    });

    it("다음 달 날짜는 그 구역의 다음 달 달력을 POST로 한 번만 읽고 알린다", async () => {
      const server = taebaekServer();
      const p = run({ from: "2026-11-01", to: "2026-11-03" }, { server });
      await settle();
      expect(p.allRequests).toHaveLength(1);
      expect(p.allRequests[0]!.method).toBe("POST");
      expect(p.allRequests[0]!.body).toBe("wh_year=2026&wh_month=11&man=2&wloc=B01");
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0]!.text).toContain("2026-11-01");
      await p.stop();
    });

    it("같은 구역·달을 쓰는 감시 조건이 여럿이어도 달력 조회는 한 번만 나가고 야영데크도 읽는다", async () => {
      const yaml = configWith(watch({ from: "2026-10-15", to: "2026-10-20" }, ["1"]) + watch({ from: "2026-10-21", to: "2026-10-30" }, ["1"], 2));
      const p = startPoller(() => ({ status: 404, body: "" }), { yaml, server: taebaekServer(), now: NOW });
      await settle();
      expect(p.allRequests.map((r) => r.body)).toEqual(["wh_year=2026&wh_month=10&man=1&wloc=B01"]);
      await p.stop();
    });

    it("카라반은 예약완료 날짜를 알리지 않는다", async () => {
      const p = run({ from: "2026-10-15", to: "2026-10-18" }, { zones: ["3"] }); // 15 가능, 16·17 완료, 18 가능
      await settle();
      const text = p.sent[0]!.text;
      expect(text).toContain("2026-10-15");
      expect(text).toContain("2026-10-18");
      expect(text).not.toContain("2026-10-16");
      expect(text).not.toContain("2026-10-17");
      expect(text).toContain("카라반");
      await p.stop();
    });

    it("요청은 쿠키 없이 나가고 정직한 UA만 붙으며 폼 POST에는 Referer·Origin을 싣는다", async () => {
      const p = run({ from: "2026-10-15" }, { server: taebaekServer({ calendar: (f) => ({ status: 200, body: taebaekCalendar(f.month, f.man), setCookie: ["ASPSESSIONIDX=abc; secure; path=/"] }) }), zones: ["2", "3"] });
      await settle();
      expect(p.allRequests).toHaveLength(2);
      for (const r of p.allRequests) {
        expect(r.headers.Cookie).toBeUndefined();
        expect(r.headers["User-Agent"]).toBe("overlord-availability-poller/0.1.0 (ops)");
      }
      expect(p.allRequests[1]!.method).toBe("POST");
      expect(p.allRequests[1]!.headers.Origin).toBe("https://tfmc.huyang.co.kr:452");
      expect(p.allRequests[1]!.headers.Referer).toBe("https://tfmc.huyang.co.kr:452/reservation.asp?location=002&wloc=B01");
      await p.stop();
    });

    it("접근 금지 경로(예약 제출·자리 목록, 예약확인·취소·결제, 로그인·회원)는 HTTP 층이 막고 달력과 안내 화면은 막지 않는다", async () => {
      const sent: string[] = [];
      const http = createHttpClient({
        transport: async (r) => (sent.push(r.url), { status: 200, body: "" }),
        version: "0.1.0",
        userAgentSuffix: "",
        blockedPaths: adapters.taebaek!.describe().blockedPaths,
        cookieSession: false,
      });
      const origin = "https://tfmc.huyang.co.kr:452";
      for (const blocked of ["/reservation.asp?location=002_01", "/Reservation.asp?location=002_01", "/reservation.asp?location=003&wloc=B01", "/login.asp", "/member/join.asp", "/mypage.asp"]) {
        await expect(http.post(`${origin}${blocked}`, "x=1"), blocked).rejects.toThrow(/접근 금지/);
      }
      expect(sent).toEqual([]);
      await http.get(`${origin}/reservation.asp?location=002&wloc=B01`);
      await http.post(`${origin}/reservation.asp?location=002`, "wh_year=2026&wh_month=11&man=2&wloc=B01");
      await http.get(`${origin}/reservation.asp?location=001&wloc=B01`);
      expect(sent).toHaveLength(3);
    });

    it("접근 금지 경로로 리다이렉트되면 blocked로 보고 예약처가 멈춘다", async () => {
      const p = run({ from: "2026-10-15" }, { server: taebaekServer({ intercept: (r) => (r.method === "GET" ? { status: 302, body: "", location: "/login.asp" } : undefined) }) });
      await settle();
      expect(p.logs.filter((l) => l.msg === "query failed").map((l) => l.fields?.kind)).toEqual(["blocked"]);
      expect(p.allRequests).toHaveLength(1); // 로그인 경로로는 요청이 나가지 않는다
      await p.stop();
    });
  });

  describe("여러 박", () => {
    it("입실일부터 연속한 N일이 모두 예약가능일 때만 알린다", async () => {
      const p = run({ from: "2026-10-14", to: "2026-10-30" }, { zones: ["3"], nights: 2 }); // 카라반: 15 가능, 16 완료, 18~22 가능, 23 완료
      await settle();
      const dates = p.sent[0]!.text.match(/2026-10-\d\d/g);
      expect(dates).toEqual(["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"]);
      await p.stop();
    });

    it("달이 바뀌는 박은 두 달의 달력을 읽고 최대 박수를 넘는 설정은 거부한다", async () => {
      const p = run({ from: "2026-10-31" }, { nights: 2 });
      await settle();
      expect(p.allRequests.map((r) => r.body ?? "GET")).toEqual(["GET", "wh_year=2026&wh_month=11&man=2&wloc=B01"]);
      expect(p.sent[0]!.text).toContain("2026-10-31");
      await p.stop();
      expect(adapters.taebaek!.describe().maxNights).toBe(4);
      const yaml = configWith(watch({ from: "2026-10-15" }, ["2"], 5));
      expect(() => loadConfig(yaml, ENV)).toThrow(/최대 4박/);
    });

    it("다음 달 1일 오전 10시 전에는 다음 달을 조회하지 않는다", async () => {
      const p = run({ from: "2026-11-02" }, { now: "2026-10-01T09:30:00+09:00" });
      await settle();
      expect(p.allRequests).toHaveLength(0);
      await p.stop();
      const open = run({ from: "2026-11-02" }, { now: "2026-10-01T10:00:00+09:00" });
      await settle();
      expect(open.allRequests).toHaveLength(1);
      await open.stop();
    });
  });

  describe("신호 분류", () => {
    const failedKinds = (p: ReturnType<typeof run>) => p.logs.filter((l) => l.msg === "query failed").map((l) => l.fields?.kind);
    const get = (res: { status: number; body: string }) => taebaekServer({ intercept: () => res });

    it.each([
      ["403", { status: 403, body: "" }],
      ["429", { status: 429, body: "" }],
      ["로그인 화면", { status: 200, body: "<html><body><form action='/member/login.asp'>로그인</form></body></html>" }],
      ["봇 탐지", { status: 200, body: "<script src='/botmanager.js'></script>" }],
      ["대기열", { status: 200, body: "<html>접속 대기 순번 120번</html>" }],
    ])("%s는 blocked로 판정한다", async (_name, res) => {
      const p = run({ from: "2026-10-15" }, { server: get(res) });
      await settle();
      expect(failedKinds(p)).toEqual(["blocked"]);
      expect(p.sent).toHaveLength(1); // 차단은 한 번이면 예약처가 멈추고 알린다
      const before = p.allRequests.length;
      await p.clock.advance(3_600_000);
      await settle();
      expect(p.allRequests).toHaveLength(before);
      await p.stop();
    });

    it("날짜 칸의 뜻을 알 수 없으면 unrecognized다", async () => {
      const p = run({ from: "2026-10-15" }, { server: taebaekServer({ calendar: () => ({ status: 200, body: taebaekPatched("예약가능", "예약마감") }) }) });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      await p.stop();
    });

    it("서버가 요청한 구역이 아닌 탭의 달력을 주면 unrecognized다", async () => {
      const p = run({ from: "2026-10-15" }, { server: taebaekServer({ calendar: () => ({ status: 200, body: taebaekCalendar("2026-10", "3") }) }) }); // 자동차야영장을 물었는데 카라반 달력
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      await p.stop();
    });

    it("구조 변경이 두 바퀴 연속이면 예약처가 stopped가 된다", async () => {
      const p = run({ from: "2026-10-15" }, { server: taebaekServer({ calendar: () => ({ status: 200, body: "<html>점검</html>" }) }) });
      await settle();
      await p.clock.advance(600_000);
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized", "unrecognized"]);
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0]!.text).toMatch(/구조가 바뀌/);
      const before = p.allRequests.length;
      await p.clock.advance(3_600_000);
      await settle();
      expect(p.allRequests).toHaveLength(before); // 멈춘 예약처는 조회하지 않는다.
      await p.stop();
    });

    it("5xx와 연결 실패는 일시 오류다", async () => {
      const p = run({ from: "2026-10-15" }, { server: get({ status: 503, body: "" }) });
      await settle();
      expect(failedKinds(p)).toEqual(["transient"]);
      await p.stop();
      const down = run({ from: "2026-10-15" }, { server: taebaekServer({ intercept: () => { throw new Error("ECONNRESET"); } }) });
      await settle();
      expect(failedKinds(down)).toEqual(["transient"]);
      await down.stop();
    });
  });

  describe("폴링 간격", () => {
    it("기본은 600초이고 이 예약처의 설정 하한은 300초이며 다른 예약처의 하한(60초)은 그대로다", async () => {
      expect(adapters.taebaek!.describe().defaultPollIntervalSeconds).toBe(600);
      const p = run({ from: "2026-10-15" });
      await settle();
      expect(p.allRequests).toHaveLength(1);
      await p.clock.advance(599_000);
      expect(p.allRequests).toHaveLength(1);
      await p.clock.advance(8_000);
      await settle();
      expect(p.allRequests).toHaveLength(2);
      await p.stop();
      const config = (providers: string) => loadConfig(configWith(watch({ from: "2026-10-15" })).replace("providers:\n", `providers:\n${providers}`), ENV);
      expect(() => config("  taebaek: { pollIntervalSeconds: 299 }\n")).toThrow(ConfigError);
      expect(() => config("  taebaek: { pollIntervalSeconds: 299 }\n")).toThrow(/300초 이상/);
      expect(config("  taebaek: { pollIntervalSeconds: 300 }\n").providers.taebaek?.pollIntervalSeconds).toBe(300);
      expect(config("  bukgu: { pollIntervalSeconds: 60 }\n").providers.bukgu?.pollIntervalSeconds).toBe(60);
    });
  });
});

/** 기록한 이번 달 자동차야영장 달력에서 상태 문구 하나를 바꾼 본문. */
function taebaekPatched(from: string, to: string): string {
  return taebaekCalendar("2026-10", "2").replaceAll(from, to);
}

describe("catalog taebaek", () => {
  const catalog = async (facility?: string) => {
    const out: string[] = [];
    const requests: TransportRequest[] = [];
    const code = await runCatalog(
      { kind: "catalog", provider: "taebaek", ...(facility ? { facility } : {}), live: false },
      { adapters, transport: async (r) => (requests.push(r), { status: 404, body: "" }), version: "0.1.0", now: () => new Date(NOW), sleep: async () => {}, random: () => 0.5, out: (t) => void out.push(t), err: () => {} },
    );
    return { code, out: out.join(""), requests };
  };

  it("시설 목록은 gowon 하나이고 요청은 보내지 않는다", async () => {
    const r = await catalog();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^gowon\s+태백 고원힐링캠핑장\s+3곳$/m);
    expect(r.requests).toEqual([]);
  });

  it("고원힐링의 세 구역(야영데크 1, 자동차야영장 2, 카라반 3)을 요청 없이 보인다", async () => {
    const r = await catalog("gowon");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^1\s+야영데크/m);
    expect(r.out).toMatch(/^2\s+자동차야영장/m);
    expect(r.out).toMatch(/^3\s+카라반/m);
    expect(r.requests).toEqual([]);
  });

  it("최대 4박은 확인하지 못한 값이라 미확인으로 표시한다", async () => {
    expect((await catalog("gowon")).out).toMatch(/^taebaek \(최대 4박\(미확인\)\)$/m);
  });
});
