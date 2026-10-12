import { describe, expect, it } from "vitest";
import { adapters } from "../src/adapters/index.js";
import { runCatalog } from "../src/commands.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { createHttpClient } from "../src/http.js";
import { ENV, settle, configWith, startPoller, uljuRows, uljuRowsFor, uljuServer } from "./harness.js";
import type { UljuRow } from "./harness.js";
import type { TransportRequest, TransportResponse } from "../src/types.js";

// 작천정별빛야영장(jakcheon-byeolbit, classes=C0000001)의 기록한 응답(2026-10-12, research/raw/ulju)을 fixture로 쓴다.
// 2026-10-16(금)은 88자리 가운데 Y가 11자리다: 야영데크(4*4)(F0000004) 7자리, 야영데크(6*4)(F0000016) 4자리.
// 가짜 시계는 2026-09-29 09:00 KST에서 시작한다. 그때 10월 날짜는 "다음 달"이고 9/11 10:00부터 열려 있다.
const ZONE_4X4 = "F0000004"; // 야영데크(4*4)
const ZONE_6X4 = "F0000016"; // 야영데크(6*4)
const ZONE_CABIN = "F0000005"; // 캐빈하우스: 10/16에는 모두 N이다.

const watch = (checkIn: { from: string; to?: string }, zones: string[] = [ZONE_4X4], extra = "", facility = "jakcheon-byeolbit", nights = 1) => `
  - name: ${facility} ${zones.join("+")} ${checkIn.from} ${nights}박
    provider: ulju
    facility: ${facility}
    zones: [${zones.join(", ")}]
    checkIn: { from: ${checkIn.from}, to: ${checkIn.to ?? checkIn.from} }
    nights: ${nights}
    notify: [default]${extra}`;

const start = (watches: string, opts: { server?: ReturnType<typeof uljuServer>; random?: () => number; now?: string } = {}) =>
  startPoller(() => ({ status: 404, body: "" }), { yaml: configWith(watches), server: opts.server ?? uljuServer(), random: opts.random, now: opts.now });

const run = (
  checkIn: { from: string; to?: string },
  opts: { server?: ReturnType<typeof uljuServer>; zones?: string[]; random?: () => number; now?: string; extra?: string; facility?: string; nights?: number } = {},
) => start(watch(checkIn, opts.zones, opts.extra, opts.facility, opts.nights), opts);

const path = (r: TransportRequest) => new URL(r.url).pathname;
const DAY = "/ujcamping/campsite/get_cal_day_data_list";
const ok = (rows: unknown[]): TransportResponse => ({ status: 200, body: JSON.stringify({ result: "ok", list: rows }) });
const failedKinds = (p: { logs: { msg: string; fields?: Record<string, unknown> }[] }) => p.logs.filter((l) => l.msg === "query failed").map((l) => l.fields?.kind);

describe("ulju 폴러", () => {
  it("Y 자리는 구역 이름, 자리 이름, 딥링크가 담긴 메시지 한 건으로 알리고 N 자리는 알리지 않는다", async () => {
    const p = run({ from: "2026-10-16" });
    await settle();
    expect(p.sent).toHaveLength(1);
    const text = p.sent[0]!.text;
    expect(text).toContain("야영데크(4*4)");
    for (const name of ["별빛야영장2", "별빛야영장9", "별빛야영장11", "별빛야영장17", "별빛야영장20", "별빛야영장22", "별빛야영장23"]) expect(text).toContain(name);
    expect(text).not.toContain("별빛야영장1,"); // N
    expect(text).not.toContain("별빛야영장4"); // N
    expect(JSON.stringify(p.sent[0]!.reply_markup)).toContain("https://camping.ulju.ulsan.kr/ujcamping/campsite/booking");
    await p.stop();
  });

  it("구역을 여럿 감시해도 그 밤은 한 번만 조회하고 메시지는 한 건이다", async () => {
    const p = run({ from: "2026-10-16" }, { zones: [ZONE_4X4, ZONE_6X4, ZONE_CABIN] });
    await settle();
    expect(p.allRequests.map((r) => path(r))).toEqual([DAY]);
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("야영데크(4*4)");
    expect(p.sent[0]!.text).toContain("야영데크(6*4)");
    expect(p.sent[0]!.text).toContain("별빛야영장57");
    expect(p.sent[0]!.text).not.toContain("캐빈하우스"); // 모두 N
    await p.stop();
  });

  it("같은 빈자리가 연속 두 바퀴 잡혀도 첫 바퀴에만 알린다", async () => {
    const p = run({ from: "2026-10-16" });
    await settle();
    expect(p.sent).toHaveLength(1);
    await p.clock.advance(150_000);
    await settle();
    expect(p.allRequests.filter((r) => path(r) === DAY)).toHaveLength(2); // 기본 폴링 간격 150초
    expect(p.sent).toHaveLength(1);
    await p.stop();
  });

  it("요청은 페이지와 같은 JSON 본문과 헤더 세 개이고 쿠키·예약 화면·month 호출 없이 날짜마다 POST 한 번이다", async () => {
    const p = run({ from: "2026-10-16", to: "2026-10-17" });
    await settle();
    expect(p.allRequests.map((r) => `${r.method} ${new URL(r.url).host}${path(r)}`)).toEqual([`POST camping.ulju.ulsan.kr${DAY}`, `POST camping.ulju.ulsan.kr${DAY}`]);
    expect(p.allRequests.map((r) => JSON.parse(r.body!))).toEqual([
      { sql_state: "GetData", select_date: "2026-10-16", classes: "C0000001", facility: "", use_only: "N" },
      { sql_state: "GetData", select_date: "2026-10-17", classes: "C0000001", facility: "", use_only: "N" },
    ]);
    for (const r of p.allRequests) {
      expect(r.headers["Content-Type"]).toBe("application/json");
      expect(r.headers["X-HTTP-Method-Override"]).toBe("POST");
      expect(r.headers["X-CSRF-TOKEN"]).toBe("");
      expect(r.headers.Cookie).toBeUndefined();
      expect(r.headers["User-Agent"]).toBe("overlord-availability-poller/0.1.0 (ops)");
    }
    await p.stop();
  });

  it("요청 사이는 5초 + 지터 간격이다", async () => {
    const p = run({ from: "2026-10-16", to: "2026-10-17" }); // random 0.5: 6.5초
    await settle();
    expect(p.requestTimes[1]! - p.requestTimes[0]!).toBe(6_500);
    await p.stop();
    const low = run({ from: "2026-10-16", to: "2026-10-17" }, { random: () => 0 });
    await settle();
    expect(low.requestTimes[1]! - low.requestTimes[0]!).toBe(5_000);
    await low.stop();
  });

  describe("당일 마감과 날짜 창", () => {
    it("17:00 KST 뒤에는 당일 입실을 조회하지 않고 그 전에는 조회한다", async () => {
      const late = run({ from: "2026-10-16" }, { now: "2026-10-16T17:00:00+09:00" });
      await settle();
      expect(late.allRequests).toHaveLength(0);
      await late.stop();
      const early = run({ from: "2026-10-16" }, { now: "2026-10-16T16:59:00+09:00" });
      await settle();
      expect(early.allRequests).toHaveLength(1);
      await early.stop();
    });

    it.each([
      ["17시 이후 당일", "당일(2026-10-16) 예약은 17시에 마감되었습니다.\n내일 다시 이용해 주시기 바랍니다."],
      ["과거 날짜", "지난 날짜(2026-10-16)는 예약할 수 없습니다."],
      ["현재 달과 다음 달 밖", "예약은 현재 달과 다음 달까지만 조회 가능합니다."],
    ])("booking_ended(%s)는 빈자리 없음이고 실패로 세지 않으며 예약처 상태를 바꾸지 않는다", async (_name, msg) => {
      const p = run({ from: "2026-10-16" }, { server: uljuServer({ day: () => ({ status: 200, body: JSON.stringify({ result: "booking_ended", msg }) }) }) });
      await settle();
      expect(p.allRequests).toHaveLength(1);
      expect(p.sent).toHaveLength(0);
      expect(failedKinds(p)).toEqual([]);
      await p.clock.advance(150_000);
      await settle();
      expect(p.allRequests).toHaveLength(2); // 멈추지 않고 다음 바퀴를 돈다.
      expect(p.sent).toHaveLength(0); // 헬스 알림도 없다.
      await p.stop();
    });

    it("no_list도 실패가 아니라 빈자리 없음이다", async () => {
      const p = run({ from: "2026-10-16" }, { server: uljuServer({ day: () => ({ status: 200, body: JSON.stringify({ result: "no_list" }) }) }) });
      await settle();
      expect(p.sent).toHaveLength(0);
      expect(failedKinds(p)).toEqual([]);
      await p.stop();
    });

    it("현재 달과 다음 달 밖의 날짜는 요청을 보내지 않는다", async () => {
      const p = run({ from: "2026-11-02" }); // 9/29에는 다다음 달이다.
      await settle();
      expect(p.allRequests).toHaveLength(0);
      expect(failedKinds(p)).toEqual([]);
      await p.stop();
    });

    it("2박 가운데 한 밤이라도 조회 창 밖이면 그 단위는 첫 밤도 조회하지 않고 창 안의 다른 감시 조건은 그대로 조회한다", async () => {
      // 10/10 09:00 KST: 10/31 입실 2박의 둘째 밤(11/1)은 아직 닫혀 있다.
      const p = start(watch({ from: "2026-10-31" }, [ZONE_4X4], "", "jakcheon-byeolbit", 2) + watch({ from: "2026-10-16" }), { now: "2026-10-10T09:00:00+09:00" });
      await settle();
      expect(p.allRequests.map((r) => JSON.parse(r.body!).select_date)).toEqual(["2026-10-16"]);
      expect(failedKinds(p)).toEqual([]);
      await p.stop();
    });

    it("다음 달 날짜는 이번 달 11일 10:00 KST(선착순 시작) 전에는 조회하지 않고 그 뒤에는 조회한다", async () => {
      const before = run({ from: "2026-11-20" }, { now: "2026-10-11T09:59:00+09:00" });
      await settle();
      expect(before.allRequests).toHaveLength(0);
      await before.stop();
      const after = run({ from: "2026-11-20" }, { now: "2026-10-11T10:00:00+09:00" });
      await settle();
      expect(after.allRequests).toHaveLength(1);
      await after.stop();
      const sameMonth = run({ from: "2026-10-20" }, { now: "2026-10-01T09:00:00+09:00" }); // 이번 달은 늘 조회한다.
      await settle();
      expect(sameMonth.allRequests).toHaveLength(1);
      await sameMonth.stop();
    });
  });

  describe("접근 금지 경로", () => {
    it("조회 흐름은 접근 금지 경로로 요청을 보내지 않는다", async () => {
      const p = run({ from: "2026-10-16" });
      await settle();
      const forbidden = ["/ujcamping/campsite/booking_", "/ujcamping/campsite/ulju_resident_apply", "/ujcamping/campsite/general_apply", "/ujcamping/memberIntro/", "/ujcamping/mypage", "/ujcamping/camp_exp/"];
      for (const r of p.allRequests) expect(forbidden.some((f) => path(r).startsWith(f))).toBe(false);
      await p.stop();
    });

    it("예약 다음 단계·추첨 신청·로그인·마이페이지·숲공작 경로는 HTTP 층이 막고 예약 화면과 조회 경로는 막지 않는다", async () => {
      const sent: string[] = [];
      const http = createHttpClient({
        transport: async (r) => (sent.push(r.url), { status: 200, body: "{}" }),
        version: "0.1.0",
        userAgentSuffix: "",
        blockedPaths: adapters.ulju!.describe().blockedPaths,
        cookieSession: false,
      });
      for (const blocked of [
        "/ujcamping/campsite/booking_step1?CAMP_ID=C0000002&SDATE=2026-10-16&EDATE=2026-10-17",
        "/ujcamping/campsite/booking_step2",
        "/ujcamping/campsite/ulju_resident_apply",
        "/ujcamping/campsite/general_apply",
        "/ujcamping/campsite/winnerList",
        "/ujcamping/memberIntro/login",
        "/ujcamping/mypage/mypage5",
        "/ujcamping/camp_exp/camp_exp_booking",
      ]) {
        await expect(http.get(`https://camping.ulju.ulsan.kr${blocked}`), blocked).rejects.toThrow(/접근 금지/);
      }
      expect(sent).toEqual([]);
      await http.get("https://camping.ulju.ulsan.kr/ujcamping/campsite/booking");
      await http.post(`https://camping.ulju.ulsan.kr${DAY}`, "{}");
      expect(sent).toHaveLength(2);
    });

    it("조회가 로그인 경로로 리다이렉트되면 그 경로로 요청을 보내지 않고 blocked로 멈춘다", async () => {
      const server = uljuServer({ intercept: (r) => (path(r) === DAY ? { status: 302, body: "", location: "/ujcamping/memberIntro/login" } : undefined) });
      const p = run({ from: "2026-10-16" }, { server });
      await settle();
      expect(p.allRequests.some((r) => path(r).startsWith("/ujcamping/memberIntro/"))).toBe(false);
      expect(failedKinds(p)).toEqual(["blocked"]);
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0]!.text).toMatch(/차단|blocked/);
      const before = p.allRequests.length;
      await p.clock.advance(300_000);
      await settle();
      expect(p.allRequests.length).toBe(before);
      await p.stop();
    });
  });

  describe("신호 분류(기본)", () => {
    const onDay = (response: TransportResponse) => uljuServer({ day: () => response });

    it.each([
      ["HTTP 401(로그인 요구)", { status: 401, body: "" }],
      ["HTTP 403", { status: 403, body: "" }],
      ["HTTP 429", { status: 429, body: "" }],
    ])("%s는 blocked다", async (_name, response) => {
      const p = run({ from: "2026-10-16" }, { server: onDay(response) });
      await settle();
      expect(failedKinds(p)).toEqual(["blocked"]);
      await p.stop();
    });

    it("HTTP 5xx는 transient다", async () => {
      const p = run({ from: "2026-10-16" }, { server: onDay({ status: 503, body: "" }) });
      await settle();
      expect(failedKinds(p)).toEqual(["transient"]);
      expect(p.sent).toHaveLength(0);
      await p.stop();
    });

    it("list 행에 CAMP_ID가 없으면 구조 변경(unrecognized)이다", async () => {
      const rows = uljuRowsFor("2026-10-16").map((r): Partial<UljuRow> => ({ ...r, CAMP_ID: undefined }));
      const p = run({ from: "2026-10-16" }, { server: onDay(ok(rows)) });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      expect(p.sent).toHaveLength(0);
      await p.stop();
    });

    it("ISRESERVABLE이 Y/N 밖이면 구조 변경(unrecognized)이다", async () => {
      const rows = uljuRowsFor("2026-10-16").map((r, i) => (i === 0 ? { ...r, ISRESERVABLE: "M" } : r));
      const p = run({ from: "2026-10-16" }, { server: onDay(ok(rows)) });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      await p.stop();
    });
  });
});

describe("ulju 요청이 한 건도 나가지 않은 바퀴", () => {
  const HOURLY = "hourlySummary: { enabled: true, everyHours: 1 }";
  const hourlies = (p: { sent: { text: string }[] }) => p.sent.filter((m) => m.text.includes("시간별 요약"));

  it("조회 창 규칙(다음 달은 이번 달 11일 10:00부터)으로 요청이 없던 시간은 바퀴 0회, 마지막 성공 없음으로 적는다", async () => {
    // 2026-10-10 09:00 KST에 11월 날짜는 아직 닫혀 있다(10/11 10:00에 열린다). 10:00까지 한 시간 동안 요청이 없다.
    const p = startPoller(() => ({ status: 404, body: "" }), {
      yaml: configWith(watch({ from: "2026-11-20" })).replace("providers:", `${HOURLY}\nproviders:`),
      server: uljuServer(),
      now: "2026-10-10T09:00:00+09:00",
    });
    await settle();
    for (let i = 0; i < 24; i++) await p.clock.advance(150_000);
    expect(p.allRequests).toHaveLength(0);
    expect(failedKinds(p)).toEqual([]);
    const m = hourlies(p)[0]!;
    expect(m.text).toMatch(/ulju<\/b>: 정상 · 지난 1시간 바퀴 0회, 실패한 바퀴 0회 · 마지막 성공 없음/);
    await p.stop();
  });

  it("창이 열려 요청이 나가기 시작하면 그 바퀴부터 바퀴 수와 마지막 성공에 잡힌다", async () => {
    // 09:01에 시작해 150초마다 돈다. 10/11 10:00에 11월이 열려 10:01 바퀴부터 요청이 나간다.
    const p = startPoller(() => ({ status: 404, body: "" }), {
      yaml: configWith(watch({ from: "2026-11-20" })).replace("providers:", `${HOURLY}\nproviders:`),
      server: uljuServer(),
      now: "2026-10-11T09:01:00+09:00",
    });
    await settle();
    for (let i = 0; i < 48; i++) await p.clock.advance(150_000); // 11:01
    const [before, after] = hourlies(p);
    expect(before!.text).toMatch(/바퀴 0회.*마지막 성공 없음/);
    expect(after!.text).toMatch(/바퀴 [1-9]\d*회, 실패한 바퀴 0회 · 마지막 성공 10-11 (10:[0-5]\d|11:00)/);
    await p.stop();
  });
});

describe("ulju 여러 박과 여러 시설", () => {
  /** 기록한 10/16 응답에서 자리 이름이 맞는 행만 N으로 바꾼 응답. */
  const closing = (names: string[]) => (date: string, classes: string) =>
    ok(uljuRowsFor(date, uljuRows(classes).map((r) => (names.includes(r.NAME) ? { ...r, ISRESERVABLE: "N" } : r))));
  const mentions = (text: string, seat: string) => new RegExp(`${seat}(?!\\d)`).test(text);

  it("2박 조회 단위는 두 밤 모두 Y인 자리만 알리고 첫 밤만 Y인 자리는 알리지 않는다", async () => {
    // 10/16은 기록 그대로(4*4 Y: 2, 9, 11, 17, 20, 22, 23), 10/17은 2와 9가 N이다.
    const server = uljuServer({ day: (date, classes) => (date === "2026-10-17" ? closing(["별빛야영장2", "별빛야영장9"])(date, classes) : ok(uljuRowsFor(date, uljuRows(classes)))) });
    const p = run({ from: "2026-10-16" }, { server, nights: 2 });
    await settle();
    expect(p.allRequests.map((r) => JSON.parse(r.body!).select_date)).toEqual(["2026-10-16", "2026-10-17"]);
    expect(p.sent).toHaveLength(1);
    const text = p.sent[0]!.text;
    for (const seat of ["별빛야영장11", "별빛야영장17", "별빛야영장20", "별빛야영장22", "별빛야영장23"]) expect(mentions(text, seat), seat).toBe(true);
    for (const seat of ["별빛야영장2", "별빛야영장9"]) expect(mentions(text, seat), seat).toBe(false);
    await p.stop();
  });

  it("둘째 밤이 모두 N이면 첫 밤에 Y가 있어도 알리지 않는다", async () => {
    const server = uljuServer({ day: (date, classes) => (date === "2026-10-17" ? closing(uljuRows(classes).map((r) => r.NAME))(date, classes) : ok(uljuRowsFor(date, uljuRows(classes)))) });
    const p = run({ from: "2026-10-16" }, { server, nights: 2 });
    await settle();
    expect(p.allRequests).toHaveLength(2);
    expect(p.sent).toHaveLength(0);
    expect(failedKinds(p)).toEqual([]);
    await p.stop();
  });

  it("감시 조건 둘이 같은 밤을 쓰면 그 밤은 한 번만 조회한다", async () => {
    const p = start(watch({ from: "2026-10-16" }, [ZONE_4X4], "", "jakcheon-byeolbit", 2) + watch({ from: "2026-10-17" }, [ZONE_6X4]));
    await settle();
    expect(p.allRequests.map((r) => JSON.parse(r.body!).select_date).sort()).toEqual(["2026-10-16", "2026-10-17"]);
    await p.stop();
  });

  it("두 시설을 감시하면 classes가 다른 요청이 각각 나가고 시설마다 구역·자리로 알린다", async () => {
    const p = start(watch({ from: "2026-10-16" }, [ZONE_4X4]) + watch({ from: "2026-10-16" }, ["F0000001"], "", "deungeok"));
    await settle();
    expect(p.allRequests.map((r) => JSON.parse(r.body!).classes)).toEqual(["C0000001", "C0000002"]);
    expect(p.allRequests.every((r) => r.headers["Content-Type"] === "application/json" && r.headers["X-CSRF-TOKEN"] === "")).toBe(true);
    const text = p.sent.map((m) => m.text).join("\n");
    expect(text).toContain("야영데크(4*4)");
    expect(text).toContain("등억 오토캠핑장");
    await p.stop();
  });

  it("같은 FACILITY_ID(F0000001)라도 시설마다 따로 판정한다", async () => {
    // 등억알프스 오토캠핑장은 15자리가 Y, 작천정달빛 오토캠핑장은 6자리가 Y다.
    const p = start(watch({ from: "2026-10-16" }, ["F0000001"], "", "jakcheon-dalbit"));
    await settle();
    expect(p.allRequests.map((r) => JSON.parse(r.body!).classes)).toEqual(["C0000003"]);
    const text = p.sent[0]!.text;
    expect(text).toContain("달빛 오토캠핑장");
    expect(text).not.toContain("등억");
    await p.stop();
  });
});

describe("ulju 신호 분류", () => {
  const without = (zone: string) => (date: string, classes: string) => ok(uljuRowsFor(date, uljuRows(classes).filter((r) => r.FACILITY_ID !== zone)));
  const bad: [string, () => TransportResponse][] = [
    ["모르는 result", () => ({ status: 200, body: JSON.stringify({ result: "maintenance", list: [] }) })],
    ["JSON이 아닌 응답", () => ({ status: 200, body: "<html>점검 중입니다</html>" })],
    ["list가 없는 ok", () => ({ status: 200, body: JSON.stringify({ result: "ok" }) })],
    ["FACILITY_ID가 없는 행", () => ok(uljuRowsFor("2026-10-16").map((r): Partial<UljuRow> => ({ ...r, FACILITY_ID: undefined })))],
    ["ISRESERVABLE이 없는 행", () => ok(uljuRowsFor("2026-10-16").map((r): Partial<UljuRow> => ({ ...r, ISRESERVABLE: undefined })))],
    ["ISRESERVABLE이 Y/N 밖", () => ok(uljuRowsFor("2026-10-16").map((r, i) => (i === 0 ? { ...r, ISRESERVABLE: "P" } : r)))],
    ["감시 구역 소실", () => without(ZONE_4X4)("2026-10-16", "C0000001")],
    ["빈 list", () => ok([])],
  ];

  it.each(bad)("%s는 첫 바퀴에는 알림 없이 두 바퀴 연속일 때 unrecognized로 멈추고 알린다", async (_name, response) => {
    const p = run({ from: "2026-10-16" }, { server: uljuServer({ day: () => response() }) });
    await settle();
    expect(failedKinds(p)).toEqual(["unrecognized"]);
    expect(p.sent).toHaveLength(0);
    await p.clock.advance(150_000);
    await settle();
    expect(failedKinds(p)).toEqual(["unrecognized", "unrecognized"]);
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toMatch(/구조가 바뀌/);
    const before = p.allRequests.length;
    await p.clock.advance(150_000);
    await settle();
    expect(p.allRequests.length).toBe(before); // 멈췄다.
    await p.stop();
  });

  it("200 응답이 로그인 화면이면 blocked로 멈추고 알린다", async () => {
    const p = run({ from: "2026-10-16" }, { server: uljuServer({ day: () => ({ status: 200, body: '<html><a href="/ujcamping/memberIntro/login">로그인</a></html>' }) }) });
    await settle();
    expect(failedKinds(p)).toEqual(["blocked"]);
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toMatch(/차단|blocked/);
    await p.stop();
  });

  it("첫 바퀴에만 구조가 달라 보이고 다음 바퀴가 정상이면 멈추지 않는다", async () => {
    let calls = 0;
    const server = uljuServer({ day: (date, classes) => (++calls === 1 ? { status: 200, body: JSON.stringify({ result: "maintenance" }) } : ok(uljuRowsFor(date, uljuRows(classes)))) });
    const p = run({ from: "2026-10-16" }, { server });
    await settle();
    await p.clock.advance(150_000);
    await settle();
    await p.clock.advance(150_000);
    await settle();
    expect(failedKinds(p)).toEqual(["unrecognized"]);
    expect(p.allRequests).toHaveLength(3);
    expect(p.sent).toHaveLength(1); // 빈자리 알림뿐이다.
    expect(p.sent[0]!.text).toContain("야영데크(4*4)");
    await p.stop();
  });

  it("쓰지 않는 구역이 사라지거나 새로 생겨도 경고만 한 번 남기고 감시를 계속한다", async () => {
    const server = uljuServer({
      day: (date, classes) => {
        const rows = uljuRows(classes).filter((r) => r.FACILITY_ID !== "F0000003");
        return ok(uljuRowsFor(date, [...rows, { ...rows[0]!, FACILITY_ID: "F0000099", FACILITY_NAME: "새 구역", CAMP_ID: "NEW1", NAME: "새자리1" }]));
      },
    });
    const p = run({ from: "2026-10-16" }, { server });
    await settle();
    await p.clock.advance(150_000);
    await settle();
    expect(failedKinds(p)).toEqual([]);
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("야영데크(4*4)");
    const warns = p.logs.filter((l) => l.msg === "ulju zone drift").map((l) => `${l.fields?.change}:${l.fields?.zone}`);
    expect(warns.sort()).toEqual(["gone:F0000003", "new:F0000099"]);
    await p.stop();
  });

  it("자리 목록이 있는 시설(대운산하늘숲)은 쓰지 않는 자리가 사라지거나 새로 생겨도 경고만 한 번 남기고 감시를 계속한다", async () => {
    // 감시 구역은 F0000015(A5~A14). 같은 구역의 A6이 사라지고 A21이 생기고, 다른 구역 F0000008의 A16도 사라진다.
    const server = uljuServer({
      day: (date, classes) => {
        const rows = uljuRows(classes).filter((r) => r.NAME !== "A6" && r.NAME !== "A16");
        return ok(uljuRowsFor(date, [...rows, { ...rows.find((r) => r.FACILITY_ID === "F0000015")!, CAMP_ID: "N21", NAME: "A21" }]));
      },
    });
    const p = run({ from: "2026-10-16" }, { server, facility: "daeunsan", zones: ["F0000015"] });
    await settle();
    await p.clock.advance(150_000);
    await settle();
    expect(failedKinds(p)).toEqual([]);
    expect(p.allRequests).toHaveLength(2); // 두 바퀴 모두 계속 조회한다.
    const warns = p.logs.filter((l) => l.msg === "ulju seat drift").map((l) => `${l.fields?.change}:${l.fields?.zone}:${l.fields?.seat}`);
    expect(warns.sort()).toEqual(["gone:F0000008:A16", "gone:F0000015:A6", "new:F0000015:A21"]); // 두 바퀴에도 한 번씩만
    expect(p.logs.some((l) => l.msg === "ulju zone drift")).toBe(false); // 구역은 그대로다.
    await p.stop();
  });

  it("자리 목록이 없는 시설은 자리가 늘거나 줄어도 자리 차이 경고를 남기지 않는다", async () => {
    const server = uljuServer({
      day: (date, classes) => {
        const rows = uljuRows(classes).filter((r) => r.NAME !== "별빛야영장2");
        return ok(uljuRowsFor(date, [...rows, { ...rows[0]!, CAMP_ID: "N1", NAME: "별빛야영장99" }]));
      },
    });
    const p = run({ from: "2026-10-16" }, { server });
    await settle();
    expect(failedKinds(p)).toEqual([]);
    expect(p.logs.filter((l) => l.msg.includes("drift"))).toEqual([]);
    await p.stop();
  });

  it("구역이 통째로 사라지면 자리마다 경고하지 않고 구역 경고만 남긴다", async () => {
    const server = uljuServer({ day: (date, classes) => ok(uljuRowsFor(date, uljuRows(classes).filter((r) => r.FACILITY_ID !== "F0000014"))) });
    const p = run({ from: "2026-10-16" }, { server, facility: "daeunsan", zones: ["F0000015"] });
    await settle();
    expect(failedKinds(p)).toEqual([]);
    expect(p.logs.filter((l) => l.msg === "ulju zone drift").map((l) => l.fields?.zone)).toEqual(["F0000014"]);
    expect(p.logs.filter((l) => l.msg === "ulju seat drift")).toEqual([]);
    await p.stop();
  });

  it.each([
    ["HTTP 503", { status: 503, body: "" }, "transient"],
    ["HTTP 502", { status: 502, body: "" }, "transient"],
    ["HTTP 403", { status: 403, body: "" }, "blocked"],
  ])("한 밤이 %s이면 남은 요청은 보내지 않고 이미 받은 밤의 결과는 반영한다", async (_name, response, kind) => {
    // 10/16 ok -> 10/17 실패 -> 10/18은 보내지 않는다.
    const server = uljuServer({ day: (date, classes) => (date === "2026-10-17" ? response : ok(uljuRowsFor(date, uljuRows(classes)))) });
    const p = start(watch({ from: "2026-10-16" }) + watch({ from: "2026-10-17" }) + watch({ from: "2026-10-18" }), { server });
    await settle();
    expect(p.allRequests.map((r) => JSON.parse(r.body!).select_date)).toEqual(["2026-10-16", "2026-10-17"]);
    expect(new Set(failedKinds(p))).toEqual(new Set([kind]));
    expect(p.sent.some((m) => m.text.includes("야영데크(4*4)"))).toBe(true); // 10/16 결과
    await p.stop();
  });

  it("연결 실패는 transient이고 알리지 않고 멈추지 않는다", async () => {
    const server = uljuServer({
      intercept: () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    const p = run({ from: "2026-10-16" }, { server });
    await settle();
    expect(failedKinds(p)).toEqual(["transient"]);
    await p.clock.advance(300_000); // 일시 오류가 이어지면 간격이 두 배로 늘어난다.
    await settle();
    expect(failedKinds(p)).toEqual(["transient", "transient"]);
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("2박 조회 단위에서 둘째 밤이 실패하면 그 단위는 알리지 않는다", async () => {
    const server = uljuServer({ day: (date, classes) => (date === "2026-10-17" ? { status: 503, body: "" } : ok(uljuRowsFor(date, uljuRows(classes)))) });
    const p = run({ from: "2026-10-16" }, { server, nights: 2 });
    await settle();
    expect(failedKinds(p)).toEqual(["transient"]);
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });
});

describe("ulju 설정", () => {
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
  - name: 별빛
    provider: ulju
${lines}
    checkIn: { from: 2026-10-16, to: 2026-10-16 }
    notify: [default]`);

  it("provider: ulju, facility: jakcheon-byeolbit, FACILITY_ID 구역, 1박 감시 조건을 받는다", () => {
    expect(problems(block("    facility: jakcheon-byeolbit\n    zones: [F0000005, F0000004]\n    nights: 1"))).toBe("");
  });

  it("facility 없는 감시 조건은 위치와 쓸 수 있는 시설 코드와 함께 거부된다", () => {
    expect(problems(block("    zones: [F0000004]"))).toMatch(/\d+번째 줄 watches\.0\.facility: 시설을 골라야 한다\. 쓸 수 있는 값: jakcheon-byeolbit, deungeok, jakcheon-dalbit, daeunsan$/);
  });

  it("없는 구역은 위치와 쓸 수 있는 구역 코드와 함께 거부된다", () => {
    expect(problems(block("    facility: jakcheon-byeolbit\n    zones: [F9999999]"))).toMatch(
      /\d+번째 줄 watches\.0\.zones: 없는 구역 "F9999999"다\. 쓸 수 있는 값: F0000001, F0000002, F0000003, F0000004, F0000016, F0000017, F0000005/,
    );
  });

  it("다른 시설의 구역은 위치와 그 시설의 구역 코드와 함께 거부된다", () => {
    expect(problems(block("    facility: deungeok\n    zones: [F0000004]"))).toMatch(/\d+번째 줄 watches\.0\.zones: 없는 구역 "F0000004"다\. 쓸 수 있는 값: F0000001, F0000006, F0000007/);
    expect(problems(block("    facility: deungeok\n    zones: [F0000006, F0000001]\n    nights: 2"))).toBe("");
  });

  it("2박은 받고 3박은 최대 박수와 함께 위치를 짚어 거부한다", () => {
    expect(problems(block("    facility: jakcheon-byeolbit\n    zones: [F0000004]\n    nights: 2"))).toBe("");
    expect(problems(block("    facility: jakcheon-byeolbit\n    zones: [F0000004]\n    nights: 3"))).toMatch(/\d+번째 줄 watches\.0\.nights: ulju는 최대 2박까지 예약할 수 있다\(설정값 3\)/);
  });
});

describe("catalog ulju", () => {
  const run = async (facility?: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const requests: TransportRequest[] = [];
    const code = await runCatalog(
      { kind: "catalog", provider: "ulju", ...(facility ? { facility } : {}), live: false },
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

  it("시설을 안 고르면 시설 목록을 보이고 요청은 보내지 않는다", async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^jakcheon-byeolbit\s+작천정별빛야영장\s+7곳$/m);
    expect(r.out).toMatch(/^deungeok\s+등억알프스야영장\s+3곳$/m);
    expect(r.out).toMatch(/^jakcheon-dalbit\s+작천정달빛야영장\s+2곳$/m);
    expect(r.out).toMatch(/^daeunsan\s+대운산하늘숲야영장\s+8곳$/m);
    expect(r.requests).toEqual([]);
  });

  it("작천정별빛은 최대 2박과 FACILITY_ID 구역 일곱 곳을 보인다", async () => {
    const r = await run("jakcheon-byeolbit");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^ulju \(최대 2박\)$/m);
    for (const z of ["F0000001 오토캠핑장", "F0000002 야영데크(8*8)", "F0000003 야영데크(8*4)", "F0000004 야영데크(4*4)", "F0000016 야영데크(6*4)", "F0000017 야영데크(8*5)", "F0000005 캐빈하우스"]) {
      expect(r.out.replace(/ +/g, " ")).toContain(z);
    }
  });

  it.each([
    ["deungeok", ["F0000001 오토캠핑장", "F0000006 카라반(일반)", "F0000007 카라반(테마)"]],
    ["jakcheon-dalbit", ["F0000001 오토캠핑장", "F0000018 야영데크(8.5*6.5)"]],
    ["daeunsan", ["F0000015 7.3m × 7m", "F0000008 7.2m × 7m", "F0000009 8m × 5.8m", "F0000010 7.1m × 7m", "F0000011 7.1m × 6.9m", "F0000012 2.5m × 12m, 8m × 8m", "F0000013 7.2m × 7.2m", "F0000014 7.2m × 6.9m"]],
  ])("%s는 기록한 FACILITY_ID 구역을 보인다", async (facility, zones) => {
    const r = await run(facility);
    expect(r.code).toBe(0);
    for (const z of zones) expect(r.out.replace(/ +/g, " ")).toContain(z);
    expect(r.requests).toEqual([]);
  });

  it("없는 시설은 쓸 수 있는 값을 보이며 거부한다", async () => {
    const r = await run("nope");
    expect(r.code).toBe(1);
    expect(r.err).toContain("jakcheon-byeolbit");
  });
});
