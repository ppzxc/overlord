import { describe, expect, it } from "vitest";
import { goraebulAdapter } from "../src/adapters/goraebul.js";
import { loadConfig } from "../src/config.js";
import { AdapterError, type ProviderAdapter } from "../src/types.js";
import { TelegramError } from "../src/telegram.js";
import {
  CONFIG_YAML,
  ENV,
  calendarHtml,
  configWith,
  fixture,
  queryOf,
  settle,
  startPoller,
} from "./harness.js";

const POLL_MS = 150_000;
const open = () => ({
  status: 200,
  body: fixture("dka-2026-09-29-1night.htm"),
});
const soldOut = () => ({
  status: 200,
  body: fixture("dka-2026-09-30-2nights-soldout.htm"),
});

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
      expect(r.headers).toEqual({
        "User-Agent": "overlord-availability-poller/0.1.0 (ops)",
      });
      expect(r.timeoutMs).toBe(10_000);
    }
    await p.stop();
  });

  it("/bbs/ 경로로는 요청하지 않는다", async () => {
    const p = startPoller(open);
    await settle();
    await p.clock.advance(POLL_MS);
    for (const r of p.allRequests)
      expect(new URL(r.url).pathname.startsWith("/bbs/")).toBe(false);
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

  it("차단 페이지를 받으면 빈자리 알림은 없고 차단 알림만 보낸다", async () => {
    const p = startPoller(() => ({
      status: 200,
      body: "<html>영덕군 전산팀 문의</html>",
    }));
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("차단");
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
    expect(loadConfig(CONFIG_YAML, ENV).notifiers["default"]?.botToken).toBe(
      "tok",
    );
  });

  it("참조한 환경 변수가 비어 있으면 거부한다", () => {
    expect(() =>
      loadConfig(CONFIG_YAML, { ...ENV, TELEGRAM_BOT_TOKEN: "" }),
    ).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});

const watchYaml = (name: string, body: string) => `
  - name: ${name}
    provider: goraebul
    zones: [DKA]
    notify: [default]
${body}`;
const days = (p: { requests: Parameters<typeof queryOf>[0][] }) =>
  p.requests.map((r) => queryOf(r).checkIn);

describe("감시 조건 전개", () => {
  it("입실일 범위 안에서 요일 필터에 맞는 날짜만 조회한다", async () => {
    // 2026-10-01(목) ~ 10-07(수). 금·토는 10-02, 10-03. 모두 오늘(09-29)+30일 안이라 열려 있다.
    const p = startPoller(open, {
      yaml: configWith(
        watchYaml(
          "주말",
          "    checkIn: { from: 2026-10-01, to: 2026-10-07 }\n    weekdays: [fri, sat]",
        ),
      ),
    });
    await settle();
    expect(days(p)).toEqual(["2026-10-02", "2026-10-03"]);
    await p.stop();
  });

  it("박수를 생략하면 1박으로, 주면 N박으로 조회한다", async () => {
    const one = startPoller(open, {
      yaml: configWith(
        watchYaml("a", "    checkIn: { from: 2026-10-02, to: 2026-10-02 }"),
      ),
    });
    const two = startPoller(soldOut, {
      yaml: configWith(
        watchYaml(
          "b",
          "    checkIn: { from: 2026-10-02, to: 2026-10-02 }\n    nights: 2",
        ),
      ),
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
      yaml: configWith(
        watchYaml("첫째", range),
        watchYaml("둘째", `${range}\n    seats: [A02]`),
      ),
    });
    await settle();
    expect(p.requests).toHaveLength(1);
    expect(p.sent).toHaveLength(1); // 같은 알림 대상에는 메시지 한 건
    expect(p.sent[0]!.text).toContain("첫째");
    expect(p.sent[0]!.text).toContain("둘째");
    expect(p.sent[0]!.reply_markup?.inline_keyboard).toHaveLength(1); // 같은 예약 화면 버튼은 한 번만
    await p.stop();
  });

  it("자리 필터에 맞지 않는 빈자리는 알리지 않는다", async () => {
    const p = startPoller(open, {
      yaml: configWith(
        watchYaml(
          "필터",
          '    checkIn: { from: 2026-10-02, to: 2026-10-02 }\n    seats: [A02, "A10-A12"]',
        ),
      ),
    });
    await settle();
    const text = p.sent[0]!.text;
    for (const n of ["A02호", "A10호", "A11호", "A12호"])
      expect(text).toContain(n);
    for (const n of ["A04호", "A13호", "A15호"]) expect(text).not.toContain(n);
    await p.stop();
  });

  it("필터에 맞는 자리가 하나도 없으면 메시지를 보내지 않는다", async () => {
    const p = startPoller(open, {
      yaml: configWith(
        watchYaml(
          "없음",
          "    checkIn: { from: 2026-10-02, to: 2026-10-02 }\n    seats: [A01]",
        ),
      ),
    });
    await settle();
    expect(p.requests).toHaveLength(1);
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("아직 열리지 않은 날짜는 조회하지 않고, 오픈 시각(D−30일 10:00)을 지나면 조회한다", async () => {
    // 10-29는 09-29 10:00(KST)에 열린다. 시작 시각은 09:00이다.
    const p = startPoller(open, {
      yaml: configWith(
        watchYaml(
          "먼 날짜",
          "    checkIn: { from: 2026-10-29, to: 2026-10-29 }",
        ),
      ),
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
      yaml: configWith(
        watchYaml("오늘", "    checkIn: { from: 2026-09-29, to: 2026-09-30 }"),
      ),
    });
    await settle();
    expect(days(p)).toEqual(["2026-09-29", "2026-09-30"]);
    await p.clock.advance(9 * 3600_000); // 18:00
    expect(days(p).slice(2)).toEqual(["2026-09-30"]);
    await p.stop();
  });

  it("지난 날짜는 조회하지 않는다", async () => {
    const p = startPoller(open, {
      yaml: configWith(
        watchYaml(
          "어제부터",
          "    checkIn: { from: 2026-09-27, to: 2026-09-29 }",
        ),
      ),
    });
    await settle();
    expect(days(p)).toEqual(["2026-09-29"]);
    await p.stop();
  });

  it("입실일 범위가 모두 지나면 만료 알림을 한 번만 보내고 더 조회하지 않는다", async () => {
    const p = startPoller(open, {
      yaml: configWith(
        watchYaml(
          "곧 만료",
          "    checkIn: { from: 2026-09-29, to: 2026-09-29 }",
        ),
      ),
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
    configWith(
      watchYaml(
        "x",
        `    checkIn: { from: 2026-10-02, to: 2026-10-02 }\n    seats: [${s}]`,
      ),
    );
  it.each(["A15-A10", "A10-B15", "abc", "10"])(
    "잘못된 자리 표기 %s를 거부한다",
    (s) => {
      expect(() => loadConfig(withSeats(`"${s}"`), ENV)).toThrow();
    },
  );
  it("A02와 A10-A15는 받아들인다", () => {
    expect(() =>
      loadConfig(withSeats('A02, "A10-A15", "A20-25"'), ENV),
    ).not.toThrow();
  });
});

describe("캘린더 선필터와 요청 매너", () => {
  const calendars = (p: { allRequests: { url: string }[] }) =>
    p.allRequests.filter((r) => r.url.includes("view_cate="));

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
      remaining: (zone, date) =>
        (zone === "DKB" && date === "2026-09-30") ||
        (zone === "CAA" && date === "2026-09-29")
          ? 3
          : 0,
    });
    await settle();
    expect(
      p.requests.map((r) => `${queryOf(r).zone}|${queryOf(r).checkIn}`),
    ).toEqual(["DKB|2026-09-30", "CAA|2026-09-29"]);
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
    expect(
      calendars(p).map((r) => new URL(r.url).searchParams.get("view_cate2")),
    ).toEqual(["9", "10"]);
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
    for (const [random, gap] of [
      [0, 5000],
      [0.5, 6500],
      [0.999, 7997],
    ] as const) {
      const p = startPoller(open, { yaml, random: () => random });
      await settle();
      expect(p.allRequests).toHaveLength(4); // 캘린더 1 + 구역 3
      const gaps = p.requestTimes
        .slice(1)
        .map((t, i) => t - p.requestTimes[i]!);
      for (const g of gaps) expect(g).toBeGreaterThanOrEqual(gap - 3);
      for (const g of gaps) expect(g).toBeLessThanOrEqual(gap + 3);
      await p.stop();
    }
  });

  it("바퀴 간격은 설정 간격의 ±20% 안에서 지터가 붙는다", async () => {
    const early = startPoller(open, { random: () => 0 });
    await settle();
    await early.clock.advance(119_000);
    expect(
      early.allRequests.filter((r) => r.url.includes("view_cate=")),
    ).toHaveLength(1);
    await early.clock.advance(1_000);
    expect(
      early.allRequests.filter((r) => r.url.includes("view_cate=")),
    ).toHaveLength(2);
    await early.stop();

    const late = startPoller(open, { random: () => 0.9999 });
    await settle();
    await late.clock.advance(179_000);
    expect(
      late.allRequests.filter((r) => r.url.includes("view_cate=")),
    ).toHaveLength(1);
    await late.clock.advance(2_000);
    expect(
      late.allRequests.filter((r) => r.url.includes("view_cate=")),
    ).toHaveLength(2);
    await late.stop();
  });
});

describe("고래불 실제 캘린더 fixture", () => {
  const ctxFor = (body: string, seen: string[] = []) => ({
    http: {
      get: async (url: string) => {
        seen.push(url);
        return {
          status: 200,
          body: url.includes("view_cate=") ? body : open().body,
        };
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
    const res = await goraebulAdapter.queryAvailabilityBatch!(
      units,
      ctxFor(fixture("calendar-2026-09.htm"), seen),
    );
    expect(seen.filter((u) => u.includes("zoneAreaAjax"))).toHaveLength(1);
    expect(res.get(units[0]!)).not.toEqual([]);
    expect(res.get(units[1]!)).toEqual([]);
    expect(res.get(units[2]!)).toEqual([]);
  });

  it("캘린더 구조를 읽지 못하면 unrecognized로 실패한다", async () => {
    const { goraebulAdapter } = await import("../src/adapters/goraebul.js");
    const unit = { zone: "DKA", checkIn: "2026-09-29", nights: 1 };
    const res = await goraebulAdapter.queryAvailabilityBatch!(
      [unit],
      ctxFor("<html></html>"),
    );
    expect(res.get(unit)).toMatchObject({ kind: "unrecognized" });
  });
});

describe("캘린더 실패 격리", () => {
  const run = async (body: string, months: string[]) => {
    const { goraebulAdapter } = await import("../src/adapters/goraebul.js");
    const units = months.map((m) => ({
      zone: "DKA",
      checkIn: `${m}-29`,
      nights: 1,
    }));
    const ctx = {
      http: {
        get: async (url: string) => {
          if (!url.includes("view_cate="))
            return { status: 200, body: open().body };
          return {
            status: 200,
            body: url.includes("view_cate2=9") ? body : calendarHtml("2026-10"),
          };
        },
      },
    };
    return {
      units,
      res: await goraebulAdapter.queryAvailabilityBatch!(units, ctx),
    };
  };

  it("구역 링크에서 type을 읽지 못하면 매진으로 착각하지 않고 unrecognized다", async () => {
    const { units, res } = await run(
      calendarHtml("2026-09").replaceAll("type=", "kind="),
      ["2026-09"],
    );
    expect(res.get(units[0]!)).toMatchObject({ kind: "unrecognized" });
  });

  it("한 달의 캘린더가 깨져도 다른 달 조회 단위는 계속 처리한다", async () => {
    const { units, res } = await run("<html></html>", ["2026-09", "2026-10"]);
    expect(res.get(units[0]!)).toMatchObject({ kind: "unrecognized" });
    expect(Array.isArray(res.get(units[1]!))).toBe(true);
  });
});

describe("Telegram 알림 완성", () => {
  const watchesOver = (days: number, extra = "") =>
    configWith(
      watchYaml(
        "긴 범위",
        `    checkIn: { from: 2026-09-29, to: 2026-${days > 2 ? "10" : "09"}-${String(28 + days - (days > 2 ? 30 : 0)).padStart(2, "0")} }${extra}`,
      ),
    );

  it("감시 조건별 블록에 날짜(요일) N박 · 구역명 · 자리 번호들을 적는다", async () => {
    const p = startPoller(open);
    await settle();
    const lines = p.sent[0]!.text.split("\n");
    expect(lines[1]).toBe("<b>9월 말 숲속야영장</b>");
    expect(lines[2]).toMatch(/^2026-09-29\(화\) 1박 · .+ · .*텐트사이트 A02호/);
    await p.stop();
  });

  it("(구역, 입실일)이 여덟 개를 넘으면 버튼은 여덟 개까지만 붙고 나머지는 본문 링크로 준다", async () => {
    const p = startPoller(open, {
      yaml: watchesOver(10, "\n    seats: [A02]"),
    });
    await settle();
    const total = p.requests.length;
    expect(total).toBeGreaterThan(8);
    const buttons = p.sent.flatMap(
      (m) => m.reply_markup?.inline_keyboard.flat() ?? [],
    );
    expect(
      p.sent.every((m) => (m.reply_markup?.inline_keyboard.length ?? 0) <= 8),
    ).toBe(true);
    const bodyLinks = p.sent.flatMap(
      (m) => m.text.match(/<a href="[^"]+">/g) ?? [],
    );
    expect(buttons.length + bodyLinks.length).toBe(total);
    expect(bodyLinks.length).toBeGreaterThan(0);
    await p.stop();
  });

  it("4096자를 넘으면 나눠 보내고 각 메시지는 한도 안이다", async () => {
    const p = startPoller(open, {
      yaml: configWith(
        ...Array.from({ length: 30 }, (_, i) =>
          watchYaml(
            `${"긴이름".repeat(20)}${i}`,
            `    checkIn: { from: 2026-09-29, to: 2026-09-29 }`,
          ),
        ),
      ),
    });
    await settle();
    expect(p.sent.length).toBeGreaterThan(1);
    for (const m of p.sent) expect(m.text.length).toBeLessThanOrEqual(4096);
    await p.stop();
  });

  it("여러 메시지로 나뉜 알림 중 뒤쪽이 실패해도 그 자리들은 다음 바퀴에 다시 보낸다", async () => {
    const seatCount = 500;
    const names = Array.from(
      { length: seatCount },
      (_, i) => `텐트사이트 A${String(i + 1).padStart(3, "0")}호`,
    );
    const html = `<div id="zone_dka" class="select_room">${names
      .map(
        (n, i) =>
          `<a href="#" onclick="zone_area_select('${i}','dka_${i}','${n}');return false;" id="dka_${i}" class="num "><span>${i}</span></a>`,
      )
      .join("")}</div>`;
    let calls = 0;
    // 첫 메시지는 나가고, 둘째 메시지는 재시도까지 모두 실패한 뒤 다음 바퀴에서 나간다.
    const p = startPoller(() => ({ status: 200, body: html }), {
      failSend: () =>
        ++calls >= 2 && calls <= 5 ? new TelegramError("서버", 502) : false,
    });
    await settle();
    expect(p.sent).toHaveLength(1);
    await p.clock.advance(POLL_MS);
    const delivered = new Set(
      p.sent.flatMap((m) => names.filter((n) => m.text.includes(n))),
    );
    expect(delivered.size).toBe(seatCount);
    await p.stop();
  });

  it("429는 retry_after를 지켜 다시 보낸다", async () => {
    let n = 0;
    const p = startPoller(open, {
      failSend: () => (n++ === 0 ? new TelegramError("한도", 429, 30) : false),
    });
    await settle();
    expect(p.sent).toHaveLength(0);
    await p.clock.advance(29_000);
    expect(p.sent).toHaveLength(0);
    await p.clock.advance(1_000);
    expect(p.sent).toHaveLength(1);
    await p.stop();
  });

  it("5xx는 최대 세 번 다시 시도하고 그래도 안 되면 다음 바퀴에 다시 보낸다", async () => {
    let fail = true;
    const p = startPoller(open, {
      failSend: () => fail && new TelegramError("서버", 502),
    });
    await settle();
    expect(p.attempts()).toBe(4); // 첫 시도 + 재시도 3회
    expect(p.sent).toHaveLength(0);
    fail = false;
    await p.clock.advance(POLL_MS);
    expect(p.sent).toHaveLength(1);
    await p.stop();
  });

  it("잘못된 요청(4xx)은 다시 시도하지 않는다", async () => {
    const p = startPoller(open, {
      failSend: () => new TelegramError("chat 없음", 400),
    });
    await settle();
    expect(p.attempts()).toBe(1);
    await p.stop();
  });

  it("notifiers에 없는 알림 대상은 설정 검증에서 거부한다", () => {
    expect(() =>
      loadConfig(
        configWith(
          watchYaml(
            "x",
            "    checkIn: { from: 2026-10-02, to: 2026-10-02 }",
          ).replace("[default]", "[nowhere]"),
        ),
        ENV,
      ),
    ).toThrow(/nowhere[\s\S]*default/);
  });
});

describe("헬스 상태 머신", () => {
  const blockedPage = () => ({ status: 200, body: "<html>영덕군 전산팀 문의</html>" });
  const serverError = () => ({ status: 503, body: "" });
  const healthTexts = (p: { sent: { text: string }[] }) => p.sent.map((m) => m.text);

  it("차단 페이지를 받으면 즉시 멈추고 재시작 안내를 보낸 뒤 더 요청하지 않는다", async () => {
    const p = startPoller(blockedPage);
    await settle();
    const before = p.allRequests.length;
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("차단");
    expect(p.sent[0]!.text).toContain("재시작");
    await p.clock.advance(POLL_MS * 3);
    expect(p.allRequests).toHaveLength(before);
    expect(p.sent).toHaveLength(1);
    await p.stop();
  });

  it("차단으로 멈춘 예약처는 24시간마다 한 번 리마인드한다", async () => {
    const p = startPoller(blockedPage);
    await settle();
    await p.clock.advance(23 * 3600_000);
    expect(p.sent).toHaveLength(1);
    await p.clock.advance(3600_000);
    expect(p.sent).toHaveLength(2);
    expect(p.sent[1]!.text).toContain("계속");
    await p.stop();
  });

  it("구조 검증 실패는 한 바퀴는 계속 돌고 연속 2바퀴면 unrecognized로 멈춘다", async () => {
    const p = startPoller(() => ({ status: 200, body: "<html></html>" }), { remaining: () => 9 });
    await settle();
    // 상세 페이지가 구조에 맞지 않는 경우: 첫 바퀴는 알림 없이 계속
    expect(p.sent).toHaveLength(0);
    await p.clock.advance(POLL_MS);
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("구조");
    const before = p.allRequests.length;
    await p.clock.advance(POLL_MS * 3);
    expect(p.allRequests).toHaveLength(before);
    await p.stop();
  });

  it("성공한 바퀴가 끼면 unrecognized 연속 횟수가 0으로 돌아간다", async () => {
    let bad = true;
    const p = startPoller(() => (bad ? { status: 200, body: "<html></html>" } : soldOut()));
    await settle();
    bad = false;
    await p.clock.advance(POLL_MS);
    bad = true;
    await p.clock.advance(POLL_MS);
    expect(p.sent).toHaveLength(0);
    await p.stop();
  });

  it("transient 실패는 간격을 두 배씩 늘리고(상한 30분) 성공하면 원래 간격으로 돌아온다", async () => {
    let fail = true;
    const p = startPoller(() => (fail ? serverError() : soldOut()));
    await settle();
    const count = () => p.requests.length;
    expect(count()).toBe(1);
    await p.clock.advance(299_000);
    expect(count()).toBe(1);
    await p.clock.advance(1_000); // 300초 = 2배
    expect(count()).toBe(2);
    await p.clock.advance(599_000);
    expect(count()).toBe(2);
    await p.clock.advance(1_000); // 600초 = 4배
    expect(count()).toBe(3);
    await p.clock.advance(1_200_000); // 1200초 = 8배
    expect(count()).toBe(4);
    await p.clock.advance(1_800_000); // 상한 30분
    expect(count()).toBe(5);
    await p.clock.advance(1_800_000);
    expect(count()).toBe(6);
    fail = false;
    await p.clock.advance(1_800_000);
    expect(count()).toBe(7); // 성공
    await p.clock.advance(POLL_MS);
    expect(count()).toBe(8); // 원래 간격
    await p.stop();
  });

  it("transient가 5바퀴 이상 15분 이상 이어지면 degraded를 한 번 알리고 회복하면 recovered를 한 번 알린다", async () => {
    let fail = true;
    const p = startPoller(() => (fail ? serverError() : soldOut()));
    await settle();
    for (const ms of [300_000, 600_000, 1_200_000]) await p.clock.advance(ms);
    expect(p.sent).toHaveLength(0); // 4바퀴
    await p.clock.advance(1_800_000); // 5바퀴, 경과 60분
    expect(healthTexts(p)).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("계속 실패");
    await p.clock.advance(1_800_000);
    expect(p.sent).toHaveLength(1); // 같은 상태는 다시 알리지 않는다
    fail = false;
    await p.clock.advance(1_800_000);
    expect(p.sent).toHaveLength(2);
    expect(p.sent[1]!.text).toContain("회복");
    await p.clock.advance(POLL_MS * 2);
    expect(p.sent).toHaveLength(2);
    await p.stop();
  });

  it("점검 중(unavailable)이면 30분 간격으로 확인하고 알림은 한 번만 보낸다", async () => {
    const adapter = {
      ...goraebulAdapter,
      queryAvailability: async () => {
        throw new AdapterError("unavailable", "점검 중");
      },
    } as ProviderAdapter;
    const p = startPoller(open, { adapters: { goraebul: { ...adapter, queryAvailabilityBatch: undefined } } });
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("점검");
    await p.clock.advance(POLL_MS * 2);
    expect(p.sent).toHaveLength(1);
    await p.clock.advance(3 * 3600_000);
    expect(p.sent).toHaveLength(1);
    await p.stop();
  });

  it("같은 장애가 이어지면 24시간마다 한 번만 리마인드한다", async () => {
    const adapter = {
      ...goraebulAdapter,
      queryAvailabilityBatch: undefined,
      queryAvailability: async () => {
        throw new AdapterError("unavailable", "점검 중");
      },
    } as ProviderAdapter;
    const yaml = CONFIG_YAML.replace("to: 2026-09-29", "to: 2026-10-20");
    const p = startPoller(open, { yaml, adapters: { goraebul: adapter } });
    await settle();
    expect(p.sent).toHaveLength(1);
    await p.clock.advance(23 * 3600_000);
    expect(p.sent).toHaveLength(1);
    await p.clock.advance(2 * 3600_000);
    expect(p.sent).toHaveLength(2);
    expect(p.sent[1]!.text).toContain("계속");
    await p.stop();
  });

  it("한 예약처가 멈춰도 다른 예약처는 계속 돈다", async () => {
    let calls = 0;
    const other: ProviderAdapter = {
      ...goraebulAdapter,
      id: "other",
      queryAvailabilityBatch: undefined,
      queryAvailability: async () => {
        calls++;
        return [];
      },
    };
    const yaml = configWith(
      `  - { name: 고래불, provider: goraebul, zones: [DKA], checkIn: { from: 2026-09-29, to: 2026-09-29 }, nights: 1, notify: [default] }`,
      `  - { name: 다른곳, provider: other, zones: [DKA], checkIn: { from: 2026-09-29, to: 2026-09-29 }, nights: 1, notify: [default] }`,
    ).replace("providers:\n", "providers:\n  other: { pollIntervalSeconds: 150 }\n");
    const p = startPoller(blockedPage, { yaml, adapters: { goraebul: goraebulAdapter, other } });
    await settle();
    for (let i = 0; i < 3; i++) await p.clock.advance(POLL_MS);
    expect(p.sent.filter((m) => m.text.includes("차단"))).toHaveLength(1);
    expect(calls).toBeGreaterThanOrEqual(3);
    await p.stop();
  });

  it("바퀴 도중 실패하면 그 바퀴를 중단하되 이미 성공한 조회 결과는 반영한다", async () => {
    const seen: string[] = [];
    const adapter: ProviderAdapter = {
      ...goraebulAdapter,
      queryAvailabilityBatch: undefined,
      queryAvailability: async (q) => {
        seen.push(q.checkIn);
        if (q.checkIn === "2026-09-30") throw new AdapterError("transient", "HTTP 503");
        return q.checkIn === "2026-09-29" ? [{ id: "A02", name: "A02" }] : [];
      },
    };
    const yaml = configWith(
      `  - { name: 여러날, provider: goraebul, zones: [DKA], checkIn: { from: 2026-09-29, to: 2026-10-01 }, nights: 1, notify: [default] }`,
    );
    const p = startPoller(open, { yaml, adapters: { goraebul: adapter } });
    await settle();
    expect(seen).toEqual(["2026-09-29", "2026-09-30"]); // 10-01은 조회하지 않는다
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("A02");
    await p.stop();
  });
});

describe("헬스 상태 머신 회귀", () => {
  it("첫 알림 전송이 실패하면 24시간이 아니라 기본 간격으로 다시 시도한다", async () => {
    let failing = true;
    const p = startPoller(() => ({ status: 200, body: "<html>영덕군 전산팀 문의</html>" }), {
      failSend: () => failing,
    });
    await settle();
    expect(p.sent).toHaveLength(0);
    failing = false;
    await p.clock.advance(POLL_MS * 2);
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("차단");
    await p.stop();
  });
});

describe("quietHours, 일일 요약, dead-man ping", () => {
  // 하네스 기본 설정은 일일 요약을 끈다. 요약을 다루는 테스트는 top에서 다시 켠다.
  const withTop = (top: string) =>
    (top.startsWith("dailySummary") ? CONFIG_YAML.replace("dailySummary: { enabled: false }\n", "") : CONFIG_YAML).replace(
      "providers:",
      `${top}\nproviders:`,
    );
  const PING = "https://hc.example/ping/abc";
  const pings = (p: { allRequests: { url: string; headers?: unknown }[] }) => p.allRequests.filter((r) => r.url === PING);

  it("quietHours 안에서는 모든 이벤트를 무음으로 보내고 바퀴 간격이 3배가 된다", async () => {
    const p = startPoller(open, { yaml: withTop('quietHours: { from: "08:00", to: "10:00" }') });
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.disable_notification).toBe(true);
    await p.clock.advance(POLL_MS);
    expect(p.requests).toHaveLength(1);
    await p.clock.advance(POLL_MS * 2);
    expect(p.requests).toHaveLength(2);
    await p.stop();
  });

  it("자정을 넘는 quietHours도 지킨다", async () => {
    const p = startPoller(open, { yaml: withTop('quietHours: { from: "22:00", to: "10:00" }') });
    await settle();
    expect(p.sent[0]!.disable_notification).toBe(true);
    await p.stop();
  });

  it("quietHours 밖이거나 설정하지 않으면 소리가 나고 간격도 그대로다", async () => {
    const outside = startPoller(open, { yaml: withTop('quietHours: { from: "02:00", to: "06:00" }') });
    const none = startPoller(open);
    await settle();
    expect(outside.sent[0]!.disable_notification).toBeUndefined();
    expect(none.sent[0]!.disable_notification).toBeUndefined();
    await outside.clock.advance(POLL_MS);
    expect(outside.requests).toHaveLength(2);
    await outside.stop();
    await none.stop();
  });

  it("일일 요약은 설정한 시각에 무음으로 한 건 나가고 전날 바퀴 수와 실패 수를 담는다", async () => {
    let fail = true;
    const p = startPoller(() => (fail ? { status: 503, body: "" } : soldOut()), {
      yaml: withTop('dailySummary: { at: "09:00" }').replace("to: 2026-09-29", "to: 2026-10-03"),
    });
    await settle();
    fail = false; // 첫 바퀴만 실패한다. 백오프로 두 배가 된 간격 뒤의 두 번째 바퀴는 성공한다.
    await p.clock.advance(POLL_MS * 2);
    // 다음 날 09:00까지 넘긴다.
    await p.clock.advance(24 * 3600_000);
    const summaries = p.sent.filter((m) => m.text.includes("일일 요약"));
    expect(summaries).toHaveLength(1);
    const s = summaries[0]!;
    expect(s.disable_notification).toBe(true);
    expect(s.text).toContain("goraebul");
    expect(s.text).toContain("정상");
    expect(s.text).toContain("활성 감시 조건: 1건");
    expect(s.text).toContain("바퀴 2회, 실패 1회");
    expect(s.text).toContain("곧 만료");
    await p.stop();
  });

  it("dailySummary.enabled를 끄면 요약을 보내지 않는다", async () => {
    const p = startPoller(soldOut, { yaml: withTop("dailySummary: { enabled: false }") });
    await settle();
    await p.clock.advance(25 * 3600_000);
    expect(p.sent.filter((m) => m.text.includes("일일 요약"))).toHaveLength(0);
    await p.stop();
  });

  it("deadManPingUrl이 있으면 바퀴가 끝날 때마다 헤더 없이 GET만 보낸다", async () => {
    const p = startPoller(soldOut, { yaml: withTop(`deadManPingUrl: ${PING}`) });
    await settle();
    expect(pings(p)).toHaveLength(1);
    expect(pings(p)[0]!.headers).toEqual({});
    await p.clock.advance(POLL_MS);
    expect(pings(p)).toHaveLength(2);
    await p.stop();
  });

  it("deadManPingUrl을 설정하지 않으면 ping을 보내지 않는다", async () => {
    const p = startPoller(soldOut);
    await settle();
    expect(p.allRequests.every((r) => new URL(r.url).hostname === "stay.yd.go.kr")).toBe(true);
    await p.stop();
  });

  it("알림 채널이 계속 실패하면 ping을 보내지 않고 회복하면 다시 보낸다", async () => {
    let broken = true;
    const p = startPoller(open, {
      yaml: withTop(`deadManPingUrl: ${PING}`),
      failSend: () => broken && new TelegramError("잘못된 요청", 400),
    });
    await settle();
    await p.clock.advance(POLL_MS);
    expect(pings(p)).toHaveLength(0);
    broken = false;
    await p.clock.advance(POLL_MS);
    expect(pings(p)).toHaveLength(1);
    await p.stop();
  });

  it("quietHours와 dailySummary 형식이 틀리면 설정을 거부한다", () => {
    expect(() => loadConfig(withTop('quietHours: { from: "25:00", to: "06:00" }'), ENV)).toThrow(/quietHours/);
    expect(() => loadConfig(withTop('dailySummary: { at: "9시" }'), ENV)).toThrow(/dailySummary/);
  });
});
