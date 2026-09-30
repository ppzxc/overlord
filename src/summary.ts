import type { PollerDeps } from "./poller.js";
import { notifierNamesOf, type Shared } from "./notify.js";
import { addDays, HOUR_MS, isExpired, isQuiet, kstDate, kstHhmm, kstHourKey, msUntilNext, msUntilNextHourMark } from "./schedule.js";
import { renderHourlySummary, renderSummary, type SummaryProvider } from "./telegram.js";

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
  const notifierNames = notifierNamesOf(config);
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
        // 기록이 없으면(재시작 직후 등) 0회로 착각하지 않도록 비워 둔다.
        providers: providers.map((id) => summaryProvider(id, shared, shared.stats.get(id)?.days.get(yesterday))),
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

/** 요약 메시지에 실을 예약처 한 곳의 현재 상태. counts는 호출하는 요약이 센 구간의 바퀴 수다. */
function summaryProvider(id: string, shared: Shared, counts: SummaryProvider["counts"]): SummaryProvider {
  const st = shared.stats.get(id);
  const since = st?.health.statusSince;
  return {
    id,
    status: st?.health.status ?? "ok",
    counts,
    lastSuccessAt: st?.lastSuccessAt,
    statusSince: since === undefined ? undefined : new Date(since),
  };
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
  const notifierNames = notifierNamesOf(config);
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
    const window = Array.from({ length: everyHours }, (_, i) => kstHourKey(new Date(now.getTime() - (i + 1) * HOUR_MS)));
    const summary = (chatId: string) =>
      renderHourlySummary({
        chatId,
        everyHours,
        startedAt: shared.startedAt,
        providers: providers.map((id) => {
          const counts = { rounds: 0, failures: 0 };
          for (const key of window) {
            const h = shared.stats.get(id)?.hours.get(key);
            if (!h) continue;
            counts.rounds += h.rounds;
            counts.failures += h.failures;
          }
          return summaryProvider(id, shared, counts);
        }),
      });
    for (const name of notifierNames) await shared.send(name, "hourly summary", summary);
  }
}
