import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import type { TransportRequest, TransportResponse } from "../src/types.js";
import { ENV, configWith, settle, startPoller } from "./harness.js";
import { FOREST_ENV, foresttripServer, type ForestOptions } from "./foresttrip-server.js";

// 숲나들e `seats:`는 화면에 보이는 상품 이름 정확 일치다(Spec #142 / Ticket-3, Decision-11).
// 유명산 상품(가짜 서버): 야영데크(101)~(107)(02002), 고라니·꾀꼬리(01002).
const NOW = "2026-10-20T14:00:00+09:00";
const DAY = "2026-10-24";
const LOOP = 600_000;

const watch = (zones: string[], seats?: string[], name = "유명산 감시") => `
  - name: ${name}
    provider: foresttrip
    facility: yumyeongsan
    zones: [${zones.map((z) => `"${z}"`).join(", ")}]${seats ? `\n    seats: [${seats.map((s) => `"${s}"`).join(", ")}]` : ""}
    checkIn: { from: ${DAY}, to: ${DAY} }
    nights: 1
    notify: [default]`;

/** 모든 상품이 DAY에 빈자리다. */
const allOpen: ForestOptions["status"] = (_g, date) => (date === DAY ? { rsrvtAvail: "Y", rsrvtCnt: 0 } : { rsrvtAvail: "Y", rsrvtCnt: 1 });

/**
 * 가짜 서버를 감싸 상품 목록을 바꾼다. `hidden`에 든 이름은 목록에서 빠지고, `extra`는 목록에 더해진다(이름이 겹치는 상품).
 * 더한 상품의 잔여 행은 `avail` 훅이 DAY 빈자리로 붙인다.
 */
function shop() {
  const ctl = { hidden: new Set<string>(), extra: [] as { id: string; name: string; clsscCd: string }[] };
  const server = foresttripServer({
    status: allOpen,
    avail: (rows, req) => {
      const asked = (JSON.parse(req.body ?? "{}") as { goodsIdList: string[] }).goodsIdList;
      const more = ctl.extra
        .filter((g) => asked.includes(g.id))
        .map((g) => ({ goodsId: g.id, useDt: DAY.replaceAll("-", ""), rsrvtAvail: "Y", rsrvtCnt: 0, wtngCnt: 0 }));
      return { status: 200, body: JSON.stringify({ rsrvtAvailInfoList: [...rows, ...more] }) };
    },
  });
  const respond = (req: TransportRequest): TransportResponse => {
    const res = server(req);
    if (!new URL(req.url).pathname.endsWith("selectRsrvtGoodsListForMonthRsrvt.do") || res.status !== 200) return res;
    const body = JSON.parse(res.body) as { rsrvtGoodsList: { goodsId: string; goodsNm: string; goodsClsscCd: string }[] };
    const zone = (JSON.parse(req.body ?? "{}") as { goodsClsscCd?: string }).goodsClsscCd;
    const extra = ctl.extra.filter((g) => !zone || g.clsscCd === zone).map((g) => ({ goodsId: g.id, goodsNm: g.name, goodsClsscCd: g.clsscCd }));
    body.rsrvtGoodsList = [...body.rsrvtGoodsList, ...extra].filter((g) => !ctl.hidden.has(g.goodsNm));
    return { ...res, body: JSON.stringify(body) };
  };
  return { respond, ctl };
}

const run = (yaml: string, s = shop()) => {
  const p = startPoller(() => ({ status: 404, body: "" }), { yaml, server: s.respond, env: FOREST_ENV, now: NOW });
  return { p, ctl: s.ctl };
};
type Poller = ReturnType<typeof run>["p"];

const mismatches = (p: Poller) => p.sent.filter((m) => m.text.includes("자리 이름"));
const advance = async (p: Poller) => {
  await p.clock.advance(LOOP);
  await settle();
};

describe("숲나들e seats 이름 필터", () => {
  describe("이름 일치", () => {
    it("seats에 쓴 이름의 빈자리만 알리고 다른 자리는 알리지 않는다", async () => {
      const { p } = run(configWith(watch(["02002"], ["야영데크(101)", "야영데크(103)"])));
      await settle();
      expect(p.sent).toHaveLength(1);
      const text = p.sent[0]!.text;
      expect(text).toContain("야영데크(101)");
      expect(text).toContain("야영데크(103)");
      expect(text).not.toContain("야영데크(102)");
      expect(text).not.toContain("야영데크(107)");
      await p.stop();
    });

    it("seats를 생략하면 구역의 모든 빈자리를 알린다", async () => {
      const { p } = run(configWith(watch(["02002"])));
      await settle();
      expect(p.sent[0]!.text).toContain("야영데크(107)");
      await p.stop();
    });

    it("이름이 겹치는 상품은 모두 포함한다", async () => {
      const s = shop();
      s.ctl.extra.push({ id: "G0101020020000009101", name: "야영데크(101)", clsscCd: "02002" });
      const { p } = run(configWith(watch(["02002"], ["야영데크(101)"])), s);
      await settle();
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0]!.text.match(/야영데크\(101\)/g)?.length).toBeGreaterThanOrEqual(2);
      expect(p.sent[0]!.text).not.toContain("야영데크(102)");
      await p.stop();
    });

    it("객실(숲속의집 등)도 이름으로 감시한다", async () => {
      const { p } = run(configWith(watch(["01002"], ["고라니"])));
      await settle();
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0]!.text).toContain("고라니");
      expect(p.sent[0]!.text).not.toContain("꾀꼬리");
      await p.stop();
    });

    it("여러 구역을 한 조건으로 걸면 구역마다 있는 이름을 찾는다", async () => {
      const { p } = run(configWith(watch(["02002", "01002"], ["야영데크(101)", "고라니"])));
      await settle();
      const text = p.sent.map((m) => m.text).join("\n");
      expect(text).toContain("야영데크(101)");
      expect(text).toContain("고라니");
      expect(mismatches(p)).toHaveLength(0);
      await p.stop();
    });
  });

  describe("설정 로드", () => {
    const msg = (yaml: string): string => {
      try {
        loadConfig(yaml, { ...ENV, ...FOREST_ENV });
      } catch (e) {
        if (e instanceof ConfigError) return e.message;
        throw e;
      }
      return "";
    };

    it("틀린 구역 코드는 거부하고 그 시설의 쓸 수 있는 코드와 라벨을 보인다", () => {
      const m = msg(configWith(watch(["99999"])));
      expect(m).toContain("99999");
      expect(m).toContain("02002(야영데크)");
      expect(m).toContain("01001(숲속의집)");
    });

    it("숫자로 읽힌 구역 코드는 따옴표를 안내한다", () => {
      expect(msg(configWith(watch(["02002"]).replace('"02002"', "02002")))).toContain("따옴표");
    });

    it("자리 이름은 설정 로드에서 확인하지 않는다(상품 목록을 받은 뒤에 확인한다)", () => {
      expect(msg(configWith(watch(["02002"], ["야영데크(101)", "A10-A15", "없는이름"])))).toBe("");
    });

    it("다른 예약처의 자리 토큰 형식 검증은 그대로다", () => {
      const goraebul = (seats: string) => `
  - name: 고래불
    provider: goraebul
    zones: [DKA]
    seats: [${seats}]
    checkIn: { from: 2026-10-10, to: 2026-10-11 }
    nights: 1
    notify: [default]`;
      expect(msg(configWith(goraebul("A02")))).toBe("");
      expect(msg(configWith(goraebul('"야영데크(101)"')))).toContain("자리 번호(A02) 또는 범위(A10-A15) 형식이어야 한다");
    });
  });

  describe("자리 이름 확인", () => {
    it("일부만 없으면 없는 이름을 1회 알리고 있는 자리는 계속 감시한다", async () => {
      const { p } = run(configWith(watch(["02002"], ["야영데크(101)", "야영데크(999)"])));
      await settle();
      const notices = mismatches(p);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toContain("야영데크(999)");
      expect(p.sent.some((m) => !mismatches(p).includes(m) && m.text.includes("야영데크(101)"))).toBe(true);
      const before = p.sent.length;
      await advance(p);
      await advance(p);
      expect(p.sent).toHaveLength(before); // 같은 알림도, 같은 빈자리도 반복하지 않는다.
      await p.stop();
    });

    it("전부 없으면 그 조건만 멈추고 1회 알린다. 예약처 상태는 멈추지 않는다", async () => {
      const { p } = run(configWith(watch(["02002"], ["오타1", "오타2"], "오타 감시"), watch(["02002"], ["야영데크(101)"], "정상 감시")));
      await settle();
      const notices = mismatches(p);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toContain("오타 감시");
      expect(notices[0]!.text).toContain("오타1");
      expect(notices[0]!.text).toContain("오타2");
      expect(notices[0]!.text).toContain("멈춤");
      expect(p.sent.some((m) => m.text.includes("정상 감시") && m.text.includes("야영데크(101)"))).toBe(true);
      expect(p.sent.some((m) => m.text.includes("오타 감시") && m.text.includes("야영데크(10"))).toBe(false);
      const reqs = p.allRequests.length;
      await advance(p);
      expect(p.allRequests.length).toBeGreaterThan(reqs); // 예약처는 계속 돈다.
      expect(mismatches(p)).toHaveLength(1);
      await p.stop();
    });

    it("갱신 때 상태가 바뀌면 다시 알리고 같으면 알리지 않으며 상품이 돌아오면 다시 감시한다", async () => {
      const { p, ctl } = run(configWith(watch(["02002"], ["야영데크(101)", "야영데크(102)"])));
      await settle();
      expect(mismatches(p)).toHaveLength(0);
      ctl.hidden.add("야영데크(102)"); // 휴양림이 상품을 지웠다.
      await advance(p);
      expect(mismatches(p)).toHaveLength(1);
      expect(mismatches(p)[0]!.text).toContain("야영데크(102)");
      ctl.hidden.add("야영데크(101)"); // 이제 전부 없다.
      await advance(p);
      expect(mismatches(p)).toHaveLength(2);
      expect(mismatches(p)[1]!.text).toContain("멈춤");
      await advance(p);
      expect(mismatches(p)).toHaveLength(2);
      ctl.hidden.clear(); // 상품이 돌아오면 다시 감시한다.
      const before = p.sent.length;
      await advance(p);
      expect(mismatches(p)).toHaveLength(2);
      expect(p.sent.length).toBeGreaterThan(before);
      expect(p.sent.at(-1)!.text).toContain("야영데크(10");
      await p.stop();
    });

    it("이름이 모두 있으면 알리지 않는다", async () => {
      const { p } = run(configWith(watch(["02002"], ["야영데크(101)"])));
      await settle();
      expect(mismatches(p)).toHaveLength(0);
      await p.stop();
    });
  });
});
