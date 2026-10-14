import { describe, expect, it } from "vitest";
import { donghaeAdapter } from "../src/adapters/donghae.js";
import { goraebulAdapter } from "../src/adapters/goraebul.js";
import { renderCatalog } from "../src/catalog.js";
import { parseArgs } from "../src/cli.js";
import { runCatalog } from "../src/commands.js";
import type { Transport } from "../src/types.js";
import { twoFacilityAdapter } from "./harness.js";

const setup = (over: Record<string, unknown> = {}) => {
  const multi = twoFacilityAdapter();
  const out: string[] = [];
  const err: string[] = [];
  const requests: string[] = [];
  const deps = {
    adapters: { multi: multi.adapter, goraebul: goraebulAdapter, donghae: donghaeAdapter },
    transport: (async ({ url }) => {
      requests.push(url);
      return { status: 500, body: "" };
    }) as Transport,
    version: "0.1.0",
    now: () => new Date("2026-09-29T00:00:00Z"),
    sleep: async () => {},
    random: () => 0.5,
    out: (s: string) => void out.push(s),
    err: (s: string) => void err.push(s),
    ...over,
  };
  const run = (provider: string | undefined, facility: string | undefined, live = false) =>
    runCatalog({ kind: "catalog", provider, ...(facility ? { facility } : {}), live }, deps);
  return { run, out, err, requests, calls: multi.calls };
};

describe("catalog 인자", () => {
  it("두 번째 위치 인자가 시설이고 옵션 값과 섞이지 않는다", () => {
    expect(parseArgs(["catalog", "donghae", "mangsang", "--live"])).toEqual({ kind: "catalog", provider: "donghae", facility: "mangsang", live: true });
    expect(parseArgs(["catalog", "--config", "c.yaml", "donghae", "mangsang"])).toEqual({
      kind: "catalog",
      provider: "donghae",
      facility: "mangsang",
      live: false,
      configPath: "c.yaml",
    });
  });
});

describe("catalog <예약처> <시설>", () => {
  it("시설이 둘이면 시설 목록(코드, 이름, 구역 수)을 보여 준다", async () => {
    const s = setup();
    expect(await s.run("multi", undefined)).toBe(0);
    const out = s.out.join("");
    expect(out).toMatch(/^alpha\s+알파 시설\s+2곳$/m);
    expect(out).toMatch(/^beta\s+베타 시설\s+2곳$/m);
    expect(out).not.toContain("공용구역");
  });

  it("시설을 고르면 그 시설의 구역 표를 보여 준다", async () => {
    const s = setup();
    expect(await s.run("multi", "beta")).toBe(0);
    const out = s.out.join("");
    expect(out).toMatch(/^BO\s+베타전용/m);
    expect(out).toMatch(/^SH\s+공용구역\s+테스트\s+-\s+1자리: T01$/m);
    expect(out).not.toContain("알파전용");
    expect(s.requests).toEqual([]);
  });

  it("최대 박수가 미확인인 예약처라도 시설이 최대 박수를 따로 정했으면 (미확인)을 붙이지 않는다", async () => {
    const base = twoFacilityAdapter().adapter;
    const info = base.describe();
    const adapter = {
      ...base,
      describe: () => ({
        ...info,
        maxNightsUnconfirmed: true,
        facilities: info.facilities.map((f) => (f.code === "alpha" ? { ...f, maxNights: 3 } : f)),
      }),
    };
    const s = setup({ adapters: { multi: adapter } });
    expect(await s.run("multi", "alpha")).toBe(0);
    expect(s.out.join("")).toContain("최대 3박)");
    expect(s.out.join("")).not.toContain("미확인");
    s.out.length = 0;
    expect(await s.run("multi", "beta")).toBe(0);
    expect(s.out.join("")).toContain("최대 2박(미확인)");
    s.out.length = 0;
    expect(await s.run("multi", undefined)).toBe(0);
    expect(s.out.join("")).toContain("(미확인)"); // 시설 목록: beta가 예약처 기본을 따른다
  });

  it("없는 시설은 쓸 수 있는 값과 함께 1을 돌려준다", async () => {
    const s = setup();
    expect(await s.run("multi", "gamma")).toBe(1);
    expect(s.err.join("")).toContain("gamma");
    expect(s.err.join("")).toContain("alpha, beta");
  });

  it("고래불도 시설 인자를 줘도 생략한 것과 표가 같다", async () => {
    const a = setup();
    const b = setup();
    expect(await a.run("goraebul", undefined)).toBe(0);
    expect(await b.run("goraebul", "goraebul")).toBe(0);
    expect(a.out.join("")).not.toBe("");
    expect(b.out.join("")).toBe(a.out.join(""));
  });

  it("시설이 하나인 예약처의 표는 시설 인자 유무와 상관없이 같다", async () => {
    const a = setup();
    await a.run("donghae", undefined);
    const b = setup();
    await b.run("donghae", "mangsang");
    expect(b.out.join("")).toBe(a.out.join(""));
    expect(a.out.join("")).toBe(renderCatalog(donghaeAdapter));
    expect(a.requests).toEqual([]);
  });
});

describe("catalog --live 시설 단위", () => {
  it("시설이 둘 이상인데 시설이 없으면 요청 없이 1을 돌려준다", async () => {
    const s = setup();
    expect(await s.run("multi", undefined, true)).toBe(1);
    expect(s.err.join("")).toContain("시설을 골라야 한다");
    expect(s.err.join("")).toContain("alpha, beta");
    expect(s.requests).toEqual([]);
  });

  it("고른 시설의 구역만 시설 코드를 실어 대조한다", async () => {
    const multi = twoFacilityAdapter();
    const listed: { facility: string; zone: string }[] = [];
    multi.adapter.listSeats = async (q) => {
      listed.push({ facility: q.facility, zone: q.zone });
      return ["T01"];
    };
    const s = setup({ adapters: { multi: multi.adapter } });
    expect(await s.run("multi", "beta", true)).toBe(0);
    expect(listed).toEqual([
      { facility: "beta", zone: "SH" },
      { facility: "beta", zone: "BO" },
    ]);
    expect(s.out.join("")).toContain("SH: 일치 (1자리)");
  });
});
