import { describe, expect, it } from "vitest";
import type { TransportRequest, TransportResponse } from "../src/types.js";
import { facilities } from "../src/catalogs/foresttrip.js";
import { LIVENESS_GRACE_MS } from "../src/liveness.js";
import { MAX_REQUEST_WAIT_MS } from "../src/http.js";
import { configWith, settle, startPoller } from "./harness.js";
import { FOREST_ENV, foresttripServer } from "./foresttrip-server.js";

// 운영 설정과 같은 모양의 숲나들e 감시 16건은 첫 바퀴가 유예(15분)보다 길다.
// 첫 바퀴는 시설마다 정책 1번 + 구역마다 상품 목록 1번(캐시가 비어 있다) + 잔여 호출이 나가고, 요청 사이에는 5~8초 간격이 있다.
// 그래도 요청이 계속 진행되는 동안은 멈춘 것으로 보면 안 되고, 요청 하나가 유예보다 오래 걸리면 멈춘 것으로 봐야 한다.
const NOW = "2026-11-16T15:00:00+09:00";
const GOODS = "/rep/or/sssn/selectRsrvtGoodsListForMonthRsrvt.do";
const AVAIL = "/rep/or/selectRsrvtAvailInfoListForMonthRsrvt.do";
const pathOf = (r: TransportRequest) => new URL(r.url).pathname;
const bodyOf = (r: TransportRequest) => JSON.parse(r.body ?? "{}") as Record<string, unknown>;
const json = (body: unknown): TransportResponse => ({ status: 200, body: JSON.stringify(body) });

/** 운영 설정의 숲나들e 감시(시설과 구역). 자리 필터는 빼고 센다. 필터가 있으면 호출이 더 적다. */
const WATCHES: { facility: string; zones: string[] }[] = [
  { facility: "hyangrosan", zones: ["01001"] },
  { facility: "songjeong", zones: ["01001"] },
  { facility: "gusugok", zones: ["01001", "01003"] },
  { facility: "daebongkaempingraendeu", zones: ["01001", "01003"] },
  { facility: "daeyasan", zones: ["01001", "01002", "01003", "02006"] },
  { facility: "deokyusan", zones: ["01003"] },
  { facility: "bihaksan", zones: ["01001", "01002", "01010", "02008"] },
  { facility: "jangtaesan", zones: ["01001", "01002", "01003"] },
  { facility: "hadongpyeonbaek", zones: ["01001", "01010"] },
  { facility: "sacheonkeibeulka", zones: ["01001"] },
  { facility: "namhaepyeonbaek", zones: ["01001"] },
  { facility: "wonsando", zones: ["01001"] },
  { facility: "jindo", zones: ["01001"] },
  { facility: "sinsido", zones: ["01001"] },
  { facility: "byeonsan", zones: ["01001"] },
  { facility: "anmyeondo", zones: ["01001"] },
];

const watchYaml = ({ facility, zones }: (typeof WATCHES)[number]) => `
  - name: ${facility} 토요일
    provider: foresttrip
    facility: ${facility}
    zones: [${zones.map((z) => `"${z}"`).join(", ")}]
    checkIn: { from: 2026-11-21, to: 2027-01-31 }
    weekdays: [sat]
    nights: 1
    notify: [default]`;

/** 구역마다 상품 수. 잔여 호출은 한 번에 5개씩 묻는다(가짜 서버도 앞의 5개만 답한다). 잔여는 모두 마감이다. */
const GOODS_PER_ZONE = 9;
const AVAIL_PAGE = 5;
const intercept = (req: TransportRequest): TransportResponse | undefined => {
  if (pathOf(req) === GOODS) {
    const zone = String(bodyOf(req).goodsClsscCd ?? bodyOf(req).upperGoodsClsscCd);
    return json({ rsrvtGoodsList: Array.from({ length: GOODS_PER_ZONE }, (_, i) => ({ goodsId: `${zone}-${i + 1}`, goodsNm: `${zone} ${i + 1}`, goodsClsscCd: zone })), rsrvtPssblDtList: [], hldtInfoList: [] });
  }
  if (pathOf(req) === AVAIL) {
    return json({ rsrvtAvailInfoList: (bodyOf(req).goodsIdList as string[]).slice(0, AVAIL_PAGE).map((goodsId) => ({ goodsId, useDt: "20261121", rsrvtAvail: "Y", rsrvtCnt: 1 })) });
  }
  return undefined;
};

/**
 * 요청 하나가 응답하는 데 걸리는 시간. 가짜 서버는 0이다. 운영 응답 시간은 재 본 적이 없다.
 * 이 시나리오에서 요청당 1초면 첫 바퀴가 14.5분이라 유예에 못 미치고 2초면 16.5분이다. 유예를 넘기는 값으로 2초를 둔다.
 */
const NORMAL_LATENCY_MS = 2_000;
/** 걸린 요청 시나리오: 앞의 요청들은 2분씩(합이 유예를 넘는다) 걸리고 이 번호의 요청이 유예보다 오래 걸린다. */
const SLOW_LATENCY_MS = 2 * 60_000;
const HUNG_REQUEST = 10;

/**
 * 감시 16건의 첫 바퀴를 끝까지 돌린다. `latencyOf(n)`은 n번째 요청이 걸리는 시간이다.
 * 요청이 도는 동안 워치독이 보았을 멈춤(`stalled`)과, 그것을 처음 본 요청 번호(`seenAt`)를 남긴다. 운영 워치독은 60초마다 이것을 보고 멈춤이면 프로세스를 끝낸다.
 */
async function runFirstCycle(latencyOf: (n: number) => number) {
  const insttIds = WATCHES.map(({ facility }) => (facilities.find((x) => x.code === facility)!.ref as { insttId: string }).insttId);
  const ref: { poller?: ReturnType<typeof startPoller> } = {};
  let requests = 0;
  let seen: string[] = [];
  let seenAt: number | undefined;
  const live = () => ref.poller!;
  const server = foresttripServer({
    today: "2026-11-16",
    extraInstts: insttIds,
    intercept: (req) => {
      const { clock, liveness } = live();
      const ms = latencyOf(++requests);
      if (ms <= MAX_REQUEST_WAIT_MS) void clock.sleep(ms); // 가짜 시계가 요청 사이의 짧은 대기를 바로 지난 것으로 치는 범위
      else {
        clock.freezeTimers = true; // 이 요청이 걸려 있는 동안 시각만 흐르고 다른 타이머는 깨우지 않는다.
        void clock.advance(ms);
        clock.freezeTimers = false;
      }
      const stalled = liveness.stalled();
      if (stalled.length > 0 && seen.length === 0) {
        seen = stalled;
        seenAt = requests;
      }
      return intercept(req);
    },
  });
  const poller = (ref.poller = startPoller(() => ({ status: 404, body: "" }), { yaml: configWith(...WATCHES.map(watchYaml)), server, env: FOREST_ENV, now: NOW }));
  const started = poller.clock.now().getTime();
  try {
    let last = -1;
    while (poller.allRequests.length !== last) {
      last = poller.allRequests.length;
      await settle();
    }
    return {
      seen,
      seenAt,
      elapsedMs: poller.clock.now().getTime() - started,
      cycleDone: poller.logs.some((l) => l.msg === "cycle done" && l.fields?.provider === "foresttrip"),
    };
  } finally {
    await poller.stop();
  }
}

describe("숲나들e 첫 바퀴와 살아있음 신호", () => {
  it("첫 바퀴가 유예보다 길어도 요청이 진행되는 동안은 예약처가 멈춘 것으로 보이지 않는다", async () => {
    const run = await runFirstCycle(() => NORMAL_LATENCY_MS);
    expect(run.elapsedMs).toBeGreaterThan(LIVENESS_GRACE_MS); // 이 시나리오가 유예를 넘는 바퀴라는 전제
    expect(run.cycleDone).toBe(true);
    expect(run.seen).toEqual([]); // 운영에서는 이 순간 process.exit(1)이 불린다.
  });

  it("앞선 요청들이 신호를 보냈어도 요청 하나가 유예보다 오래 걸려 있으면 그 요청에서 멈춘 것으로 본다", async () => {
    const run = await runFirstCycle((n) => (n < HUNG_REQUEST ? SLOW_LATENCY_MS : n === HUNG_REQUEST ? LIVENESS_GRACE_MS + 60_000 : 0));
    // 앞의 9번이 합쳐서 유예를 넘었는데도 걸린 요청 전까지는 멈춘 것이 아니다. 요청마다 신호를 보내지 않으면 그 전에 잡힌다.
    expect(run.seen).toEqual(["foresttrip"]);
    expect(run.seenAt).toBe(HUNG_REQUEST);
  });
});
