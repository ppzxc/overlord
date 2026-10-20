import { describe, expect, it } from "vitest";
import type { TransportRequest, TransportResponse } from "../src/types.js";
import { configWith, fixture, settle, startPoller } from "./harness.js";
import { FOREST_ENV, foresttripServer, type ForestOptions } from "./foresttrip-server.js";

// 호출 예산과 상품 목록 캐시(Spec #142 / Ticket-5). 가짜 서버(test/foresttrip-server.ts)는 고치지 않고 intercept·avail 훅으로 상품 수를 늘린다.
const NOW = "2026-10-20T14:00:00+09:00";
const GOODS = "/rep/or/sssn/selectRsrvtGoodsListForMonthRsrvt.do";
const AVAIL = "/rep/or/selectRsrvtAvailInfoListForMonthRsrvt.do";
const POLICY = "/rep/or/selectSthngListForMonthRsrvt.do";
const json = (body: unknown): TransportResponse => ({ status: 200, body: JSON.stringify(body) });
const pathOf = (r: TransportRequest) => new URL(r.url).pathname;
const bodyOf = (r: TransportRequest) => JSON.parse(r.body ?? "{}") as Record<string, unknown>;

const watch = (name: string, facility: string, zone: string, checkIn = "2026-11-20") => `
  - name: ${name}
    provider: foresttrip
    facility: ${facility}
    zones: ["${zone}"]
    checkIn: { from: ${checkIn}, to: ${checkIn} }
    nights: 1
    notify: [default]`;

/** 야영데크(02002)가 `count`개인 유명산. 잔여는 모두 마감이다. */
const manyGoods =
  (count: number): ForestOptions["intercept"] =>
  (req) => {
    if (pathOf(req) === GOODS) {
      return json({ rsrvtGoodsList: Array.from({ length: count }, (_, i) => ({ goodsId: `G${i + 1}`, goodsNm: `야영데크(${i + 1})`, goodsClsscCd: "02002" })) });
    }
    if (pathOf(req) === AVAIL) {
      const ids = (bodyOf(req).goodsIdList as string[]).slice(0, 5);
      return json({ rsrvtAvailInfoList: ids.map((goodsId) => ({ goodsId, useDt: "20261120", rsrvtAvail: "Y", rsrvtCnt: 1 })) });
    }
    return undefined;
  };

const run = (opts: { server?: ForestOptions; yaml?: string } = {}) => {
  const server = foresttripServer(opts.server);
  const p = startPoller(() => ({ status: 404, body: "" }), { yaml: opts.yaml ?? configWith(watch("유명산 감시", "yumyeongsan", "02002")), server, env: FOREST_ENV, now: NOW });
  return { p, server };
};

describe("숲나들e 호출 예산", () => {
  it("호출 수가 상한 이하이면 보낸 잔여 요청 수가 상품 수 ÷ 5의 올림이고 구역 필터가 상품 수를 줄인다", async () => {
    // 유명산 상품은 야영데크 7개와 휴양관 2개다. 야영데크만 감시하면 9개가 아니라 7개를 묻는다(2번).
    const { p } = run();
    await settle();
    const avail = p.allRequests.filter((r) => pathOf(r) === AVAIL);
    expect(avail.map((r) => (bodyOf(r).goodsIdList as string[]).length)).toEqual([5, 2]);
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("정확히 상한(상품 100개, 20번)이면 조회한다", async () => {
    const { p } = run({ server: { intercept: manyGoods(100) } });
    await settle();
    expect(p.allRequests.filter((r) => pathOf(r) === AVAIL)).toHaveLength(20);
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("상한을 넘으면 조회하지 않고 필요한 호출 수와 줄이는 방법을 한 번만 알린다", async () => {
    const { p } = run({ server: { intercept: manyGoods(101) } });
    await settle();
    expect(p.allRequests.filter((r) => pathOf(r) === AVAIL)).toHaveLength(0);
    expect(p.sent).toHaveLength(1);
    const text = p.sent[0]!.text;
    expect(text).toContain("유명산 감시");
    expect(text).toContain("유명산자연휴양림");
    expect(text).toContain("21번"); // ceil(101 / 5)
    expect(text).toContain("20번");
    expect(text).toContain("자리 필터");
    expect(text).toContain("구역");
    expect(p.logs.filter((l) => l.msg === "query failed")).toEqual([]);
    // 다음 바퀴에도 같은 알림을 되풀이하지 않는다.
    await p.clock.advance(600_000);
    await settle();
    expect(p.sent).toHaveLength(1);
    await p.stop();
  });

  it("상한은 시설의 구역 호출 수 합계로 센다: 구역마다는 넘지 않아도 합이 넘으면 둘 다 조회하지 않는다", async () => {
    const intercept: ForestOptions["intercept"] = (req) => {
      if (pathOf(req) === GOODS) {
        const zone = String(bodyOf(req).goodsClsscCd);
        return json({ rsrvtGoodsList: Array.from({ length: 55 }, (_, i) => ({ goodsId: `${zone}-${i}`, goodsNm: `자리${i}`, goodsClsscCd: zone })) });
      }
      return undefined;
    };
    const yaml = configWith(`
  - name: 유명산 둘
    provider: foresttrip
    facility: yumyeongsan
    zones: ["02002", "01002"]
    checkIn: { from: 2026-11-20, to: 2026-11-20 }
    nights: 1
    notify: [default]`);
    const { p } = run({ server: { intercept }, yaml });
    await settle();
    expect(p.allRequests.filter((r) => pathOf(r) === AVAIL)).toHaveLength(0);
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("22번"); // 11 + 11
    await p.stop();
  });
});

describe("숲나들e seats로 줄이는 호출", () => {
  const seatWatch = (name: string, seats?: string[]) => `
  - name: ${name}
    provider: foresttrip
    facility: yumyeongsan
    zones: ["02002"]${seats ? `\n    seats: [${seats.map((s) => `"${s}"`).join(", ")}]` : ""}
    checkIn: { from: 2026-11-20, to: 2026-11-20 }
    nights: 1
    notify: [default]`;
  const asked = (p: ReturnType<typeof run>["p"]) => p.allRequests.filter((r) => pathOf(r) === AVAIL).map((r) => (bodyOf(r).goodsIdList as string[]).length);

  it("seats만 있는 감시 조건은 그 이름의 상품만 묻는다", async () => {
    const { p } = run({ yaml: configWith(seatWatch("하나", ["야영데크(101)", "야영데크(102)"])) });
    await settle();
    expect(asked(p)).toEqual([2]);
    await p.stop();
  });

  it("같은 구역을 보는 감시 조건들의 seats 합집합만 묻는다", async () => {
    const { p } = run({ yaml: configWith(seatWatch("하나", ["야영데크(101)"]) + seatWatch("둘", ["야영데크(105)", "야영데크(101)"])) });
    await settle();
    expect(asked(p)).toEqual([2]);
    await p.stop();
  });

  it("seats가 없는 감시 조건이 하나라도 있으면 구역의 모든 상품을 묻는다", async () => {
    const { p } = run({ yaml: configWith(seatWatch("하나", ["야영데크(101)"]) + seatWatch("전부")) });
    await settle();
    expect(asked(p)).toEqual([5, 2]);
    await p.stop();
  });

  it("seats로 줄인 호출 수가 상한 이하면 상품이 100개를 넘어도 조회한다", async () => {
    const seats = Array.from({ length: 5 }, (_, i) => `야영데크(${i + 1})`);
    const { p } = run({ server: { intercept: manyGoods(101) }, yaml: configWith(seatWatch("좁힘", seats)) });
    await settle();
    expect(asked(p)).toEqual([5]);
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });
});

describe("숲나들e 낡은 목록 재조회와 호출 상한", () => {
  it("낡은 목록을 다시 받은 뒤 다시 읽으면 상한을 넘을 때는 다시 읽지 않고 한 번만 알린다", async () => {
    let armed = false;
    const intercept: ForestOptions["intercept"] = (req) => {
      if (pathOf(req) === GOODS) return manyGoods(100)!(req, undefined as never);
      if (pathOf(req) === AVAIL) {
        const ids = bodyOf(req).goodsIdList as string[];
        const rows: Record<string, unknown>[] = ids.map((goodsId) => ({ goodsId, useDt: "20261120", rsrvtAvail: "Y", rsrvtCnt: 1 }));
        if (armed) rows.push({ goodsId: "G-NEW", useDt: "20261120", rsrvtAvail: "Y", rsrvtCnt: 1 });
        return json({ rsrvtAvailInfoList: rows });
      }
      return undefined;
    };
    const { p } = run({ server: { intercept } });
    await settle();
    expect(p.allRequests.filter((r) => pathOf(r) === AVAIL)).toHaveLength(20);
    armed = true;
    await p.clock.advance(600_000);
    await settle();
    expect(p.allRequests.filter((r) => pathOf(r) === AVAIL)).toHaveLength(40); // 둘째 바퀴 20번
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("20번");
    await p.stop();
  });
});

describe("숲나들e 상품 목록 캐시", () => {
  const goodsRequests = (p: ReturnType<typeof run>["p"]) => p.allRequests.filter((r) => pathOf(r) === GOODS);

  it("시작 시 한 번 받고 다음 바퀴에는 다시 받지 않으며 24시간이 지나면 다시 받는다", async () => {
    const { p } = run();
    await settle();
    expect(goodsRequests(p)).toHaveLength(1);
    await p.clock.advance(600_000);
    await settle();
    expect(goodsRequests(p)).toHaveLength(1);
    expect(p.allRequests.filter((r) => pathOf(r) === AVAIL)).toHaveLength(4); // 바퀴마다 2번
    await p.clock.advance(86_400_000);
    await settle();
    expect(goodsRequests(p)).toHaveLength(2);
    await p.stop();
  });

  // 첫 바퀴에는 목록을 방금 받았으므로 어긋나도 다시 받지 않는다. 캐시를 쓰는 둘째 바퀴에서 어긋남을 만든다.
  it("잔여 응답에 모르는 goodsId가 보이면 그 바퀴에서 바로 다시 받는다", async () => {
    let armed = false;
    const { p } = run({
      server: {
        avail: (rows) => {
          if (!armed) return undefined;
          armed = false;
          return json({ rsrvtAvailInfoList: [...rows, { goodsId: "G-NEW", useDt: "20261120", rsrvtAvail: "Y", rsrvtCnt: 1 }] });
        },
      },
    });
    await settle();
    expect(goodsRequests(p)).toHaveLength(1);
    armed = true;
    await p.clock.advance(600_000);
    await settle();
    expect(goodsRequests(p)).toHaveLength(2);
    await p.clock.advance(600_000);
    await settle();
    expect(goodsRequests(p)).toHaveLength(2); // 이후에는 다시 캐시를 쓴다.
    await p.stop();
  });

  it("감시하던 goodsId가 잔여 응답에서 빠지면 바로 다시 받는다", async () => {
    let armed = false;
    const { p } = run({
      server: {
        avail: (rows) => {
          if (!armed) return undefined;
          armed = false;
          return json({ rsrvtAvailInfoList: rows.filter((r) => r.goodsId !== "G0101020020000000101") });
        },
      },
    });
    await settle();
    armed = true;
    await p.clock.advance(600_000);
    await settle();
    expect(goodsRequests(p)).toHaveLength(2);
    await p.stop();
  });

  it("대기열 키(action8)는 상품 목록을 받을 때만 쓰고 캐시를 쓰는 바퀴에는 받지 않는다", async () => {
    const { p, server } = run();
    await settle();
    await p.clock.advance(600_000);
    await settle();
    const action8 = server.state.keys.filter((k) => k.aid === "action8");
    expect(action8).toHaveLength(goodsRequests(p).length);
    expect(goodsRequests(p)).toHaveLength(1);
    await p.stop();
  });
});

describe("숲나들e 시설이 여럿", () => {
  it("시설이 둘이어도 호스트로 요청이 한 줄로 나가 겹치지 않는다", async () => {
    // 삼척활기(ID02030104)는 가짜 서버가 모르는 시설이라 intercept가 응답한다.
    const policy = fixture("foresttrip/policy-yumyeongsan.json");
    const intercept: ForestOptions["intercept"] = (req) => {
      if (!req.body?.startsWith("{") || bodyOf(req).insttId !== "ID02030104") return undefined;
      if (pathOf(req) === POLICY) return { status: 200, body: policy };
      if (pathOf(req) === GOODS) return json({ rsrvtGoodsList: [{ goodsId: "S1", goodsNm: "한옥(1)", goodsClsscCd: "01007" }] });
      if (pathOf(req) === AVAIL) return json({ rsrvtAvailInfoList: [{ goodsId: "S1", useDt: "20261120", rsrvtAvail: "Y", rsrvtCnt: 1 }] });
      return undefined;
    };
    const yaml = configWith(watch("유명산 감시", "yumyeongsan", "02002") + watch("삼척 감시", "samcheok-hwalgi", "01007"));
    const { p } = run({ server: { intercept }, yaml });
    await settle();
    const wwwTimes = p.allRequests.flatMap((r, i) => (new URL(r.url).hostname === "www.foresttrip.go.kr" ? [p.requestTimes[i]!] : []));
    const insttIds = new Set(p.allRequests.filter((r) => r.body?.startsWith("{")).map((r) => bodyOf(r).insttId));
    expect(insttIds).toEqual(new Set(["0101", "ID02030104"]));
    for (let i = 1; i < wwwTimes.length; i++) expect(wwwTimes[i]! - wwwTimes[i - 1]!).toBeGreaterThanOrEqual(4_000);
    await p.stop();
  });
});
