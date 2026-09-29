import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CONFIG_YAML, ENV, calendarHtml, configWith, fixture, queryOf, settle, startPoller } from "./harness.js";

const POLL_MS = 150_000;
const open = () => ({ status: 200, body: fixture("dka-2026-09-29-1night.htm") });
const soldOut = () => ({ status: 200, body: fixture("dka-2026-09-30-2nights-soldout.htm") });

describe("고래불 폴러 워킹 스켈레톤", () => {
  it("빈 자리가 있으면 자리 번호와 딥링크가 담긴 메시지를 한 건 보낸다", async () => {
    const p = startPoller(open);
    await settle();
    expect(p.sent).toHaveLength(1);
    const msg = p.sent[0]!;
    expect(msg.chatId).toBe("42");
    expect(msg.text).toContain("텐트사이트 A02호");
    expect(msg.text).toContain("2026-09-29(화) 1박");
    expect(msg.reply_markup?.inline_keyboard[0]?.[0]?.url).toBe(
      "https://stay.yd.go.kr/pages/sub.htm?nav_code=gor1501675800&mode=step01&type=DKA&today=2026-09-29&col=2",
    );
    // ban, 폐쇄된 자리는 나오지 않는다.
    expect(msg.text).not.toContain("A01호");
    expect(msg.text).not.toContain("A03호");
    await p.stop();
  });

  it("빈 자리가 없으면 메시지를 보내지 않는다", async () => {
    const p = startPoller(soldOut);
    await settle();
    expect(p.requests).toHaveLength(1);
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("모든 요청에 정직한 UA만 붙고 From 등 다른 식별 헤더는 없다", async () => {
    const p = startPoller(open);
    await settle();
    await p.clock.advance(POLL_MS);
    expect(p.allRequests.length).toBeGreaterThan(0);
    for (const r of p.allRequests) {
      expect(r.headers).toEqual({ "User-Agent": "overlord-availability-poller/0.1.0 (ops)" });
      expect(r.timeoutMs).toBe(10_000);
    }
    await p.stop();
  });

  it("/bbs/ 경로로는 요청하지 않는다", async () => {
    const p = startPoller(open);
    await settle();
    await p.clock.advance(POLL_MS);
    for (const r of p.allRequests) expect(new URL(r.url).pathname.startsWith("/bbs/")).toBe(false);
    await p.stop();
  });

  it("가짜 시계를 돌리면 고정 간격마다 바퀴가 반복된다", async () => {
    const p = startPoller(open);
    await settle();
    expect(p.requests).toHaveLength(1);
    await p.clock.advance(149_000);
    expect(p.requests).toHaveLength(1);
    await p.clock.advance(1_000);
    expect(p.requests).toHaveLength(2);
    await p.clock.advance(POLL_MS);
    expect(p.requests).toHaveLength(3);
    await p.stop();
  });

  it("차단 페이지를 받으면 메시지 없이 다음 바퀴를 기다린다", async () => {
    const p = startPoller(() => ({ status: 200, body: "<html>영덕군 전산팀 문의</html>" }));
    await settle();
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });
});

describe("새 빈자리만 알림", () => {
  it("같은 빈자리가 연속 두 바퀴 잡히면 첫 바퀴에만 알린다", async () => {
    const p = startPoller(open);
    await settle();
    await p.clock.advance(POLL_MS);
    await p.clock.advance(POLL_MS);
    expect(p.requests).toHaveLength(3);
    expect(p.sent).toHaveLength(1);
    await p.stop();
  });

  it("빈자리가 사라졌다가 다시 나타나면 다시 알린다", async () => {
    let respond = open;
    const p = startPoller(() => respond());
    await settle();
    respond = soldOut;
    await p.clock.advance(POLL_MS);
    respond = open;
    await p.clock.advance(POLL_MS);
    expect(p.sent).toHaveLength(2);
    expect(p.sent[1]!.text).toContain("🏕 빈자리 발견");
    await p.stop();
  });

  it("첫 바퀴에 잡힌 빈자리 알림에만 재시작 직후 현황 표시가 있다", async () => {
    const p = startPoller(open);
    await settle();
    expect(p.sent[0]!.text).toContain("🔄 재시작 직후 현황");
    expect(p.sent[0]!.text).not.toContain("🏕");
    await p.stop();
  });

  it("첫 바퀴 뒤에 새로 생긴 빈자리는 재시작 직후 현황으로 표시하지 않는다", async () => {
    let respond = soldOut;
    const p = startPoller(() => respond());
    await settle();
    respond = open;
    await p.clock.advance(POLL_MS);
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("🏕 빈자리 발견");
    expect(p.sent[0]!.text).not.toContain("재시작 직후 현황");
    await p.stop();
  });

  it("전송이 실패하면 다음 바퀴에 같은 빈자리를 다시 보낸다", async () => {
    let fail = true;
    const p = startPoller(open, { failSend: () => fail });
    await settle();
    expect(p.sent).toHaveLength(0);
    fail = false;
    await p.clock.advance(POLL_MS);
    expect(p.sent).toHaveLength(1);
    await p.clock.advance(POLL_MS);
    expect(p.sent).toHaveLength(1);
    await p.stop();
  });
});

describe("설정 로딩", () => {
  it("${VAR}를 환경 변수로 치환한다", () => {
    expect(loadConfig(CONFIG_YAML, ENV).notifiers["default"]?.botToken).toBe("tok");
  });

  it("참조한 환경 변수가 비어 있으면 거부한다", () => {
    expect(() => loadConfig(CONFIG_YAML, { ...ENV, TELEGRAM_BOT_TOKEN: "" })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});

const watchYaml = (name: string, body: string) => `
  - name: ${name}
    provider: goraebul
    zones: [DKA]
    notify: [default]
${body}`;
const days = (p: { requests: Parameters<typeof queryOf>[0][] }) => p.requests.map((r) => queryOf(r).checkIn);

describe("감시 조건 전개", () => {
  it("입실일 범위 안에서 요일 필터에 맞는 날짜만 조회한다", async () => {
    // 2026-10-01(목) ~ 10-07(수). 금·토는 10-02, 10-03. 모두 오늘(09-29)+30일 안이라 열려 있다.
    const p = startPoller(open, {
      yaml: configWith(
        watchYaml("주말", "    checkIn: { from: 2026-10-01, to: 2026-10-07 }\n    weekdays: [fri, sat]"),
      ),
    });
    await settle();
    expect(days(p)).toEqual(["2026-10-02", "2026-10-03"]);
    await p.stop();
  });

  it("박수를 생략하면 1박으로, 주면 N박으로 조회한다", async () => {
    const one = startPoller(open, {
      yaml: configWith(watchYaml("a", "    checkIn: { from: 2026-10-02, to: 2026-10-02 }")),
    });
    const two = startPoller(soldOut, {
      yaml: configWith(watchYaml("b", "    checkIn: { from: 2026-10-02, to: 2026-10-02 }\n    nights: 2")),
    });
    await settle();
    expect(one.requests.map((r) => queryOf(r).nights)).toEqual(["1"]);
    expect(two.requests.map((r) => queryOf(r).nights)).toEqual(["2"]);
    await one.stop();
    await two.stop();
  });

  it("같은 조회 단위를 쓰는 감시 조건 둘은 요청 한 번으로 둘 다 알림을 받는다", async () => {
    const range = "    checkIn: { from: 2026-10-02, to: 2026-10-02 }";
    const p = startPoller(open, {
      yaml: configWith(watchYaml("첫째", range), watchYaml("둘째", `${range}\n    seats: [A02]`)),
    });
    await settle();
    expect(p.requests).toHaveLength(1);
    expect(p.sent).toHaveLength(2);
    expect(p.sent[0]!.text).toContain("첫째");
    expect(p.sent[1]!.text).toContain("둘째");
    await p.stop();
  });

  it("자리 필터에 맞지 않는 빈자리는 알리지 않는다", async () => {
    const p = startPoller(open, {
      yaml: configWith(
        watchYaml("필터", '    checkIn: { from: 2026-10-02, to: 2026-10-02 }\n    seats: [A02, "A10-A12"]'),
      ),
    });
    await settle();
    const text = p.sent[0]!.text;
    for (const n of ["A02호", "A10호", "A11호", "A12호"]) expect(text).toContain(n);
    for (const n of ["A04호", "A13호", "A15호"]) expect(text).not.toContain(n);
    await p.stop();
  });

  it("필터에 맞는 자리가 하나도 없으면 메시지를 보내지 않는다", async () => {
    const p = startPoller(open, {
      yaml: configWith(watchYaml("없음", "    checkIn: { from: 2026-10-02, to: 2026-10-02 }\n    seats: [A01]")),
    });
    await settle();
    expect(p.requests).toHaveLength(1);
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("아직 열리지 않은 날짜는 조회하지 않고, 오픈 시각(D−30일 10:00)을 지나면 조회한다", async () => {
    // 10-29는 09-29 10:00(KST)에 열린다. 시작 시각은 09:00이다.
    const p = startPoller(open, {
      yaml: configWith(watchYaml("먼 날짜", "    checkIn: { from: 2026-10-29, to: 2026-10-29 }")),
    });
    await settle();
    expect(p.requests).toHaveLength(0);
    await p.clock.advance(59 * 60_000);
    expect(p.requests).toHaveLength(0);
    await p.clock.advance(3 * 60_000);
    expect(days(p)).toEqual(["2026-10-29"]);
    await p.stop();
  });

  it("당일 입실은 18:00 이후 조회하지 않는다", async () => {
    const p = startPoller(open, {
      yaml: configWith(watchYaml("오늘", "    checkIn: { from: 2026-09-29, to: 2026-09-30 }")),
    });
    await settle();
    expect(days(p)).toEqual(["2026-09-29", "2026-09-30"]);
    await p.clock.advance(9 * 3600_000); // 18:00
    expect(days(p).slice(2)).toEqual(["2026-09-30"]);
    await p.stop();
  });

  it("지난 날짜는 조회하지 않는다", async () => {
    const p = startPoller(open, {
      yaml: configWith(watchYaml("어제부터", "    checkIn: { from: 2026-09-27, to: 2026-09-29 }")),
    });
    await settle();
    expect(days(p)).toEqual(["2026-09-29"]);
    await p.stop();
  });

  it("입실일 범위가 모두 지나면 만료 알림을 한 번만 보내고 더 조회하지 않는다", async () => {
    const p = startPoller(open, {
      yaml: configWith(watchYaml("곧 만료", "    checkIn: { from: 2026-09-29, to: 2026-09-29 }")),
    });
    await settle();
    expect(p.sent).toHaveLength(1); // 빈자리 알림
    await p.clock.advance(9 * 3600_000); // 당일 마감(18:00)이 지나 범위가 모두 지났다
    expect(p.requests).toHaveLength(1);
    expect(p.sent).toHaveLength(2);
    expect(p.sent[1]!.text).toContain("만료");
    expect(p.sent[1]!.text).toContain("곧 만료");
    await p.clock.advance(POLL_MS);
    await p.clock.advance(POLL_MS);
    expect(p.requests).toHaveLength(1);
    expect(p.sent).toHaveLength(2);
    await p.stop();
  });
});

describe("자리 필터 설정 검증", () => {
  const withSeats = (s: string) =>
    configWith(watchYaml("x", `    checkIn: { from: 2026-10-02, to: 2026-10-02 }\n    seats: [${s}]`));
  it.each(["A15-A10", "A10-B15", "abc", "10"])("잘못된 자리 표기 %s를 거부한다", (s) => {
    expect(() => loadConfig(withSeats(`"${s}"`), ENV)).toThrow();
  });
  it("A02와 A10-A15는 받아들인다", () => {
    expect(() => loadConfig(withSeats('A02, "A10-A15", "A20-25"'), ENV)).not.toThrow();
  });
});

describe("캘린더 선필터와 요청 매너", () => {
  const calendars = (p: { allRequests: { url: string }[] }) => p.allRequests.filter((r) => r.url.includes("view_cate="));

  it("대상 날짜와 구역이 모두 매진이면 캘린더 요청만 한 번 나가고 알림은 없다", async () => {
    const p = startPoller(open, { remaining: () => 0 });
    await settle();
    expect(p.allRequests).toHaveLength(1);
    expect(p.allRequests[0]!.url).toBe(
      "https://stay.yd.go.kr/pages/sub.htm?nav_code=gor1501675800&view_cate=2026&view_cate2=9",
    );
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("1박 잔여가 있는 (구역, 날짜)만 자세히 조회한다", async () => {
    const yaml = configWith(`  - name: 여러 구역
    provider: goraebul
    zones: [DKA, DKB, CAA]
    checkIn: { from: 2026-09-29, to: 2026-09-30 }
    nights: 1
    notify: [default]
`);
    const p = startPoller(open, {
      yaml,
      remaining: (zone, date) => (zone === "DKB" && date === "2026-09-30") || (zone === "CAA" && date === "2026-09-29") ? 3 : 0,
    });
    await settle();
    expect(p.requests.map((r) => `${queryOf(r).zone}|${queryOf(r).checkIn}`)).toEqual([
      "DKB|2026-09-30",
      "CAA|2026-09-29",
    ]);
    await p.stop();
  });

  it("입실일이 두 달에 걸치면 월마다 캘린더를 한 번씩만 읽는다", async () => {
    const yaml = configWith(`  - name: 월 경계
    provider: goraebul
    zones: [DKA]
    checkIn: { from: 2026-09-29, to: 2026-10-10 }
    nights: 1
    notify: [default]
`);
    const p = startPoller(open, { yaml, remaining: () => 0 });
    await settle();
    expect(calendars(p).map((r) => new URL(r.url).searchParams.get("view_cate2"))).toEqual(["9", "10"]);
    await p.stop();
  });

  it("한 예약처로 가는 요청은 순서대로, 5초에 0~3초 지터를 더한 간격으로 나간다", async () => {
    const yaml = configWith(`  - name: 여러 구역
    provider: goraebul
    zones: [DKA, DKB, CAA]
    checkIn: { from: 2026-09-29, to: 2026-09-29 }
    nights: 1
    notify: [default]
`);
    for (const [random, gap] of [[0, 5000], [0.5, 6500], [0.999, 7997]] as const) {
      const p = startPoller(open, { yaml, random: () => random });
      await settle();
      expect(p.allRequests).toHaveLength(4); // 캘린더 1 + 구역 3
      const gaps = p.requestTimes.slice(1).map((t, i) => t - p.requestTimes[i]!);
      for (const g of gaps) expect(g).toBeGreaterThanOrEqual(gap - 3);
      for (const g of gaps) expect(g).toBeLessThanOrEqual(gap + 3);
      await p.stop();
    }
  });

  it("바퀴 간격은 설정 간격의 ±20% 안에서 지터가 붙는다", async () => {
    const early = startPoller(open, { random: () => 0 });
    await settle();
    await early.clock.advance(119_000);
    expect(early.allRequests.filter((r) => r.url.includes("view_cate="))).toHaveLength(1);
    await early.clock.advance(1_000);
    expect(early.allRequests.filter((r) => r.url.includes("view_cate="))).toHaveLength(2);
    await early.stop();

    const late = startPoller(open, { random: () => 0.9999 });
    await settle();
    await late.clock.advance(179_000);
    expect(late.allRequests.filter((r) => r.url.includes("view_cate="))).toHaveLength(1);
    await late.clock.advance(2_000);
    expect(late.allRequests.filter((r) => r.url.includes("view_cate="))).toHaveLength(2);
    await late.stop();
  });
});

describe("고래불 실제 캘린더 fixture", () => {
  const ctxFor = (body: string, seen: string[] = []) => ({
    http: {
      get: async (url: string) => {
        seen.push(url);
        return { status: 200, body: url.includes("view_cate=") ? body : open().body };
      },
    },
  });

  it("(N) 잔여가 있는 구역만 상세 조회하고 (마감)과 td.not은 빈 결과로 둔다", async () => {
    const { goraebulAdapter } = await import("../src/adapters/goraebul.js");
    const seen: string[] = [];
    const units = [
      { zone: "DKA", checkIn: "2026-09-29", nights: 1 }, // (34)
      { zone: "PEA", checkIn: "2026-09-29", nights: 1 }, // 캘린더에 없는 구역
      { zone: "DKA", checkIn: "2026-09-15", nights: 1 }, // 지난 날짜(td.not)
    ];
    const res = await goraebulAdapter.queryAvailabilityBatch!(units, ctxFor(fixture("calendar-2026-09.htm"), seen));
    expect(seen.filter((u) => u.includes("zoneAreaAjax"))).toHaveLength(1);
    expect(res.get(units[0]!)).not.toEqual([]);
    expect(res.get(units[1]!)).toEqual([]);
    expect(res.get(units[2]!)).toEqual([]);
  });

  it("캘린더 구조를 읽지 못하면 unrecognized로 실패한다", async () => {
    const { goraebulAdapter } = await import("../src/adapters/goraebul.js");
    const unit = { zone: "DKA", checkIn: "2026-09-29", nights: 1 };
    const res = await goraebulAdapter.queryAvailabilityBatch!([unit], ctxFor("<html></html>"));
    expect(res.get(unit)).toMatchObject({ kind: "unrecognized" });
  });
});

describe("캘린더 실패 격리", () => {
  const run = async (body: string, months: string[]) => {
    const { goraebulAdapter } = await import("../src/adapters/goraebul.js");
    const units = months.map((m) => ({ zone: "DKA", checkIn: `${m}-29`, nights: 1 }));
    const ctx = {
      http: {
        get: async (url: string) => {
          if (!url.includes("view_cate=")) return { status: 200, body: open().body };
          return { status: 200, body: url.includes("view_cate2=9") ? body : calendarHtml("2026-10") };
        },
      },
    };
    return { units, res: await goraebulAdapter.queryAvailabilityBatch!(units, ctx) };
  };

  it("구역 링크에서 type을 읽지 못하면 매진으로 착각하지 않고 unrecognized다", async () => {
    const { units, res } = await run(calendarHtml("2026-09").replaceAll("type=", "kind="), ["2026-09"]);
    expect(res.get(units[0]!)).toMatchObject({ kind: "unrecognized" });
  });

  it("한 달의 캘린더가 깨져도 다른 달 조회 단위는 계속 처리한다", async () => {
    const { units, res } = await run("<html></html>", ["2026-09", "2026-10"]);
    expect(res.get(units[0]!)).toMatchObject({ kind: "unrecognized" });
    expect(Array.isArray(res.get(units[1]!))).toBe(true);
  });
});
