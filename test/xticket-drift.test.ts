import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { configWith, settle, startPoller, xticketProducts, xticketServer } from "./harness.js";
import type { XticketProduct } from "./harness.js";

// 달서 카라반(0001)에만 자리 목록이 있는 것으로 바꾼다(기록한 응답의 14곳). 실제 카탈로그에는 xticket 자리 목록이 아직 없다.
vi.mock("../src/catalogs/xticket.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/catalogs/xticket.js")>();
  const names = (JSON.parse(readFileSync("test/fixtures/xticket-GetBookProduct010001-0001-20261015.json", "utf8")).data.bookProductList as { product_name: string }[]).map(
    (p) => p.product_name,
  );
  return {
    ...orig,
    facilities: orig.facilities.map((f) =>
      f.code === "dalseo" ? { ...f, zones: f.zones.map((z) => (z.code === "0001" ? { ...z, seats: names } : z)) } : f,
    ),
  };
});

const watch = (zone: string) => `
  - name: dalseo ${zone}
    provider: xticket
    facility: dalseo
    zones: ["${zone}"]
    checkIn: { from: 2026-10-15, to: 2026-10-15 }
    nights: 1
    notify: [default]`;

const run = (products: () => XticketProduct[], zone = "0001") =>
  startPoller(() => ({ status: 404, body: "" }), { yaml: configWith(watch(zone)), server: xticketServer({ products }) });

const ROUND = 300_000;
const drift = (p: { logs: { msg: string; fields?: Record<string, unknown> }[] }) => p.logs.filter((l) => l.msg === "xticket seat drift");
const productCalls = (p: { allRequests: { url: string }[] }) => p.allRequests.filter((r) => r.url.endsWith("GetBookProduct010001.json")).length;

describe("xticket 자리 드리프트 경고", () => {
  it("응답에 카탈로그에 없는 자리가 있으면 한 번만 경고하고 상태·알림·요청 수는 그대로다", async () => {
    const base = run(xticketProducts);
    await settle();
    await base.clock.advance(ROUND);
    await settle();
    const baseCalls = productCalls(base);
    const baseSent = base.sent.length;
    await base.stop();

    const p = run(() => [...xticketProducts(), { ...xticketProducts()[0]!, product_name: "카라반-99", status_code: "1" }]);
    await settle();
    await p.clock.advance(ROUND);
    await settle();
    expect(drift(p)).toHaveLength(1);
    expect(drift(p)[0]!.fields).toMatchObject({ facility: "dalseo", zone: "0001", change: "new", seat: "카라반-99" });
    expect(p.logs.some((l) => l.msg === "query failed")).toBe(false);
    expect(p.sent).toHaveLength(baseSent);
    expect(productCalls(p)).toBe(baseCalls);
    await p.stop();
  });

  it("카탈로그의 자리가 응답에서 빠지면 한 번만 경고한다", async () => {
    const p = run(() => xticketProducts().filter((x) => x.product_name !== "카라반-14"));
    await settle();
    await p.clock.advance(ROUND);
    await settle();
    expect(drift(p)).toHaveLength(1);
    expect(drift(p)[0]!.fields).toMatchObject({ facility: "dalseo", zone: "0001", change: "gone", seat: "카라반-14" });
    expect(p.logs.some((l) => l.msg === "query failed")).toBe(false);
    await p.stop();
  });

  it("자리 목록이 없는 상품군은 견주지 않는다", async () => {
    const p = run(() => xticketProducts().map((x) => ({ ...x, product_name: `오토-${x.product_name}` })), "0002");
    await settle();
    expect(productCalls(p)).toBeGreaterThan(0);
    expect(drift(p)).toHaveLength(0);
    await p.stop();
  });
});
