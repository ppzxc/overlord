import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { ENV, configWith, fixture, knpsServer, settle, startPoller } from "./harness.js";
import type { TransportRequest } from "../src/types.js";

// 갓바위(B252001)의 기록한 응답 축소본: 자리 A01·A04·A08 x 입실일 10/13~10/22.
// A01은 10/15·10/21·10/22가 예약가능(_N), A04는 10/13~10/15·10/20·10/21이 _N이고 10/22는 대기가능(_W), A08은 전부 예약불가(_R)다.
// A01의 10/13은 예약만료(_C)다.
const ZONE = "0200901"; // 일반(대형)야영지의 prod-ctg-id

const watch = (checkIn: string, extra = "", nights = 1) => `
  - name: 갓바위 가을
    provider: knps
    facility: gatbawi
    zones: ["${ZONE}"]
    checkIn: { from: ${checkIn}, to: ${checkIn} }
    nights: ${nights}
    notify: [default]${extra}`;

const run = (checkIn: string, opts: { server?: ReturnType<typeof knpsServer>; extra?: string; random?: () => number; nights?: number } = {}) =>
  startPoller(() => ({ status: 404, body: "" }), { yaml: configWith(watch(checkIn, opts.extra, opts.nights)), server: opts.server ?? knpsServer(), random: opts.random });

describe("국립공원 폴러", () => {
  it("예약가능(_N) 자리는 구역 이름·자리·딥링크가 담긴 메시지 한 건으로 알린다", async () => {
    const p = run("2026-10-15");
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("일반(대형)야영지");
    expect(p.sent[0]!.text).toContain("A01");
    expect(p.sent[0]!.text).toContain("A04");
    expect(p.sent[0]!.text).not.toContain("A08");
    expect(JSON.stringify(p.sent[0]!.reply_markup)).toContain("https://reservation.knps.or.kr/reservation/searchSimpleCampReservation.do");
    await p.stop();
  });

  it("_W·_C·_R는 알리지 않는다", async () => {
    // 10/22: A01 _N, A04 _W. 10/13: A01 _C, A04 _N, A08 _R. 10/16: 세 자리 모두 _C 또는 _R.
    const w = run("2026-10-22");
    await settle();
    expect(w.sent[0]!.text).toContain("A01");
    expect(w.sent[0]!.text).not.toContain("A04");
    await w.stop();
    const c = run("2026-10-13");
    await settle();
    expect(c.sent[0]!.text).toContain("A04");
    expect(c.sent[0]!.text).not.toMatch(/A01|A08/);
    await c.stop();
    const none = run("2026-10-16");
    await settle();
    expect(none.sent).toHaveLength(0);
    await none.stop();
  });

  it("응답 범위 밖 입실일은 실패가 아니라 빈자리 없음이다", async () => {
    const p = run("2027-01-15");
    await settle();
    expect(p.sent).toHaveLength(0);
    expect(p.logs.some((l) => l.msg === "query failed")).toBe(false);
    await p.stop();
  });

  it("같은 빈자리가 연속 두 바퀴 잡혀도 첫 바퀴에만 알린다", async () => {
    const p = run("2026-10-15");
    await settle();
    expect(p.sent).toHaveLength(1);
    await p.clock.advance(300_000);
    await settle();
    expect(p.allRequests.filter((r) => r.url.endsWith("searchSimpleCampReservation.do"))).toHaveLength(2);
    expect(p.sent).toHaveLength(1);
    await p.stop();
  });

  it("요청 순서는 화면 → 5101(landingCamp) → 5101(reservation2) → campsiteList.do → 5004이고 대기열 요청은 5초 간격을 따르지 않는다", async () => {
    const p = run("2026-10-15");
    await settle();
    const isLottery = (r: TransportRequest) => r.url.endsWith("selectCampLottery.do");
    const label = (r: TransportRequest) => {
      const u = new URL(r.url);
      return u.hostname === "netfunnel.knps.or.kr" ? `nf:${u.searchParams.get("opcode")}:${u.searchParams.get("aid")}` : `${r.method} ${u.pathname.split("/").pop()}`;
    };
    const reqs = p.allRequests.filter((r) => !isLottery(r)); // 추첨 화면 읽기는 추첨 기간 묶음에서 본다.
    expect(reqs.slice(0, 5).map(label)).toEqual([
      "GET searchSimpleCampReservation.do",
      "nf:5101:landingCamp",
      "nf:5101:reservation2",
      "POST campsiteList.do",
      "nf:5004:reservation2",
    ]);
    const t = p.requestTimes.filter((_, i) => !isLottery(p.allRequests[i]!));
    expect(t[1]! - t[0]!).toBe(0); // 대기열은 큐 밖이라 앞 요청과 같은 시각에 나간다.
    expect(t[2]! - t[1]!).toBe(0);
    expect(t[3]! - t[0]!).toBe(6_500); // reservation.knps.or.kr 요청은 5초 + 지터 간격이다.
    expect(t[4]! - t[3]!).toBe(0);
    const form = Object.fromEntries(new URLSearchParams(reqs[3]!.body));
    expect(form).toEqual({ dept_id: "B252001", dept_name: "갓바위", parent_dept_name: "팔공산", prd_ctg_id: "", isGreenpoint: "N" });
    await p.stop();
  });

  it("reservation2 5101 결과를 escape 인코딩한 NetFunnel_ID 쿠키로 campsiteList.do에 싣는다", async () => {
    const p = run("2026-10-15");
    await settle();
    const list = p.allRequests.find((r) => r.url.endsWith("campsiteList.do"))!;
    const cookies = Object.fromEntries(list.headers.Cookie!.split("; ").map((c) => c.split("=", 2) as [string, string]));
    // KEY2는 reservation2 5101이 준 키다(KEY1은 landingCamp). 결과 문자열 전체를 escape한다: ':'은 %3A, '='은 %3D, '&'는 %26.
    expect(cookies.NetFunnel_ID).toBe("5002%3A200%3Akey%3DKEY2%26nwait%3D0%26nnext%3D0%26tps%3D0.000000%26ttl%3D0%26ip%3Dnetfunnel.knps.or.kr%26port%3D443");
    expect(cookies.JSESSIONID).toBe("sess1");
    // 대기열 서버에는 쿠키를 보내지 않는다.
    for (const r of p.allRequests.filter((r) => new URL(r.url).hostname === "netfunnel.knps.or.kr")) expect(r.headers.Cookie).toBeUndefined();
    await p.stop();
  });

  it("모든 요청에 정직한 UA만 붙고 접근 금지 경로로는 요청이 나가지 않는다", async () => {
    const p = run("2026-10-15");
    await settle();
    for (const r of p.allRequests) expect(r.headers["User-Agent"]).toBe("overlord-availability-poller/0.1.0 (ops)");
    const forbidden = ["/reservation/auth.do", "/reservation/registerCampReservation.do", "/reserCaptcha.do", "/member/", "/mmb/", "/mypage/", "/pay/", "/srchrefund/"];
    for (const r of p.allRequests) expect(forbidden.some((f) => new URL(r.url).pathname.startsWith(f))).toBe(false);
    await p.stop();
  });

  it("기본 폴링 간격은 300초다", async () => {
    const p = run("2026-10-15");
    await settle();
    const rounds = () => p.allRequests.filter((r) => r.url.endsWith("searchSimpleCampReservation.do")).length;
    expect(rounds()).toBe(1);
    await p.clock.advance(299_000);
    expect(rounds()).toBe(1);
    await p.clock.advance(8_000);
    await settle();
    expect(rounds()).toBe(2);
    await p.stop();
  });

  it("NetFunnel 301은 차단으로 멈추고 알리며 campsiteList.do는 보내지 않는다", async () => {
    const p = run("2026-10-15", { server: knpsServer({ queue: () => "5002:301:key=&nwait=0" }) });
    await settle();
    expect(p.sent.some((m) => /blocked|차단/.test(m.text))).toBe(true);
    expect(p.allRequests.some((r) => r.url.endsWith("campsiteList.do"))).toBe(false);
    await p.stop();
  });
});

describe("국립공원 신호 분류", () => {
  const listOf = () => fixture("knps-gatbawi-campsiteList.htm");
  const failedKinds = (p: ReturnType<typeof run>) => p.logs.filter((l) => l.msg === "query failed").map((l) => l.fields?.kind);
  const pageRounds = (p: ReturnType<typeof run>) => p.allRequests.filter((r) => r.url.endsWith("searchSimpleCampReservation.do")).length;
  const stopped = (p: ReturnType<typeof run>) => p.sent.some((m) => /구조가 바뀌/.test(m.text));

  it("NetFunnel 302도 곧바로 차단 알림이고 가상 대기에 참여하지 않으며 campsiteList.do는 나가지 않는다", async () => {
    const p = run("2026-10-15", { server: knpsServer({ queue: (aid) => (aid === "reservation2" ? "5002:302:key=&nwait=0" : undefined) }) });
    await settle();
    expect(p.sent.some((m) => /차단/.test(m.text))).toBe(true);
    expect(p.allRequests.filter((r) => r.url.includes("opcode=5002"))).toHaveLength(0);
    expect(p.allRequests.some((r) => r.url.endsWith("campsiteList.do"))).toBe(false);
    await p.stop();
  });

  it("로그인 화면이 오면 차단 알림이고 그 뒤로 예약처에 요청이 더 나가지 않는다", async () => {
    const p = run("2026-10-15", { server: knpsServer({ list: () => "<html><body><h1>로그인</h1><form action='/reservation/auth.do'></form></body></html>" }) });
    await settle();
    expect(p.sent.some((m) => /차단/.test(m.text))).toBe(true);
    const before = p.allRequests.length;
    await p.clock.advance(3_600_000);
    await settle();
    expect(p.allRequests).toHaveLength(before);
    await p.stop();
  });

  it("칸이 하나도 없으면 첫 바퀴는 알림 없이 넘기고 두 바퀴 연속이면 unrecognized로 멈춘다", async () => {
    const p = run("2026-10-15", { server: knpsServer({ list: () => listOf().replace(/<i title="[^"]*"\s+class="[^"]*"/g, "<i") }) });
    await settle();
    expect(failedKinds(p)).toEqual(["unrecognized"]);
    expect(stopped(p)).toBe(false);
    await p.clock.advance(400_000);
    await settle();
    expect(failedKinds(p)).toEqual(["unrecognized", "unrecognized"]);
    expect(stopped(p)).toBe(true);
    const before = pageRounds(p);
    await p.clock.advance(3_600_000);
    await settle();
    expect(pageRounds(p)).toBe(before);
    await p.stop();
  });

  it("모르는 상태 접미(_X)는 빈자리 없음이 아니라 unrecognized로 두 바퀴 연속이면 멈춘다", async () => {
    const p = run("2026-10-15", { server: knpsServer({ list: () => listOf().replace(/ 20261015_N/g, " 20261015_X") }) });
    await settle();
    expect(failedKinds(p)).toEqual(["unrecognized"]);
    expect(p.sent).toHaveLength(0);
    await p.clock.advance(400_000);
    await settle();
    expect(stopped(p)).toBe(true);
    await p.stop();
  });

  it("감시 조건이 쓰는 구역이 응답에서 사라지면 두 바퀴 연속일 때 unrecognized로 멈춘다", async () => {
    const p = run("2026-10-15", { server: knpsServer({ list: () => listOf().replace("일반(대형)야영지", "다른야영지") }) });
    await settle();
    expect(failedKinds(p)).toEqual(["unrecognized"]);
    await p.clock.advance(400_000);
    await settle();
    expect(stopped(p)).toBe(true);
    await p.stop();
  });

  it("HTTP 5xx는 transient이고 다음 바퀴까지의 간격이 늘어난다", async () => {
    const p = run("2026-10-15", { server: knpsServer({ listStatus: 503 }), random: () => 0.5 });
    await settle();
    expect(failedKinds(p)).toEqual(["transient"]);
    await p.clock.advance(350_000); // 기본 간격이면 이미 다음 바퀴가 시작했을 시간이다.
    await settle();
    expect(pageRounds(p)).toBe(1);
    await p.stop();
  });

  it("대기 상한(120초)을 넘기면 transient이고 간격이 늘어난다", async () => {
    const p = run("2026-10-15", {
      server: knpsServer({ queue: (aid) => (aid === "reservation2" ? "5002:201:key=KEYW&nwait=5&nnext=1&tps=1&ttl=130&ip=x&port=443" : undefined) }),
      random: () => 0.5,
    });
    await settle();
    expect(failedKinds(p)).toEqual(["transient"]);
    await p.clock.advance(350_000);
    await settle();
    expect(pageRounds(p)).toBe(1);
    await p.stop();
  });

  it("쓰지 않는 새 구역은 경고만 남기고 알림도 실패도 없다", async () => {
    const extra = (html: string) => {
      let n = 0;
      return html.replace(/<\/tbody>/g, () =>
        ++n === 1
          ? '<tr><th rowspan="1" scope="row"><span class="title">신규구역</span></th><th scope="row"><span class="title">Z01</span></th></tr></tbody>'
          : '<tr><td><i title="Z01 : 2026-10-15" class="icon-x 20261015_R"></i></td></tr></tbody>',
      );
    };
    const p = run("2026-10-15", { server: knpsServer({ list: () => extra(listOf()) }) });
    await settle();
    expect(p.logs.some((l) => l.msg === "knps zone drift" && l.fields?.zone === "신규구역")).toBe(true);
    expect(failedKinds(p)).toEqual([]);
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).not.toMatch(/차단|구조가 바뀌/);
    await p.stop();
  });

  it("netfunnel.js 버전이나 TS_HOST가 달라지면 경고만 남기고 첫 조회가 끝난 뒤 세션당 한 번만 받는다", async () => {
    const p = run("2026-10-15", { server: knpsServer({ script: "/* Version 2.3.0 */\nNetFunnel.TS_HOST = 'nf.example.kr';\n" }) });
    await settle();
    expect(p.logs.some((l) => l.msg === "knps netfunnel.js version changed" && l.fields?.actual === "2.3.0")).toBe(true);
    expect(p.logs.some((l) => l.msg === "knps TS_HOST changed" && l.fields?.actual === "nf.example.kr")).toBe(true);
    const scripts = () => p.allRequests.filter((r) => r.url.endsWith("/assets/js/lib/netfunnel.js"));
    expect(scripts()).toHaveLength(1);
    expect(p.allRequests.indexOf(scripts()[0]!)).toBeGreaterThan(p.allRequests.findIndex((r) => r.url.endsWith("campsiteList.do")));
    expect(p.sent).toHaveLength(1);
    await p.clock.advance(300_000);
    await settle();
    expect(scripts()).toHaveLength(1);
    await p.stop();
  });

  it("netfunnel.js가 기록한 값과 같으면 경고가 없다", async () => {
    const p = run("2026-10-15");
    await settle();
    expect(p.allRequests.some((r) => r.url.endsWith("/assets/js/lib/netfunnel.js"))).toBe(true);
    expect(p.logs.filter((l) => /changed|drift/.test(l.msg))).toEqual([]);
    await p.stop();
  });
});

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const lotteryReqs = (p: ReturnType<typeof run>) => p.allRequests.filter((r) => r.url.endsWith("selectCampLottery.do"));
const listReqs = (p: ReturnType<typeof run>) => p.allRequests.filter((r) => r.url.endsWith("campsiteList.do"));

describe("국립공원 오픈 경쟁 시간", () => {
  it("10:00 KST 바퀴는 10:30으로 미뤄지고 그동안 요청·헬스 알림이 없으며 정체로 보지 않는다", async () => {
    const p = run("2026-10-15");
    await settle();
    await p.clock.advance(55 * MIN); // 09:55. 시작은 09:00이다.
    const before = p.allRequests.length;
    await p.clock.advance(5 * MIN); // 10:00
    await p.clock.advance(29 * MIN); // 10:29
    expect(p.allRequests.length).toBe(before);
    expect(p.liveness.stalled()).toEqual([]);
    expect(p.sent.filter((m) => /상태|점검|중단|일시|blocked|차단/.test(m.text))).toEqual([]);
    await p.clock.advance(1 * MIN); // 10:30
    expect(p.allRequests.length).toBeGreaterThan(before);
    await p.stop();
  });

  it("설정의 openingRush가 기본값을 덮어쓴다", async () => {
    const custom = configWith(watch("2026-10-15")).replace("providers:", 'providers:\n  knps: { openingRush: { from: "09:00", to: "09:20" } }');
    const p = startPoller(() => ({ status: 404, body: "" }), { yaml: custom, server: knpsServer() });
    await settle();
    expect(p.allRequests).toHaveLength(0); // 시작 시각 09:00이 구간 안이다
    await p.clock.advance(19 * MIN);
    expect(p.allRequests).toHaveLength(0);
    await p.clock.advance(1 * MIN);
    expect(listReqs(p).length).toBeGreaterThan(0);
    await p.stop();
  });
});

describe("국립공원 2박", () => {
  it("첫 밤만 _N이고 다음날이 _C 또는 _W인 자리는 2박 빈자리가 아니다", async () => {
    // 10/15: A01 _N→10/16 _C, A04 _N→10/16 비예약가능. 1박이면 알리지만 2박이면 알리지 않는다.
    const p = run("2026-10-15", { nights: 2 });
    await settle();
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("두 밤 모두 _N인 자리만 알린다", async () => {
    // 10/21: A01 _N→10/22 _N, A04 _N→10/22 _W.
    const p = run("2026-10-21", { nights: 2 });
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("A01");
    expect(p.sent[0]!.text).not.toContain("A04");
    await p.stop();
  });

  it("다음날이 응답 범위 밖이면 2박 빈자리가 아니다", async () => {
    const p = run("2026-12-31", { nights: 2 });
    await settle();
    expect(p.sent).toHaveLength(0);
    expect(p.logs.some((l) => l.msg === "query failed")).toBe(false);
    await p.stop();
  });
});

describe("국립공원 자리 필터", () => {
  it("seats 필터에 맞는 자리만 알린다", async () => {
    const p = run("2026-10-15", { extra: "\n    seats: [A04]" });
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("A04");
    expect(p.sent[0]!.text).not.toContain("A01");
    await p.stop();
  });
});

describe("국립공원 추첨 기간", () => {
  // 기록한 화면(야영장 0 개소, 6차 11/1~12/31, 빈자리 접수일 10/08 10:00)을 대상 기간 10/14~10/20, 빈자리 접수일 10/01 10:00으로 바꾼 변형이다.
  const base = () =>
    fixture("knps-selectCampLottery.htm")
      .replace(/2026\.11\.01 \[일\]/g, "2026.10.14 [수]")
      .replace(/2026\.12\.31 \[목\]/g, "2026.10.20 [화]")
      .replace("2026.10.08(10:00)", "2026.10.01(10:00)");
  const lottery = () => base().replace("(야영장) 0 개소", "(야영장) 3 개소");
  const serverWith = (body: string) => knpsServer({ lottery: () => ({ status: 200, body }) });

  it("야영장이 0 개소면 대상 기간 안이어도 제외하지 않는다", async () => {
    const p = run("2026-10-15", { server: serverWith(base()) });
    await settle();
    expect(p.sent).toHaveLength(1);
    await p.stop();
  });

  it("대상 기간 안의 날짜는 빈자리 접수 개시 전이면 _N이어도 알리지 않고, 개시 뒤에는 알린다", async () => {
    const p = run("2026-10-15", { server: serverWith(lottery()) });
    await settle();
    expect(lotteryReqs(p)).toHaveLength(1);
    expect(listReqs(p)).toHaveLength(0); // 조회 단위에서 빠져 시설 조회도 나가지 않는다.
    expect(p.sent).toHaveLength(0);
    await p.clock.advance(2 * DAY + 90 * MIN); // 10/01 10:30
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("A01");
    await p.stop();
  });

  it("대상 기간 밖의 날짜는 개시 전에도 알린다", async () => {
    const p = run("2026-10-21", { server: serverWith(lottery()) });
    await settle();
    expect(p.sent).toHaveLength(1);
    await p.stop();
  });

  it("추첨 화면은 하루에 한 번만 읽고 KST 날짜가 바뀐 뒤 첫 바퀴에 다시 읽는다", async () => {
    const p = run("2026-10-21", { server: serverWith(lottery()) });
    await settle();
    for (let i = 0; i < 5; i++) await p.clock.advance(300_000);
    expect(p.allRequests.filter((r) => r.url.endsWith("searchSimpleCampReservation.do")).length).toBeGreaterThan(3);
    expect(lotteryReqs(p)).toHaveLength(1);
    await p.clock.advance(DAY);
    await settle();
    expect(lotteryReqs(p)).toHaveLength(2);
    await p.stop();
  });

  it("추첨 화면 요청은 간격 큐 안에서 나간다", async () => {
    const p = run("2026-10-21");
    await settle();
    const i = p.allRequests.findIndex((r) => r.url.endsWith("selectCampLottery.do"));
    const j = p.allRequests.findIndex((r) => r.url.endsWith("searchSimpleCampReservation.do"));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(Math.abs(p.requestTimes[j]! - p.requestTimes[i]!)).toBe(6_500);
    await p.stop();
  });

  const variants: [string, () => { status: number; body: string }][] = [
    ["모양이 바뀐 화면", () => ({ status: 200, body: "<html><body><h3>점검 중</h3></body></html>" })],
    ["날짜가 깨진 화면", () => ({ status: 200, body: lottery().replace("추첨 대상 기간", "대상") })],
    ["HTTP 500", () => ({ status: 500, body: "" })],
    ["HTTP 403", () => ({ status: 403, body: "" })],
  ];
  for (const [name, respond] of variants) {
    it(`${name}이면 경고 로그만 남기고 달력대로 알린다`, async () => {
      const p = run("2026-10-15", { server: knpsServer({ lottery: respond }) });
      await settle();
      expect(p.logs.some((l) => l.msg === "knps lottery schedule unreadable")).toBe(true);
      expect(p.sent).toHaveLength(1);
      expect(p.sent.filter((m) => /상태|점검|중단|일시|blocked|차단/.test(m.text))).toEqual([]);
      await p.stop();
    });
  }
});

describe("국립공원 설정", () => {
  const cfg = (extra: string, facility = "    facility: gatbawi\n") =>
    configWith(`  - name: w\n    provider: knps\n${facility}    zones: ["0200901"]\n    checkIn: { from: 2026-10-15, to: 2026-10-15 }\n${extra}`);
  const messageOf = (yaml: string) => {
    try {
      loadConfig(yaml, ENV);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      return (e as Error).message;
    }
    throw new Error("설정이 받아들여졌다");
  };

  it("facility 없는 감시 조건은 위치와 쓸 수 있는 시설 코드를 담아 거부한다", () => {
    const m = messageOf(cfg("", ""));
    expect(m).toContain("watches.0.facility");
    expect(m).toContain("gatbawi, dohak");
  });

  it("3박 감시 조건은 위치와 함께 거부한다", () => {
    const m = messageOf(cfg("    nights: 3\n"));
    expect(m).toContain("watches.0.nights");
    expect(m).toContain("최대 2박");
  });

  it("2박 감시 조건은 받아들인다", () => {
    expect(() => loadConfig(cfg("    nights: 2\n"), ENV)).not.toThrow();
  });

  it("없는 자리 이름은 위치와 함께 거부한다", () => {
    const m = messageOf(cfg("    seats: [A99]\n"));
    expect(m).toContain("watches.0.seats");
    expect(m).toContain("A99");
  });

  it("1박 감시 조건은 받아들인다", () => {
    expect(() => loadConfig(cfg("    nights: 1\n"), ENV)).not.toThrow();
  });
});
