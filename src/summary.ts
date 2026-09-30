import type { PollerDeps } from "./poller.js";
import type { Shared } from "./notify.js";
import { addDays, isExpired, isQuiet, kstDate, kstHhmm, kstHourKey, msUntilNext, msUntilNextHourMark } from "./schedule.js";
import { renderHourlySummary, renderSummary } from "./telegram.js";

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
          return { id, status: st?.health.status ?? "ok", day: st?.days.get(yesterday), lastSuccessAt: st?.lastSuccessAt, statusSince: st?.statusSince };
        }),
        startedAt: shared.startedAt,
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

/** 정각(설정한 간격의 배수 시)마다 무음 시간별 요약을 알림 대상마다 한 건씩 보낸다. 실패하면 다음 정각을 기다린다. */
export async function runHourlySummary(
  deps: PollerDeps,
  providers: string[],
  shared: Shared,
  signal: AbortSignal,
): Promise<void> {
  const { config, clock } = deps;
  const { enabled, everyHours } = config.hourlySummary;
  if (!enabled) return;
  const notifierNames = [...new Set(config.watches.flatMap((w) => w.notify))];
  let cursor = clock.now();
  while (!signal.aborted) {
    const target = cursor.getTime() + msUntilNextHourMark(cursor, everyHours);
    await clock.sleep(target - clock.now().getTime(), signal);
    if (signal.aborted) return;
    // 타이머가 정각보다 조금 일찍 깨도 정각으로 본다. 아니면 창이 한 시간 밀리고 같은 정각에 한 번 더 보낸다.
    const now = new Date(Math.max(clock.now().getTime(), target));
    cursor = now;
    if (isQuiet(now, config.quietHours)) continue;
    // 일일 요약과 같은 시각이면 예약처 상태가 이미 그쪽에 있다.
    if (config.dailySummary.enabled && kstHhmm(now) === config.dailySummary.at) continue;
    const window = Array.from({ length: everyHours }, (_, i) => kstHourKey(new Date(now.getTime() - (i + 1) * 3600_000)));
    const summary = (chatId: string) =>
      renderHourlySummary({
        chatId,
        everyHours,
        providers: providers.map((id) => {
          const st = shared.stats.get(id);
          const day = { rounds: 0, failures: 0 };
          for (const key of window) {
            const h = st?.hours.get(key);
            if (!h) continue;
            day.rounds += h.rounds;
            day.failures += h.failures;
          }
          return { id, status: st?.health.status ?? "ok", day, lastSuccessAt: st?.lastSuccessAt, statusSince: st?.statusSince };
        }),
      });
    for (const name of notifierNames) await shared.send(name, "hourly summary", summary);
  }
}
