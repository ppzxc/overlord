import { describe, expect, it } from "vitest";
import { resolveFacility, zoneName } from "../src/facility.js";
import { twoFacilityAdapter } from "./harness.js";

const info = twoFacilityAdapter().adapter.describe();

describe("resolveFacility", () => {
  it("코드가 없으면 첫 시설이다", () => {
    expect(resolveFacility(info).code).toBe("alpha");
  });

  it("코드가 있으면 그 시설이다", () => {
    expect(resolveFacility(info, "beta").name).toBe("베타 시설");
  });

  it("없는 시설은 첫 시설로 바꾸지 않고 쓸 수 있는 코드를 담아 던진다", () => {
    expect(() => resolveFacility(info, "gamma")).toThrow(/gamma.*alpha, beta/);
  });
});

describe("zoneName", () => {
  it("시설 안의 구역 이름을 준다", () => {
    expect(zoneName(info, "beta", "BO")).toBe("베타전용");
  });

  it("모르는 시설이나 구역이면 구역 코드를 그대로 준다", () => {
    expect(zoneName(info, "gamma", "BO")).toBe("BO");
    expect(zoneName(info, "alpha", "ZZ")).toBe("ZZ");
  });
});
