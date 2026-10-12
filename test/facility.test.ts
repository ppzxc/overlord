import { describe, expect, it } from "vitest";
import { goraebulAdapter } from "../src/adapters/goraebul.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { ENV, configWith, settle, startPoller, twoFacilityAdapter } from "./harness.js";

const watch = (name: string, rest: string) =>
  `  - { name: ${name}, provider: multi, ${rest}, checkIn: { from: 2026-09-29, to: 2026-09-29 }, nights: 1, notify: [default] }`;

const messageOf = (yaml: string) => {
  try {
    loadConfig(yaml, ENV, { goraebul: goraebulAdapter, multi: twoFacilityAdapter().adapter });
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error("설정이 받아들여졌다");
};

describe("시설 검증", () => {
  it("시설이 둘 이상인데 facility가 없으면 위치와 쓸 수 있는 시설 코드를 담아 거부한다", () => {
    const msg = messageOf(configWith(watch("w", "zones: [SH]")));
    expect(msg).toContain("watches.0");
    expect(msg).toContain("시설을 골라야 한다");
    expect(msg).toContain("alpha, beta");
  });

  it("없는 시설 코드는 쓸 수 있는 값과 함께 거부한다", () => {
    const msg = messageOf(configWith(watch("w", "facility: gamma, zones: [SH]")));
    expect(msg).toContain("watches.0.facility");
    expect(msg).toContain("gamma");
    expect(msg).toContain("alpha, beta");
  });

  it("다른 시설의 구역 코드는 거부하고 두 시설에 같은 코드가 있으면 통과한다", () => {
    const msg = messageOf(configWith(watch("w", "facility: beta, zones: [AO]")));
    expect(msg).toContain("watches.0.zones");
    expect(msg).toContain("SH, BO");
    const adapters = { goraebul: goraebulAdapter, multi: twoFacilityAdapter().adapter };
    expect(() =>
      loadConfig(configWith(watch("a", "facility: alpha, zones: [SH]"), watch("b", "facility: beta, zones: [SH]")), ENV, adapters),
    ).not.toThrow();
  });

  it("seats는 고른 시설의 자리 목록으로 검증한다", () => {
    expect(messageOf(configWith(watch("w", "facility: beta, zones: [SH], seats: [S01]")))).toContain("watches.0.seats");
    const adapters = { goraebul: goraebulAdapter, multi: twoFacilityAdapter().adapter };
    expect(() => loadConfig(configWith(watch("w", "facility: alpha, zones: [SH], seats: [S01]")), ENV, adapters)).not.toThrow();
  });
});

describe("시설이 둘인 예약처의 폴러", () => {
  const run = async (...watches: string[]) => {
    const { adapter, calls } = twoFacilityAdapter();
    const p = startPoller(() => ({ status: 200, body: "" }), { yaml: configWith(...watches), adapters: { goraebul: goraebulAdapter, multi: adapter } });
    await settle();
    return { p, calls };
  };

  it("두 시설의 같은 구역 코드·같은 날짜는 따로 조회되고 따로 알려진다", async () => {
    const { p, calls } = await run(watch("가", "facility: alpha, zones: [SH]"), watch("나", "facility: beta, zones: [SH]"));
    expect(calls.map((c) => `${c.facility}/${c.zone}`).sort()).toEqual(["alpha/SH", "beta/SH"]);
    const lines = p.sent.flatMap((m) => m.text.split("\n"));
    expect(lines).toContain("2026-09-29(화) 1박 · 알파 시설 · 공용구역 · 1번 자리");
    expect(lines).toContain("2026-09-29(화) 1박 · 베타 시설 · 공용구역 · 1번 자리");
    // 다음 바퀴에는 새 빈자리가 없다. 시설마다 알렸음 상태를 따로 가진다.
    const before = p.sent.length;
    await p.clock.advance(150_000);
    await settle();
    expect(p.sent.length).toBe(before);
    await p.stop();
  });

  it("같은 시설·구역·날짜를 감시하는 조건 둘은 한 번만 조회한다", async () => {
    const { p, calls } = await run(watch("가", "facility: alpha, zones: [SH]"), watch("나", "facility: alpha, zones: [SH]"));
    expect(calls).toHaveLength(1);
    await p.stop();
  });
});
