import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { lotteryPeriods, runForestLotteryReminder } from "../src/forest-lottery-reminder.js";
import type { Sender } from "../src/notify.js";
import { CONFIG_YAML, ENV, FakeClock, settle } from "./harness.js";

describe("숲나들e 추첨 접수 알림", () => {
  const config = loadConfig(`${CONFIG_YAML}\nforestLotteryReminder:\n  enabled: true\n  periods:\n    - { name: '월 추첨', from: '2026-12-02', to: '2026-12-04' }\n`, ENV).forestLotteryReminder;
  it("국립 일정과 직접 입력한 기간의 양끝을 포함한다", () => {
    expect(lotteryPeriods("2026-12-02", config)).toHaveLength(1);
    expect(lotteryPeriods("2026-12-04", config)).toHaveLength(3);
    expect(lotteryPeriods("2026-12-08", config)).toHaveLength(2);
    expect(lotteryPeriods("2026-12-09", config)).toHaveLength(1);
    expect(lotteryPeriods("2026-12-10", config)).toEqual([]);
  });
  it("접수 기간에 하루 한 번만 전송하고 종료 신호에 멈춘다", async () => {
    const clock = new FakeClock("2026-12-04T09:30:00+09:00");
    const controller = new AbortController();
    const sent: string[] = [];
    const send: Sender = async (_name, _label, build) => { sent.push(build("42").text); return true; };
    const shared = { send };
    const deps = { config: { forestLotteryReminder: config }, clock };
    const task = runForestLotteryReminder(deps, shared, controller.signal);
    await clock.advance(30 * 60_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("다자녀");
    await clock.advance(24 * 60 * 60_000);
    expect(sent).toHaveLength(2);
    controller.abort();
    await settle();
    await task;
  });
  it("알 수 없는 수신처와 접수 시간 밖의 알림 시각을 거부한다", () => {
    expect(() => loadConfig(`${CONFIG_YAML}\nforestLotteryReminder: { enabled: true, notify: [missing] }`, ENV)).toThrow("missing");
    expect(() => loadConfig(`${CONFIG_YAML}\nforestLotteryReminder: { enabled: true, at: '18:00' }`, ENV)).toThrow("18:00");
  });
});
