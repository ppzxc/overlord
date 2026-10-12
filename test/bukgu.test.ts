import { describe, expect, it } from "vitest";
import { adapters } from "../src/adapters/index.js";
import { runCatalog } from "../src/commands.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { createHttpClient } from "../src/http.js";
import type { TransportRequest } from "../src/types.js";
import { ENV, bukguPage, bukguServer, bukguTable, configWith, settle, startPoller } from "./harness.js";

// 강동오토캠핑장(gangdong, siteKindCode=010100)의 기록한 응답(2026-10-13 00시 전후, research/raw/bukgu)을 fixture로 쓴다.
// 10/14는 25자리 가운데 18자리가 예약가능(일반데크 1·2·8~13, 필로티 1~3, 카라반 1~4·7~9)이고, 10/17은 25자리 모두 예약종료다.
// 당사현대차오션캠프(dangsa, siteKindCode=010200)의 기록은 같은 때 받았다. 10/14는 20자리 가운데 17자리가 예약가능이고 10/17은 2자리다.
// 가짜 시계는 기록한 때(2026-10-13 00:10 KST)다. 그때 10월 날짜는 이달이라 이미 선착순이고 11월 날짜는 추첨 대상이다.
const NOW = "2026-10-13T00:10:00+09:00";
const watch = (checkIn: { from: string; to?: string }, zones: string[] = ["일반데크"], facility = "gangdong") => `
  - name: ${facility} ${checkIn.from}
    provider: bukgu
    facility: ${facility}
    zones: [${zones.join(", ")}]
    checkIn: { from: ${checkIn.from}, to: ${checkIn.to ?? checkIn.from} }
    nights: 1
    notify: [default]`;

const run = (
  checkIn: { from: string; to?: string },
  opts: { server?: ReturnType<typeof bukguServer>; zones?: string[]; facility?: string; random?: () => number; now?: string; extraWatches?: string } = {},
) =>
  startPoller(() => ({ status: 404, body: "" }), {
    yaml: configWith(watch(checkIn, opts.zones, opts.facility) + (opts.extraWatches ?? "")),
    server: opts.server ?? bukguServer(),
    random: opts.random,
    now: opts.now ?? NOW,
  });

/** 기록은 몇 날짜뿐이라, 여러 날짜를 조회하는 시험은 어느 날짜든 기록한 10/14 표로 답한다. */
const anyDay = () => bukguServer({ table: () => ({ status: 200, body: bukguTable("2026-10-14") }) });

/** 메시지에 실린 이름 가운데 `접두어` + 숫자인 자리. */
const seatsIn = (text: string, prefix: string) => text.match(new RegExp(`${prefix.replace(/[()]/g, "\\$&")} ?\\d+`, "g")) ?? [];

describe("북구 폴러", () => {
  it("예약가능 자리는 구역 이름, 자리 이름, 딥링크가 담긴 메시지 한 건으로 알리고 예약종료 자리는 알리지 않는다", async () => {
    const p = run({ from: "2026-10-14" });
    await settle();
    expect(p.sent).toHaveLength(1);
    const text = p.sent[0]!.text;
    expect(text).toContain("일반데크");
    expect(seatsIn(text, "일반데크")).toEqual(["일반데크1", "일반데크2", "일반데크8", "일반데크9", "일반데크10", "일반데크11", "일반데크12", "일반데크13"]); // 3~7은 예약종료
    expect(text).not.toContain("필로티"); // 감시 구역이 아니다
    expect(JSON.stringify(p.sent[0]!.reply_markup)).toContain("https://camping.ubimc.or.kr/Pmreservation.do");
    await p.stop();
  });

  it("예약종료뿐인 날은 알리지 않고 실패로 치지 않는다", async () => {
    const p = run({ from: "2026-10-17" });
    await settle();
    expect(p.allRequests).toHaveLength(1);
    expect(p.sent).toHaveLength(0);
    expect(p.logs.filter((l) => l.msg === "query failed")).toEqual([]);
    await p.stop();
  });

  it("같은 빈자리가 연속 두 바퀴 잡혀도 첫 바퀴에만 알린다", async () => {
    const p = run({ from: "2026-10-14" });
    await settle();
    expect(p.sent).toHaveLength(1);
    await p.clock.advance(150_000);
    await settle();
    expect(p.allRequests).toHaveLength(2); // 기본 폴링 간격 150초
    expect(p.sent).toHaveLength(1);
    await p.stop();
  });

  describe("요청 흐름", () => {
    it("(시설, 밤)마다 POST 한 번이고 본문은 페이지(addTable)와 같으며 예약 화면 GET은 없다", async () => {
      const p = run({ from: "2026-10-14", to: "2026-10-17" }, { server: anyDay(), zones: ["일반데크", "필로티", "카라반"] });
      await settle();
      expect(p.allRequests.map((r) => `${r.method} ${new URL(r.url).host}${new URL(r.url).pathname}`)).toEqual(
        Array(4).fill("POST camping.ubimc.or.kr/ajax/reservationCntAjax.do"),
      );
      expect(p.allRequests.map((r) => r.body)).toEqual([
        "resDate=2026-10-14&siteKindCode=010100&priceCode=",
        "resDate=2026-10-15&siteKindCode=010100&priceCode=",
        "resDate=2026-10-16&siteKindCode=010100&priceCode=",
        "resDate=2026-10-17&siteKindCode=010100&priceCode=",
      ]);
      await p.stop();
    });

    it("구역 셋을 감시해도 그 밤은 한 번만 조회하고 메시지는 한 건이며 구역마다 자기 자리만 담긴다", async () => {
      const p = run({ from: "2026-10-14" }, { zones: ["일반데크", "필로티", "카라반"] });
      await settle();
      expect(p.allRequests).toHaveLength(1);
      expect(p.sent).toHaveLength(1);
      const text = p.sent[0]!.text;
      expect(seatsIn(text, "필로티")).toEqual(["필로티1", "필로티2", "필로티3"]);
      // 무장애카라반5·6은 예약종료이고, 카라반 구역 안에 이름이 달라도(무장애) 색 클래스로 같은 구역이다.
      expect(seatsIn(text, "카라반")).toEqual(["카라반1", "카라반2", "카라반3", "카라반4", "카라반7", "카라반8", "카라반9"]);
      await p.stop();
    });

    it("무장애카라반은 카라반 구역의 자리로 읽는다", async () => {
      const p = run({ from: "2026-10-20" }, { zones: ["카라반"] }); // 기록한 10/20은 25행 가운데 22행이 예약가능이다
      await settle();
      expect(p.sent[0]!.text).toContain("무장애카라반5");
      await p.stop();
    });

    it("요청은 쿠키 없이 나가고 페이지처럼 Referer·Origin·X-Requested-With를 싣고 정직한 UA만 붙는다", async () => {
      const p = run({ from: "2026-10-14", to: "2026-10-15" }, { server: anyDay() }); // 서버는 매번 JSESSIONID를 준다
      await settle();
      expect(p.allRequests).toHaveLength(2);
      for (const r of p.allRequests) {
        expect(r.headers.Cookie).toBeUndefined();
        expect(r.headers["User-Agent"]).toBe("overlord-availability-poller/0.1.0 (ops)");
        expect(r.headers.Referer).toBe("https://camping.ubimc.or.kr/Pmreservation.do");
        expect(r.headers.Origin).toBe("https://camping.ubimc.or.kr");
        expect(r.headers["X-Requested-With"]).toBe("XMLHttpRequest");
        expect(r.headers["Content-Type"]).toBe("application/x-www-form-urlencoded; charset=UTF-8");
      }
      await p.stop();
    });

    it("요청 사이는 5초 + 지터 간격이다", async () => {
      const p = run({ from: "2026-10-14", to: "2026-10-15" }, { server: anyDay() }); // random 0.5: 6.5초
      await settle();
      expect(p.requestTimes[1]! - p.requestTimes[0]!).toBe(6_500);
      await p.stop();
      const low = run({ from: "2026-10-14", to: "2026-10-15" }, { server: anyDay(), random: () => 0 });
      await settle();
      expect(low.requestTimes[1]! - low.requestTimes[0]!).toBe(5_000);
      await low.stop();
    });

    it("접근 금지 경로로는 요청이 나가지 않는다", async () => {
      const p = run({ from: "2026-10-14" });
      await settle();
      const forbidden = ["/ajax/preReservationAjax", "/Pmreservation2.do", "/login", "/PmmySubscription", "/Pmbukgusubscription", "/Pmsubscription"];
      for (const r of p.allRequests) {
        const u = new URL(r.url);
        expect(forbidden.some((f) => u.pathname.startsWith(f))).toBe(false);
      }
      await p.stop();
    });

    it("자리 선점·예약 제출·로그인·예약확인·추첨 신청은 HTTP 층이 막고 예약 화면과 조회 경로는 막지 않는다", async () => {
      const sent: string[] = [];
      const http = createHttpClient({
        transport: async (r) => (sent.push(r.url), { status: 200, body: "" }),
        version: "0.1.0",
        userAgentSuffix: "",
        blockedPaths: adapters.bukgu!.describe().blockedPaths,
        cookieSession: false,
      });
      const origin = "https://camping.ubimc.or.kr";
      for (const blocked of ["/ajax/preReservationAjax2.do", "/AJAX/preReservationAjax2.do", "/Pmreservation2.do", "/login.do", "/logins", "/PmmySubscription.do", "/Pmbukgusubscription.do", "/Pmsubscription.do"]) {
        await expect(http.post(`${origin}${blocked}`, "idx=1"), blocked).rejects.toThrow(/접근 금지/);
      }
      expect(sent).toEqual([]);
      await http.get(`${origin}/Pmreservation.do`);
      await http.post(`${origin}/ajax/reservationCntAjax.do`, "resDate=2026-10-14&siteKindCode=010100&priceCode=");
      expect(sent).toHaveLength(2);
    });

    it("기본 폴링 간격은 150초이고 오픈 경쟁 시간 기본값은 없다", async () => {
      expect(adapters.bukgu!.describe().defaultPollIntervalSeconds).toBe(150);
      expect(adapters.bukgu!.describe().openingRush).toBeUndefined();
      const p = run({ from: "2026-10-14" });
      await settle();
      expect(p.allRequests).toHaveLength(1);
      await p.clock.advance(149_000);
      expect(p.allRequests).toHaveLength(1);
      await p.clock.advance(8_000);
      await settle();
      expect(p.allRequests).toHaveLength(2);
      await p.stop();
    });
  });

  describe("신호 분류(기본)", () => {
    const failedKinds = (p: ReturnType<typeof run>) => p.logs.filter((l) => l.msg === "query failed").map((l) => l.fields?.kind);
    const ok = (body: string) => ({ status: 200, body });
    const respond = (body: string | ((html: string) => string)) =>
      bukguServer({ table: () => ok(typeof body === "string" ? body : body(bukguTable("2026-10-14"))) });

    it.each([
      ["HTTP 403은 blocked", 403, "blocked"],
      ["HTTP 429는 blocked", 429, "blocked"],
      ["HTTP 503은 transient", 503, "transient"],
      ["예상 밖 HTTP 404는 unrecognized", 404, "unrecognized"],
    ])("조회가 %s다", async (_name, status, kind) => {
      const p = run({ from: "2026-10-14" }, { server: bukguServer({ table: () => ({ status, body: "" }) }) });
      await settle();
      expect(failedKinds(p)).toEqual([kind]);
      expect(p.sent).toHaveLength(kind === "blocked" ? 1 : 0);
      await p.stop();
    });

    it("연결 실패(TLS 검증 실패 포함)는 transient이고 알리지 않는다", async () => {
      const server = bukguServer({
        intercept: () => {
          throw Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
        },
      });
      const p = run({ from: "2026-10-14" }, { server });
      await settle();
      expect(failedKinds(p)).toEqual(["transient"]);
      expect(p.sent).toHaveLength(0);
      await p.stop();
    });

    describe("TLS 검증 실패", () => {
      const tlsFailure = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) });
      const alerts = (p: ReturnType<typeof run>) => p.sent.map((m) => m.text).filter((t) => /구조가 바뀌/.test(t));
      const flaky = (state: { broken: boolean }) =>
        bukguServer({
          intercept: () => {
            if (state.broken) throw tlsFailure();
            return undefined;
          },
        });

      it("transient이고 두 바퀴 연속이면 unrecognized, 그다음 바퀴에 멈추고 알린다", async () => {
        const p = run({ from: "2026-10-14" }, { server: flaky({ broken: true }) });
        await settle();
        expect(failedKinds(p)).toEqual(["transient"]);
        expect(alerts(p)).toHaveLength(0);
        await p.clock.advance(300_000); // 일시 오류 뒤 간격은 두 배다.
        await settle();
        expect(failedKinds(p)).toEqual(["transient", "unrecognized"]);
        expect(alerts(p)).toHaveLength(0); // unrecognized도 첫 바퀴는 아직 장애로 치지 않는다(헬스 상태 머신 그대로).
        await p.clock.advance(150_000);
        await settle();
        expect(failedKinds(p)).toEqual(["transient", "unrecognized", "unrecognized"]);
        expect(alerts(p)).toHaveLength(1);
        await p.stop();
      });

      it("검증 실패 뒤 성공한 바퀴가 있으면 연속이 끊겨 다음 검증 실패는 다시 transient다", async () => {
        const state = { broken: true };
        const p = run({ from: "2026-10-14" }, { server: flaky(state) });
        await settle();
        state.broken = false;
        await p.clock.advance(300_000);
        await settle();
        expect(failedKinds(p)).toEqual(["transient"]); // 이번 바퀴는 성공
        state.broken = true;
        await p.clock.advance(150_000);
        await settle();
        expect(failedKinds(p)).toEqual(["transient", "transient"]);
        await p.stop();
      });

      it("TLS가 아닌 연결 실패는 두 바퀴 연속이어도 transient다", async () => {
        const server = bukguServer({
          intercept: () => {
            throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
          },
        });
        const p = run({ from: "2026-10-14" }, { server });
        await settle();
        await p.clock.advance(300_000);
        await settle();
        expect(failedKinds(p)).toEqual(["transient", "transient"]);
        await p.stop();
      });
    });

    it("로그인 경로로 리다이렉트되면 로그인 경로로 요청을 보내지 않고 blocked로 멈춘다", async () => {
      const server = bukguServer({ table: () => ({ status: 302, body: "", location: "/login.do" }) });
      const p = run({ from: "2026-10-14" }, { server });
      await settle();
      expect(p.allRequests.some((r) => r.url.includes("/login"))).toBe(false);
      expect(failedKinds(p)).toEqual(["blocked"]);
      expect(p.sent[0]!.text).toMatch(/차단/);
      await p.stop();
    });

    it("표 자리에 로그인 요구(/login.do로 보내는 스크립트)가 오면 blocked다", async () => {
      // 예약 화면 `subIdx()`가 로그인 안 한 방문자에게 하는 것과 같은 모양이다. 조회 응답의 로그인 화면 원문은 기록이 없다.
      const p = run({ from: "2026-10-14" }, { server: respond('<script>alert("로그인이 필요합니다.");location.href="/login.do";</script>') });
      await settle();
      expect(failedKinds(p)).toEqual(["blocked"]);
      await p.stop();
    });

    it("표 자리에 봇 탐지 장치 표지(botmanager)가 오면 blocked로 멈춘다", async () => {
      const p = run({ from: "2026-10-14" }, { server: respond((html) => html.replace("<table", '<script src="https://cdn-botmanager.example/agent.js"></script><table')) });
      await settle();
      expect(failedKinds(p)).toEqual(["blocked"]);
      await p.stop();
    });

    it("표가 없으면 unrecognized이고 두 바퀴 연속이면 멈추고 알린다", async () => {
      const p = run({ from: "2026-10-14" }, { server: respond("<html>점검 중</html>") });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      expect(p.sent).toHaveLength(0); // 첫 바퀴는 아직 알리지 않는다.
      await p.clock.advance(150_000);
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

    it.each([
      ["사이트명 열이 사라짐", (h: string) => h.replace("<th class=\"title\" scope=\"col\">사이트명</th>", '<th class="title" scope="col">이름</th>')],
      ["예약현황 열이 사라짐", (h: string) => h.replace("<th class=\"title\" scope=\"col\">예약현황</th>", '<th class="title" scope="col">상태</th>')],
      ["예약가능·예약종료 밖의 값", (h: string) => h.replace(" 예약종료</td>", "예약중</td>")],
      ["모르는 시설종류 색 클래스", (h: string) => h.replace("line_sky", "line_green")],
      ["행이 하나도 없음", (h: string) => h.replace(/<tbody>[\s\S]*<\/tbody>/, "<tbody></tbody>")],
    ])("%s이면 빈자리 없음이 아니라 unrecognized이고 알리지 않는다", async (_name, change) => {
      const p = run({ from: "2026-10-14" }, { server: respond(change) });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      expect(p.sent).toHaveLength(0);
      await p.stop();
    });

    it("감시하는 구역의 행이 응답에서 사라지면 unrecognized이고 쓰지 않는 구역이 사라진 것은 로그 경고만 남긴다", async () => {
      const withoutZone = (cls: string) => (html: string) => html.replace(new RegExp(`<tr>(?:(?!</tr>)[\\s\\S])*?${cls}(?:(?!</tr>)[\\s\\S])*?</tr>`, "g"), "");
      const gone = run({ from: "2026-10-14" }, { server: respond(withoutZone("line_yellow")) }); // 일반데크 감시
      await settle();
      expect(failedKinds(gone)).toEqual(["unrecognized"]);
      expect(gone.sent).toHaveLength(0); // 첫 바퀴는 아직 알리지 않는다.
      await gone.clock.advance(150_000);
      await settle();
      expect(failedKinds(gone)).toEqual(["unrecognized", "unrecognized"]);
      expect(gone.sent).toHaveLength(1);
      expect(gone.sent[0]!.text).toMatch(/구조가 바뀌/);
      await gone.stop();
      const unused = run({ from: "2026-10-14" }, { server: respond(withoutZone("line_sky")) }); // 필로티가 사라졌지만 일반데크를 감시
      await settle();
      expect(failedKinds(unused)).toEqual([]);
      expect(unused.sent).toHaveLength(1);
      expect(unused.logs.filter((l) => l.msg === "bukgu zone drift").map((l) => l.fields)).toEqual([{ facility: "gangdong", change: "gone", zone: "필로티" }]);
      await unused.stop();
    });
  });
});

describe("북구 폴러: 추첨 대상 날짜", () => {
  // 2026-10-13 추첨 접수 기간. 11월분 일정(공지 nttId 3301): 일반 추첨 접수 10/12~10/14, 결제 10/16(금)까지, 선착순 10/19(월) 10시부터.
  // 기록한 강동 11/01 표는 25자리가 모두 예약가능이지만 그 자리는 추첨 대상이다(10월 일요일은 11·15자리).
  // 예약 화면은 요청마다 달력 상한 `d2`(그때 11/01 00:00 KST + 밀리초)와 `resEndDay`(결제 마감일 16)를 실어 보낸다.
  const D2_NOV_1 = "1793458800072";
  const D2_DEC_1 = "1796050800000";
  const D2_JAN_1 = "1798729200000";
  /** 기록은 몇 날짜뿐이라 표는 어느 날짜든 기록한 11/01(25자리 모두 예약가능) 표로 답한다. */
  const pageWith = (change: (html: string) => string) =>
    bukguServer({ page: () => ({ status: 200, body: change(bukguPage()) }), table: () => ({ status: 200, body: bukguTable("2026-11-01") }) });
  const withD2 = (d2: string) => pageWith((h) => h.replace(D2_NOV_1, d2).replace(`//var d3= ${D2_NOV_1}`, `//var d3= ${d2}`));
  const pageGets = (p: ReturnType<typeof run>) => p.allRequests.filter((r) => r.method === "GET");
  const kinds = (p: ReturnType<typeof run>) => p.logs.filter((l) => l.msg === "query failed").map((l) => l.fields?.kind);

  it("추첨 접수 기간의 다음 달 날짜는 표가 25자리 모두 예약가능이어도 알리지 않고 표를 조회하지 않는다", async () => {
    const p = run({ from: "2026-11-01" });
    await settle();
    expect(pageGets(p).map((r) => new URL(r.url).pathname)).toEqual(["/Pmreservation.do"]);
    expect(p.allRequests.filter((r) => r.method === "POST")).toEqual([]);
    expect(p.sent).toHaveLength(0);
    expect(kinds(p)).toEqual([]);
    await p.stop();
  });

  it("이달 날짜는 이미 선착순이라 예약 화면 요청 없이 알린다", async () => {
    const p = run({ from: "2026-10-25" });
    await settle();
    expect(pageGets(p)).toEqual([]);
    expect(p.sent).toHaveLength(1);
    await p.stop();
  });

  it("이달 날짜와 다음 달 날짜가 섞이면 이달 날짜만 조회하고 예약 화면은 한 번만 받는다", async () => {
    const p = run({ from: "2026-10-30", to: "2026-11-01" }, { server: bukguServer({ table: () => ({ status: 200, body: bukguTable("2026-10-14") }) }) });
    await settle();
    expect(p.allRequests.filter((r) => r.method === "POST").map((r) => r.body)).toEqual([
      "resDate=2026-10-30&siteKindCode=010100&priceCode=",
      "resDate=2026-10-31&siteKindCode=010100&priceCode=",
    ]);
    expect(pageGets(p)).toHaveLength(1);
    await p.stop();
  });

  it("강동과 당사를 함께 감시해도 예약 화면은 한 번만 받는다", async () => {
    const p = run({ from: "2026-11-01" }, { extraWatches: watch({ from: "2026-11-01" }, ["복층데크(단독형)"], "dangsa") });
    await settle();
    expect(pageGets(p)).toHaveLength(1);
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("예약 화면 요청도 5초 + 지터 간격과 정직한 UA를 지킨다", async () => {
    const p = run({ from: "2026-10-31", to: "2026-11-01" }, { server: bukguServer({ table: () => ({ status: 200, body: bukguTable("2026-10-14") }) }) });
    await settle();
    expect(pageGets(p)[0]!.headers["User-Agent"]).toBe("overlord-availability-poller/0.1.0 (ops)");
    expect(p.requestTimes[1]! - p.requestTimes[0]!).toBe(6_500);
    await p.stop();
  });

  describe("선착순 개시(10/19 월 10:00 KST)", () => {
    // 결제 마감일(resEndDay 16, 금) 다음 월요일 10시다. 달력의 "선착순예약"이 16일부터 그려지지만 그 전에 열리지 않는다.
    const at = (when: string, server: ReturnType<typeof bukguServer>) => run({ from: "2026-11-01" }, { server, now: when });

    it("달력 상한이 12/01로 올라 있어도 개시 시각 전에는 다음 달 날짜를 알리지 않는다", async () => {
      const p = at("2026-10-19T09:59:00+09:00", withD2(D2_DEC_1));
      await settle();
      expect(p.sent).toHaveLength(0);
      expect(p.allRequests.filter((r) => r.method === "POST")).toEqual([]);
      await p.stop();
    });

    it("개시 시각 뒤 달력 상한이 12/01이면 다음 달 날짜를 알린다", async () => {
      const p = at("2026-10-19T10:01:00+09:00", withD2(D2_DEC_1));
      await settle();
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0]!.text).toContain("일반데크");
      await p.stop();
    });

    it("개시 시각 뒤에도 달력 상한(d2)이 그 날짜까지 열려 있지 않으면 알리지 않는다(상한 날짜 자체는 `>` 비교 때문에 눌리지만 열린 날이 아니다)", async () => {
      const p = at("2026-10-19T10:01:00+09:00", bukguServer());
      await settle();
      expect(p.sent).toHaveLength(0);
      expect(p.allRequests.filter((r) => r.method === "POST")).toEqual([]);
      await p.stop();
    });

    it("두 달 뒤 날짜는 달력 상한이 넘어가도 알리지 않는다(조례: 사용일이 속한 월의 전월부터 예약)", async () => {
      const p = run({ from: "2026-12-05" }, { server: withD2(D2_JAN_1), now: "2026-10-25T09:00:00+09:00" });
      await settle();
      expect(p.sent).toHaveLength(0);
      expect(p.allRequests.filter((r) => r.method === "POST")).toEqual([]);
      await p.stop();
    });

    it("다음 달 날짜는 상한이 올라간 뒤 이달 말에도 알린다", async () => {
      const p = run({ from: "2026-11-15" }, { server: withD2(D2_DEC_1), now: "2026-10-25T09:00:00+09:00" });
      await settle();
      expect(p.sent).toHaveLength(1);
      await p.stop();
    });
  });

  describe("예약 화면 신호 분류", () => {
    it.each([
      ["달력 상한(d2)이 없음", (h: string) => h.replace(/var d2= \d+;/, "var d2 = null;")],
      ["달력 상한(d2)이 숫자가 아님", (h: string) => h.replace(/var d2= \d+;/, "var d2= 'x';")],
      ["결제 마감일(resEndDay)이 없음", (h: string) => h.replace(/var resEndDay = '16';/, "")],
      ["결제 마감일(resEndDay)이 날짜가 아님", (h: string) => h.replace("var resEndDay = '16';", "var resEndDay = '0';")],
    ])("%s이면 unrecognized이고 알리지 않으며 그 날짜의 표를 조회하지 않는다", async (_name, change) => {
      const p = run({ from: "2026-11-01" }, { server: pageWith(change) });
      await settle();
      expect(kinds(p)).toEqual(["unrecognized"]);
      expect(p.sent).toHaveLength(0);
      expect(p.allRequests.filter((r) => r.method === "POST")).toEqual([]);
      await p.clock.advance(150_000); // 두 바퀴 연속이면 멈추고 알린다
      await settle();
      expect(kinds(p)).toEqual(["unrecognized", "unrecognized"]);
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0]!.text).toMatch(/구조가 바뀌/);
      await p.stop();
    });

    it("예약 화면 구조가 바뀌어도 이달 날짜는 계속 읽는다", async () => {
      const server = pageWith((h) => h.replace(/var d2= \d+;/, ""));
      const p = run({ from: "2026-10-25" }, { server });
      await settle();
      expect(kinds(p)).toEqual([]);
      expect(p.sent).toHaveLength(1);
      await p.stop();
    });

    it.each([
      ["HTTP 403은 blocked", 403, "blocked"],
      ["HTTP 429는 blocked", 429, "blocked"],
      ["HTTP 503은 transient", 503, "transient"],
    ])("예약 화면이 %s다", async (_name, status, kind) => {
      const p = run({ from: "2026-11-01" }, { server: bukguServer({ page: () => ({ status, body: "" }) }) });
      await settle();
      expect(kinds(p)).toEqual([kind]);
      await p.stop();
    });

    it("예약 화면 자리에 봇 탐지 장치 표지가 오면 blocked로 멈춘다", async () => {
      const p = run({ from: "2026-11-01" }, { server: pageWith((h) => h.replace("</head>", '<script src="https://cdn-botmanager.example/agent.js"></script></head>')) });
      await settle();
      expect(kinds(p)).toEqual(["blocked"]);
      await p.stop();
    });

    it("예약 화면 요청이 TLS 검증에 두 바퀴 연속 실패하면 unrecognized다", async () => {
      const tls = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) });
      const p = run({ from: "2026-11-01" }, { server: bukguServer({ intercept: () => { throw tls(); } }) });
      await settle();
      await p.clock.advance(300_000);
      await settle();
      expect(kinds(p)).toEqual(["transient", "unrecognized"]);
      await p.stop();
    });
  });
});

describe("북구 폴러: 당사현대차오션캠프", () => {
  const dangsa = (zones: string[], from = "2026-10-14") => run({ from }, { facility: "dangsa", zones });

  it("구역은 표의 시설종류 이름이고 사이트명 칸의 색 클래스로 가른다. 같은 색 클래스도 시설마다 다른 구역이다(line_yellow는 강동에서는 일반데크, 당사에서는 복층데크(단독형))", async () => {
    const p = dangsa(["복층데크(단독형)"]);
    await settle();
    expect(p.allRequests.map((r) => r.body)).toEqual(["resDate=2026-10-14&siteKindCode=010200&priceCode="]);
    expect(p.sent).toHaveLength(1);
    const text = p.sent[0]!.text;
    expect(text).toContain("복층데크(단독형)");
    expect(seatsIn(text, "복층데크(단독형)")).toEqual(["복층데크(단독형) 3", "복층데크(단독형) 6", "복층데크(단독형) 7", "복층데크(단독형) 14", "복층데크(단독형) 15", "복층데크(단독형) 18"]);
    expect(text).not.toContain("일반데크");
    expect(JSON.stringify(p.sent[0]!.reply_markup)).toContain("https://camping.ubimc.or.kr/Pmreservation.do");
    await p.stop();
  });

  it("구역 넷은 한 번의 조회에서 자기 자리만 담아 한 건으로 알리고 예약종료 자리는 알리지 않는다", async () => {
    const p = dangsa(["일반데크(단독형)", "복층데크(단독형)", "일반데크(당사)", "복층데크(당사)"]);
    await settle();
    expect(p.allRequests).toHaveLength(1);
    expect(p.sent).toHaveLength(1);
    const text = p.sent[0]!.text;
    // 기록한 10/14: 일반데크(단독형) 2·5·8은 예약종료다.
    expect(seatsIn(text, "일반데크(단독형)")).toEqual(["일반데크(단독형) 1", "일반데크(단독형) 4", "일반데크(단독형) 13"]);
    expect(text).toContain("일반데크 10");
    expect(text).toContain("일반데크 20");
    expect(text).toContain("복층데크 9");
    expect(text).toContain("복층데크 19");
    await p.stop();
  });

  it("강동과 당사를 함께 감시하면 siteKindCode가 다른 요청이 각각 나간다", async () => {
    const p = run({ from: "2026-10-14" }, { extraWatches: watch({ from: "2026-10-14" }, ["복층데크(단독형)"], "dangsa") });
    await settle();
    expect(p.allRequests.map((r) => r.body)).toEqual(["resDate=2026-10-14&siteKindCode=010100&priceCode=", "resDate=2026-10-14&siteKindCode=010200&priceCode="]);
    const text = p.sent.map((m) => m.text).join("\n"); // 재시작 직후 현황으로 한 건에 묶여 온다
    expect(text).toContain("강동오토캠핑장 · 일반데크 · 일반데크1");
    expect(text).toContain("당사현대차오션캠프 · 복층데크(단독형) · 복층데크(단독형) 3");
    await p.stop();
  });

  it("모르는 시설종류 색 클래스는 구조 변경이다", async () => {
    const server = bukguServer({ table: (f) => ({ status: 200, body: bukguTable(f.resDate, f.siteKindCode).replace("line_sky", "line_green") }) });
    const p = run({ from: "2026-10-14" }, { server, facility: "dangsa", zones: ["일반데크(단독형)"] });
    await settle();
    expect(p.logs.filter((l) => l.msg === "query failed").map((l) => l.fields?.kind)).toEqual(["unrecognized"]);
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });
});

describe("bukgu 설정", () => {
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
  - name: 강동
    provider: bukgu
${lines}
    checkIn: { from: 2026-10-14, to: 2026-10-14 }
    notify: [default]`);

  it("provider: bukgu, facility: gangdong, 시설종류 이름 구역, 1박 감시 조건을 받는다", () => {
    expect(problems(block("    facility: gangdong\n    zones: [일반데크, 필로티, 카라반]\n    nights: 1"))).toBe("");
  });

  it("당사현대차오션캠프의 시설종류 이름 구역도 받는다", () => {
    expect(problems(block("    facility: dangsa\n    zones: [일반데크(단독형), 복층데크(단독형), 일반데크(당사), 복층데크(당사)]\n    nights: 1"))).toBe("");
    expect(problems(block("    facility: dangsa\n    zones: [일반데크]\n    nights: 1"))).toMatch(/없는 구역 "일반데크"다\. 쓸 수 있는 값: 일반데크\(단독형\), 복층데크\(단독형\), 일반데크\(당사\), 복층데크\(당사\)/);
  });

  it("facility 없는 감시 조건은 위치와 쓸 수 있는 시설 코드와 함께 거부된다", () => {
    expect(problems(block("    zones: [일반데크]"))).toMatch(/\d+번째 줄 watches\.0\.facility: 시설을 골라야 한다\. 쓸 수 있는 값: gangdong, dangsa$/);
  });

  it("없는 구역 이름은 위치와 쓸 수 있는 구역 이름과 함께 거부된다", () => {
    expect(problems(block("    facility: gangdong\n    zones: [복층데크]"))).toMatch(
      /\d+번째 줄 watches\.0\.zones: 없는 구역 "복층데크"다\. 쓸 수 있는 값: 일반데크, 필로티, 카라반/,
    );
  });

  it("2박은 최대 박수와 함께 위치를 짚어 거부한다", () => {
    expect(problems(block("    facility: gangdong\n    zones: [일반데크]\n    nights: 2"))).toMatch(
      /\d+번째 줄 watches\.0\.nights: bukgu는 최대 1박까지 예약할 수 있다\(설정값 2\)/,
    );
  });
});

describe("catalog bukgu", () => {
  const catalog = async (facility?: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const requests: TransportRequest[] = [];
    const code = await runCatalog(
      { kind: "catalog", provider: "bukgu", ...(facility ? { facility } : {}), live: false },
      {
        adapters,
        transport: async (r) => (requests.push(r), { status: 404, body: "" }),
        version: "0.1.0",
        now: () => new Date("2026-10-12T15:00:00Z"),
        sleep: async () => {},
        random: () => 0.5,
        out: (s) => void out.push(s),
        err: (s) => void err.push(s),
      },
    );
    return { code, out: out.join(""), err: err.join(""), requests };
  };

  it("시설을 안 고르면 시설 목록을 보이고 요청은 보내지 않는다", async () => {
    const r = await catalog();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^gangdong\s+강동오토캠핑장\s+3곳$/m);
    expect(r.out).toMatch(/^dangsa\s+당사현대차오션캠프\s+4곳$/m);
    expect(r.requests).toEqual([]);
  });

  it("당사는 최대 1박과 시설종류 이름 구역 넷을 요청 없이 보인다", async () => {
    const r = await catalog("dangsa");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^bukgu \(최대 1박\)$/m);
    for (const z of ["일반데크(단독형) 일반데크(단독형)", "복층데크(단독형) 복층데크(단독형)", "일반데크(당사) 일반데크(당사)", "복층데크(당사) 복층데크(당사)"]) expect(r.out.replace(/ +/g, " ")).toContain(z);
    expect(r.requests).toEqual([]);
  });

  it("강동은 최대 1박과 시설종류 이름 구역 셋을 보인다", async () => {
    const r = await catalog("gangdong");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^bukgu \(최대 1박\)$/m);
    for (const z of ["일반데크 일반데크", "필로티 필로티", "카라반 카라반"]) expect(r.out.replace(/ +/g, " ")).toContain(z);
    expect(r.requests).toEqual([]);
  });

  it("없는 시설은 쓸 수 있는 값을 보이며 거부한다", async () => {
    const r = await catalog("hwangbang");
    expect(r.code).toBe(1);
    expect(r.err).toContain("gangdong, dangsa");
  });
});

describe("catalog bukgu <시설> --live", () => {
  // 가짜 시계는 2026-10-13 00:00 KST라 내일(KST)은 2026-10-14다. 그날은 두 시설 모두 기록한 표가 있다.
  const setup = (server = bukguServer()) => {
    const out: string[] = [];
    const err: string[] = [];
    const requests: TransportRequest[] = [];
    const sleeps: number[] = [];
    const run = (facility?: string) =>
      runCatalog(
        { kind: "catalog", provider: "bukgu", ...(facility ? { facility } : {}), live: true },
        {
          adapters,
          transport: async (r) => (requests.push(r), server(r)),
          version: "0.1.0",
          now: () => new Date("2026-10-12T15:00:00Z"),
          sleep: async (ms) => void sleeps.push(ms),
          random: () => 0.5,
          out: (s) => void out.push(s),
          err: (s) => void err.push(s),
        },
      );
    return { run, out: () => out.join(""), err: () => err.join(""), requests, sleeps };
  };

  it.each([
    ["gangdong", "010100", 25],
    ["dangsa", "010200", 20],
  ])("%s: 내일(KST) 날짜로 시설 전체 표를 한 번만 요청하고 카탈로그와 같으면 차이 없음 0이다(예약 화면은 받지 않는다)", async (facility, siteKindCode, seats) => {
    const s = setup();
    expect(await s.run(facility)).toBe(0);
    expect(s.requests.map((r) => `${r.method} ${new URL(r.url).pathname} ${r.body ?? ""}`)).toEqual([`POST /ajax/reservationCntAjax.do resDate=2026-10-14&siteKindCode=${siteKindCode}&priceCode=`]);
    expect(s.out()).toContain("실제 예약처와 비교");
    expect(s.out()).toContain("차이 없음");
    expect(s.out()).not.toMatch(/사라|새로 생긴|다르다|예약처 응답에 구역이 없다/);
    expect(s.out().match(/실제 (\d+)자리/g)?.map((m) => Number(m.replace(/\D/g, ""))).reduce((a, b) => a + b, 0)).toBe(seats);
    expect(s.err()).toBe("");
  });

  it("구역마다 실제 자리를 보인다(자리 목록은 카탈로그에 두지 않았다)", async () => {
    const s = setup();
    expect(await s.run("dangsa")).toBe(0);
    expect(s.out()).toContain("복층데크(단독형): 고정 목록이 없다. 실제 6자리");
    expect(s.out()).toContain("일반데크(당사): 고정 목록이 없다. 실제 4자리");
  });

  it("시설 없이 --live를 걸면 요청 없이 쓸 수 있는 시설 코드와 함께 1이다", async () => {
    const s = setup();
    expect(await s.run(undefined)).toBe(1);
    expect(s.err()).toContain("시설을 골라야 한다");
    expect(s.err()).toContain("gangdong, dangsa");
    expect(s.requests).toEqual([]);
  });

  it("표에서 구역이 사라지면 응답에 없는 구역으로 보고하고 종료 코드는 0이다", async () => {
    const withoutSky = (f: { resDate: string; siteKindCode: string }) => ({
      status: 200,
      body: bukguTable(f.resDate, f.siteKindCode).replace(/<tr>(?:(?!<\/tr>)[\s\S])*?line_sky(?:(?!<\/tr>)[\s\S])*?<\/tr>/g, ""),
    });
    const s = setup(bukguServer({ table: withoutSky }));
    expect(await s.run("gangdong")).toBe(0);
    expect(s.out()).toContain("필로티: 예약처 응답에 구역이 없다(필로티)");
    expect(s.out()).toContain("차이 있는 구역 1곳: 카탈로그를 갱신해야 한다");
  });

  it("모르는 시설종류 색 클래스는 새로 생긴 구역으로 보고하고 종료 코드는 0이다", async () => {
    const s = setup(bukguServer({ table: (f) => ({ status: 200, body: bukguTable(f.resDate, f.siteKindCode).replace(/line_sky/g, "line_green") }) }));
    expect(await s.run("gangdong")).toBe(0);
    expect(s.out()).toContain("필로티: 예약처 응답에 구역이 없다(필로티)");
    expect(s.out()).toMatch(/예약처에 새로 생긴 구역 .*line_green.*: 3자리/);
    expect(s.out()).not.toContain("구역 코드가 다르다");
  });

  it.each([
    ["HTTP 403", { status: 403, body: "" }, "blocked"],
    ["HTTP 429", { status: 429, body: "" }, "blocked"],
    ["HTTP 503", { status: 503, body: "" }, "transient"],
    ["표 없음", { status: 200, body: "<html>점검 중</html>" }, "unrecognized"],
  ])("조회가 실패하면(%s) 종료 코드 1이고 실패 종류를 알린다", async (_name, response, kind) => {
    const s = setup(bukguServer({ table: () => response }));
    expect(await s.run("gangdong")).toBe(1);
    expect(s.out()).toContain(`조회 실패(${kind})`);
  });

  it("TLS 검증 실패도 조회 실패라 1이다(검증을 끄지 않는다)", async () => {
    const tls = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) });
    const s = setup(bukguServer({ intercept: () => { throw tls(); } }));
    expect(await s.run("dangsa")).toBe(1);
    expect(s.out()).toContain("조회 실패(transient)");
  });

  it("추첨 접수 기간의 다음 달 날짜를 마스크하지 않는다(대조는 표의 모양만 본다)", async () => {
    const out: string[] = [];
    const requests: TransportRequest[] = [];
    const server = bukguServer();
    const code = await runCatalog(
      { kind: "catalog", provider: "bukgu", facility: "gangdong", live: true },
      { adapters, transport: async (r) => (requests.push(r), server(r)), version: "0.1.0", now: () => new Date("2026-10-30T15:00:00Z"), sleep: async () => {}, random: () => 0.5, out: (x) => void out.push(x), err: () => {} },
    ); // 내일 = 11/01
    expect(code).toBe(0);
    expect(requests.map((r) => r.body)).toEqual(["resDate=2026-11-01&siteKindCode=010100&priceCode="]);
  });
});
