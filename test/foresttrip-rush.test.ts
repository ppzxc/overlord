import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { TransportRequest } from "../src/types.js";
import { ENV, configWith, settle, startPoller } from "./harness.js";
import { FOREST_ENV, foresttripServer } from "./foresttrip-server.js";

// 숲나들e 시설별 오픈 경쟁 시간(#148). 개시 시각(`rsrvtBgnTm`) 5분 전부터 30분 후까지 그 시설만 쉰다. 주별은 매일, 월별은 매월 1일이다.
const YUMYEONGSAN = "0101";
const SAMCHEOK = "ID02030104";
const PING = "https://hc.example/ping";
const MIN = 60_000;

const watch = (name: string, facility: string, zone: string, checkIn = "2026-10-24") => `
  - name: ${name}
    provider: foresttrip
    facility: ${facility}
    zones: ["${zone}"]
    checkIn: { from: ${checkIn}, to: ${checkIn} }
    nights: 1
    notify: [default]`;

const BOTH = configWith(watch("유명산", "yumyeongsan", "02002"), watch("삼척", "samcheok-hwalgi", "01007"));
const ONE = configWith(watch("유명산", "yumyeongsan", "02002"));

/** 시설별 정책: 유명산 주별 09:00, 삼척활기 주별 10:00. */
const policies = (over: Record<string, Record<string, unknown>> = {}) => (base: Record<string, unknown>, insttId?: string) => ({
  ...base,
  rsrvtPolcy: { ...(base.rsrvtPolcy as object), ...(insttId === SAMCHEOK ? { rsrvtBgnTm: "1000" } : {}), ...(over[insttId ?? ""] ?? {}) },
});

const run = (now: string, opts: { yaml?: string; policy?: ReturnType<typeof policies> } = {}) => {
  const server = foresttripServer({ extraInstts: [SAMCHEOK], policy: opts.policy ?? policies() });
  const p = startPoller(() => ({ status: 404, body: "" }), { yaml: opts.yaml ?? BOTH, server, env: FOREST_ENV, now });
  return { p, server };
};

type Poller = ReturnType<typeof run>["p"];
const bodyOf = (r: TransportRequest) => (r.body?.startsWith("{") ? (JSON.parse(r.body) as Record<string, unknown>) : {});
const hits = (p: Poller, suffix: string) => p.allRequests.filter((r) => new URL(r.url).pathname.endsWith(suffix));
/** 상품 목록을 받아 간 시설 id. 시설이 쉬지 않았다는 증거다. */
const polled = (p: Poller) => [...new Set(hits(p, "selectRsrvtGoodsListForMonthRsrvt.do").map((r) => String(bodyOf(r).insttId)))].sort();

describe("숲나들e 시설별 오픈 경쟁 시간", () => {
  it("개시 시각이 다른 두 시설은 각자 자기 구간에만 쉰다", async () => {
    // 08:58: 유명산(09:00 개시, 08:55~09:30)은 쉬고 삼척활기(10:00 개시)는 돈다.
    const a = run("2026-10-20T08:58:00+09:00");
    await settle();
    expect(polled(a.p)).toEqual([SAMCHEOK]);
    await a.p.stop();
    // 09:58: 삼척활기(09:55~10:30)는 쉬고 유명산은 돈다.
    const b = run("2026-10-20T09:58:00+09:00");
    await settle();
    expect(polled(b.p)).toEqual([YUMYEONGSAN]);
    await b.p.stop();
  });

  it("구간은 개시 5분 전부터 포함하고 30분 후는 제외한다", async () => {
    const before = run("2026-10-20T08:54:59+09:00");
    await settle();
    expect(polled(before.p)).toEqual([SAMCHEOK, YUMYEONGSAN].sort());
    await before.p.stop();
    const start = run("2026-10-20T08:55:00+09:00");
    await settle();
    expect(polled(start.p)).toEqual([SAMCHEOK]);
    await start.p.stop();
    const end = run("2026-10-20T09:30:00+09:00");
    await settle();
    expect(polled(end.p)).toEqual([SAMCHEOK, YUMYEONGSAN].sort());
    await end.p.stop();
  });

  it("쉬던 시설은 구간이 끝난 뒤 바퀴에서 다시 돈다", async () => {
    const { p } = run("2026-10-20T09:20:00+09:00");
    await settle();
    expect(polled(p)).toEqual([SAMCHEOK]);
    await p.clock.advance(11 * MIN); // 09:31
    await settle();
    expect(polled(p)).toEqual([SAMCHEOK, YUMYEONGSAN].sort());
    await p.stop();
  });

  it("주별 시설은 매일 쉰다", async () => {
    for (const day of ["2026-10-20", "2026-10-21", "2026-10-31"]) {
      const { p } = run(`${day}T09:00:00+09:00`, { yaml: configWith(watch("유명산", "yumyeongsan", "02002", "2026-11-05"), watch("삼척", "samcheok-hwalgi", "01007", "2026-11-05")) });
      await settle();
      expect(polled(p)).toEqual([SAMCHEOK]);
      await p.stop();
    }
  });

  it("월별 시설은 매월 1일에만 쉬고 다른 날에는 돈다", async () => {
    const monthly = policies({ [YUMYEONGSAN]: { rsrvtCycleTpeCd: "MON", monthLastDay: "20261130" } });
    const yaml = configWith(watch("유명산", "yumyeongsan", "02002", "2026-11-05"));
    const day1 = run("2026-11-01T09:00:00+09:00", { yaml, policy: monthly });
    await settle();
    expect(polled(day1.p)).toEqual([]); // 조회하지 않았다
    await day1.p.stop();
    const day2 = run("2026-10-20T09:00:00+09:00", { yaml, policy: monthly });
    await settle();
    expect(polled(day2.p)).toEqual([YUMYEONGSAN]); // 돌았다
    await day2.p.stop();
  });

  it("개시 시각이 자정 직후인 주별 시설은 전날 밤부터 쉰다", async () => {
    const { p } = run("2026-10-20T23:58:00+09:00", { yaml: ONE, policy: policies({ [YUMYEONGSAN]: { rsrvtBgnTm: "0002" } }) });
    await settle();
    expect(polled(p)).toEqual([]);
    await p.stop();
  });

  it("설정의 openingRush가 시설별 값을 덮어쓰고 쉬는 동안에도 살아있음 신호가 나간다", async () => {
    const yaml = BOTH.replace("providers:", `deadManPingUrl: ${PING}\nproviders:\n  foresttrip: { openingRush: { from: "12:00", to: "12:30" } }`);
    // 08:58: 설정 구간이 아니므로 시설별 정책(유명산 09:00)은 무시되고 둘 다 돈다.
    const a = run("2026-10-20T08:58:00+09:00", { yaml });
    await settle();
    expect(polled(a.p)).toEqual([SAMCHEOK, YUMYEONGSAN].sort());
    await a.p.stop();
    // 12:10: 모든 시설이 쉬고 폴링 간격마다 ping만 나간다.
    const b = run("2026-10-20T12:05:00+09:00", { yaml });
    await settle();
    for (let i = 0; i < 2; i++) {
      await b.p.clock.advance(10 * MIN);
      await settle();
    }
    expect(b.p.allRequests.filter((r) => r.url !== PING)).toHaveLength(0);
    expect(b.p.allRequests.filter((r) => r.url === PING).length).toBeGreaterThanOrEqual(2);
    await b.p.stop();
  });

  it("모든 시설이 정책 구간에 쉬는 동안에도 살아있음 신호가 나가고 예약처 상태 알림은 없다", async () => {
    const yaml = ONE.replace("providers:", `deadManPingUrl: ${PING}\nproviders:`);
    const { p } = run("2026-10-20T09:00:00+09:00", { yaml });
    await settle();
    for (let i = 0; i < 2; i++) {
      await p.clock.advance(10 * MIN);
      await settle();
    }
    expect(polled(p)).toEqual([]);
    expect(p.allRequests.filter((r) => r.url === PING).length).toBeGreaterThanOrEqual(2);
    expect(p.sent).toEqual([]);
    await p.stop();
  });

  it("쉬는 시설이 있어도 도는 시설의 알림은 나간다", async () => {
    const server = foresttripServer({ extraInstts: [SAMCHEOK], policy: policies(), status: () => ({ rsrvtAvail: "Y", rsrvtCnt: 0 }) });
    const p = startPoller(() => ({ status: 404, body: "" }), { yaml: BOTH, server, env: FOREST_ENV, now: "2026-10-20T09:58:00+09:00" });
    await settle();
    expect(p.sent).toHaveLength(1); // 삼척활기는 쉬고 유명산만 돈다
    expect(p.sent[0]!.text).toContain("유명산자연휴양림");
    await p.stop();
  });

  describe("폴링 간격", () => {
    const withProvider = (extra: string) => ONE.replace("providers:", `providers:\n  foresttrip: { ${extra} }`);
    const load = (y: string) => loadConfig(y, { ...ENV, ...FOREST_ENV });

    it("300초 미만은 거부하고 300초는 받는다", () => {
      expect(() => load(withProvider("pollIntervalSeconds: 299"))).toThrow(/300초 이상/);
      expect(() => load(withProvider("pollIntervalSeconds: 300"))).not.toThrow();
    });

    it("생략하면 600초마다 돈다", async () => {
      const { p } = run("2026-10-20T14:00:00+09:00", { yaml: ONE });
      await settle();
      // 상품 목록은 24시간 캐시라 바퀴마다 나가는 잔여 호출로 바퀴 수를 센다.
      const logins = () => hits(p, "selectRsrvtAvailInfoListForMonthRsrvt.do").length;
      const first = logins();
      expect(first).toBeGreaterThan(0);
      await p.clock.advance(9 * MIN);
      await settle();
      expect(logins()).toBe(first);
      await p.clock.advance(2 * MIN);
      await settle();
      expect(logins()).toBeGreaterThan(first);
      await p.stop();
    });
  });
});
