import { describe, expect, it } from "vitest";
import { adapters } from "../src/adapters/index.js";
import { runCatalog } from "../src/commands.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { createHttpClient } from "../src/http.js";
import { ENV, settle, configWith, startPoller, uljuRowsFor, uljuServer } from "./harness.js";
import type { UljuRow } from "./harness.js";
import type { TransportRequest, TransportResponse } from "../src/types.js";

// 작천정별빛야영장(jakcheon-byeolbit, classes=C0000001)의 기록한 응답(2026-10-12, research/raw/ulju)을 fixture로 쓴다.
// 2026-10-16(금)은 88자리 가운데 Y가 11자리다: 야영데크(4*4)(F0000004) 7자리, 야영데크(6*4)(F0000016) 4자리.
// 가짜 시계는 2026-09-29 09:00 KST에서 시작한다. 그때 10월 날짜는 "다음 달"이고 9/11 10:00부터 열려 있다.
const ZONE_4X4 = "F0000004"; // 야영데크(4*4)
const ZONE_6X4 = "F0000016"; // 야영데크(6*4)
const ZONE_CABIN = "F0000005"; // 캐빈하우스: 10/16에는 모두 N이다.

const watch = (checkIn: { from: string; to?: string }, zones: string[] = [ZONE_4X4], extra = "") => `
  - name: 별빛 ${zones.join("+")} ${checkIn.from}
    provider: ulju
    facility: jakcheon-byeolbit
    zones: [${zones.join(", ")}]
    checkIn: { from: ${checkIn.from}, to: ${checkIn.to ?? checkIn.from} }
    nights: 1
    notify: [default]${extra}`;

const run = (
  checkIn: { from: string; to?: string },
  opts: { server?: ReturnType<typeof uljuServer>; zones?: string[]; random?: () => number; now?: string; extra?: string } = {},
) =>
  startPoller(() => ({ status: 404, body: "" }), {
    yaml: configWith(watch(checkIn, opts.zones, opts.extra)),
    server: opts.server ?? uljuServer(),
    random: opts.random,
    now: opts.now,
  });

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
    expect(problems(block("    zones: [F0000004]"))).toMatch(/\d+번째 줄 watches\.0\.facility: 시설을 골라야 한다\. 쓸 수 있는 값: jakcheon-byeolbit/);
  });

  it("없는 구역은 위치와 쓸 수 있는 구역 코드와 함께 거부된다", () => {
    expect(problems(block("    facility: jakcheon-byeolbit\n    zones: [F9999999]"))).toMatch(
      /\d+번째 줄 watches\.0\.zones: 없는 구역 "F9999999"다\. 쓸 수 있는 값: F0000001, F0000002, F0000003, F0000004, F0000016, F0000017, F0000005/,
    );
  });

  it("2박은 위치와 함께 거부된다(즉시결제는 한 번에 1박)", () => {
    expect(problems(block("    facility: jakcheon-byeolbit\n    zones: [F0000004]\n    nights: 2"))).toMatch(/\d+번째 줄 watches\.0\.nights: ulju는 최대 1박까지 예약할 수 있다\(설정값 2\)/);
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
    expect(r.requests).toEqual([]);
  });

  it("작천정별빛은 최대 1박과 FACILITY_ID 구역 일곱 곳을 보인다", async () => {
    const r = await run("jakcheon-byeolbit");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^ulju \(최대 1박\)$/m);
    for (const z of ["F0000001 오토캠핑장", "F0000002 야영데크(8*8)", "F0000003 야영데크(8*4)", "F0000004 야영데크(4*4)", "F0000016 야영데크(6*4)", "F0000017 야영데크(8*5)", "F0000005 캐빈하우스"]) {
      expect(r.out.replace(/ +/g, " ")).toContain(z);
    }
  });

  it("없는 시설은 쓸 수 있는 값을 보이며 거부한다", async () => {
    const r = await run("nope");
    expect(r.code).toBe(1);
    expect(r.err).toContain("jakcheon-byeolbit");
  });
});
