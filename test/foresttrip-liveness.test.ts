import { describe, expect, it } from "vitest";
import type { TransportRequest, TransportResponse } from "../src/types.js";
import { facilities } from "../src/catalogs/foresttrip.js";
import { configWith, settle, startPoller } from "./harness.js";
import { FOREST_ENV, foresttripServer } from "./foresttrip-server.js";

// 운영 설정과 같은 모양의 숲나들e 감시 16건(시설·구역)은 첫 바퀴가 유예(15분)보다 길다. 그래도 요청이 계속 진행되는 동안은 멈춘 것으로 보면 안 된다.
// 첫 바퀴는 시설마다 정책 1번 + 구역마다 상품 목록 1번(캐시가 비어 있다) + 잔여 호출이 나가고, 요청 사이에는 5~8초 간격이 있다.
const NOW = "2026-11-16T15:00:00+09:00";
const GOODS = "/rep/or/sssn/selectRsrvtGoodsListForMonthRsrvt.do";
const AVAIL = "/rep/or/selectRsrvtAvailInfoListForMonthRsrvt.do";
const pathOf = (r: TransportRequest) => new URL(r.url).pathname;
const bodyOf = (r: TransportRequest) => JSON.parse(r.body ?? "{}") as Record<string, unknown>;
const json = (body: unknown): TransportResponse => ({ status: 200, body: JSON.stringify(body) });

// 운영 설정(자리 필터 없이 센다. 필터가 있으면 호출이 더 적다).
const WATCHES: [facility: string, zones: string[]][] = [
  ["hyangrosan", ["01001"]],
  ["songjeong", ["01001"]],
  ["gusugok", ["01001", "01003"]],
  ["daebongkaempingraendeu", ["01001", "01003"]],
  ["daeyasan", ["01001", "01002", "01003", "02006"]],
  ["deokyusan", ["01003"]],
  ["bihaksan", ["01001", "01002", "01010", "02008"]],
  ["jangtaesan", ["01001", "01002", "01003"]],
  ["hadongpyeonbaek", ["01001", "01010"]],
  ["sacheonkeibeulka", ["01001"]],
  ["namhaepyeonbaek", ["01001"]],
  ["wonsando", ["01001"]],
  ["jindo", ["01001"]],
  ["sinsido", ["01001"]],
  ["byeonsan", ["01001"]],
  ["anmyeondo", ["01001"]],
];

const watch = ([facility, zones]: (typeof WATCHES)[number]) => `
  - name: ${facility} 토요일
    provider: foresttrip
    facility: ${facility}
    zones: [${zones.map((z) => `"${z}"`).join(", ")}]
    checkIn: { from: 2026-11-21, to: 2027-01-31 }
    weekdays: [sat]
    nights: 1
    notify: [default]`;

/** 구역마다 상품 9개. 잔여는 모두 마감이다. */
const intercept = (req: TransportRequest): TransportResponse | undefined => {
  if (pathOf(req) === GOODS) {
    const zone = String(bodyOf(req).goodsClsscCd ?? bodyOf(req).upperGoodsClsscCd);
    return json({ rsrvtGoodsList: Array.from({ length: 9 }, (_, i) => ({ goodsId: `${zone}-${i + 1}`, goodsNm: `${zone} ${i + 1}`, goodsClsscCd: zone })), rsrvtPssblDtList: [], hldtInfoList: [] });
  }
  if (pathOf(req) === AVAIL) {
    return json({ rsrvtAvailInfoList: (bodyOf(req).goodsIdList as string[]).slice(0, 5).map((goodsId) => ({ goodsId, useDt: "20261121", rsrvtAvail: "Y", rsrvtCnt: 1 })) });
  }
  return undefined;
};

/** 요청 하나가 응답하는 데 걸리는 시간(ms). 가짜 서버는 0이고 운영은 재 본 적이 없다. */
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 2000);

describe("숲나들e 첫 바퀴와 살아있음 신호", () => {
  it("첫 바퀴가 유예보다 길어도 요청이 진행되는 동안은 예약처가 멈춘 것으로 보이지 않는다", async () => {
    const insttIds = WATCHES.map(([f]) => (facilities.find((x) => x.code === f)!.ref as { insttId: string }).insttId);
    let spend: (ms: number) => void = () => {};
    let seen: string[] = []; // 요청을 보내는 도중에 워치독이 보았을 멈춤. 운영 워치독은 60초마다 이것을 본다.
    let probe: () => string[] = () => [];
    const server = foresttripServer({
      today: "2026-11-16",
      extraInstts: insttIds,
      intercept: (req) => {
        spend(LATENCY_MS);
        const stalled = probe();
        if (stalled.length > 0 && seen.length === 0) seen = stalled;
        return intercept(req);
      },
    });
    const p = startPoller(() => ({ status: 404, body: "" }), { yaml: configWith(...WATCHES.map(watch)), server, env: FOREST_ENV, now: NOW });
    spend = (ms) => void p.clock.sleep(ms);
    probe = () => p.liveness.stalled();
    const started = p.clock.now().getTime();
    let last = -1;
    while (p.allRequests.length !== last) {
      last = p.allRequests.length;
      await settle();
    }
    const elapsedMin = (p.clock.now().getTime() - started) / 60_000;
    const cycleDone = p.logs.some((l) => l.msg === "cycle done" && l.fields?.provider === "foresttrip");
    console.log(`[loop] 요청 ${p.allRequests.length}번, 가짜 시계 ${elapsedMin.toFixed(1)}분, 바퀴 끝남=${cycleDone}, stalled=${JSON.stringify(p.liveness.stalled())}`);
    expect(seen).toEqual([]); // 운영에서는 이 순간 process.exit(1)이 불린다.
    expect(cycleDone).toBe(true);
    await p.stop();
  });
});
