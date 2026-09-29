import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CONFIG_YAML, ENV, fixture, settle, startPoller } from "./harness.js";

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
    await p.clock.advance(150_000);
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
    await p.clock.advance(150_000);
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
    await p.clock.advance(150_000);
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

describe("설정 로딩", () => {
  it("${VAR}를 환경 변수로 치환한다", () => {
    expect(loadConfig(CONFIG_YAML, ENV).notifiers["default"]?.botToken).toBe("tok");
  });

  it("참조한 환경 변수가 비어 있으면 거부한다", () => {
    expect(() => loadConfig(CONFIG_YAML, { ...ENV, TELEGRAM_BOT_TOKEN: "" })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});
