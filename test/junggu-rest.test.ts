import { describe, expect, it } from "vitest";
import { adapters } from "../src/adapters/index.js";
import { runCatalog } from "../src/commands.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { ENV, configWith, jungguMonthly, jungguPage, jungguServer, jungguSiteList, settle, startPoller } from "./harness.js";
import type { TransportRequest, TransportResponse } from "../src/types.js";

// #79: 중구 나머지 시설(황방산 hwangbang, 태화연 taehwa), 여러 박, 신호 분류, catalog --live.
// 입화산은 research/raw/junggu의 #78 기록(2026-10-12 20시대), 황방산·태화연은 같은 날 20:36~20:40 KST의 #79 기록이다.
// 가짜 시계는 기록 직후인 2026-10-12 20:50 KST다. 그때 세 시설의 월 지도는 모두 10/12~10/31이 선택 가능이다.
const NOW = "2026-10-12T20:50:00+09:00";
const IPHWA = { facility: "iphwa-auto2", cpId: "iphwa_auto2", menuNo: "1010300" };
const HWANGBANG = { facility: "hwangbang", cpId: "hwangbang", menuNo: "1020300" };
const TAEHWA = { facility: "taehwayeon", cpId: "taehwa", menuNo: "1030300" };
const OPEN_TAEHWA = "2026-10-20";
const csId = (n: string) => `CP_SPEC_0000000000${n}`;
const ZONE = {
  iphwaLarge: csId("31"),
  hwangbangAuto: csId("04"),
  hwangbangCaravanSmall: csId("34"),
  hwangbangCaravan: csId("05"),
  taehwaAuto: csId("06"),
  taehwaSmall: csId("07"),
  taehwaMobile: csId("08"),
};

const watch = (facility: string, checkIn: { from: string; to?: string }, zones: string[], nights = 1) => `
  - name: ${facility} ${checkIn.from}
    provider: junggu
    facility: ${facility}
    zones: [${zones.join(", ")}]
    checkIn: { from: ${checkIn.from}, to: ${checkIn.to ?? checkIn.from} }
    nights: ${nights}
    notify: [default]`;

interface RunOpts {
  server?: ReturnType<typeof jungguServer>;
  nights?: number;
  to?: string;
  now?: string;
}
const run = (facility: string, from: string, zones: string[], opts: RunOpts = {}) =>
  startPoller(() => ({ status: 404, body: "" }), {
    yaml: configWith(watch(facility, { from, to: opts.to }, zones, opts.nights)),
    server: opts.server ?? jungguServer(),
    now: opts.now ?? NOW,
  });

type Poller = ReturnType<typeof run>;

const json = (body: unknown): TransportResponse => ({ status: 200, body: JSON.stringify(body) });
const failedKinds = (p: Poller) => p.logs.filter((l) => l.msg === "query failed").map((l) => l.fields?.kind);
const label = (r: TransportRequest) => {
  const u = new URL(r.url);
  if (u.hostname === "campwait.junggu.ulsan.kr") return `nf:${u.searchParams.get("opcode")}:${u.searchParams.get("aid")}`;
  const menuNo = u.searchParams.get("menuNo");
  return `${r.method} ${u.pathname.split("/").pop()}${menuNo ? `?${menuNo}` : ""}`;
};
const bodyOf = (r: TransportRequest) => Object.fromEntries(new URLSearchParams(r.body));
/** 시설 하나의 한 바퀴 흐름(대기열, 예약 화면, 월 지도, 자리 목록)만 본다. 세션당 한 번 받는 netfunnel.js 확인은 뺀다. */
const flow = (p: Poller) => p.allRequests.filter((r) => !r.url.endsWith("/js/netfunnel.js"));

describe("중구 황방산·태화연", () => {
  it("태화연: 열린 자리(ACTIVE/Y/N)를 구역 이름과 자리 이름이 담긴 한 건으로 알리고 RESERVED 자리는 싣지 않는다", async () => {
    const p = run(TAEHWA.facility, "2026-10-20", [ZONE.taehwaAuto]);
    await settle();
    expect(p.sent).toHaveLength(1);
    const text = p.sent[0]!.text;
    expect(text).toContain("태화연 오토캠핑장");
    const rows = jungguSiteList(ZONE.taehwaAuto, "2026-10-20", TAEHWA.cpId).siteList;
    const open = rows.filter((s) => s.ctState === "ACTIVE").map((s) => s.ctName);
    const reserved = rows.filter((s) => s.ctState === "RESERVED").map((s) => s.ctName);
    expect(open.length).toBeGreaterThan(0);
    expect(reserved.length).toBeGreaterThan(0);
    for (const name of open) expect(text).toContain(name);
    for (const name of reserved) expect(text).not.toContain(` ${name}`);
    expect(JSON.stringify(p.sent[0]!.reply_markup)).toContain("https://camping.junggu.ulsan.kr/camping/pageCont.do?menuNo=1030300");
    await p.stop();
  });

  it("태화연: 요청은 main → 시설 예약 화면(1030300) → 월 지도(cpId=taehwa) → 자리 목록(cpId=taehwa)이고 Referer도 그 화면이다", async () => {
    const p = run(TAEHWA.facility, "2026-10-20", [ZONE.taehwaSmall]);
    await settle();
    expect(flow(p).map(label)).toEqual(["nf:5101:main", "GET pageCont.do?1030300", "POST ajaxGetMonthlyMap.do", "POST ajaxGetSiteList.do"]);
    expect(bodyOf(flow(p)[2]!)).toEqual({ searchDate: "2026-10-01", cpId: "taehwa" });
    expect(bodyOf(flow(p)[3]!)).toEqual({ searchDate: "2026-10-20", cpId: "taehwa", csId: ZONE.taehwaSmall, isExclusive: "" });
    expect(flow(p)[3]!.headers.Referer).toBe("https://camping.junggu.ulsan.kr/camping/pageCont.do?menuNo=1030300");
    await p.stop();
  });

  it("황방산: 기록한 응답은 10/20 전 자리가 CLOSED라 알리지 않고 실패로도 치지 않는다", async () => {
    const p = run(HWANGBANG.facility, "2026-10-20", [ZONE.hwangbangAuto, ZONE.hwangbangCaravanSmall, ZONE.hwangbangCaravan]);
    await settle();
    expect(flow(p).map(label)).toEqual([
      "nf:5101:main",
      "GET pageCont.do?1020300",
      "POST ajaxGetMonthlyMap.do",
      "POST ajaxGetSiteList.do",
      "POST ajaxGetSiteList.do",
      "POST ajaxGetSiteList.do",
    ]);
    expect(bodyOf(flow(p)[3]!)).toEqual({ searchDate: "2026-10-20", cpId: "hwangbang", csId: ZONE.hwangbangAuto, isExclusive: "" });
    expect(p.sent).toHaveLength(0);
    expect(failedKinds(p)).toEqual([]);
    await p.stop();
  });

  it("황방산: 열린 값(ACTIVE/Y/N)으로 바꾼 응답은 자리 이름과 황방산 딥링크로 알린다", async () => {
    const server = jungguServer({
      siteList: ({ csId: zone, searchDate, cpId }) => {
        const body = jungguSiteList(zone, searchDate, cpId);
        Object.assign(body.siteList[1]!, { ctState: "ACTIVE", ctIsBookable: "Y", ctIsIng: "N" });
        return json(body);
      },
    });
    const p = run(HWANGBANG.facility, "2026-10-20", [ZONE.hwangbangAuto], { server });
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("황방산 오토야영장");
    expect(p.sent[0]!.text).toContain("오토 102");
    expect(JSON.stringify(p.sent[0]!.reply_markup)).toContain("pageCont.do?menuNo=1020300");
    await p.stop();
  });

  it("시설이 다른 감시 조건 둘은 시설마다 main과 예약 화면을 다시 지나고 월 지도와 자리 목록은 그 시설의 cpId로 간다", async () => {
    const p = startPoller(() => ({ status: 404, body: "" }), {
      yaml: configWith(watch(TAEHWA.facility, { from: "2026-10-20" }, [ZONE.taehwaSmall]) + watch(IPHWA.facility, { from: "2026-10-20" }, [ZONE.iphwaLarge])),
      server: jungguServer(),
      now: NOW,
    });
    await settle();
    expect(flow(p).map(label)).toEqual([
      "nf:5101:main",
      "GET pageCont.do?1030300",
      "POST ajaxGetMonthlyMap.do",
      "POST ajaxGetSiteList.do",
      "nf:5101:main",
      "GET pageCont.do?1010300",
      "POST ajaxGetMonthlyMap.do",
      "POST ajaxGetSiteList.do",
    ]);
    expect(flow(p).filter((r) => r.method === "POST").map((r) => bodyOf(r).cpId)).toEqual(["taehwa", "taehwa", "iphwa_auto2", "iphwa_auto2"]);
    expect(p.sent).toHaveLength(1); // 태화연 소형은 열려 있고 입화산 대형(10/20)도 열려 있어 메시지는 알림 대상당 한 건이다.
    expect(p.sent[0]!.text).toContain("태화연 오토(소형)캠핑장");
    expect(p.sent[0]!.text).toContain("입화산 제2오토A(대형)");
    await p.stop();
  });
});

describe("중구 여러 박", () => {
  // 기록한 입화산 구역 31(대형)은 10/20에 11자리가 모두 열려 있고(ACTIVE/Y/N) 10/17에는 모두 RESERVED다. 두 응답에서 밤마다의 모양을 만든다.
  const OPEN = "2026-10-20";
  const SOLD = "2026-10-17";
  const names = (date: string) => jungguSiteList(ZONE.iphwaLarge, date).siteList.map((s) => s.ctName);
  const siteListForms = (server: ReturnType<typeof jungguServer>) => server.forms.filter((f) => f.path.endsWith("ajaxGetSiteList.do")).map((f) => f.form.searchDate);
  /** 날짜마다 기록한 응답 가운데 하나를 골라 답한다. */
  const byNight = (pick: Record<string, string>) =>
    jungguServer({ siteList: ({ csId: zone, searchDate }) => json(jungguSiteList(zone, pick[searchDate] ?? OPEN)) });
  /** 열린 응답에서 주어진 인덱스의 자리만 열어 두고 나머지는 RESERVED로 바꾼 변형. */
  const openOnly = (indexes: number[]) => {
    const body = jungguSiteList(ZONE.iphwaLarge, OPEN);
    body.siteList.forEach((s, i) => {
      if (!indexes.includes(i)) Object.assign(s, { ctState: "RESERVED", ctIsBookable: "N" });
    });
    return json(body);
  };

  it("2박 조회 단위에서 첫 밤만 열린 자리는 알리지 않는다", async () => {
    const server = byNight({ "2026-10-20": OPEN, "2026-10-21": SOLD });
    const p = run(IPHWA.facility, "2026-10-20", [ZONE.iphwaLarge], { nights: 2, server });
    await settle();
    expect(siteListForms(server)).toEqual(["2026-10-20", "2026-10-21"]); // 밤마다 한 번
    expect(p.sent).toHaveLength(0);
    expect(failedKinds(p)).toEqual([]);
    await p.stop();
  });

  it("같은 ctId가 두 밤 모두 열려 있으면 알린다", async () => {
    const server = byNight({ "2026-10-20": OPEN, "2026-10-21": OPEN });
    const p = run(IPHWA.facility, "2026-10-20", [ZONE.iphwaLarge], { nights: 2, server });
    await settle();
    expect(p.sent).toHaveLength(1);
    for (const name of names(OPEN)) expect(p.sent[0]!.text).toContain(name);
    await p.stop();
  });

  it("밤마다 열린 자리가 다르면 두 밤 모두 열린 자리만 알린다(구역이 아니라 자리 단위로 교집합)", async () => {
    const server = jungguServer({ siteList: ({ searchDate }) => openOnly(searchDate === "2026-10-20" ? [0, 1, 2, 3, 4] : [3, 4, 5, 6, 7, 8]) });
    const p = run(IPHWA.facility, "2026-10-20", [ZONE.iphwaLarge], { nights: 2, server });
    await settle();
    expect(p.sent).toHaveLength(1);
    const all = names(OPEN);
    const text = p.sent[0]!.text;
    for (const n of [all[3]!, all[4]!]) expect(text).toContain(n);
    for (const n of [all[0]!, all[1]!, all[2]!, all[5]!, all[8]!]) expect(text).not.toContain(n);
    await p.stop();
  });

  it("두 밤 어느 쪽에도 같은 자리가 겹치지 않으면 알리지 않는다", async () => {
    const server = jungguServer({ siteList: ({ searchDate }) => openOnly(searchDate === "2026-10-20" ? [0, 1, 2] : [5, 6, 7]) });
    const p = run(IPHWA.facility, "2026-10-20", [ZONE.iphwaLarge], { nights: 2, server });
    await settle();
    expect(p.sent).toHaveLength(0);
    expect(failedKinds(p)).toEqual([]);
    await p.stop();
  });

  it("조회 단위가 겹치는 밤은 같은 (구역, 밤)을 한 번만 조회한다", async () => {
    const server = byNight({});
    const p = run(IPHWA.facility, "2026-10-20", [ZONE.iphwaLarge], { nights: 2, to: "2026-10-21", server });
    await settle();
    // 입실 10/20은 밤 10/20·21, 입실 10/21은 밤 10/21·22이다. 밤 10/21은 한 번이다.
    expect(siteListForms(server)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
    await p.stop();
  });

  it("두 밤 가운데 하나라도 고를 수 없는 날(isAbleDate false)이면 자리 목록을 보내지 않는다", async () => {
    const monthly = () => {
      const body = jungguMonthly();
      body.monthlyMap.calendarList.find((d) => d.date === "2026-10-21")!.isAbleDate = false;
      return json(body);
    };
    const server = jungguServer({ monthly });
    const p = run(IPHWA.facility, "2026-10-20", [ZONE.iphwaLarge], { nights: 2, server });
    await settle();
    expect(siteListForms(server)).toEqual([]);
    expect(p.sent).toHaveLength(0);
    expect(failedKinds(p)).toEqual([]);
    await p.stop();
  });

  it("두 밤 가운데 하나라도 중구민 전용일(isExclusive true)이면 자리 목록을 보내지 않는다", async () => {
    const monthly = () => {
      const body = jungguMonthly();
      body.monthlyMap.calendarList.find((d) => d.date === "2026-10-21")!.isExclusive = true;
      return json(body);
    };
    const server = jungguServer({ monthly });
    const p = run(IPHWA.facility, "2026-10-20", [ZONE.iphwaLarge], { nights: 2, server });
    await settle();
    expect(siteListForms(server)).toEqual([]);
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  describe("달이 바뀌는 숙박", () => {
    // 11월 지도는 기록이 없다. 10월 기록의 칸을 11월 날짜로 바꾼 변형이다(isOtherMonth 칸은 빼고 11/01~11/03만 둔다).
    const november = (able: boolean) => (searchDate: string) => {
      if (searchDate !== "2026-11-01") return undefined;
      const body = jungguMonthly();
      const base = body.monthlyMap.calendarList.find((d) => d.date === "2026-10-20")!;
      body.monthlyMap.calendarList = ["2026-11-01", "2026-11-02", "2026-11-03"].map((date) => ({ ...base, date, isAbleDate: able, isOtherMonth: "N" }));
      return json(body);
    };
    const monthsRequested = (server: ReturnType<typeof jungguServer>) => server.forms.filter((f) => f.path.endsWith("ajaxGetMonthlyMap.do")).map((f) => f.form.searchDate);

    it("두 번째 밤이 다음 달이면 그 달 지도도 받고, 거기서 열려 있으면 밤마다 자리 목록을 읽는다", async () => {
      const server = jungguServer({ monthly: november(true), siteList: ({ csId: zone }) => json(jungguSiteList(zone, OPEN)) });
      const p = run(IPHWA.facility, "2026-10-31", [ZONE.iphwaLarge], { nights: 2, server });
      await settle();
      expect(monthsRequested(server)).toEqual(["2026-10-01", "2026-11-01"]);
      expect(siteListForms(server)).toEqual(["2026-10-31", "2026-11-01"]);
      expect(p.sent).toHaveLength(1);
      await p.stop();
    });

    it("다음 달 밤을 아직 고를 수 없으면 자리 목록을 보내지 않는다", async () => {
      const server = jungguServer({ monthly: november(false) });
      const p = run(IPHWA.facility, "2026-10-31", [ZONE.iphwaLarge], { nights: 2, server });
      await settle();
      expect(monthsRequested(server)).toEqual(["2026-10-01", "2026-11-01"]);
      expect(siteListForms(server)).toEqual([]);
      expect(p.sent).toHaveLength(0);
      expect(failedKinds(p)).toEqual([]);
      await p.stop();
    });
  });

  it("자리 행에 ctId가 없으면 밤을 이을 수 없어 구조 변경(unrecognized)이다", async () => {
    const server = jungguServer({
      siteList: ({ csId: zone, searchDate }) => {
        const body = jungguSiteList(zone, searchDate);
        delete (body.siteList[0] as Partial<(typeof body.siteList)[number]>).ctId;
        return json(body);
      },
    });
    const p = run(IPHWA.facility, "2026-10-20", [ZONE.iphwaLarge], { nights: 2, server });
    await settle();
    expect(failedKinds(p)).toEqual(["unrecognized"]);
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("알림 메시지는 두 밤 모두 열린 자리를 ctName으로 싣는다(ctId가 아니라 사람이 읽는 이름)", async () => {
    // 태화연 소형은 기록한 10/20에 4자리가 모두 열려 있다. 어느 밤이든 그 응답으로 답한다.
    const server = jungguServer({ siteList: ({ csId: zone, cpId }) => json(jungguSiteList(zone, OPEN_TAEHWA, cpId)) });
    const p = run(TAEHWA.facility, "2026-10-20", [ZONE.taehwaSmall], { nights: 2, server });
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("오토(소형) 127");
    expect(p.sent[0]!.text).not.toContain("CP_SITE_");
    await p.stop();
  });
});

describe("중구 신호 분류", () => {
  const IPHWA_PAGE = jungguPage("1010300");
  /** 예약 화면의 구역 선택 목록에서 구역 하나를 뺀 변형. */
  const pageWithout = (zone: string) => {
    const link = new RegExp(`\\s*<li><a href="javascript:" onclick="changeCp\\('${zone}'\\);">[^<]*</a></li>`);
    expect(IPHWA_PAGE).toMatch(link);
    return IPHWA_PAGE.replace(link, "");
  };
  const runIphwa = (opts: RunOpts = {}) => run(IPHWA.facility, "2026-10-20", [ZONE.iphwaLarge], opts);
  /** Node fetch가 인증서 검증 실패에서 던지는 모양: TypeError("fetch failed")의 cause.code. */
  const tlsFailure = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) });
  const alertTexts = (p: Poller) => p.sent.map((m) => m.text);

  describe("감시하는 구역·자리가 사라짐은 unrecognized다", () => {
    it("예약 화면의 구역 선택 목록에서 감시 구역이 사라지면 자리 목록을 보내지 않고 unrecognized, 두 바퀴 연속이면 멈추고 알린다", async () => {
      const server = jungguServer({ page: () => ({ status: 200, body: pageWithout(ZONE.iphwaLarge) }) });
      const p = runIphwa({ server });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      expect(p.allRequests.some((r) => r.url.endsWith("ajaxGetSiteList.do"))).toBe(false);
      expect(p.sent).toHaveLength(0);
      await p.clock.advance(150_000);
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized", "unrecognized"]);
      expect(alertTexts(p)).toHaveLength(1);
      expect(alertTexts(p)[0]).toMatch(/구조가 바뀌/);
      await p.stop();
    });

    it("예약 화면에 구역 선택 목록이 아예 없어도 unrecognized다", async () => {
      const server = jungguServer({ page: () => ({ status: 200, body: "<html><body>점검</body></html>" }) });
      const p = runIphwa({ server });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      await p.stop();
    });

    it("자리 목록이 비어 있으면(구역의 자리가 모두 사라짐) 빈자리 없음이 아니라 unrecognized다", async () => {
      const server = jungguServer({
        siteList: ({ csId: zone, searchDate }) => {
          const body = jungguSiteList(zone, searchDate);
          body.siteList = [];
          return json(body);
        },
      });
      const p = runIphwa({ server });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      expect(p.sent).toHaveLength(0);
      await p.stop();
    });

    it("다른 구역의 자리가 오면(구역이 바뀌거나 사라짐) unrecognized다", async () => {
      const server = jungguServer({ siteList: () => json(jungguSiteList(csId("33"), "2026-10-20")) });
      const p = runIphwa({ server });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      await p.stop();
    });

    it("감시하지 않는 구역이 화면에서 사라지거나 새로 생긴 것은 경고만 남기고 감시는 계속된다", async () => {
      const added = IPHWA_PAGE.replace("</ul>", `<li><a href="javascript:" onclick="changeCp('CP_SPEC_000000000099');">입화산 신규 구역</a></li></ul>`);
      expect(added).not.toBe(IPHWA_PAGE);
      for (const body of [pageWithout(csId("33")), added]) {
        const p = runIphwa({ server: jungguServer({ page: () => ({ status: 200, body }) }) });
        await settle();
        const drift = p.logs.filter((l) => l.msg === "junggu zone drift").map((l) => ({ change: l.fields?.change, zone: l.fields?.zone }));
        expect(drift).toEqual([body === added ? { change: "new", zone: "CP_SPEC_000000000099" } : { change: "gone", zone: csId("33") }]);
        expect(failedKinds(p)).toEqual([]);
        expect(p.sent).toHaveLength(1); // 감시하는 구역(대형)의 열린 자리는 그대로 알린다.
        await p.clock.advance(150_000);
        await settle();
        expect(p.logs.filter((l) => l.msg === "junggu zone drift")).toHaveLength(1); // 같은 차이는 한 번만 남긴다.
        await p.stop();
      }
    });
  });

  describe("TLS 검증 실패", () => {
    const failingHost = (host: string, state: { broken: boolean }) =>
      jungguServer({
        intercept: (req) => {
          if (state.broken && new URL(req.url).hostname === host) throw tlsFailure();
          return undefined;
        },
      });

    it.each(["campwait.junggu.ulsan.kr", "camping.junggu.ulsan.kr"])("%s에서 검증에 실패하면 transient이고 두 바퀴 연속이면 unrecognized, 그다음 바퀴에 멈추고 알린다", async (host) => {
      const p = runIphwa({ server: failingHost(host, { broken: true }) });
      await settle();
      expect(failedKinds(p)).toEqual(["transient"]);
      expect(alertTexts(p)).toHaveLength(0);
      await p.clock.advance(300_000); // 일시 오류 뒤 간격은 두 배다.
      await settle();
      expect(failedKinds(p)).toEqual(["transient", "unrecognized"]);
      expect(alertTexts(p)).toHaveLength(0); // unrecognized도 첫 바퀴는 아직 장애로 치지 않는다(헬스 상태 머신 그대로).
      await p.clock.advance(150_000);
      await settle();
      expect(failedKinds(p)).toEqual(["transient", "unrecognized", "unrecognized"]);
      expect(alertTexts(p)).toHaveLength(1);
      expect(alertTexts(p)[0]).toMatch(/구조가 바뀌/);
      await p.stop();
    });

    it("검증 실패 뒤 성공한 바퀴가 있으면 연속이 끊겨 다음 검증 실패는 다시 transient다", async () => {
      const state = { broken: true };
      const p = runIphwa({ server: failingHost("campwait.junggu.ulsan.kr", state) });
      await settle();
      expect(failedKinds(p)).toEqual(["transient"]);
      state.broken = false;
      await p.clock.advance(300_000);
      await settle();
      expect(failedKinds(p)).toEqual(["transient"]); // 이번 바퀴는 성공
      state.broken = true;
      await p.clock.advance(150_000);
      await settle();
      expect(failedKinds(p)).toEqual(["transient", "transient"]);
      await p.stop();
    });

    it("TLS가 아닌 연결 실패는 두 바퀴 연속이어도 transient다", async () => {
      const server = jungguServer({
        intercept: () => {
          throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
        },
      });
      const p = runIphwa({ server });
      await settle();
      await p.clock.advance(300_000);
      await settle();
      expect(failedKinds(p)).toEqual(["transient", "transient"]);
      await p.stop();
    });
  });

  describe("일시 오류", () => {
    it.each([
      ["예약 화면 HTTP 503", () => jungguServer({ page: () => ({ status: 503, body: "" }) })],
      ["월 지도 HTTP 500", () => jungguServer({ monthly: () => ({ status: 500, body: "" }) })],
      ["자리 목록 HTTP 502", () => jungguServer({ siteList: () => ({ status: 502, body: "" }) })],
      ["대기열 HTTP 503", () => jungguServer({ intercept: (req) => (new URL(req.url).hostname === "campwait.junggu.ulsan.kr" ? { status: 503, body: "" } : undefined) })],
      ["대기열이 키를 주지 않음", () => jungguServer({ queue: () => "5002:200:nwait=0&nnext=0&tps=0.000000&ttl=0" })],
      ["대기열이 예상 밖 코드(500)를 줌", () => jungguServer({ queue: () => "5002:500:msg=error" })],
    ])("%s는 transient이고 알리지 않는다", async (_name, server) => {
      const p = runIphwa({ server: server() });
      await settle();
      expect(failedKinds(p)).toEqual(["transient"]);
      expect(alertTexts(p)).toHaveLength(0);
      await p.stop();
    });

    it("대기열이 계속 줄을 세우면(201) 상한 초과로 포기하고 transient이며 예약 화면은 열지 않는다", async () => {
      const server = jungguServer({ queue: () => "5002:201:key=KEYW&nwait=500&nnext=500&tps=1.0&ttl=60" });
      const p = runIphwa({ server });
      await settle();
      await p.clock.advance(300_000);
      await settle();
      expect(failedKinds(p)[0]).toBe("transient");
      expect(p.allRequests.some((r) => r.url.includes("pageCont.do"))).toBe(false);
      await p.stop();
    });
  });

  describe("차단", () => {
    it.each([
      ["예약 화면 HTTP 429", () => jungguServer({ page: () => ({ status: 429, body: "" }) })],
      ["월 지도 HTTP 403", () => jungguServer({ monthly: () => ({ status: 403, body: "" }) })],
    ])("%s는 blocked로 곧바로 멈추고 알린다", async (_name, server) => {
      const p = runIphwa({ server: server() });
      await settle();
      expect(failedKinds(p)).toEqual(["blocked"]);
      expect(alertTexts(p)).toHaveLength(1);
      expect(alertTexts(p)[0]).toMatch(/차단/);
      await p.stop();
    });
  });

  describe("netfunnel.js 버전 변경", () => {
    it("버전이나 TS_HOST가 달라지면 경고만 남기고 첫 조회가 끝난 뒤 세션당 한 번만 받는다", async () => {
      const p = runIphwa({ server: jungguServer({ script: "/* Version 2.3.0 */\nNetFunnel.TS_HOST = 'nf.example.kr';\n" }) });
      await settle();
      expect(p.logs.some((l) => l.msg === "junggu netfunnel.js version changed" && l.fields?.actual === "2.3.0")).toBe(true);
      expect(p.logs.some((l) => l.msg === "junggu TS_HOST changed" && l.fields?.actual === "nf.example.kr")).toBe(true);
      const scripts = () => p.allRequests.filter((r) => r.url.endsWith("/camping/js/netfunnel.js"));
      expect(scripts()).toHaveLength(1);
      expect(p.allRequests.indexOf(scripts()[0]!)).toBeGreaterThan(p.allRequests.findIndex((r) => r.url.endsWith("ajaxGetSiteList.do")));
      expect(failedKinds(p)).toEqual([]);
      expect(p.sent).toHaveLength(1); // 열린 자리 알림만 있다. 헬스 알림은 없다.
      await p.clock.advance(150_000);
      await settle();
      expect(scripts()).toHaveLength(1);
      await p.stop();
    });

    it("기록한 값과 같으면 경고가 없다", async () => {
      const p = runIphwa();
      await settle();
      expect(p.allRequests.some((r) => r.url.endsWith("/camping/js/netfunnel.js"))).toBe(true);
      expect(p.logs.filter((l) => /changed|drift/.test(l.msg))).toEqual([]);
      await p.stop();
    });

    it("netfunnel.js를 받지 못해도 감시는 그대로다", async () => {
      const server = jungguServer({ intercept: (req) => (req.url.endsWith("/js/netfunnel.js") ? { status: 500, body: "" } : undefined) });
      const p = runIphwa({ server });
      await settle();
      expect(failedKinds(p)).toEqual([]);
      expect(p.sent).toHaveLength(1);
      await p.stop();
    });
  });
});

describe("catalog junggu --live", () => {
  // 가짜 시계는 2026-10-12 20:50 KST라 내일(KST)은 2026-10-13이다. 기록한 자리 목록은 10/20뿐이라 어느 날짜든 그 응답으로 답한다(구역 코드는 요청대로).
  const recorded = ({ csId: zone, cpId }: { csId: string; cpId: string }) => json(jungguSiteList(zone, "2026-10-20", cpId));
  const setup = (server = jungguServer({ siteList: recorded })) => {
    const out: string[] = [];
    const err: string[] = [];
    const requests: TransportRequest[] = [];
    const sleeps: number[] = [];
    const run = (facility?: string) =>
      runCatalog(
        { kind: "catalog", provider: "junggu", ...(facility ? { facility } : {}), live: true },
        {
          adapters,
          transport: async (r) => (requests.push(r), server(r)),
          version: "0.1.0",
          now: () => new Date(NOW),
          sleep: async (ms) => void sleeps.push(ms),
          random: () => 0.5,
          out: (s) => void out.push(s),
          err: (s) => void err.push(s),
        },
      );
    return { run, out: () => out.join(""), err: () => err.join(""), requests, sleeps, server };
  };

  it.each([
    ["iphwa-auto2", "iphwa_auto2", "1010300", 5],
    ["hwangbang", "hwangbang", "1020300", 3],
    ["taehwayeon", "taehwa", "1030300", 3],
  ])("%s: 바퀴와 같은 흐름(main, 예약 화면, 월 지도)으로 내일 날짜의 구역마다 자리 목록을 한 번씩 보내고 카탈로그와 일치하면 차이 없음 0이다", async (facility, cpId, menuNo, zones) => {
    const s = setup();
    expect(await s.run(facility)).toBe(0);
    const flowLabels = s.requests.filter((r) => !r.url.endsWith("/js/netfunnel.js")).map(label);
    expect(flowLabels).toEqual(["nf:5101:main", `GET pageCont.do?${menuNo}`, "POST ajaxGetMonthlyMap.do", ...Array<string>(zones).fill("POST ajaxGetSiteList.do")]);
    const posts = s.requests.filter((r) => r.method === "POST").map(bodyOf);
    expect(posts[0]).toEqual({ searchDate: "2026-10-01", cpId });
    expect(posts.slice(1).map((b) => b.searchDate)).toEqual(Array<string>(zones).fill("2026-10-13"));
    expect(posts.slice(1).every((b) => b.cpId === cpId && b.isExclusive === "")).toBe(true);
    expect(s.out()).toContain("실제 예약처와 비교");
    expect(s.out()).toContain("차이 없음");
    expect(s.out()).not.toMatch(/사라|새로 생긴|다르다|예약처 응답에 구역이 없다/);
    expect(s.err()).toBe("");
  });

  it("구역마다 실제 자리 수를 보인다(자리 목록은 카탈로그에 두지 않았다)", async () => {
    const s = setup();
    expect(await s.run("hwangbang")).toBe(0);
    expect(s.out()).toContain("CP_SPEC_000000000004: 고정 목록이 없다. 실제 18자리");
    expect(s.out()).toContain("CP_SPEC_000000000034: 고정 목록이 없다. 실제 1자리: 차량카라반(소)204");
    expect(s.out()).toContain("CP_SPEC_000000000005: 고정 목록이 없다. 실제 3자리: 카라반 201-카라반 203");
  });

  it("요청은 5초 + 지터 간격으로 한 줄로 나가고 대기열 요청만 간격 큐 밖이다", async () => {
    const s = setup();
    expect(await s.run("hwangbang")).toBe(0);
    // 예약처 요청(예약 화면, 월 지도, 자리 목록 3건, netfunnel.js)은 앞 요청 뒤 6.5초(5초 + 지터 0.5*3초)를 쉰 뒤 나간다. 첫 요청은 쉬지 않고 대기열 요청은 쉬지 않는다.
    expect(s.sleeps).toEqual(Array<number>(5).fill(6_500));
  });

  it("시설 없이 --live를 걸면 요청 없이 쓸 수 있는 시설 코드와 함께 1이다", async () => {
    const s = setup();
    expect(await s.run(undefined)).toBe(1);
    expect(s.err()).toContain("시설을 골라야 한다");
    expect(s.err()).toContain("iphwa-auto2, hwangbang, taehwayeon");
    expect(s.requests).toEqual([]);
  });

  it("예약 화면의 구역 선택 목록에서 구역이 사라지면 그 구역은 조회하지 않고 응답에 없는 구역으로 보고한다(종료 코드는 0)", async () => {
    const page = jungguPage("1020300").replace(/\s*<li><a href="javascript:" onclick="changeCp\('CP_SPEC_000000000034'\);">[^<]*<\/a><\/li>/, "");
    const s = setup(jungguServer({ siteList: recorded, page: () => ({ status: 200, body: page }) }));
    expect(await s.run("hwangbang")).toBe(0);
    expect(s.requests.filter((r) => r.url.endsWith("ajaxGetSiteList.do"))).toHaveLength(2);
    expect(s.out()).toContain("CP_SPEC_000000000034: 예약처 응답에 구역이 없다(황방산 차량카라반(소))");
    expect(s.out()).toContain("차이 있는 구역 1곳: 카탈로그를 갱신해야 한다");
  });

  it("예약 화면에 새 구역이 생기면 그 구역도 조회해 새로 생긴 구역으로 보고한다", async () => {
    const page = jungguPage("1020300").replace("</ul>", `<li><a href="javascript:" onclick="changeCp('CP_SPEC_000000000004');">중복</a></li><li><a href="javascript:" onclick="changeCp('CP_SPEC_000000000009');">황방산 신규</a></li></ul>`);
    const siteList = ({ csId: zone, cpId }: { csId: string; cpId: string }) => {
      if (zone !== "CP_SPEC_000000000009") return json(jungguSiteList(zone, "2026-10-20", cpId));
      const body = jungguSiteList("CP_SPEC_000000000005", "2026-10-20", cpId);
      body.csName = "황방산 신규";
      body.siteList.forEach((x) => (x.csId = "CP_SPEC_000000000009"));
      return json(body);
    };
    const s = setup(jungguServer({ siteList, page: () => ({ status: 200, body: page }) }));
    expect(await s.run("hwangbang")).toBe(0);
    expect(s.out()).toContain("예약처에 새로 생긴 구역 황방산 신규(CP_SPEC_000000000009): 3자리");
  });

  it("카탈로그와 이름이 다른 구역은 사라진 구역과 새 구역으로 보고한다", async () => {
    const s = setup(
      jungguServer({
        siteList: ({ csId: zone, cpId }) => {
          const body = jungguSiteList(zone, "2026-10-20", cpId);
          if (zone === "CP_SPEC_000000000034") body.csName = "황방산 차량카라반(중)";
          return json(body);
        },
      }),
    );
    expect(await s.run("hwangbang")).toBe(0);
    expect(s.out()).toContain("CP_SPEC_000000000034: 예약처 응답에 구역이 없다(황방산 차량카라반(소))");
    expect(s.out()).toContain("예약처에 새로 생긴 구역 황방산 차량카라반(중)(CP_SPEC_000000000034): 1자리");
  });

  it("내일을 고를 수 없으면(isAbleDate false) 자리 목록을 보내지 않고 비교할 날짜가 없다고 알리며 실패로 치지 않는다", async () => {
    const monthly = () => {
      const body = jungguMonthly("hwangbang");
      body.monthlyMap.calendarList.find((d) => d.date === "2026-10-13")!.isAbleDate = false;
      return json(body);
    };
    const s = setup(jungguServer({ siteList: recorded, monthly }));
    expect(await s.run("hwangbang")).toBe(0);
    expect(s.requests.some((r) => r.url.endsWith("ajaxGetSiteList.do"))).toBe(false);
    expect(s.out()).toContain("대조할 날짜가 없다(내일 2026-10-13은 고를 수 없는 날이다)");
  });

  it.each([
    ["자리 목록 HTTP 503", () => jungguServer({ siteList: () => ({ status: 503, body: "" }) }), "transient"],
    ["예약 화면 HTTP 403", () => jungguServer({ page: () => ({ status: 403, body: "" }) }), "blocked"],
    ["NetFunnel 302", () => jungguServer({ queue: () => "5002:302:key=&nwait=0" }), "blocked"],
    ["월 지도에 monthlyMap이 없음", () => jungguServer({ monthly: () => json({ msg: "success" }) }), "unrecognized"],
  ])("조회가 실패하면(%s) 종료 코드 1이고 실패 종류를 알린다", async (_name, server, kind) => {
    const s = setup(server());
    expect(await s.run("taehwayeon")).toBe(1);
    expect(s.out()).toContain(`조회 실패(${kind})`);
  });

  it("TLS 검증 실패도 조회 실패라 1이다(검증을 끄지 않는다)", async () => {
    const tls = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) });
    const s = setup(jungguServer({ intercept: (req) => { if (new URL(req.url).hostname === "campwait.junggu.ulsan.kr") throw tls(); return undefined; } }));
    expect(await s.run("iphwa-auto2")).toBe(1);
    expect(s.out()).toContain("조회 실패(transient)");
    expect(s.requests.map(label)).toEqual(["nf:5101:main"]);
  });
});

describe("junggu 설정과 catalog (시설 셋)", () => {
  const problems = (text: string): string => {
    try {
      loadConfig(text, ENV);
    } catch (e) {
      if (e instanceof ConfigError) return e.message;
      throw e;
    }
    return "";
  };
  const block = (lines: string) =>
    configWith(`
  - name: 중구
    provider: junggu
${lines}
    checkIn: { from: 2026-10-20, to: 2026-10-20 }
    notify: [default]`);

  it("황방산·태화연 시설과 그 구역 코드, 2박 감시 조건을 받는다", () => {
    expect(problems(block(`    facility: hwangbang\n    zones: [${ZONE.hwangbangAuto}, ${ZONE.hwangbangCaravan}]\n    nights: 2`))).toBe("");
    expect(problems(block(`    facility: taehwayeon\n    zones: [${ZONE.taehwaAuto}, ${ZONE.taehwaSmall}, ${ZONE.taehwaMobile}]\n    nights: 2`))).toBe("");
  });

  it("facility를 빠뜨리면 세 시설 코드를 보이며 거부한다", () => {
    expect(problems(block(`    zones: [${ZONE.taehwaAuto}]`))).toMatch(/watches\.0\.facility: 시설을 골라야 한다\. 쓸 수 있는 값: iphwa-auto2, hwangbang, taehwayeon$/);
  });

  it("다른 시설의 구역 코드는 그 시설에서 거부한다", () => {
    expect(problems(block(`    facility: hwangbang\n    zones: [${ZONE.taehwaAuto}]`))).toMatch(
      /watches\.0\.zones: 없는 구역 "CP_SPEC_000000000006"다\. 쓸 수 있는 값: CP_SPEC_000000000004, CP_SPEC_000000000034, CP_SPEC_000000000005/,
    );
  });

  it("3박은 시설의 최대 2박을 보이며 거부한다", () => {
    expect(problems(block(`    facility: taehwayeon\n    zones: [${ZONE.taehwaAuto}]\n    nights: 3`))).toMatch(/watches\.0\.nights: junggu는 최대 2박까지 예약할 수 있다\(설정값 3\)/);
  });

  const catalog = async (facility?: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const requests: TransportRequest[] = [];
    const code = await runCatalog(
      { kind: "catalog", provider: "junggu", ...(facility ? { facility } : {}), live: false },
      {
        adapters,
        transport: async (r) => (requests.push(r), { status: 404, body: "" }),
        version: "0.1.0",
        now: () => new Date(NOW),
        sleep: async () => {},
        random: () => 0.5,
        out: (s) => void out.push(s),
        err: (s) => void err.push(s),
      },
    );
    return { code, out: out.join(""), err: err.join(""), requests };
  };

  it("catalog junggu는 시설 셋과 구역 수를 요청 없이 보인다", async () => {
    const r = await catalog();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^iphwa-auto2\s+입화산 제2오토야영장\s+5곳$/m);
    expect(r.out).toMatch(/^hwangbang\s+황방산 생태야영장\s+3곳$/m);
    expect(r.out).toMatch(/^taehwayeon\s+태화연 야영장\s+3곳$/m);
    expect(r.requests).toEqual([]);
  });

  it("catalog junggu hwangbang은 csId 구역 표를 요청 없이 보인다", async () => {
    const r = await catalog("hwangbang");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^junggu \(최대 2박\)$/m);
    const table = r.out.replace(/ +/g, " ");
    expect(table).toContain("CP_SPEC_000000000004 황방산 오토야영장 오토캠핑 6인");
    expect(table).toContain("CP_SPEC_000000000034 황방산 차량카라반(소) 카라반 4인");
    expect(table).toContain("CP_SPEC_000000000005 황방산 카라반야영장 카라반 6인");
    expect(r.requests).toEqual([]);
  });

  it("catalog junggu taehwayeon은 csId 구역 표를 요청 없이 보인다", async () => {
    const r = await catalog("taehwayeon");
    expect(r.code).toBe(0);
    const table = r.out.replace(/ +/g, " ");
    expect(table).toContain("CP_SPEC_000000000006 태화연 오토캠핑장 오토캠핑 6인");
    expect(table).toContain("CP_SPEC_000000000007 태화연 오토(소형)캠핑장 오토캠핑 6인");
    expect(table).toContain("CP_SPEC_000000000008 태화연 오토(이동식카라반) 오토캠핑 6인");
    expect(r.requests).toEqual([]);
  });
});
