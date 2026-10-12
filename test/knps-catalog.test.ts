import { describe, expect, it } from "vitest";
import { adapters } from "../src/adapters/index.js";
import { runCatalog } from "../src/commands.js";
import type { Transport, TransportRequest } from "../src/types.js";
import { fixture, knpsServer } from "./harness.js";

// catalog knps 명령을 기록한 응답(축소본)과 카탈로그에서 만든 응답으로 돌린다.
// 자리 표를 카탈로그에서 만드는 일치·차이 시나리오는 합성이고, 표 구조는 기록한 응답과 같다.

interface FakeZone {
  name: string;
  code: string;
  seats: string[];
  /** 모든 칸이 닫힌 자리. 닫힌 칸에는 구역 코드가 없다. */
  closed?: string[];
}

/** 기록한 응답의 표 구조(왼쪽 구역 머리 rowspan + 자리 행, 오른쪽 날짜 칸)로 만든 응답. 날짜는 10/13 하루다. */
function gridHtml(zones: FakeZone[]): string {
  const left: string[] = [];
  const right: string[] = [];
  for (const z of zones) {
    z.seats.forEach((seat, i) => {
      const head = i === 0 ? `<th rowspan="${z.seats.length}" scope="row"><span class="title">${z.name}</span></th>` : "";
      left.push(`<tr>${head}<th scope="row"><span class="title">\n  ${seat}\n</span></th></tr>`);
      const closed = z.closed?.includes(seat);
      right.push(
        `<tr><td class=""><i title="${seat} : 2026-10-13" class="${closed ? "icon-none-reservation 20261013_C" : "icon-reservation 20261013_N"}"${
          closed ? "" : ` data-prod-ctg-id="${z.code}"`
        }></i></td></tr>`,
      );
    });
  }
  return `<table class="table-sticky-body"><tbody class="tbody">${left.join("")}</tbody></table><table class="table-body"><tbody class="tbody">${right.join("")}</tbody></table>`;
}

const range = (prefix: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);
const GATBAWI: FakeZone = { name: "일반(대형)야영지", code: "0200901", seats: range("A", 1, 11).map((s) => s.replace(/^A(\d)$/, "A0$1")) };
const SANGUI: FakeZone[] = [
  { name: "자동차야영장", code: "0201100", seats: [...range("A", 1, 11), ...range("B", 1, 19), ...range("E", 1, 8)] },
  { name: "카라반", code: "0203201", seats: range("C", 1, 10).map((s) => `${s}(4인)`) },
  { name: "특화야영장", code: "0202101", seats: range("D", 1, 6) },
];
const DOHAK: FakeZone = { name: "자동차야영장", code: "0201100", seats: Array.from({ length: 29 }, (_, i) => String(i + 1)) };

const setup = (opts: { list?: (form: URLSearchParams) => string; listStatus?: number; now?: string } = {}) => {
  const server = knpsServer({ ...(opts.list ? { list: opts.list } : {}), ...(opts.listStatus ? { listStatus: opts.listStatus } : {}) });
  const requests: TransportRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const transport: Transport = async (req) => {
    requests.push(req);
    return server(req);
  };
  const run = (facility: string | undefined, live = false) =>
    runCatalog(
      { kind: "catalog", provider: "knps", ...(facility ? { facility } : {}), live },
      {
        adapters,
        transport,
        version: "0.1.0",
        now: () => new Date(opts.now ?? "2026-10-12T08:00:00Z"),
        sleep: async () => {},
        random: () => 0.5,
        out: (s) => void out.push(s),
        err: (s) => void err.push(s),
      },
    );
  const www = () => requests.filter((r) => new URL(r.url).hostname === "reservation.knps.or.kr").map((r) => new URL(r.url).pathname);
  const nf = () => requests.filter((r) => new URL(r.url).hostname === "netfunnel.knps.or.kr").map((r) => `${new URL(r.url).searchParams.get("opcode")}:${new URL(r.url).searchParams.get("aid")}`);
  return { run, out: () => out.join(""), err: () => err.join(""), requests, www, nf };
};

describe("catalog knps", () => {
  it("시설 목록을 요청 없이 보여 준다", async () => {
    const s = setup();
    expect(await s.run(undefined)).toBe(0);
    expect(s.out()).toMatch(/^gatbawi\s+팔공산 갓바위야영장\s+1곳$/m);
    expect(s.out()).toMatch(/^dohak\s+팔공산 도학야영장\s+1곳$/m);
    expect(s.out()).toMatch(/^sangui\s+주왕산 상의야영장\s+3곳$/m);
    expect(s.requests).toEqual([]);
  });

  it("catalog knps gatbawi는 구역·자리 표를 요청 없이 보여 준다", async () => {
    const s = setup();
    expect(await s.run("gatbawi")).toBe(0);
    expect(s.out()).toMatch(/^0200901\s+일반\(대형\)야영지\s+일반야영지\s+-\s+11자리: A01-A11$/m);
    expect(s.requests).toEqual([]);
  });

  it("도학과 상의의 구역·자리를 보여 준다", async () => {
    const s = setup();
    expect(await s.run("dohak")).toBe(0);
    expect(s.out()).toMatch(/^0201100\s+자동차야영장\s+.*29자리: 1-29$/m);
    expect(await s.run("sangui")).toBe(0);
    expect(s.out()).toMatch(/^0203201\s+카라반\s+.*10자리: C1\(4인\)/m);
    expect(s.out()).toMatch(/^0202101\s+특화야영장\s+.*6자리: D1-D6$/m);
  });

  it("--live는 시설 없이 요청 없이 1을 돌려준다", async () => {
    const s = setup();
    expect(await s.run(undefined, true)).toBe(1);
    expect(s.err()).toContain("시설을 골라야 한다");
    expect(s.requests).toEqual([]);
  });

  it("gatbawi --live: 기록한 축소본과 대조해 사라진 자리를 보고하고 예약처 요청은 2회다", async () => {
    const s = setup();
    expect(await s.run("gatbawi", true)).toBe(0);
    expect(s.out()).toContain("0200901: 예약처에서 사라진 자리 A02-A03, A05-A07, A09-A11");
    expect(s.out()).not.toContain("새로 생긴 자리");
    expect(s.www()).toEqual(["/reservation/searchSimpleCampReservation.do", "/reservation/campsiteList.do"]);
    expect(s.nf()).toEqual(["5101:landingCamp", "5101:reservation2", "5004:reservation2"]);
  });

  it("gatbawi --live: 자리가 같으면 일치", async () => {
    const s = setup({ list: () => gridHtml([GATBAWI]) });
    expect(await s.run("gatbawi", true)).toBe(0);
    expect(s.out()).toContain("0200901: 일치 (11자리)");
    expect(s.out()).toContain("차이 없음");
  });

  it("gatbawi --live: 새로 생긴 자리와 사라진 자리를 함께 보고한다", async () => {
    const seats = [...GATBAWI.seats.filter((x) => x !== "A02"), "A12", "A13"];
    const s = setup({ list: () => gridHtml([{ ...GATBAWI, seats }]) });
    expect(await s.run("gatbawi", true)).toBe(0);
    expect(s.out()).toContain("0200901: 예약처에서 사라진 자리 A02");
    expect(s.out()).toContain("0200901: 예약처에 새로 생긴 자리 A12-A13");
    expect(s.out()).toContain("카탈로그를 갱신해야 한다");
  });

  it("dohak --live: 숫자 자리 이름 29곳이 일치", async () => {
    const s = setup({ list: (f) => (f.get("dept_id") === "B251001" ? gridHtml([DOHAK]) : "") });
    expect(await s.run("dohak", true)).toBe(0);
    expect(s.out()).toContain("0201100: 일치 (29자리)");
  });

  it("sangui --live: 구역이 셋이어도 응답 하나로 구역마다 대조한다", async () => {
    const s = setup({ list: () => gridHtml(SANGUI) });
    expect(await s.run("sangui", true)).toBe(0);
    for (const code of ["0201100: 일치 (38자리)", "0203201: 일치 (10자리)", "0202101: 일치 (6자리)"]) expect(s.out()).toContain(code);
    expect(s.www()).toEqual(["/reservation/searchSimpleCampReservation.do", "/reservation/campsiteList.do"]);
  });

  it("sangui --live: 모든 칸이 닫힌 자리도 표 구조로 구역에 속한다(구역 코드가 없는 자리)", async () => {
    const zones = SANGUI.map((z) => (z.name === "카라반" ? { ...z, closed: ["C1(4인)"] } : z));
    const s = setup({ list: () => gridHtml(zones) });
    expect(await s.run("sangui", true)).toBe(0);
    expect(s.out()).toContain("0203201: 일치 (10자리)");
  });

  it("sangui --live: 기록한 축소본(3구역, 자리 2개씩)을 구역별로 읽는다", async () => {
    const s = setup({ list: () => fixture("knps-sangui-campsiteList.htm") });
    expect(await s.run("sangui", true)).toBe(0);
    expect(s.out()).toContain("0201100: 예약처에서 사라진 자리 A3-A11, B1-B19, E1-E8");
    expect(s.out()).toContain("0203201: 예약처에서 사라진 자리 C3(4인), C4(4인), C5(4인), C6(4인), C7(4인), C8(4인), C9(4인), C10(4인)");
    expect(s.out()).toContain("0202101: 예약처에서 사라진 자리 D3-D6");
    expect(s.out()).not.toContain("새로 생긴");
  });

  it("예약처에 새 구역이 생기거나 구역 코드가 바뀌면 보고한다", async () => {
    const zones: FakeZone[] = [
      { ...SANGUI[0]!, code: "0209999" },
      SANGUI[1]!,
      { name: "글램핑", code: "0204001", seats: ["G1", "G2"] },
    ];
    const s = setup({ list: () => gridHtml(zones) });
    expect(await s.run("sangui", true)).toBe(0);
    expect(s.out()).toContain("0201100: 구역 코드가 다르다(카탈로그 0201100, 예약처 0209999)");
    expect(s.out()).toContain("예약처에 새로 생긴 구역 글램핑(0204001)");
    expect(s.out()).toContain("0202101: 예약처 응답에 구역이 없다(특화야영장)");
  });

  it("오픈 경쟁 시간에는 요청 없이 거부한다", async () => {
    const s = setup({ now: "2026-10-12T01:00:00Z" });
    expect(await s.run("gatbawi", true)).toBe(1);
    expect(s.err()).toContain("오픈 경쟁 시간");
    expect(s.requests).toEqual([]);
  });

  it("조회에 실패하면 1을 돌려준다", async () => {
    const s = setup({ listStatus: 503 });
    expect(await s.run("gatbawi", true)).toBe(1);
    expect(s.out()).toContain("조회 실패");
  });
});
