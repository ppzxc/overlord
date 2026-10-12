import { describe, expect, it } from "vitest";
import { adapters } from "../src/adapters/index.js";
import { runCatalog } from "../src/commands.js";
import { loadConfig } from "../src/config.js";
import type { TransportRequest, TransportResponse } from "../src/types.js";
import { ENV, configWith, uljuRows, uljuRowsFor, uljuServer } from "./harness.js";

// catalog ulju --live를 기록한 응답(research/raw/ulju, 2026-10-16)으로 돌린다. 그 밖의 날짜는 같은 행에 날짜만 바꿔 만든다.
// 가짜 시계는 2026-10-12 17:00 KST라 내일(KST)은 2026-10-13이다.

const setup = (server = uljuServer(), config?: ReturnType<typeof loadConfig>) => {
  const out: string[] = [];
  const err: string[] = [];
  const requests: TransportRequest[] = [];
  const sleeps: number[] = [];
  const run = (facility?: string, now = "2026-10-12T08:00:00Z") =>
    runCatalog(
      { kind: "catalog", provider: "ulju", ...(facility ? { facility } : {}), live: true },
      {
        adapters,
        ...(config ? { config } : {}),
        transport: async (r) => (requests.push(r), server(r)),
        version: "0.1.0",
        now: () => new Date(now),
        sleep: async (ms) => void sleeps.push(ms),
        random: () => 0.5,
        out: (s) => void out.push(s),
        err: (s) => void err.push(s),
      },
    );
  return { run, out: () => out.join(""), err: () => err.join(""), requests, sleeps, server };
};
const asked = (s: { server: ReturnType<typeof uljuServer> }) => s.server.bodies.map((b) => `${b.classes}@${b.select_date}`);
const ok = (rows: unknown[]): TransportResponse => ({ status: 200, body: JSON.stringify({ result: "ok", list: rows }) });
const ended = (result = "booking_ended"): TransportResponse => ({ status: 200, body: JSON.stringify({ result, msg: "예약할 수 없다" }) });

describe("catalog ulju --live", () => {
  it("시설을 고르면 내일(KST) 날짜로 그 시설에 한 번만 조회하고 구역이 일치하면 차이 없음을 보고한다", async () => {
    const s = setup();
    expect(await s.run("jakcheon-byeolbit")).toBe(0);
    expect(asked(s)).toEqual(["C0000001@2026-10-13"]);
    expect(s.requests).toHaveLength(1);
    expect(s.out()).toContain("실제 예약처와 비교");
    expect(s.out()).toContain("F0000005: 고정 목록이 없다. 실제 10자리: 캐빈하우스1-캐빈하우스10");
    expect(s.out()).toContain("차이 없음");
    expect(s.err()).toBe("");
  });

  describe("오픈 경쟁 시간", () => {
    // 울주는 오픈 경쟁 시간 기본값이 없다. 운영자가 설정한 구간 안에서는 요청 없이 거부하고 밖에서는 실행한다.
    const withRush = loadConfig(
      configWith(`  - name: w
    provider: ulju
    facility: jakcheon-byeolbit
    zones: [F0000004]
    checkIn: { from: 2026-10-16, to: 2026-10-16 }
    nights: 1
    notify: [default]`).replace("providers:", 'providers:\n  ulju: { openingRush: { from: "16:50", to: "17:10" } }'),
      ENV,
    );

    it("설정한 구간(16:50~17:10 KST) 안이면 요청 없이 1로 거부한다", async () => {
      const s = setup(uljuServer(), withRush);
      expect(await s.run("jakcheon-byeolbit", "2026-10-12T08:00:00Z")).toBe(1); // 17:00 KST
      expect(s.err()).toContain("오픈 경쟁 시간(16:50~17:10 KST)");
      expect(s.requests).toEqual([]);
    });

    it("구간 밖이면 거부하지 않고 한 번 조회한다", async () => {
      const s = setup(uljuServer(), withRush);
      expect(await s.run("jakcheon-byeolbit", "2026-10-12T09:00:00Z")).toBe(0); // 18:00 KST
      expect(s.err()).toBe("");
      expect(s.requests).toHaveLength(1);
    });

    it("설정이 없으면 기본 구간이 없어 어느 시각에도 거부하지 않는다", async () => {
      const s = setup();
      expect(await s.run("jakcheon-byeolbit", "2026-10-12T08:00:00Z")).toBe(0);
      expect(s.requests).toHaveLength(1);
    });
  });

  it("시설 없이 --live를 걸면 요청 없이 쓸 수 있는 시설 코드와 함께 1이다", async () => {
    const s = setup();
    expect(await s.run(undefined)).toBe(1);
    expect(s.err()).toContain("시설을 골라야 한다");
    expect(s.err()).toContain("jakcheon-byeolbit");
    expect(s.requests).toEqual([]);
  });

  it.each([
    ["jakcheon-byeolbit", "C0000001"],
    ["deungeok", "C0000002"],
    ["jakcheon-dalbit", "C0000003"],
    ["daeunsan", "C0000005"],
  ])("%s는 classes %s로 한 번 조회하고 기록한 구역과 일치한다(FACILITY_NAME 끝 공백 포함)", async (facility, classes) => {
    const s = setup();
    expect(await s.run(facility)).toBe(0);
    expect(asked(s)).toEqual([`${classes}@2026-10-13`]);
    expect(s.out()).toContain("차이 없음");
    expect(s.out()).not.toMatch(/사라|새로 생긴|다르다|없다\(/);
  });

  it("예약처에서 구역이 사라지면 보고한다", async () => {
    const rows = uljuRows().filter((r) => r.FACILITY_ID !== "F0000005");
    const s = setup(uljuServer({ day: (d) => ok(uljuRowsFor(d, rows)) }));
    expect(await s.run("jakcheon-byeolbit")).toBe(0);
    expect(s.out()).toContain("F0000005: 예약처 응답에 구역이 없다(캐빈하우스)");
    expect(s.out()).toContain("카탈로그를 갱신해야 한다");
    expect(s.requests).toHaveLength(1);
  });

  it("예약처에 새 구역이 생기거나 구역 코드가 바뀌면 보고한다", async () => {
    const rows = uljuRows().map((r) => (r.FACILITY_ID === "F0000002" ? { ...r, FACILITY_ID: "F0000099" } : r));
    const extra = { ...uljuRows()[0]!, CAMP_ID: "X1", NAME: "글램핑1", FACILITY_ID: "F0000030", FACILITY_NAME: "글램핑" };
    const s = setup(uljuServer({ day: (d) => ok(uljuRowsFor(d, [...rows, extra])) }));
    expect(await s.run("jakcheon-byeolbit")).toBe(0);
    expect(s.out()).toContain("F0000002: 구역 코드가 다르다(카탈로그 F0000002, 예약처 F0000099)");
    expect(s.out()).toContain("예약처에 새로 생긴 구역 글램핑(F0000030): 1자리");
  });

  describe("대조할 날짜", () => {
    it("내일이 booking_ended면 다음 날로 한 번 더 시도하고 5초+지터 간격을 둔다", async () => {
      const s = setup(uljuServer({ day: (d, c) => (d === "2026-10-13" ? ended() : ok(uljuRowsFor(d, uljuRows(c)))) }));
      expect(await s.run("jakcheon-byeolbit")).toBe(0);
      expect(asked(s)).toEqual(["C0000001@2026-10-13", "C0000001@2026-10-14"]);
      expect(s.sleeps).toEqual([6500]);
      expect(s.out()).toContain("차이 없음");
    });

    it("내일이 no_list여도 다음 날로 한 번 더 시도한다", async () => {
      const s = setup(uljuServer({ day: (d, c) => (d === "2026-10-13" ? ended("no_list") : ok(uljuRowsFor(d, uljuRows(c)))) }));
      expect(await s.run("deungeok")).toBe(0);
      expect(asked(s)).toEqual(["C0000002@2026-10-13", "C0000002@2026-10-14"]);
    });

    it("두 날 모두 없으면 대조할 날짜가 없다고 알리고 0으로 끝낸다(요청은 둘뿐)", async () => {
      const s = setup(uljuServer({ day: () => ended() }));
      expect(await s.run("jakcheon-byeolbit")).toBe(0);
      expect(asked(s)).toEqual(["C0000001@2026-10-13", "C0000001@2026-10-14"]);
      expect(s.out()).toContain("대조할 날짜가 없다");
      expect(s.out()).not.toContain("차이 없음");
      expect(s.err()).toBe("");
    });

    it("KST 기준 내일이다(UTC로는 아직 같은 날인 KST 자정 직후)", async () => {
      const s = setup();
      expect(await s.run("daeunsan", "2026-10-31T15:30:00Z")).toBe(0); // 11/1 00:30 KST
      expect(asked(s)).toEqual(["C0000005@2026-11-02"]);
    });
  });

  describe("조회 실패는 1이다", () => {
    it.each([
      ["HTTP 503", { status: 503, body: "" }, "transient"],
      ["HTTP 401", { status: 401, body: "" }, "blocked"],
      ["HTTP 403", { status: 403, body: "" }, "blocked"],
      ["JSON 아님", { status: 200, body: "<html></html>" }, "unrecognized"],
      ["모르는 result", { status: 200, body: JSON.stringify({ result: "maintenance" }) }, "unrecognized"],
    ] as [string, TransportResponse, string][])("%s", async (_, response, kind) => {
      const s = setup(uljuServer({ day: () => response }));
      expect(await s.run("jakcheon-byeolbit")).toBe(1);
      expect(s.out()).toContain(`조회 실패(${kind})`);
      expect(s.requests).toHaveLength(1);
    });

    it("행에 FACILITY_NAME이 없으면 구조 변경으로 실패한다", async () => {
      const rows = uljuRows().map((r) => {
        const copy: Partial<typeof r> = { ...r };
        delete copy.FACILITY_NAME;
        return copy as typeof r;
      });
      const s = setup(uljuServer({ day: (d) => ok(uljuRowsFor(d, rows)) }));
      expect(await s.run("jakcheon-byeolbit")).toBe(1);
      expect(s.out()).toContain("조회 실패(unrecognized)");
    });
  });

  describe("자리 목록", () => {
    it("대운산하늘숲은 자리 이름이 A1 꼴이라 자리 목록을 대조한다: 일치하면 자리 수를 보인다", async () => {
      const s = setup();
      expect(await s.run("daeunsan")).toBe(0);
      expect(s.out()).toContain("F0000015: 일치 (10자리)");
      expect(s.out()).toContain("F0000008: 일치 (4자리)");
    });

    it("대운산하늘숲에서 자리가 사라지거나 새로 생기면 보고한다", async () => {
      const rows = uljuRows("C0000005").filter((r) => r.NAME !== "A6");
      rows.push({ ...rows[0]!, CAMP_ID: "N1", NAME: "A21", FACILITY_ID: "F0000015", FACILITY_NAME: "7.3m × 7m" });
      const s = setup(uljuServer({ day: (d) => ok(uljuRowsFor(d, rows)) }));
      expect(await s.run("daeunsan")).toBe(0);
      expect(s.out()).toContain("F0000015: 예약처에서 사라진 자리 A6");
      expect(s.out()).toContain("F0000015: 예약처에 새로 생긴 자리 A21");
    });

    it("자리 이름이 한글이라 자리 필터를 못 쓰는 시설은 고정 목록 없이 실제 자리 수만 보인다", async () => {
      const s = setup();
      expect(await s.run("deungeok")).toBe(0);
      expect(s.out()).toContain("F0000001: 고정 목록이 없다. 실제 48자리: 등억 오토캠핑장1-등억 오토캠핑장48");
    });
  });
});
