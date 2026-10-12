import { describe, expect, it, vi } from "vitest";
import { configWith, knpsServer, settle, startPoller } from "./harness.js";
import type { TransportRequest, TransportResponse } from "../src/types.js";

// 이 파일은 한 바퀴의 시설 순회만 본다. 그래서 카탈로그의 도학 구역을 갓바위 구역 이름(응답 fixture와 같다)에 구역 코드 0200902를 붙인 합성으로 바꾼다.
// 도학의 실제 구역·자리는 knps-catalog.test.ts가 본다.
vi.mock("../src/catalogs/knps.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/catalogs/knps.js")>();
  const gatbawi = orig.facilities.find((f) => f.code === "gatbawi")!;
  return {
    ...orig,
    facilities: orig.facilities.map((f) => (f.code === "dohak" ? { ...f, zones: [{ ...gatbawi.zones[0]!, code: "0200902" }] } : f)),
  };
});

const watch = (name: string, facility: string, zone: string, checkIn: string) => `
  - name: ${name}
    provider: knps
    facility: ${facility}
    zones: ["${zone}"]
    checkIn: { from: ${checkIn}, to: ${checkIn} }
    nights: 1
    notify: [default]`;

const GATBAWI = watch("갓바위 A", "gatbawi", "0200901", "2026-10-15");
const GATBAWI_LATER = watch("갓바위 B", "gatbawi", "0200901", "2026-10-21");
const DOHAK = watch("도학", "dohak", "0200902", "2026-10-15");
const DOHAK_SAME_UNIT = watch("도학 같은 날", "dohak", "0200902", "2026-10-15");

const listCalls = (reqs: TransportRequest[]) => reqs.filter((r) => r.url.endsWith("campsiteList.do"));
const deptOf = (r: TransportRequest) => new URLSearchParams(r.body).get("dept_id");
const nfLabel = (r: TransportRequest) => `${new URL(r.url).searchParams.get("opcode")}:${new URL(r.url).searchParams.get("aid")}`;

/** 지정한 시설의 campsiteList.do만 503으로 바꾼다. */
const failing = (deptId: string) => {
  const inner = knpsServer();
  return (req: TransportRequest): TransportResponse =>
    req.url.endsWith("campsiteList.do") && deptOf(req) === deptId ? { status: 503, body: "" } : inner(req);
};

const start = (yaml: string, server = knpsServer()) => startPoller(() => ({ status: 404, body: "" }), { yaml, server });

describe("국립공원 여러 시설 한 바퀴", () => {
  it("감시 조건 셋(같은 시설 둘 포함)이면 landingCamp는 한 번, campsiteList.do는 시설마다 한 번이다", async () => {
    const p = start(configWith(GATBAWI, GATBAWI_LATER, DOHAK));
    await settle();
    expect(listCalls(p.allRequests).map(deptOf).sort()).toEqual(["B251001", "B252001"]);
    const nf = p.allRequests.filter((r) => new URL(r.url).hostname === "netfunnel.knps.or.kr").map(nfLabel);
    expect(nf.filter((x) => x === "5101:landingCamp")).toHaveLength(1);
    expect(nf.filter((x) => x === "5101:reservation2")).toHaveLength(2);
    expect(nf.filter((x) => x === "5004:reservation2")).toHaveLength(2);
    expect(p.allRequests.filter((r) => r.url.endsWith("searchSimpleCampReservation.do"))).toHaveLength(1);
    expect(p.sent.map((m) => m.text).join("\n")).toContain("도학");
    await p.stop();
  });

  it("같은 시설·구역·입실일·박수를 쓰는 감시 조건 둘도 응답 하나로 판정한다", async () => {
    const p = start(configWith(DOHAK, DOHAK_SAME_UNIT));
    await settle();
    expect(listCalls(p.allRequests)).toHaveLength(1);
    expect(p.sent.length).toBeGreaterThan(0);
    await p.stop();
  });

  it("첫 시설 조회가 transient로 실패하면 두 번째 시설 요청은 나가지 않는다", async () => {
    const p = start(configWith(GATBAWI, DOHAK), failing("B252001"));
    await settle();
    expect(listCalls(p.allRequests).map(deptOf)).toEqual(["B252001"]);
    expect(p.logs.some((l) => l.msg === "query failed")).toBe(true);
    await p.stop();
  });

  it("뒤 시설이 실패해도 이미 받은 시설의 결과는 반영한다", async () => {
    const p = start(configWith(GATBAWI, DOHAK), failing("B251001"));
    await settle();
    expect(listCalls(p.allRequests).map(deptOf)).toEqual(["B252001", "B251001"]);
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("갓바위");
    expect(p.logs.some((l) => l.msg === "query failed")).toBe(true);
    await p.stop();
  });
});
