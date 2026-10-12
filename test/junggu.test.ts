import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adapters } from "../src/adapters/index.js";
import { runCatalog } from "../src/commands.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { createHttpClient } from "../src/http.js";
import { ENV, configWith, jungguMonthly, jungguServer, jungguSiteList, settle, startPoller } from "./harness.js";
import type { TransportRequest, TransportResponse } from "../src/types.js";

// 입화산 제2오토야영장(iphwa-auto2, cpId=iphwa_auto2)의 기록한 응답(2026-10-12 20시대, research/raw/junggu)을 fixture로 쓴다.
// 구역 31(A 대형) 11자리: 10/20 모두 열림(ACTIVE/Y/N), 10/17 모두 RESERVED, 10/14 모두 CLOSED. 구역 32(A 중형)의 10/20은 7자리 열림에 504만 RESERVED다.
// 가짜 시계는 기록한 시각 직후인 2026-10-12 20:30 KST다. 그때 월 지도는 10/12~10/31이 선택 가능이다.
const NOW = "2026-10-12T20:30:00+09:00";
const ZONE_LARGE = "CP_SPEC_000000000031"; // 입화산 제2오토A(대형)
const ZONE_MID = "CP_SPEC_000000000032"; // 입화산 제2오토A(중형)

const watch = (checkIn: { from: string; to?: string }, zones: string[] = [ZONE_LARGE]) => `
  - name: 입화산 ${checkIn.from}
    provider: junggu
    facility: iphwa-auto2
    zones: [${zones.join(", ")}]
    checkIn: { from: ${checkIn.from}, to: ${checkIn.to ?? checkIn.from} }
    nights: 1
    notify: [default]`;

const run = (checkIn: { from: string; to?: string }, opts: { server?: ReturnType<typeof jungguServer>; zones?: string[]; random?: () => number; now?: string } = {}) =>
  startPoller(() => ({ status: 404, body: "" }), {
    yaml: configWith(watch(checkIn, opts.zones)),
    server: opts.server ?? jungguServer(),
    random: opts.random,
    now: opts.now ?? NOW,
  });

type Poller = ReturnType<typeof run>;

const json = (body: unknown): TransportResponse => ({ status: 200, body: JSON.stringify(body) });
const failedKinds = (p: Poller) => p.logs.filter((l) => l.msg === "query failed").map((l) => l.fields?.kind);
const siteListRequests = (p: Poller) => p.allRequests.filter((r) => r.url.endsWith("ajaxGetSiteList.do"));
const label = (r: TransportRequest) => {
  const u = new URL(r.url);
  return u.hostname === "campwait.junggu.ulsan.kr" ? `nf:${u.searchParams.get("opcode")}:${u.searchParams.get("aid")}` : `${r.method} ${u.pathname.split("/").pop()}`;
};

describe("중구 폴러", () => {
  it("열린 자리(ACTIVE/Y/N)는 구역 이름, 자리 이름, 딥링크가 담긴 메시지 한 건으로 알린다", async () => {
    const p = run({ from: "2026-10-20" });
    await settle();
    expect(p.sent).toHaveLength(1);
    const text = p.sent[0]!.text;
    expect(text).toContain("입화산 제2오토A(대형)");
    for (const name of jungguSiteList(ZONE_LARGE, "2026-10-20").siteList.map((s) => s.ctName)) expect(text).toContain(name);
    expect(JSON.stringify(p.sent[0]!.reply_markup)).toContain("https://camping.junggu.ulsan.kr/camping/pageCont.do?menuNo=1010300");
    await p.stop();
  });

  it("CLOSED·RESERVED 자리는 알리지 않는다", async () => {
    for (const date of ["2026-10-14", "2026-10-17"]) {
      const p = run({ from: date });
      await settle();
      expect(siteListRequests(p), date).toHaveLength(1);
      expect(p.sent, date).toHaveLength(0);
      expect(failedKinds(p), date).toEqual([]);
      await p.stop();
    }
    // 같은 날 RESERVED(오토(중형)504)와 열린 자리가 섞여 있으면 열린 자리만 알린다.
    const mixed = run({ from: "2026-10-20" }, { zones: [ZONE_MID] });
    await settle();
    expect(mixed.sent).toHaveLength(1);
    expect(mixed.sent[0]!.text).toContain("오토(중형)503");
    expect(mixed.sent[0]!.text).not.toContain("오토(중형)504");
    await mixed.stop();
  });

  it("같은 빈자리가 연속 두 바퀴 잡혀도 첫 바퀴에만 알린다", async () => {
    const p = run({ from: "2026-10-20" });
    await settle();
    expect(p.sent).toHaveLength(1);
    await p.clock.advance(150_000);
    await settle();
    expect(siteListRequests(p)).toHaveLength(2);
    expect(p.sent).toHaveLength(1);
    await p.stop();
  });

  describe("추첨 접수 중과 예약 진행 중", () => {
    // 열린 값(ACTIVE/Y/N)인 기록한 응답에서 appProcess만 고친다. 화면은 L1이면 "현재 N 건 접수"로 그리고 선착순이 아니다.
    const withAppProcess =
      (appProcess: string) =>
      (form: { searchDate: string; csId: string }): TransportResponse => {
        const body = jungguSiteList(form.csId, form.searchDate);
        body.currentAppVO.appProcess = appProcess;
        body.siteList.forEach((s, i) => (s.lotteryCount = i));
        return json(body);
      };

    it("appProcess에 L1이 있으면 열린 값이어도 알리지 않고 실패로 치지 않는다", async () => {
      const p = run({ from: "2026-10-20" }, { server: jungguServer({ siteList: withAppProcess("C0L1P1") }) });
      await settle();
      expect(siteListRequests(p)).toHaveLength(1);
      expect(p.sent).toHaveLength(0);
      expect(failedKinds(p)).toEqual([]);
      await p.stop();
    });

    it("L1과 L0가 함께 있으면 화면처럼 L1이 이긴다", async () => {
      const p = run({ from: "2026-10-20" }, { server: jungguServer({ siteList: withAppProcess("C0L0L1P1") }) });
      await settle();
      expect(p.sent).toHaveLength(0);
      await p.stop();
    });

    it("L0도 L1도 없는 appProcess는 구조 변경(unrecognized)이다", async () => {
      const p = run({ from: "2026-10-20" }, { server: jungguServer({ siteList: withAppProcess("C0P1") }) });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      expect(p.sent).toHaveLength(0);
      await p.stop();
    });

    it("ctIsIng이 Y(다른 사람이 예약 진행 중)인 자리와 DISABLED 자리는 알리지 않는다", async () => {
      const server = jungguServer({
        siteList: ({ csId, searchDate }) => {
          const body = jungguSiteList(csId, searchDate);
          body.siteList[0]!.ctIsIng = "Y"; // 오토(대형)505
          body.siteList[1]!.ctState = "DISABLED"; // 오토(대형)506
          return json(body);
        },
      });
      const p = run({ from: "2026-10-20" }, { server });
      await settle();
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0]!.text).not.toContain("오토(대형)505");
      expect(p.sent[0]!.text).not.toContain("오토(대형)506");
      expect(p.sent[0]!.text).toContain("오토(대형)507");
      await p.stop();
    });
  });

  describe("선필터(월 지도)", () => {
    type Days = ReturnType<typeof jungguMonthly>["monthlyMap"]["calendarList"];
    const monthly = (edit: (days: Days) => void) => () => {
      const body = jungguMonthly();
      edit(body.monthlyMap.calendarList);
      return json(body);
    };
    const day = (days: Days, date: string) => days.find((d) => d.date === date)!;

    it("isAbleDate가 false인 날짜에는 ajaxGetSiteList.do가 나가지 않는다", async () => {
      const server = jungguServer({ monthly: monthly((days) => (day(days, "2026-10-20").isAbleDate = false)) });
      const p = run({ from: "2026-10-20" }, { server });
      await settle();
      expect(p.allRequests.some((r) => r.url.endsWith("ajaxGetMonthlyMap.do"))).toBe(true);
      expect(siteListRequests(p)).toHaveLength(0);
      expect(p.sent).toHaveLength(0);
      expect(failedKinds(p)).toEqual([]);
      await p.stop();
    });

    it("중구민 전용일(isExclusive: true)에는 ajaxGetSiteList.do가 나가지 않는다", async () => {
      const server = jungguServer({ monthly: monthly((days) => (day(days, "2026-10-20").isExclusive = true)) });
      const p = run({ from: "2026-10-20" }, { server });
      await settle();
      expect(siteListRequests(p)).toHaveLength(0);
      expect(p.sent).toHaveLength(0);
      await p.stop();
    });

    it("고를 수 있는 날만 자리 목록을 읽는다", async () => {
      const server = jungguServer({ monthly: monthly((days) => (day(days, "2026-10-17").isAbleDate = false)) });
      const p = run({ from: "2026-10-17", to: "2026-10-18" }, { server });
      await settle();
      expect(server.forms.filter((f) => f.path.endsWith("ajaxGetSiteList.do")).map((f) => f.form.searchDate)).toEqual(["2026-10-18"]);
      await p.stop();
    });

    it("다른 달 칸(isOtherMonth Y)은 그 달의 날짜로 보지 않는다", async () => {
      // 10월 지도에 11/02 칸이 다른 달 칸으로 끼어 있어도 11월 감시 조건은 11월 지도를 받는다(기록 없음, 404). 10월 지도의 칸으로 자리 조회가 나가지 않는다.
      const server = jungguServer({
        monthly: monthly((days) => days.push({ date: "2026-11-02", isAbleDate: true, isExclusive: false, isOtherMonth: "Y" })),
        siteList: ({ csId }) => json(jungguSiteList(csId, "2026-10-20")), // 기록은 10/20뿐이라 어느 날짜든 그 응답으로 답한다.
      });
      const p = run({ from: "2026-10-31", to: "2026-11-02" }, { server });
      await settle();
      expect(server.forms.filter((f) => f.path.endsWith("ajaxGetMonthlyMap.do")).map((f) => f.form.searchDate)).toEqual(["2026-10-01", "2026-11-01"]);
      expect(server.forms.filter((f) => f.path.endsWith("ajaxGetSiteList.do")).map((f) => f.form.searchDate)).toEqual(["2026-10-31"]);
      await p.stop();
    });

    it("월 지도에 그 날짜가 없으면 구조 변경(unrecognized)이다", async () => {
      const server = jungguServer({ monthly: monthly((days) => void days.splice(days.findIndex((d) => d.date === "2026-10-20"), 1)) });
      const p = run({ from: "2026-10-20" }, { server });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      expect(siteListRequests(p)).toHaveLength(0);
      await p.stop();
    });
  });

  describe("요청 흐름", () => {
    it("순서는 5101(main) → pageCont.do → ajaxGetMonthlyMap.do → ajaxGetSiteList.do이고 5004는 나가지 않는다", async () => {
      const p = run({ from: "2026-10-20" });
      await settle();
      expect(p.allRequests.map(label)).toEqual(["nf:5101:main", "GET pageCont.do", "POST ajaxGetMonthlyMap.do", "POST ajaxGetSiteList.do"]);
      const nf = new URL(p.allRequests[0]!.url);
      expect(`${nf.origin}${nf.pathname}`).toBe("https://campwait.junggu.ulsan.kr/ts.wseq");
      expect(nf.searchParams.get("sid")).toBe("service_1");
      expect(p.allRequests.some((r) => r.url.includes("opcode=5004"))).toBe(false);
      expect(p.allRequests[1]!.url).toBe("https://camping.junggu.ulsan.kr/camping/pageCont.do?menuNo=1010300");
      expect(Object.fromEntries(new URLSearchParams(p.allRequests[2]!.body))).toEqual({ searchDate: "2026-10-01", cpId: "iphwa_auto2" });
      expect(Object.fromEntries(new URLSearchParams(p.allRequests[3]!.body))).toEqual({ searchDate: "2026-10-20", cpId: "iphwa_auto2", csId: ZONE_LARGE, isExclusive: "" });
      await p.stop();
    });

    it("대기열 요청은 간격 큐 밖이고 예약처 요청은 5초 + 지터 간격이다", async () => {
      const p = run({ from: "2026-10-20" }); // random 0.5: 6.5초
      await settle();
      const t = p.requestTimes;
      expect(t[1]! - t[0]!).toBe(0); // 5101과 첫 예약처 요청은 같은 시각
      expect(t[2]! - t[1]!).toBe(6_500);
      expect(t[3]! - t[2]!).toBe(6_500);
      await p.stop();
      const low = run({ from: "2026-10-20" }, { random: () => 0 });
      await settle();
      expect(low.requestTimes[3]! - low.requestTimes[2]!).toBe(5_000);
      await low.stop();
    });

    it("5101 결과를 escape 인코딩한 NetFunnel_ID 쿠키와 세션 쿠키가 예약처 요청에 실리고 대기열 서버에는 쿠키가 가지 않는다", async () => {
      const p = run({ from: "2026-10-20" });
      await settle();
      const cookieOf = (r: TransportRequest) =>
        Object.fromEntries((r.headers.Cookie ?? "").split("; ").filter(Boolean).map((c) => c.split("=", 2) as [string, string]));
      const nfId = "5002%3A200%3Akey%3DKEY1%26nwait%3D0%26nnext%3D0%26tps%3D0.000000%26ttl%3D0%26ip%3Dcampwait.junggu.ulsan.kr%26port%3D443";
      expect(cookieOf(p.allRequests[0]!)).toEqual({});
      expect(cookieOf(p.allRequests[1]!)).toEqual({ NetFunnel_ID: nfId });
      expect(cookieOf(p.allRequests[2]!)).toEqual({ NetFunnel_ID: nfId, JSESSIONID: "sess1" });
      expect(cookieOf(p.allRequests[3]!)).toEqual({ NetFunnel_ID: nfId, JSESSIONID: "sess1" });
      await p.stop();
    });

    it("조회는 화면 JS와 같은 헤더(Referer, Origin, X-Requested-With)를 싣고 모든 요청에 정직한 UA만 붙는다", async () => {
      const p = run({ from: "2026-10-20" });
      await settle();
      for (const r of p.allRequests) expect(r.headers["User-Agent"]).toBe("overlord-availability-poller/0.1.0 (ops)");
      for (const r of p.allRequests.filter((r) => r.method === "POST")) {
        expect(r.headers.Referer).toBe("https://camping.junggu.ulsan.kr/camping/pageCont.do?menuNo=1010300");
        expect(r.headers.Origin).toBe("https://camping.junggu.ulsan.kr");
        expect(r.headers["X-Requested-With"]).toBe("XMLHttpRequest");
        expect(r.headers["Content-Type"]).toBe("application/x-www-form-urlencoded; charset=UTF-8");
      }
      await p.stop();
    });

    it("구역과 밤이 여럿이어도 대기열·예약 화면·월 지도는 바퀴당 한 번이고 자리 목록은 (구역, 밤)마다 한 번이다", async () => {
      const server = jungguServer({ siteList: ({ csId }) => json(jungguSiteList(csId, "2026-10-20")) }); // 기록은 10/20뿐이라 어느 날짜든 그 응답으로 답한다.
      const p = run({ from: "2026-10-20", to: "2026-10-21" }, { zones: [ZONE_LARGE, ZONE_MID], server });
      await settle();
      const labels = p.allRequests.map(label);
      expect(labels.filter((l) => l === "nf:5101:main")).toHaveLength(1);
      expect(labels.filter((l) => l === "GET pageCont.do")).toHaveLength(1);
      expect(labels.filter((l) => l === "POST ajaxGetMonthlyMap.do")).toHaveLength(1);
      expect(labels.filter((l) => l === "POST ajaxGetSiteList.do")).toHaveLength(4);
      await p.stop();
    });

    it("접근 금지 경로로는 요청이 나가지 않는다", async () => {
      const p = run({ from: "2026-10-20" });
      await settle();
      const forbidden = ["/camping/ajaxSelecteSite.do", "/camping/ajaxChangeStayGigan.do", "/camping/iphwa_auto2/insert.do"];
      for (const r of p.allRequests) {
        const u = new URL(r.url);
        expect(forbidden.some((f) => u.pathname.startsWith(f))).toBe(false);
        expect(u.searchParams.get("menuNo")?.startsWith("5") ?? false).toBe(false);
      }
      await p.stop();
    });

    it("자리 선택·숙박기간 변경·예약 제출·로그인·회원가입·마이페이지(취소)는 HTTP 층이 막고 예약 화면과 조회 경로는 막지 않는다", async () => {
      const sent: string[] = [];
      const http = createHttpClient({
        transport: async (r) => (sent.push(r.url), { status: 200, body: "{}" }),
        version: "0.1.0",
        userAgentSuffix: "",
        blockedPaths: adapters.junggu!.describe().blockedPaths,
        cookieSession: false,
      });
      const origin = "https://camping.junggu.ulsan.kr";
      for (const blocked of [
        "/camping/ajaxSelecteSite.do",
        "/camping/ajaxChangeStayGigan.do",
        "/camping/iphwa_auto2/insert.do",
        "/camping/pageCont.do?menuNo=5010000", // 로그인
        "/camping/pageCont.do?menuNo=5020000", // 회원가입
        "/camping/pageCont.do?menuNo=5030000", // 아이디/비밀번호 찾기
        "/camping/pageCont.do?menuNo=5040100", // 마이페이지(예약확인·취소)
        "/camping/PAGECONT.do?menuNo=5010000",
      ]) {
        await expect(http.get(`${origin}${blocked}`), blocked).rejects.toThrow(/접근 금지/);
      }
      expect(sent).toEqual([]);
      await http.get(`${origin}/camping/pageCont.do?menuNo=1010300`);
      await http.post(`${origin}/camping/ajaxGetMonthlyMap.do`, "searchDate=2026-10-01&cpId=iphwa_auto2");
      await http.post(`${origin}/camping/ajaxGetSiteList.do`, "searchDate=2026-10-20");
      expect(sent).toHaveLength(3);
    });

    it("기본 폴링 간격은 150초이고 오픈 경쟁 시간 기본값은 없다", async () => {
      expect(adapters.junggu!.describe().defaultPollIntervalSeconds).toBe(150);
      expect(adapters.junggu!.describe().openingRush).toBeUndefined();
      const p = run({ from: "2026-10-20" });
      await settle();
      const rounds = () => p.allRequests.filter((r) => r.url.includes("/pageCont.do")).length;
      expect(rounds()).toBe(1);
      await p.clock.advance(149_000);
      expect(rounds()).toBe(1);
      await p.clock.advance(8_000);
      await settle();
      expect(rounds()).toBe(2);
      await p.stop();
    });
  });

  describe("신호 분류(기본)", () => {
    it("모르는 ctState는 빈자리 없음이 아니라 unrecognized이고 두 바퀴 연속이면 멈추고 알린다", async () => {
      const server = jungguServer({
        siteList: ({ csId, searchDate }) => {
          const body = jungguSiteList(csId, searchDate);
          body.siteList[0]!.ctState = "MAINTENANCE";
          return json(body);
        },
      });
      const p = run({ from: "2026-10-20" }, { server });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      expect(p.sent).toHaveLength(0); // 첫 바퀴는 아직 알리지 않는다.
      await p.clock.advance(150_000);
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized", "unrecognized"]);
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0]!.text).toMatch(/구조가 바뀌/);
      const before = p.allRequests.length;
      await p.clock.advance(3_600_000);
      await settle();
      expect(p.allRequests).toHaveLength(before); // 멈춘 예약처는 조회하지 않는다.
      await p.stop();
    });

    it.each([
      ["ctIsBookable이 Y/N이 아님", "ctIsBookable", "M"],
      ["ctIsIng이 Y/N이 아님", "ctIsIng", ""],
    ])("%s이면 unrecognized다", async (_name, field, value) => {
      const server = jungguServer({
        siteList: ({ csId, searchDate }) => {
          const body = jungguSiteList(csId, searchDate);
          body.siteList[2]![field] = value;
          return json(body);
        },
      });
      const p = run({ from: "2026-10-20" }, { server });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      expect(p.sent).toHaveLength(0);
      await p.stop();
    });

    it("자리 응답에 siteList가 없으면 unrecognized다", async () => {
      const siteList = ({ csId, searchDate }: { csId: string; searchDate: string }) => {
        const body: Partial<ReturnType<typeof jungguSiteList>> = jungguSiteList(csId, searchDate);
        delete body.siteList;
        return json(body);
      };
      const p = run({ from: "2026-10-20" }, { server: jungguServer({ siteList }) });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      await p.stop();
    });

    it("자리 응답이 JSON이 아니면 unrecognized다", async () => {
      const p = run({ from: "2026-10-20" }, { server: jungguServer({ siteList: () => ({ status: 200, body: "<html>점검 중</html>" }) }) });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      await p.stop();
    });

    it("사이트 레이아웃이 붙은 HTML(공통 머리말의 로그인 링크 포함)이 JSON 자리에 오면 blocked가 아니라 unrecognized다", async () => {
      const page = readFileSync(new URL("../research/raw/junggu/pageCont.do_menuNo-1010300.html", import.meta.url), "utf8");
      expect(page).toContain("menuNo=5010000"); // 기록한 화면의 머리말에 로그인 링크가 있다.
      const p = run({ from: "2026-10-20" }, { server: jungguServer({ siteList: () => ({ status: 200, body: page }) }) });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      await p.stop();
    });

    it.each(["ajaxGetMonthlyMap.do", "ajaxGetSiteList.do"])('%s 응답이 {"msg":"login"}이면 blocked로 멈춘다', async (name) => {
      const login = () => json({ msg: "login" });
      const server = name === "ajaxGetMonthlyMap.do" ? jungguServer({ monthly: login }) : jungguServer({ siteList: login });
      const p = run({ from: "2026-10-20" }, { server });
      await settle();
      expect(failedKinds(p)).toEqual(["blocked"]);
      expect(p.sent[0]!.text).toMatch(/차단/);
      await p.stop();
    });

    it("월 지도에 monthlyMap이 없으면 unrecognized이고 자리 목록은 나가지 않는다", async () => {
      const p = run({ from: "2026-10-20" }, { server: jungguServer({ monthly: () => json({ msg: "success" }) }) });
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      expect(siteListRequests(p)).toHaveLength(0);
      await p.stop();
    });

    it.each([
      ["NetFunnel 301", "5002:301:key=&nwait=0"],
      ["NetFunnel 302", "5002:302:key=&nwait=0"],
    ])("%s는 곧바로 차단 알림이고 예약 화면은 나가지 않는다", async (_name, line) => {
      const p = run({ from: "2026-10-20" }, { server: jungguServer({ queue: () => line }) });
      await settle();
      expect(failedKinds(p)).toEqual(["blocked"]);
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0]!.text).toMatch(/차단/);
      expect(p.allRequests.map((r) => new URL(r.url).hostname)).toEqual(["campwait.junggu.ulsan.kr"]);
      await p.stop();
    });

    it("예약 화면이 로그인으로 리다이렉트되면 로그인 경로로 요청을 보내지 않고 blocked로 멈춘다", async () => {
      const server = jungguServer({ page: () => ({ status: 302, body: "", location: "/camping/pageCont.do?menuNo=5010000" }) });
      const p = run({ from: "2026-10-20" }, { server });
      await settle();
      expect(p.allRequests.some((r) => r.url.includes("menuNo=5010000"))).toBe(false);
      expect(failedKinds(p)).toEqual(["blocked"]);
      expect(p.sent[0]!.text).toMatch(/차단/);
      await p.stop();
    });

    it.each([
      ["HTTP 403", 403, "blocked"],
      ["HTTP 429", 429, "blocked"],
      ["HTTP 503", 503, "transient"],
    ])("자리 목록이 %s이면 %s다", async (_name, status, kind) => {
      const p = run({ from: "2026-10-20" }, { server: jungguServer({ siteList: () => ({ status, body: "" }) }) });
      await settle();
      expect(failedKinds(p)).toEqual([kind]);
      await p.stop();
    });

    it("연결 실패는 transient이고 알리지 않는다", async () => {
      const server = jungguServer({
        intercept: () => {
          throw new Error("connect ECONNREFUSED");
        },
      });
      const p = run({ from: "2026-10-20" }, { server });
      await settle();
      expect(failedKinds(p)).toEqual(["transient"]);
      expect(p.sent).toHaveLength(0);
      await p.stop();
    });
  });
});

describe("junggu 설정", () => {
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
  - name: 입화산
    provider: junggu
${lines}
    checkIn: { from: 2026-10-20, to: 2026-10-20 }
    notify: [default]`);

  it("provider: junggu, facility: iphwa-auto2, csId 구역, 1박 감시 조건을 받는다", () => {
    expect(problems(block(`    facility: iphwa-auto2\n    zones: [${ZONE_LARGE}, ${ZONE_MID}]\n    nights: 1`))).toBe("");
  });

  it("facility 없는 감시 조건은 위치와 쓸 수 있는 시설 코드와 함께 거부된다", () => {
    expect(problems(block(`    zones: [${ZONE_LARGE}]`))).toMatch(/\d+번째 줄 watches\.0\.facility: 시설을 골라야 한다\. 쓸 수 있는 값: iphwa-auto2$/);
  });

  it("없는 구역은 위치와 쓸 수 있는 구역 코드와 함께 거부된다", () => {
    expect(problems(block("    facility: iphwa-auto2\n    zones: [CP_SPEC_000000000099]"))).toMatch(
      /\d+번째 줄 watches\.0\.zones: 없는 구역 "CP_SPEC_000000000099"다\. 쓸 수 있는 값: CP_SPEC_000000000031, CP_SPEC_000000000033, CP_SPEC_000000000032, CP_SPEC_000000000036, CP_SPEC_000000000035/,
    );
  });

  it("2박은 최대 박수와 함께 위치를 짚어 거부한다", () => {
    expect(problems(block(`    facility: iphwa-auto2\n    zones: [${ZONE_LARGE}]\n    nights: 2`))).toMatch(
      /\d+번째 줄 watches\.0\.nights: junggu는 최대 1박까지 예약할 수 있다\(설정값 2\)/,
    );
  });
});

describe("catalog junggu", () => {
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
        now: () => new Date("2026-10-12T11:30:00Z"),
        sleep: async () => {},
        random: () => 0.5,
        out: (s) => void out.push(s),
        err: (s) => void err.push(s),
      },
    );
    return { code, out: out.join(""), err: err.join(""), requests };
  };

  it("시설을 안 고르면 시설 목록을 보이고 요청은 보내지 않는다", async () => {
    const r = await catalog();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^iphwa-auto2\s+입화산 제2오토야영장\s+5곳$/m);
    expect(r.requests).toEqual([]);
  });

  it("입화산 제2오토는 최대 1박과 csId 구역 다섯 곳을 보인다", async () => {
    const r = await catalog("iphwa-auto2");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^junggu \(최대 1박\)$/m);
    for (const z of [
      "CP_SPEC_000000000031 입화산 제2오토A(대형)",
      "CP_SPEC_000000000033 입화산 제2오토A(소형)",
      "CP_SPEC_000000000032 입화산 제2오토A(중형)",
      "CP_SPEC_000000000036 입화산 제2오토B(소형)",
      "CP_SPEC_000000000035 입화산 제2오토B(중형)",
    ]) {
      expect(r.out.replace(/ +/g, " ")).toContain(z);
    }
    expect(r.requests).toEqual([]);
  });

  it("없는 시설은 쓸 수 있는 값을 보이며 거부한다", async () => {
    const r = await catalog("nope");
    expect(r.code).toBe(1);
    expect(r.err).toContain("iphwa-auto2");
  });
});
