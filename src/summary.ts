import type { PollerDeps } from "./poller.js";
import type { Shared } from "./notify.js";
import { addDays, isExpired, kstDate, msUntilNext } from "./schedule.js";
import { renderSummary } from "./telegram.js";

/** 일일 요약에서 "곧 만료"로 치는 남은 일수. */
const EXPIRING_DAYS = 7;
/** 요약 전송이 실패했을 때 다시 시도하는 간격과 횟수. */
const RETRY_MS = 10 * 60_000;
const MAX_RETRIES = 5;

/** 설정한 시각마다 무음 일일 요약을 알림 대상마다 한 건씩 보낸다. 실패한 대상은 몇 번 더 시도한다. */
export async function runDailySummary(
  deps: PollerDeps,
  providers: string[],
  shared: Shared,
  signal: AbortSignal,
): Promise<void> {
  const { config, clock } = deps;
  if (!config.dailySummary.enabled) return;
  const notifierNames = [...new Set(config.watches.flatMap((w) => w.notify))];
  const rules = new Map(providers.map((id) => [id, deps.adapters[id]!.describe().openingRule]));
  while (!signal.aborted) {
    await clock.sleep(msUntilNext(clock.now(), config.dailySummary.at), signal);
    if (signal.aborted) return;
    const now = clock.now();
    const today = kstDate(now);
    const yesterday = addDays(today, -1);
    const live = config.watches.filter((w) => !isExpired(w, rules.get(w.provider)!, now));
    const expiring = live
      .filter((w) => w.checkIn.to <= addDays(today, EXPIRING_DAYS))
      .map((w) => ({ name: w.name, lastCheckIn: w.checkIn.to }));
    const summary = (chatId: string) =>
      renderSummary({
        chatId,
        date: yesterday,
        activeWatches: live.length,
        expiring,
        providers: providers.map((id) => {
          const st = shared.stats.get(id);
          // 기록이 없으면(재시작 직후 등) 0회로 착각하지 않도록 비워 둔다.
          return { id, status: st?.health.status ?? "ok", day: st?.days.get(yesterday) };
        }),
      });
    let remaining = notifierNames;
    for (let attempt = 0; remaining.length > 0 && !signal.aborted; attempt++) {
      if (attempt > 0) {
        if (attempt > MAX_RETRIES) break;
        await clock.sleep(RETRY_MS, signal);
        if (signal.aborted) return;
      }
      const failed: string[] = [];
      for (const name of remaining) if (!(await shared.send(name, "daily summary", summary))) failed.push(name);
      remaining = failed;
    }
  }
}
