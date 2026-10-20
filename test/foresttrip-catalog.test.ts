import { describe, expect, it } from "vitest";
import { adapters } from "../src/adapters/index.js";
import { parseArgs } from "../src/cli.js";
import { runCatalog } from "../src/commands.js";
import type { TransportRequest, TransportResponse } from "../src/types.js";
import { loadConfig } from "../src/config.js";
import { CONFIG_YAML, ENV } from "./harness.js";
import { FOREST_ENV, FOREST_SECRET_VALUES, foresttripServer, type ForestOptions } from "./foresttrip-server.js";

// `catalog foresttrip`을 runCatalog의 출력으로 본다. --live는 가짜 숲나들e 서버(test/foresttrip-server.ts)로 돌린다.
// 카탈로그의 유명산(0101)은 구역 네 곳(02002 야영데크, 01002 휴양관, 01001 숲속의집, 01003 연립동)이다.
const NOON = "2026-10-20T12:00:00+09:00";

interface FakeGoods {
  goodsId: string;
  goodsNm: string;
  goodsClsscCd: string;
  goodsClsscNm: string;
}

const goodsOf = (code: string, label: string, n: number, prefix = label): FakeGoods[] =>
  Array.from({ length: n }, (_, i) => ({ goodsId: `G${code}${i}`, goodsNm: `${prefix}(${101 + i})`, goodsClsscCd: code, goodsClsscNm: label }));

/** 상품 목록 응답을 바꾼다(인자는 상위 구분(01 숙소, 02 야영)). */
type Goods = (upper: string, base: FakeGoods[]) => FakeGoods[];

const setup = (opts: { server?: ForestOptions; goods?: Goods; now?: string; env?: Record<string, string | undefined>; config?: string } = {}) => {
  const server = foresttripServer(opts.server);
  const requests: TransportRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    requests.push(req);
    const res = server(req);
    if (opts.goods && new URL(req.url).pathname === "/rep/or/sssn/selectRsrvtGoodsListForMonthRsrvt.do") {
      const body = JSON.parse(req.body ?? "{}") as { upperGoodsClsscCd: string };
      const base = (JSON.parse(res.body) as { rsrvtGoodsList: FakeGoods[] }).rsrvtGoodsList;
      return { status: 200, body: JSON.stringify({ rsrvtGoodsList: opts.goods(body.upperGoodsClsscCd, base) }) };
    }
    return res;
  };
  const now = new Date(opts.now ?? NOON);
  const run = async (args: string[]) => {
    out.length = 0;
    err.length = 0;
    const command = parseArgs(["catalog", "foresttrip", ...args]);
    if (command.kind !== "catalog") throw new Error("catalog 명령이 아니다");
    const code = await runCatalog(command, {
      adapters,
      transport,
      ...(opts.config ? { config: loadConfig(opts.config, ENV, adapters) } : {}),
      env: opts.env ?? FOREST_ENV,
      version: "0.1.0",
      now: () => now,
      sleep: async () => {},
      random: () => 0.5,
      out: (t) => void out.push(t),
      err: (t) => void err.push(t),
    });
    return { code, out: out.join(""), err: err.join("") };
  };
  const paths = () => requests.map((r) => new URL(r.url).pathname);
  return { run, requests, paths, server };
};

/** 카탈로그와 같은 구역 네 곳을 응답한다. */
const matching: Goods = (upper) => (upper === "02" ? goodsOf("02002", "야영데크", 7) : [...goodsOf("01002", "휴양관", 2, "고라니"), ...goodsOf("01001", "숲속의집", 3, "숲속"), ...goodsOf("01003", "연립동", 4, "연립")]);

describe("catalog foresttrip", () => {
  it("시설 목록과 구역 표를 카탈로그대로 보이고 요청은 보내지 않는다", async () => {
    const t = setup();
    const list = await t.run([]);
    expect(list.out).toMatch(/^yumyeongsan\s+유명산자연휴양림\s+4곳$/m);
    const one = await t.run(["yumyeongsan"]);
    expect(one.out).toMatch(/^구역 코드\s+라벨\s+상품 수$/m);
    for (const [code, label] of [["02002", "야영데크"], ["01002", "휴양관"], ["01001", "숲속의집"], ["01003", "연립동"]]) expect(one.out).toMatch(new RegExp(`^${code}\\s+${label}\\s+-$`, "m"));
    expect(one.out).toContain("insttId 0101");
    expect(t.requests).toEqual([]);
  });

  it("없는 시설은 쓸 수 있는 값을 알리고 --live는 시설을 골라야 한다", async () => {
    const t = setup();
    expect((await t.run(["nowhere"])).err).toContain("yumyeongsan");
    const live = await t.run(["--live"]);
    expect(live.code).toBe(1);
    expect(t.requests).toEqual([]);
  });

  describe("--live", () => {
    it("카탈로그와 응답이 맞으면 구역마다 일치를 보이고 상품 목록과 예상 호출 수를 보인다", async () => {
      const t = setup({ goods: matching });
      const r = await t.run(["yumyeongsan", "--live"]);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^02002\s+야영데크\s+7\s+일치$/m);
      expect(r.out).toMatch(/^01002\s+휴양관\s+2\s+일치$/m);
      expect(r.out).toMatch(/^01001\s+숲속의집\s+3\s+일치$/m);
      expect(r.out).toMatch(/^01003\s+연립동\s+4\s+일치$/m);
      expect(r.out).toContain("차이 없음");
      expect(r.out).toContain("02002 야영데크: 7개 야영데크(101), 야영데크(102)");
      // 구역마다 상품 5개씩: 야영데크 2번, 휴양관 1번, 숲속의집 1번, 연립동 1번.
      expect(r.out).toMatch(/^02002\s+야영데크\s+7\s+2번$/m);
      expect(r.out).toContain("합계 5번 (상한 20번)");
    });

    it("insttId로 조회하고 로그인한 응답에서만 읽으며 예약·회원정보 경로로는 나가지 않는다", async () => {
      const t = setup({ goods: matching });
      await t.run(["yumyeongsan", "--live"]);
      const posts = t.requests.filter((r) => r.method === "POST" && new URL(r.url).pathname.startsWith("/rep/")).map((r) => JSON.parse(r.body ?? "{}") as { insttId: string });
      expect(posts.length).toBeGreaterThan(0);
      expect(new Set(posts.map((p) => p.insttId))).toEqual(new Set(["0101"]));
      expect(t.paths().filter((p) => /^\/(pot\/mc|com\/alert|rep\/or\/(rsrvt|pay|cncl))/.test(p))).toEqual([]);
    });

    it("예약처에서 사라진 구역과 새로 생긴 구역, 라벨이 바뀐 구역을 보고한다", async () => {
      const t = setup({
        goods: (upper) => (upper === "02" ? [...goodsOf("02002", "오토캠핑", 7), ...goodsOf("02007", "캐러밴", 10)] : goodsOf("01002", "휴양관", 2)),
      });
      const r = await t.run(["yumyeongsan", "--live"]);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^01001\s+숲속의집\s+-\s+예약처에서 사라진 구역$/m);
      expect(r.out).toMatch(/^01003\s+연립동\s+-\s+예약처에서 사라진 구역$/m);
      expect(r.out).toMatch(/^02007\s+캐러밴\s+10\s+예약처에 새로 생긴 구역$/m);
      expect(r.out).toMatch(/^02002\s+오토캠핑\s+7\s+라벨이 다르다\(카탈로그 야영데크\)$/m);
      expect(r.out).toContain("차이 있는 구역 4곳");
    });

    it("예상 호출 수가 구역과 자리 필터에 따라 달라진다", async () => {
      const t = setup({ goods: matching });
      const all = await t.run(["yumyeongsan", "--live"]);
      expect(all.out).toContain("합계 5번");
      const zone = await t.run(["yumyeongsan", "--live", "--zones", "02002"]);
      expect(zone.out).toContain("합계 2번");
      expect(zone.out).not.toMatch(/^01002\s+휴양관\s+2\s+1번$/m);
      const seat = await t.run(["yumyeongsan", "--live", "--zones", "02002", "--seats", "야영데크(101),야영데크(102)"]);
      expect(seat.out).toContain("합계 1번");
      const typo = await t.run(["yumyeongsan", "--live", "--zones", "02002", "--seats", "야영데크(999)"]);
      expect(typo.out).toContain("없는 자리 이름: 야영데크(999)");
      expect(typo.out).toContain("합계 0번");
    });

    it("예상 호출 수가 상한(20번)을 넘으면 어떻게 줄일지와 함께 드러난다", async () => {
      const big: Goods = (upper) => (upper === "02" ? goodsOf("02002", "야영데크", 120) : goodsOf("01002", "휴양관", 6, "고라니"));
      const t = setup({ goods: big });
      const over = await t.run(["yumyeongsan", "--live"]);
      expect(over.out).toContain("합계 26번: 상한 20번을 넘는다");
      expect(over.out).toContain("--zones");
      const zoneOnly = await t.run(["yumyeongsan", "--live", "--zones", "02002"]);
      expect(zoneOnly.out).toContain("합계 24번: 상한 20번을 넘는다");
      const narrowed = await t.run(["yumyeongsan", "--live", "--zones", "02002", "--seats", Array.from({ length: 100 }, (_, i) => `야영데크(${101 + i})`).join(",")]);
      expect(narrowed.out).toContain("합계 20번 (상한 20번)");
    });

    it("예약 개시 시각 5분 전부터 30분 후까지는 상품 목록을 조회하지 않는다", async () => {
      // 유명산 개시 시각은 0900. 08:55~09:30이 오픈 경쟁 시간이다.
      for (const [now, blocked] of [["2026-10-20T08:54:59+09:00", false], ["2026-10-20T08:55:00+09:00", true], ["2026-10-20T09:29:59+09:00", true], ["2026-10-20T09:30:00+09:00", false]] as const) {
        const t = setup({ goods: matching, now });
        const r = await t.run(["yumyeongsan", "--live"]);
        const goodsCalls = t.paths().filter((p) => p.endsWith("selectRsrvtGoodsListForMonthRsrvt.do"));
        expect(goodsCalls.length > 0, now).toBe(!blocked);
        expect(r.code, now).toBe(blocked ? 1 : 0);
        if (blocked) {
          expect(r.out).not.toContain("합계");
          expect(r.out + r.err).toContain("오픈 경쟁 시간");
        }
      }
    });

    it("설정의 openingRush 안에서는 요청 없이 실행하지 않는다", async () => {
      const config = CONFIG_YAML.replace("providers:", 'providers:\n  foresttrip: { openingRush: { from: "11:00", to: "13:00" } }');
      const t = setup({ goods: matching, config });
      const r = await t.run(["yumyeongsan", "--live"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("오픈 경쟁 시간");
      expect(t.requests).toEqual([]);
    });

    it("차단되면 사유를 알리고 비밀 값은 출력에 없다", async () => {
      const t = setup({ server: { crawling: "false" } });
      const r = await t.run(["yumyeongsan", "--live"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("crawlingCheck.do가 거부했다");
      for (const secret of FOREST_SECRET_VALUES(t.server)) expect(r.out + r.err).not.toContain(secret);
    });

    it("계정 값이 없으면 요청 없이 멈춘다", async () => {
      const t = setup({ env: {} });
      const r = await t.run(["yumyeongsan", "--live"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("FORESTTRIP_USERNAME");
      expect(t.requests.filter((q) => q.method === "POST")).toEqual([]);
    });
  });
});
