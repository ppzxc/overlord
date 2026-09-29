import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createHttpClient } from "../src/http.js";
import { DONGHAE_ENTRY, DONGHAE_ZONES, ENV, configWith, donghaeServer, settle, startPoller } from "./harness.js";

const HEAD_WATCH = (extra = "") => `
  - name: 망상 가을
    provider: donghae
    zones: [자동차캠핑장]
    checkIn: { from: 2026-10-03, to: 2026-10-03 }
    nights: 1
    notify: [default]${extra}`;

const yaml = (watch = HEAD_WATCH()) => configWith(watch);
const wwwPath = (r: { url: string }) => new URL(r.url).pathname.split("/").pop();

const run = (server: ReturnType<typeof donghaeServer>, watch?: string, random?: () => number) =>
  startPoller(() => ({ status: 404, body: "" }), { yaml: yaml(watch), server, random });

describe("동해시 폴러", () => {
  it("남은 수가 있으면 구역 이름·남은 수·딥링크가 담긴 메시지를 한 건 보낸다", async () => {
    const p = run(donghaeServer({ counts: (z) => (z === "자동차캠핑장" ? 20 : "예약완료") }));
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("2026-10-03(토) 1박 · 자동차캠핑장 · 남은 20");
    expect(JSON.stringify(p.sent[0]!.reply_markup)).toContain("/user/reservation/BD_reservation.do");
    await p.stop();
  });

  it("요청 순서는 5101 → ND_setNfKey → BD_reservation → 월 달력 → 날짜 조회이고 화면 구성용 요청은 없다", async () => {
    const p = run(donghaeServer({ counts: () => 3 }));
    await settle();
    const seq = p.allRequests.map((r) => (new URL(r.url).hostname.startsWith("nf.") ? `nf:${new URL(r.url).searchParams.get("opcode")}` : `${r.method} ${wwwPath(r)}`));
    expect(seq.slice(0, 5)).toEqual(["nf:5101", "POST ND_setNfKey.do", "POST BD_reservation.do", "POST BD_reservationOrigin.do", "POST ND_selectFcltyCalendarDetail.do"]);
    expect(p.allRequests.some((r) => /ND_globalConfig|ND_massageConfig|ND_popupConfig/.test(r.url))).toBe(false);
    const setKey = p.allRequests[1]!;
    expect(setKey.body).toBe("KEY1");
    expect(setKey.headers["Content-Type"]).toBe("application/json");
    const enter = new URLSearchParams(p.allRequests[2]!.body);
    expect(enter.get("q_complete")).toBe("Y");
    expect(enter.get("netfunnel_key")).toBe("KEY1");
    const detail = new URLSearchParams(p.allRequests[4]!.body);
    expect(Object.fromEntries(detail)).toMatchObject({ trrsrtCode: "1000", q_year: "2026", q_month: "10", qDay: "3", netfunnel_key: "KEY1", passNfTime: "0" });
    await p.stop();
  });

  it("모든 요청에 정직한 UA만 붙고 쿠키는 동해시 www 요청에만 이어진다", async () => {
    const p = run(donghaeServer({ counts: () => 3 }));
    await settle();
    for (const r of p.allRequests) expect(r.headers["User-Agent"]).toMatch(/^overlord-availability-poller\/0\.1\.0 \(ops\)$/);
    const www = p.allRequests.filter((r) => new URL(r.url).hostname === "www.campingkorea.or.kr");
    expect(www[0]!.headers.Cookie).toBeUndefined(); // 첫 www 요청(ND_setNfKey) 전에는 쿠키가 없다.
    for (const r of www.slice(1)) expect(r.headers.Cookie).toBe("DHCMP_JSESSIONID=sess1");
    for (const r of p.allRequests.filter((r) => new URL(r.url).hostname.startsWith("nf."))) expect(r.headers.Cookie).toBeUndefined();
    await p.stop();
  });

  it("www 요청은 5초 + 지터 간격으로 나가고 대기열 서버 요청은 그 간격을 따르지 않는다", async () => {
    const p = run(donghaeServer({ counts: () => 3 }), undefined, () => 0.5);
    await settle();
    const times = p.requestTimes;
    // nf(5101)와 첫 www(ND_setNfKey)는 같은 시각에 나간다.
    expect(times[1]! - times[0]!).toBe(0);
    expect(times[2]! - times[1]!).toBe(6_500);
    expect(times[3]! - times[2]!).toBe(6_500);
    await p.stop();
  });

  it("대기열이 201을 주면 서버가 준 간격대로 5002를 다시 보내고 기다린 시간을 passNfTime으로 보낸다", async () => {
    const p = run(
      donghaeServer({
        counts: () => 3,
        queue: ["5002:201:key=KEYW&nwait=5&nnext=1&tps=1&ttl=3&ip=x&port=443", "5002:200:key=KEYW&nwait=0&nnext=0&tps=0&ttl=0&ip=x&port=443"],
      }),
    );
    await settle();
    const nf = p.allRequests.filter((r) => new URL(r.url).hostname.startsWith("nf."));
    expect(nf.map((r) => new URL(r.url).searchParams.get("opcode"))).toEqual(["5101", "5002"]);
    expect(new URL(nf[1]!.url).searchParams.get("key")).toBe("KEYW");
    expect(p.requestTimes[1]! - p.requestTimes[0]!).toBe(3_000);
    const detail = p.allRequests.find((r) => wwwPath(r) === "ND_selectFcltyCalendarDetail.do")!;
    expect(new URLSearchParams(detail.body).get("passNfTime")).toBe("3000");
    await p.stop();
  });

  it("임시 사용 중단 호실은 이름이 정확히 같을 때만 남은 수에서 뺀다", async () => {
    const p = run(
      donghaeServer({ counts: (z) => (z === "자동차캠핑장" ? 20 : "예약완료"), reduced: { "A-zone 자동차캠핑장": 20 } }),
    );
    await settle();
    expect(p.sent[0]!.text).toContain("남은 20"); // 이름이 다르면 빼지 않는다.
    await p.stop();

    const q = run(donghaeServer({ counts: (z) => (z === "자동차캠핑장" ? 20 : "예약완료"), reduced: { 자동차캠핑장: 20 } }));
    await settle();
    expect(q.sent).toHaveLength(0);
    await q.stop();

    const r = run(donghaeServer({ counts: (z) => (z === "자동차캠핑장" ? 25 : "예약완료"), reduced: { 자동차캠핑장: 20 } }));
    await settle();
    expect(r.sent[0]!.text).toContain("남은 5");
    await r.stop();
  });

  it.each(["예약완료", "예약불가", "준비중", 0])("%s는 빈자리가 아니다", async (value) => {
    const p = run(donghaeServer({ counts: () => value }));
    await settle();
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("중단 호실 수가 남은 수보다 커도 0으로 맞추고 알리지 않는다", async () => {
    const p = run(donghaeServer({ counts: (z) => (z === "자동차캠핑장" ? 5 : "예약완료"), reduced: { 자동차캠핑장: 20 } }));
    await settle();
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("같은 빈자리는 다음 바퀴에 다시 알리지 않고, 남은 수가 바뀌어도 알리지 않으며, 0이 된 뒤 다시 생기면 알린다", async () => {
    let n: number | string = 20;
    const p = run(donghaeServer({ counts: (z) => (z === "자동차캠핑장" ? n : "예약완료") }));
    await settle();
    expect(p.sent).toHaveLength(1);
    n = 19;
    await p.clock.advance(150_000);
    await settle();
    expect(p.sent).toHaveLength(1);
    n = "예약완료";
    await p.clock.advance(150_000);
    await settle();
    n = 4;
    await p.clock.advance(150_000);
    await settle();
    expect(p.sent).toHaveLength(2);
    expect(p.sent[1]!.text).toContain("남은 4");
    await p.stop();
  });

  it("아직 열리지 않은 날짜는 조회하지 않는다", async () => {
    // 지금은 2026-09-29 09:00 KST. 2026-10-29 입실은 D−30인 09-29 11:00에 열린다.
    const p = run(
      donghaeServer({ counts: () => 3 }),
      HEAD_WATCH().replace("2026-10-03", "2026-10-29").replace("2026-10-03", "2026-10-29"),
    );
    await settle();
    expect(p.allRequests).toHaveLength(0);
    await p.stop();
  });

  it("당일 입실은 조회하지 않는다", async () => {
    const p = run(donghaeServer({ counts: () => 3 }), HEAD_WATCH().replace("2026-10-03", "2026-09-29").replace("2026-10-03", "2026-09-29"));
    await settle();
    expect(p.allRequests).toHaveLength(0);
    await p.stop();
  });

  it("첫 실패에서 멈추고 이미 읽은 밤의 결과는 반영한다", async () => {
    const w = HEAD_WATCH().replace("from: 2026-10-03, to: 2026-10-03", "from: 2026-10-03, to: 2026-10-04").replace(/\n {4}nights: 1/, "\n    nights: 1");
    const p = run(
      donghaeServer({
        counts: (z) => (z === "자동차캠핑장" ? 7 : "예약완료"),
        detailBody: (date) => (date === "2026-10-04" ? '{"result":true,"value":"자동차캠핑장:이상한값"}' : undefined),
      }),
      w,
    );
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("2026-10-03");
    expect(p.sent[0]!.text).not.toContain("2026-10-04");
    await p.stop();
  });

  it("필요한 밤이 예약마감이면 그 조회 단위는 날짜 조회 없이 끝난다", async () => {
    const w = HEAD_WATCH().replace("nights: 1", "nights: 2");
    const p = run(donghaeServer({ counts: () => 5, closed: (d) => d === "2026-10-04" }), w);
    await settle();
    expect(p.sent).toHaveLength(0);
    expect(p.allRequests.some((r) => wwwPath(r) === "ND_selectFcltyCalendarDetail.do")).toBe(false);
    await p.stop();
  });

  it("진입한 달 밖의 밤은 BD_reservationOrigin으로 그 달 달력을 읽는다", async () => {
    const p = run(donghaeServer({ counts: () => 5, closed: (d) => d === "2026-10-03" }));
    await settle();
    const origin = p.allRequests.filter((r) => wwwPath(r) === "BD_reservationOrigin.do");
    expect(origin).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(origin[0]!.body))).toMatchObject({ trrsrtCode: "1000", q_year: "2026", q_month: "10", netfunnel_key: "KEY1" });
    expect(p.allRequests.some((r) => wwwPath(r) === "ND_selectFcltyCalendarDetail.do")).toBe(false);
    await p.stop();
  });

  it("여러 달에 걸치면 달마다 한 번씩만 달력을 읽는다", async () => {
    const w = HEAD_WATCH().replace("from: 2026-10-03, to: 2026-10-03", "from: 2026-09-30, to: 2026-09-30").replace("nights: 1", "nights: 2");
    const p = run(donghaeServer({ counts: () => 5 }), w);
    await settle();
    const months = p.allRequests.filter((r) => wwwPath(r) === "BD_reservationOrigin.do").map((r) => new URLSearchParams(r.body).get("q_month"));
    expect(months).toEqual(["09", "10"]);
    await p.stop();
  });

  it("두 번째 달 달력이 실패하면 날짜 조회를 보내지 않는다", async () => {
    const w = HEAD_WATCH().replace("from: 2026-10-03, to: 2026-10-03", "from: 2026-09-30, to: 2026-09-30").replace("nights: 1", "nights: 2");
    const p = startPoller(() => ({ status: 404, body: "" }), {
      yaml: yaml(w),
      server: (req) => (req.url.endsWith("BD_reservationOrigin.do") && new URLSearchParams(req.body).get("q_month") === "10" ? { status: 500, body: "" } : donghaeServer({ counts: () => 5 })(req)),
    });
    await settle();
    expect(p.allRequests.some((r) => wwwPath(r) === "ND_selectFcltyCalendarDetail.do")).toBe(false);
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("달력을 읽지 못하면 그 바퀴는 실패하고 날짜 조회를 보내지 않는다", async () => {
    const p = startPoller(() => ({ status: 404, body: "" }), {
      yaml: yaml(),
      server: (req) => (req.url.endsWith("BD_reservationOrigin.do") ? { status: 200, body: "<html></html>" } : donghaeServer({ counts: () => 5 })(req)),
    });
    await settle();
    expect(p.allRequests.some((r) => wwwPath(r) === "ND_selectFcltyCalendarDetail.do")).toBe(false);
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("2박은 밤마다 남은 수의 최솟값과 연속 보장 없음을 알린다", async () => {
    const w = HEAD_WATCH().replace("nights: 1", "nights: 2");
    const p = run(donghaeServer({ counts: (z, d) => (z === "자동차캠핑장" ? (d === "2026-10-03" ? 9 : 4) : "예약완료") }), w);
    await settle();
    expect(p.sent[0]!.text).toContain("2026-10-03(토) 2박 · 자동차캠핑장 · 밤마다 남은 최소 4 (같은 자리 연속 보장 없음)");
    await p.stop();
  });

  it("NetFunnel 301은 차단으로 멈추고 알린다", async () => {
    const p = run(donghaeServer({ queue: ["5002:301:key=&nwait=0"] }));
    await settle();
    expect(p.sent.some((m) => /blocked|차단/.test(m.text))).toBe(true);
    expect(p.allRequests.every((r) => new URL(r.url).hostname.startsWith("nf."))).toBe(true);
    await p.stop();
  });

  it("고래불과 동해시를 한 설정에 두면 둘 다 감시한다", async () => {
    const both = configWith(
      `
  - name: 고래불
    provider: goraebul
    zones: [DKA]
    checkIn: { from: 2026-09-30, to: 2026-09-30 }
    nights: 1
    notify: [default]`,
      HEAD_WATCH(),
    );
    const donghae = donghaeServer({ counts: () => 3 });
    const p = startPoller(() => ({ status: 404, body: "" }), {
      yaml: both,
      server: (req) => (req.url.includes("stay.yd.go.kr") ? { status: 200, body: "" } : donghae(req)),
    });
    await settle();
    await p.clock.advance(120_000);
    await settle();
    expect(p.allRequests.some((r) => r.url.includes("campingkorea"))).toBe(true);
    expect(p.allRequests.some((r) => r.url.includes("stay.yd.go.kr"))).toBe(true);
    await p.stop();
  });
});

describe("동해시 접근 금지 경로", () => {
  it.each([
    "/user/reservation/ND_ncaptcha.do",
    "/user/reservation/ND_chkAnswer.do",
    "/user/reservation/BD_reservationReq.do",
    "/user/reservation/ND_deletePreOcpcInfo.do",
    "/login/BD_loginForm.do",
    "/user/myPage/x.do",
  ])("%s로는 요청이 나가지 않는다", async (path) => {
    const { donghaeAdapter } = await import("../src/adapters/donghae.js");
    const sent: string[] = [];
    const http = createHttpClient({
      transport: async (r) => (sent.push(r.url), { status: 200, body: "" }),
      version: "0.1.0",
      userAgentSuffix: "",
      blockedPaths: donghaeAdapter.describe().blockedPaths,
      cookieSession: true,
    });
    await expect(http.post(`https://www.campingkorea.or.kr${path}`, {})).rejects.toThrow(/접근 금지/);
    expect(sent).toHaveLength(0);
  });
});

describe("동해시 설정 검증", () => {
  const load = (watch: string) => () => loadConfig(configWith(watch), ENV);

  it("구역 오타는 쓸 수 있는 구역 9개와 함께 거부한다", () => {
    let message = "";
    try {
      load(HEAD_WATCH().replace("자동차캠핑장", "자동차캠핑"))();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('없는 구역 "자동차캠핑"');
    for (const z of DONGHAE_ZONES) expect(message).toContain(z);
    expect(message).toMatch(/\d+번째 줄/);
  });

  it("자리 목록이 없는 구역에 seats를 걸면 거부한다", () => {
    expect(load(HEAD_WATCH("\n    seats: [A01]"))).toThrow(/seats/);
  });

  it("3박을 넘으면 거부하고 3박은 받는다", () => {
    expect(load(HEAD_WATCH().replace("nights: 1", "nights: 4"))).toThrow(/최대 3박/);
    expect(load(HEAD_WATCH().replace("nights: 1", "nights: 3"))).not.toThrow();
  });
});

describe("동해시 대기열 키 재사용과 수명", () => {
  const opcodes = (p: ReturnType<typeof run>) =>
    p.allRequests.filter((r) => new URL(r.url).hostname.startsWith("nf.")).map((r) => new URL(r.url).searchParams.get("opcode"));
  const paths = (p: ReturnType<typeof run>) =>
    p.allRequests.map((r) => (new URL(r.url).hostname.startsWith("nf.") ? `nf:${new URL(r.url).searchParams.get("opcode")}` : wwwPath(r)));
  const rounds = async (p: ReturnType<typeof run>, n: number) => {
    for (let i = 0; i < n; i++) {
      await p.clock.advance(150_000);
      await settle();
    }
  };

  it("두 번째 바퀴는 5101 없이 ND_checkNfKeyAvail.do 뒤에 날짜 조회로 간다", async () => {
    const p = run(donghaeServer({ counts: () => 3 }));
    await settle();
    const first = p.allRequests.length;
    await rounds(p, 1);
    const second = paths(p).slice(first);
    expect(second.slice(0, 3)).toEqual(["ND_checkNfKeyAvail.do", "BD_reservationOrigin.do", "ND_selectFcltyCalendarDetail.do"]);
    expect(opcodes(p)).toEqual(["5101"]);
    const check = p.allRequests[first]!;
    expect(new URLSearchParams(check.body).get("netfunnel_key")).toBe("KEY1");
    const detail = new URLSearchParams(p.allRequests[first + 2]!.body);
    expect(detail.get("netfunnel_key")).toBe("KEY1");
    await p.stop();
  });

  it("NOT Available를 받으면 같은 바퀴에서 새로 진입하고 실패로 치지 않는다", async () => {
    const p = run(donghaeServer({ counts: () => 3, keyAvailable: (k) => k !== "KEY1" }));
    await settle();
    await rounds(p, 1);
    expect(opcodes(p)).toEqual(["5101", "5101"]);
    const detail = p.allRequests.filter((r) => wwwPath(r) === "ND_selectFcltyCalendarDetail.do");
    expect(new URLSearchParams(detail[1]!.body).get("netfunnel_key")).toBe("KEY2");
    expect(p.logs.some((l) => l.msg === "query failed")).toBe(false);
    expect(p.sent).toHaveLength(1); // 첫 바퀴의 빈자리 알림뿐이다. 재진입은 알림을 더하지 않는다.
    await p.stop();
  });

  it("새로 받은 키도 곧바로 NOT Available이면 unrecognized다", async () => {
    const p = run(donghaeServer({ counts: () => 3, keyAvailable: () => false }));
    await settle();
    await rounds(p, 1);
    expect(p.logs.some((l) => l.msg === "query failed" && l.fields?.kind === "unrecognized")).toBe(true);
    await p.stop();
  });

  it("2시간이 지난 키는 확인하지 않고 새로 진입한다", async () => {
    // 7_000_000ms 뒤는 10:56로 오픈 경쟁 시간 안이라 바퀴가 11:30까지 미뤄진다.
    const p = run(donghaeServer({ counts: () => 3 }));
    await settle();
    await p.clock.advance(7_000_000);
    await settle();
    expect(opcodes(p).filter((o) => o === "5101")).toHaveLength(1);
    await p.clock.advance(2_100_000);
    await settle();
    expect(opcodes(p).filter((o) => o === "5101")).toHaveLength(2);
    const seq = paths(p);
    const second = seq.lastIndexOf("nf:5101");
    expect(seq[second + 1]).toBe("ND_setNfKey.do");
    await p.stop();
  });

  it("진입 뒤 5분이 지난 다음 바퀴 시작에 5004가 한 번 나간다", async () => {
    const p = run(donghaeServer({ counts: () => 3 }));
    await settle();
    await rounds(p, 1); // 150초
    expect(opcodes(p)).not.toContain("5004");
    await rounds(p, 1); // 300초
    expect(opcodes(p).filter((o) => o === "5004")).toHaveLength(1);
    await rounds(p, 3);
    expect(opcodes(p).filter((o) => o === "5004")).toHaveLength(1);
    const seq = paths(p);
    expect(seq[seq.indexOf("nf:5004") + 1]).toBe("ND_checkNfKeyAvail.do");
    await p.stop();
  });

  it("5분 전에 종료해도 5004를 한 번 보낸다", async () => {
    const p = run(donghaeServer({ counts: () => 3 }));
    await settle();
    await p.stop();
    expect(opcodes(p)).toEqual(["5101", "5004"]);
  });

  it("5002가 120초 넘게 계속 대기를 돌려주면 그 바퀴는 transient로 끝난다", async () => {
    const p = run(donghaeServer({ counts: () => 3, queue: ["5002:201:key=KEYW&nwait=5&nnext=1&tps=1&ttl=10&ip=x&port=443"] }));
    await settle();
    await p.clock.advance(130_000);
    await settle();
    expect(p.logs.some((l) => l.msg === "query failed" && l.fields?.kind === "transient")).toBe(true);
    expect(p.allRequests.some((r) => wwwPath(r) === "ND_setNfKey.do")).toBe(false);
    await p.stop();
  });

  it("대기 상한을 넘겨 transient로 끝나면 다음 바퀴까지의 간격이 늘어난다", async () => {
    const p = run(donghaeServer({ counts: () => 3, queue: ["5002:201:key=KEYW&nwait=5&nnext=1&tps=1&ttl=10&ip=x&port=443"] }), undefined, () => 0.5);
    await settle();
    await p.clock.advance(130_000); // 첫 바퀴가 상한에서 끝난다.
    await settle();
    const nf = () => p.allRequests.filter((r) => new URL(r.url).hostname.startsWith("nf.") && new URL(r.url).searchParams.get("opcode") === "5101").length;
    expect(nf()).toBe(1);
    await p.clock.advance(150_000); // 기본 간격이면 이미 다음 바퀴가 시작했을 시간이다.
    await settle();
    expect(nf()).toBe(1);
    await p.stop();
  });

  describe("신호 분류", () => {
    const failedKinds = (p: ReturnType<typeof run>) => p.logs.filter((l) => l.msg === "query failed").map((l) => l.fields?.kind);
    const detailReq = (r: { url: string }) => r.url.endsWith("ND_selectFcltyCalendarDetail.do");

    it("NetFunnel 302도 차단으로 멈추고 가상 대기에 참여하지 않는다", async () => {
      const p = run(donghaeServer({ queue: ["5002:302:key=&nwait=0"] }));
      await settle();
      expect(p.sent.some((m) => /blocked|차단/.test(m.text))).toBe(true);
      expect(p.allRequests.filter((r) => new URL(r.url).hostname.startsWith("nf."))).toHaveLength(1);
      expect(p.allRequests.some((r) => new URL(r.url).hostname === "www.campingkorea.or.kr")).toBe(false);
      await p.stop();
    });

    it("로그인·인증을 요구하는 result:false는 blocked다", async () => {
      const p = run(donghaeServer({ detailBody: () => JSON.stringify({ result: false, message: "로그인이 필요합니다" }) }));
      await settle();
      expect(failedKinds(p)).toEqual(["blocked"]);
      expect(p.sent.some((m) => /blocked|차단/.test(m.text))).toBe(true);
      await p.stop();
    });

    it("그 밖의 result:false는 unrecognized이고 알림 없이 다음 바퀴에 다시 시도한다", async () => {
      const p = run(donghaeServer({ detailBody: () => JSON.stringify({ result: false, message: "오류" }) }));
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      expect(p.sent).toHaveLength(0);
      await p.stop();
    });

    it("NOPASS는 키와 쿠키를 버리고 같은 바퀴에서 한 번 다시 진입해 성공하면 실패로 치지 않는다", async () => {
      let first = true;
      const p = run(
        donghaeServer({
          counts: () => 3,
          intercept: (req) => {
            if (req.url.endsWith("BD_reservationOrigin.do") && first) {
              first = false;
              return { status: 200, body: "NOPASS:" };
            }
          },
        }),
      );
      await settle();
      expect(opcodes(p)).toEqual(["5101", "5101"]);
      const www = p.allRequests.filter((r) => new URL(r.url).hostname === "www.campingkorea.or.kr");
      const reentrySetKey = www.filter((r) => r.url.endsWith("ND_setNfKey.do"))[1]!;
      expect(reentrySetKey.headers.Cookie).toBeUndefined();
      expect(failedKinds(p)).toEqual([]);
      expect(p.sent).toHaveLength(1);
      await p.stop();
    });

    it("NOPASS가 재진입 뒤에도 반복되면 unrecognized이고 세션을 다시 만든다", async () => {
      const p = run(donghaeServer({ counts: () => 3, intercept: (req) => (req.url.endsWith("BD_reservationOrigin.do") ? { status: 200, body: "NOPASS:" } : undefined) }));
      await settle();
      expect(opcodes(p)).toEqual(["5101", "5101"]);
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      await p.stop();
    });

    it("공통 404(div.mError1)는 unrecognized다", async () => {
      const p = run(donghaeServer({ intercept: (req) => (req.url.endsWith("ND_selectFcltyCalendarDetail.do") ? { status: 404, body: '<div class="mError1"></div>' } : undefined) }));
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      expect(p.logs.find((l) => l.msg === "query failed")!.fields?.message).toContain("공통 404");
      await p.stop();
    });

    it.each([
      ['<input name="netfunnel_key"', "netfunnel_key 필드"],
      ["ND_setNfKey.do", "ND_setNfKey.do 호출"],
      ['NetFunnel_Action({action_id:"reserve"}', "NetFunnel_Action"],
    ])("진입 페이지에서 %s가 사라지면 unrecognized다", async (gone, what) => {
      const p = run(donghaeServer({ entryBody: (r) => DONGHAE_ENTRY(r).replace(gone.startsWith("<") ? /<input[^>]*>/ : gone, "") }));
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      expect(p.logs.find((l) => l.msg === "query failed")!.fields?.message).toContain(what);
      expect(p.allRequests.some(detailReq)).toBe(false);
      await p.stop();
    });

    it("temporaryReducedCounts가 없으면 unrecognized이고 빈 {}는 정상이다", async () => {
      const gone = run(donghaeServer({ entryBody: () => `<input name="netfunnel_key"/>ND_setNfKey.do NetFunnel_Action({action_id:"reserve"}` }));
      await settle();
      expect(failedKinds(gone)).toEqual(["unrecognized"]);
      await gone.stop();
      const empty = run(donghaeServer({ counts: () => 3 }));
      await settle();
      expect(failedKinds(empty)).toEqual([]);
      await empty.stop();
    });

    it.each([
      ["구조 깨짐", "자동차캠핑장"],
      ["모르는 값", "자동차캠핑장:곧오픈"],
    ])("value %s는 빈자리 없음으로 넘기지 않고 unrecognized다", async (_n, value) => {
      const p = run(donghaeServer({ detailBody: () => JSON.stringify({ result: true, value, message: null }) }));
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      await p.stop();
    });

    it("감시 조건이 쓰는 구역이 응답에서 사라지면 unrecognized다", async () => {
      const value = DONGHAE_ZONES.filter((z) => z !== "자동차캠핑장").map((z) => `${z}:3`).join("|^|");
      const p = run(donghaeServer({ detailBody: () => JSON.stringify({ result: true, value, message: null }) }));
      await settle();
      expect(failedKinds(p)).toEqual(["unrecognized"]);
      await p.stop();
    });

    it("쓰지 않는 구역이 사라지거나 새로 생기면 경고만 한 번 남기고 감시를 계속한다", async () => {
      const value = [...DONGHAE_ZONES.filter((z) => z !== "캐라반").map((z) => `${z}:${z === "자동차캠핑장" ? 7 : "예약완료"}`), "새구역:1"].join("|^|");
      const p = run(donghaeServer({ detailBody: () => JSON.stringify({ result: true, value, message: null }) }));
      await settle();
      await p.clock.advance(150_000);
      await settle();
      expect(failedKinds(p)).toEqual([]);
      expect(p.sent[0]!.text).toContain("남은 7");
      const warns = p.logs.filter((l) => l.msg === "donghae zone drift").map((l) => `${l.fields?.change}:${l.fields?.zone}`);
      expect(warns.sort()).toEqual(["gone:캐라반", "new:새구역"]);
      await p.stop();
    });

    it("netfunnel.js 버전이나 TS_HOST가 바뀌면 경고만 남기고 감시를 계속한다", async () => {
      const js = "/* Version 9.9.9 */\nNetFunnel.TS_HOST = 'other.example';\n";
      const p = run(donghaeServer({ counts: () => 3, intercept: (req) => (req.url.endsWith("netfunnel.js") ? { status: 200, body: js } : undefined) }));
      await settle();
      const msgs = p.logs.map((l) => l.msg);
      expect(msgs).toContain("donghae netfunnel.js version changed");
      expect(msgs).toContain("donghae TS_HOST changed");
      expect(failedKinds(p)).toEqual([]);
      expect(p.sent).toHaveLength(1);
      await p.stop();
    });

    it("netfunnel.js가 확인한 값 그대로면 경고가 없고, 받지 못해도 감시는 계속된다", async () => {
      const ok = "/* Version 2.2.25_hotfix */\nNetFunnel.TS_HOST = 'nf.campingkorea.or.kr';\n";
      const same = run(donghaeServer({ counts: () => 3, intercept: (req) => (req.url.endsWith("netfunnel.js") ? { status: 200, body: ok } : undefined) }));
      await settle();
      expect(same.logs.some((l) => /changed/.test(l.msg))).toBe(false);
      await same.stop();
      const missing = run(donghaeServer({ counts: () => 3 }));
      await settle();
      expect(failedKinds(missing)).toEqual([]);
      expect(missing.sent).toHaveLength(1);
      await missing.stop();
    });

    it("netfunnel.js는 세션당 한 번만 받는다", async () => {
      const p = run(donghaeServer({ counts: () => 3 }));
      await settle();
      await p.clock.advance(150_000);
      await settle();
      expect(p.allRequests.filter((r) => r.url.endsWith("netfunnel.js"))).toHaveLength(1);
      await p.stop();
    });
  });
});

describe("동해시 오픈 경쟁 시간", () => {
  const MIN = 60_000;
  const cycles = (p: ReturnType<typeof run>) => p.allRequests.filter((r) => wwwPath(r) === "BD_reservation.do").length;
  const toRush = async (p: ReturnType<typeof run>) => {
    await settle();
    await p.clock.advance(114 * MIN); // 10:54. 다음 바퀴 예정은 10:56:30
  };

  it("다음 바퀴 예정 시각이 10:55~11:30 안이면 11:30으로 미루고 그 사이 요청이 없다", async () => {
    const p = run(donghaeServer({ counts: () => 3 }));
    await toRush(p);
    const before = p.allRequests.length;
    await p.clock.advance(35 * MIN); // 11:29
    expect(p.allRequests.length).toBe(before);
    expect(p.liveness.stalled()).toEqual([]);
    await p.clock.advance(1 * MIN); // 11:30
    expect(p.allRequests.length).toBeGreaterThan(before);
    await p.stop();
  });

  it("구간 동안에도 살아있음 신호가 폴링 간격마다 나간다", async () => {
    const PING = "https://hc.example/ping";
    const p = startPoller(() => ({ status: 404, body: "" }), {
      yaml: yaml().replace("providers:", `deadManPingUrl: ${PING}\nproviders:`),
      server: donghaeServer({ counts: () => 3 }),
    });
    await toRush(p);
    const pings = () => p.allRequests.filter((r) => r.url === PING).length;
    const before = pings();
    for (let i = 0; i < 12; i++) {
      await p.clock.advance(150_000);
      await settle();
    }
    expect(pings() - before).toBeGreaterThanOrEqual(10);
    await p.stop();
  });

  it("구간 안에서는 헬스 알림이 없고 상태가 바뀌지 않는다", async () => {
    const p = run(donghaeServer({ counts: () => 3 }));
    await toRush(p);
    await p.clock.advance(35 * MIN);
    expect(p.sent.filter((m) => /상태|점검|중단|일시/.test(m.text))).toEqual([]);
    await p.stop();
  });

  it("설정의 openingRush로 구간을 바꿀 수 있다", async () => {
    const custom = yaml().replace("providers:", "providers:\n  donghae: { openingRush: { from: \"09:00\", to: \"09:20\" } }");
    const p = startPoller(() => ({ status: 404, body: "" }), { yaml: custom, server: donghaeServer({ counts: () => 3 }) });
    await settle();
    expect(p.allRequests).toHaveLength(0); // 시작 시각 09:00이 구간 안이다
    await p.clock.advance(19 * MIN);
    expect(p.allRequests).toHaveLength(0);
    await p.clock.advance(1 * MIN);
    expect(cycles(p)).toBeGreaterThan(0);
    await p.stop();
  });

  it("openingRush에서 from과 to가 같으면 설정을 거부한다", () => {
    const bad = yaml().replace("providers:", "providers:\n  donghae: { openingRush: { from: \"10:00\", to: \"10:00\" } }");
    expect(() => loadConfig(bad, ENV)).toThrow(/from과 to/);
  });
});
