import { describe, expect, it } from "vitest";
import { adapters } from "../src/adapters/index.js";
import { runCatalog } from "../src/commands.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { createHttpClient } from "../src/http.js";
import type { TransportRequest } from "../src/types.js";
import { ENV, bukguServer, bukguTable, configWith, settle, startPoller } from "./harness.js";

// 강동오토캠핑장(gangdong, siteKindCode=010100)의 기록한 응답(2026-10-13 00시 전후, research/raw/bukgu)을 fixture로 쓴다.
// 10/14는 25자리 가운데 18자리가 예약가능(일반데크 1·2·8~13, 필로티 1~3, 카라반 1~4·7~9)이고, 10/17은 25자리 모두 예약종료다.
// 가짜 시계는 기본(2026-09-29 09:00 KST)이다. 그때 10월 날짜는 전월부터 열려 있다.
const watch = (checkIn: { from: string; to?: string }, zones: string[] = ["일반데크"]) => `
  - name: 강동 ${checkIn.from}
    provider: bukgu
    facility: gangdong
    zones: [${zones.join(", ")}]
    checkIn: { from: ${checkIn.from}, to: ${checkIn.to ?? checkIn.from} }
    nights: 1
    notify: [default]`;

const run = (checkIn: { from: string; to?: string }, opts: { server?: ReturnType<typeof bukguServer>; zones?: string[]; random?: () => number; now?: string } = {}) =>
  startPoller(() => ({ status: 404, body: "" }), {
    yaml: configWith(watch(checkIn, opts.zones)),
    server: opts.server ?? bukguServer(),
    random: opts.random,
    now: opts.now,
  });

/** 기록은 몇 날짜뿐이라, 여러 날짜를 조회하는 시험은 어느 날짜든 기록한 10/14 표로 답한다. */
const anyDay = () => bukguServer({ table: () => ({ status: 200, body: bukguTable("2026-10-14") }) });

/** 메시지에 실린 이름 가운데 `접두어` + 숫자인 자리. */
const seatsIn = (text: string, prefix: string) => text.match(new RegExp(`${prefix}\\d+`, "g")) ?? [];

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

  it("facility 없는 감시 조건은 위치와 쓸 수 있는 시설 코드와 함께 거부된다", () => {
    expect(problems(block("    zones: [일반데크]"))).toMatch(/\d+번째 줄 watches\.0\.facility: 시설을 골라야 한다\. 쓸 수 있는 값: gangdong$/);
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
    const r = await catalog("dangsa");
    expect(r.code).toBe(1);
    expect(r.err).toContain("gangdong");
  });
});
