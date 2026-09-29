import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CONFIG_YAML, ENV, configWith, fixture, queryOf, settle, startPoller } from "./harness.js";

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
    expect(p.requests.length).toBeGreaterThan(0);
    for (const r of p.requests) {
      expect(r.headers).toEqual({ "User-Agent": "overlord-availability-poller/0.1.0 (ops)" });
      expect(r.timeoutMs).toBe(10_000);
    }
    await p.stop();
  });

  it("/bbs/ 경로로는 요청하지 않는다", async () => {
    const p = startPoller(open);
    await settle();
    await p.clock.advance(POLL_MS);
    for (const r of p.requests) expect(new URL(r.url).pathname.startsWith("/bbs/")).toBe(false);
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
      yaml: configWith(watchYaml("첫째", range), watchYaml("둘째", `${range}\n    sites: [A02]`)),
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
        watchYaml("필터", '    checkIn: { from: 2026-10-02, to: 2026-10-02 }\n    sites: [A02, "A10-A12"]'),
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
      yaml: configWith(watchYaml("없음", "    checkIn: { from: 2026-10-02, to: 2026-10-02 }\n    sites: [A99]")),
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
