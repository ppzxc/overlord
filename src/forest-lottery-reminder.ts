import type { PollerDeps } from "./poller.js";
import type { Shared } from "./notify.js";
import { kstDate, msUntilNext } from "./schedule.js";

/** 고정된 국립 추첨 일정과 사용자가 확인해 입력한 개별 접수 기간. */
export function lotteryPeriods(date: string, config: PollerDeps["config"]["forestLotteryReminder"]): string[] {
  const day = Number(date.slice(8, 10));
  const labels: string[] = [];
  if (config.types.includes("weekend") && day >= 4 && day <= 9) labels.push("국립 주말 추첨 (매월 4일 09:00~9일 18:00)");
  if (config.types.includes("multiChild") && day >= 4 && day <= 8) labels.push("국립 다자녀 우선예약 추첨 (매월 4일 09:00~8일 18:00)");
  for (const period of config.periods) if (period.from <= date && date <= period.to) labels.push(`${period.name} (${period.from}~${period.to})`);
  return labels;
}

/** 매일 지정 시각에 접수 기간이면 알린다. 재시작 뒤에는 다음 지정 시각부터 보낸다. */
export async function runForestLotteryReminder(deps: { config: Pick<PollerDeps["config"], "forestLotteryReminder">; clock: PollerDeps["clock"] }, shared: Pick<Shared, "send">, signal: AbortSignal): Promise<void> {
  const config = deps.config.forestLotteryReminder;
  if (!config.enabled) return;
  while (!signal.aborted) {
    await deps.clock.sleep(msUntilNext(deps.clock.now(), config.at), signal);
    if (signal.aborted) return;
    const labels = lotteryPeriods(kstDate(deps.clock.now()), config);
    if (!labels.length) continue;
    const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const text = `숲나들e 추첨 신청 기간입니다.\n${labels.map((s) => `• ${escape(s)}`).join("\n")}\n일정과 신청 자격을 숲나들e에서 확인하세요.`;
    for (const name of new Set(config.notify)) {
      await shared.send(name, "forest lottery reminder", (chatId) => ({
        chatId, text, parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "숲나들e 추첨 안내", url: "https://www.foresttrip.go.kr/rep/drlts/drltsUseGdnc.do?hmpgId=FRIP" }]] },
      }));
    }
  }
}
