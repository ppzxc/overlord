import { describe, expect, it } from "vitest";
import { configWith, settle, startPoller } from "./harness.js";
import { FOREST_ENV, foresttripServer, type ForestOptions } from "./foresttrip-server.js";

// 여러 박·월별 시설·날짜 범위 판정(Spec #142 / Ticket-4, Decision-9). 가짜 서버는 foresttrip.test.ts와 같은 것을 쓴다.
// 표본에 없는 상태(PRIOR, DRLTS, 대기 가능)와 월별(MON) 시설 응답은 화면 JS 해석과 스파이크 필드 목록으로 만든 합성 응답이다.
const NOW = "2026-10-20T14:00:00+09:00";

const watch = (checkIn: string, nights: number, zone = "02002") => `
  - name: 유명산 감시
    provider: foresttrip
    facility: yumyeongsan
    zones: ["${zone}"]
    checkIn: { from: ${checkIn}, to: ${checkIn} }
    nights: ${nights}
    notify: [default]`;

const run = (checkIn: string, nights: number, server: ForestOptions) => {
  const s = foresttripServer(server);
  const p = startPoller(() => ({ status: 404, body: "" }), { yaml: configWith(watch(checkIn, nights)), server: s, env: FOREST_ENV, now: NOW });
  return { p, server: s };
};

const OPEN = { rsrvtAvail: "Y", rsrvtCnt: 0 };
const FULL = { rsrvtAvail: "Y", rsrvtCnt: 1 };
/** 자리 이름별로 빈 날짜를 정한다. 나머지 칸은 마감이다. */
const opensOn =
  (open: Record<string, string[]>): ForestOptions["status"] =>
  (goods, date) =>
    open[goods.name]?.includes(date) ? OPEN : FULL;

describe("숲나들e 연박", () => {
  it("같은 자리가 입실일부터 N일 연속 비었을 때만 그 자리를 알린다", async () => {
    const { p } = run("2026-10-24", 2, { status: opensOn({ "야영데크(101)": ["2026-10-24", "2026-10-25"], "야영데크(102)": ["2026-10-24"], "야영데크(103)": ["2026-10-25"] }) });
    await settle();
    expect(p.sent).toHaveLength(1);
    const text = p.sent[0]!.text;
    expect(text).toContain("야영데크(101)");
    expect(text).toContain("2박");
    expect(text).not.toContain("야영데크(102)");
    expect(text).not.toContain("야영데크(103)");
    await p.stop();
  });

  it("밤마다 다른 자리가 비어 있으면 알리지 않는다", async () => {
    const { p } = run("2026-10-24", 3, { status: opensOn({ "야영데크(101)": ["2026-10-24"], "야영데크(102)": ["2026-10-25"], "야영데크(103)": ["2026-10-26"] }) });
    await settle();
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });
});

/** 월별(MON) 시설 정책: 예약 가능 마지막 날은 다음 달 말일이다. */
const monthly: ForestOptions["policy"] = (base) => ({ ...base, rsrvtPolcy: { rsrvtCycleTpeCd: "MON", rsrvtBgnTm: "0900", weekLastDay: "", monthLastDay: "20261130" } });
/** 월별 보기(`01`)는 `srchDate`(YYYYMM)의 달만 돌려준다. */
const onlyRequestedMonth: ForestOptions["avail"] = (rows, req) => {
  const month = (JSON.parse(req.body!) as { srchDate: string }).srchDate;
  return { status: 200, body: JSON.stringify({ rsrvtAvailInfoList: rows.filter((r) => String(r.useDt).startsWith(month)) }) };
};

describe("숲나들e 월별 시설", () => {
  it("달별 응답을 이어 붙여 달 경계를 넘는 연박을 판정한다", async () => {
    const { p, server } = run("2026-10-31", 2, {
      policy: monthly,
      avail: onlyRequestedMonth,
      status: opensOn({ "야영데크(101)": ["2026-10-31", "2026-11-01"], "야영데크(102)": ["2026-10-31"], "야영데크(103)": ["2026-11-01"] }),
    });
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("야영데크(101)");
    expect(p.sent[0]!.text).not.toContain("야영데크(102)");
    expect(p.sent[0]!.text).not.toContain("야영데크(103)");
    const views = p.allRequests.filter((r) => r.url.includes("selectRsrvtAvailInfo")).map((r) => JSON.parse(r.body!) as { inqurSctin: string; srchDate: string });
    expect([...new Set(views.map((v) => `${v.inqurSctin}:${v.srchDate}`))]).toEqual(["01:202610", "01:202611"]);
    expect(server.state.logins).toBe(1);
    await p.stop();
  });

  it("달 경계를 넘는 연박에서 한쪽 달만 비면 알리지 않는다", async () => {
    const { p } = run("2026-10-31", 2, { policy: monthly, avail: onlyRequestedMonth, status: opensOn({ "야영데크(101)": ["2026-10-31"] }) });
    await settle();
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });
});

describe("숲나들e 최대 연박", () => {
  it("시설의 최대 연박(응답 mxmmStngDayCnt)을 넘는 조건은 빈자리를 알리지 않고 조건마다 한 번만 사용자에게 알린다", async () => {
    const { p, server } = run("2026-10-24", 4, { status: () => OPEN });
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("최대 연박");
    expect(p.sent[0]!.text).toContain("3박");
    expect(p.sent[0]!.text).not.toContain("야영데크(101)");
    expect(p.logs.filter((l) => l.msg === "query failed")).toEqual([]);
    // 모든 조건이 넘으면 첫 응답을 읽고 더 조회하지 않는다.
    expect(server.state.availCalls).toHaveLength(1);
    await p.clock.advance(600_000);
    await settle();
    expect(p.sent).toHaveLength(1);
    await p.stop();
  });

  it("최대 연박 이하인 조건은 그대로 조회한다", async () => {
    const { p } = run("2026-10-24", 3, { status: opensOn({ "야영데크(101)": ["2026-10-24", "2026-10-25", "2026-10-26"] }) });
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("3박");
    await p.stop();
  });
});

describe("숲나들e 날짜 범위와 상태", () => {
  it("연박이 예약 가능 마지막 날(응답 값)을 넘으면 알리지 않는다", async () => {
    const { p } = run("2026-11-23", 3, { status: () => OPEN });
    await settle();
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("연박 중 하루가 기간 밖(OVER_DATE)이면 알리지 않는다", async () => {
    const { p } = run("2026-10-24", 2, { status: (_g, date) => (date === "2026-10-25" ? { rsrvtAvail: "OVER_DATE", rsrvtCnt: 0 } : OPEN) });
    await settle();
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("지난 날짜 입실은 알리지 않는다", async () => {
    const { p } = run("2026-10-19", 1, { status: () => OPEN });
    await settle();
    // 지난 날짜는 폴러가 조회 단위에 넣지 않고 만료로 알린다. 빈자리 알림은 나가지 않는다.
    expect(p.sent.every((m) => m.text.includes("만료"))).toBe(true);
    expect(p.allRequests.some((r) => r.url.includes("selectRsrvtAvailInfo"))).toBe(false);
    await p.stop();
  });

  it.each([
    ["PRIOR", "foresttrip status not treated as opening"],
    ["DRLTS", "foresttrip status not treated as opening"],
    ["WEEKEND_DRLTS", "foresttrip status not treated as opening"],
    ["NEW_STATE_X", "foresttrip unknown status"],
  ])("연박 중 하루가 %s이면 알리지 않고 로그에 남긴다", async (status, msg) => {
    const { p } = run("2026-10-24", 2, { status: (_g, date) => (date === "2026-10-25" ? { rsrvtAvail: status } : OPEN) });
    await settle();
    expect(p.sent).toHaveLength(0);
    expect(p.logs.some((l) => l.msg === msg && l.fields?.status === status)).toBe(true);
    await p.stop();
  });

  it("대기 가능(예약 건수 1 이상, 대기 가능 Y)·공사·휴무 칸은 알리지 않는다", async () => {
    const { p } = run("2026-10-24", 1, {
      status: (g) => (g.name === "야영데크(101)" ? { rsrvtAvail: "Y", rsrvtCnt: 1 } : g.name === "야영데크(102)" ? { rsrvtAvail: "REPAIR" } : { rsrvtAvail: "PRNSL_DAY" }),
      avail: (rows) => ({ status: 200, body: JSON.stringify({ rsrvtAvailInfoList: rows.map((r) => ({ ...r, wtngPssblYn: "Y", wtngCnt: 0 })) }) }),
    });
    await settle();
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });
});
