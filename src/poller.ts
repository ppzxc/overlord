import type { Config } from "./config.js";
import { ProviderHealth, worstFailure, type Failure } from "./health.js";
import { createHttpClient } from "./http.js";
import { addDays, expandWatch, isExpired, isQuiet, kstDate, msUntilNext, unitKey } from "./schedule.js";
import { filterSeats } from "./seats.js";
import {
  renderHealth,
  renderOpenings,
  renderSummary,
  renderWatchExpired,
  sendWithRetry,
  type OpeningEntry,
  type TelegramMessage,
  type TelegramSink,
} from "./telegram.js";
import {
  AdapterError,
  type AvailabilityQuery,
  type AvailableSite,
  type Clock,
  type ProviderAdapter,
  type Transport,
} from "./types.js";

export interface PollerDeps {
  config: Config;
  adapters: Record<string, ProviderAdapter>;
  transport: Transport;
  clock: Clock;
  sink: TelegramSink;
  version: string;
  /** 0 이상 1 미만. 지터에 쓴다. 기본은 Math.random. */
  random?: () => number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/** 예약처 사이에 첫 바퀴를 벌리는 간격. */
const STAGGER_MS = 30_000;
/** quietHours 안에서 바퀴 간격에 곱하는 배율. */
const QUIET_INTERVAL_FACTOR = 3;
/** 일일 요약에서 "곧 만료"로 치는 남은 일수. */
const EXPIRING_DAYS = 7;
/** 바퀴 간격의 ±비율. */
const INTERVAL_JITTER = 0.2;

/** ms에 ±ratio 안에서 지터를 준다. random이 0이면 -ratio, 0.5면 그대로. */
const jittered = (ms: number, ratio: number, random: () => number) => ms * (1 + (random() * 2 - 1) * ratio);

type Watch = Config["watches"][number];

/** 예약처마다 바퀴 루프를 하나씩 돌린다. */
export async function runPoller(deps: PollerDeps, signal: AbortSignal): Promise<void> {
  const providers = [...new Set(deps.config.watches.map((w) => w.provider))];
  for (const id of providers) {
    if (!deps.adapters[id]) throw new Error(`알 수 없는 예약처: ${id}`);
  }
  // 예약처가 여럿이면 첫 바퀴 시작 시각을 분산한다. 첫 예약처는 바로 시작한다.
  const random = deps.random ?? Math.random;
  const shared: Shared = { ...createSender(deps, signal), stats: new Map() };
  await Promise.all([
    ...providers.map(async (id, i) => {
      if (i > 0) await deps.clock.sleep(i * STAGGER_MS + random() * STAGGER_MS, signal);
      await runProvider(deps, id, random, signal, shared);
    }),
    runDailySummary(deps, providers, shared, signal),
  ]);
}

interface DayStats {
  rounds: number;
  /** 실패가 하나라도 있었던 바퀴 수 */
  failures: number;
}

type Sender = (notifierName: string, label: string, msg: (chatId: string) => TelegramMessage) => Promise<boolean>;

/** 예약처 바퀴들이 함께 쓰는 것. */
interface Shared {
  send: Sender;
  /** 알림 대상 모두의 마지막 전송이 성공했는가. 아직 보낸 적 없는 대상은 정상으로 본다. */
  channelOk(): boolean;
  /** 예약처별 상태와 날짜(KST)별 바퀴 수·실패 수. 일일 요약이 읽는다. */
  stats: Map<string, { health: ProviderHealth; days: Map<string, DayStats> }>;
}

/** 알림 한 건을 재시도 정책으로 보낸다. quietHours이면 무음으로 보낸다. 실패해도 던지지 않는다. */
function createSender(deps: PollerDeps, signal: AbortSignal): Pick<Shared, "send" | "channelOk"> {
  const { config, clock } = deps;
  const log = deps.log ?? (() => {});
  const results = new Map<string, boolean>();
  const send: Sender = async (notifierName, label, msg) => {
    const notifier = config.notifiers[notifierName]!; // 설정을 읽을 때 notify 이름을 이미 검증했다.
    const built = msg(notifier.chatId);
    const message: TelegramMessage = isQuiet(clock.now(), config.quietHours) ? { ...built, disable_notification: true } : built;
    try {
      await sendWithRetry(
        deps.sink,
        notifier.botToken,
        message,
        (ms) => clock.sleep(ms, signal),
        () => signal.aborted,
      );
      results.set(notifierName, true);
      return true;
    } catch (err) {
      // 전송 실패는 기록하지 않아 다음 바퀴에 다시 보낸다. 다른 알림 대상은 계속 진행한다.
      if (!signal.aborted) {
        results.set(notifierName, false);
        // sink가 던지는 오류에는 토큰이 없지만, 남의 오류 메시지를 그대로 믿지 않는다.
        const text = errMessage(err).replaceAll(notifier.botToken, "***");
        log("notify failed", { watch: label, notifier: notifierName, message: text });
      }
      return false;
    }
  };
  return { send, channelOk: () => [...results.values()].every(Boolean) };
}

/** 설정한 시각마다 무음 일일 요약을 한 건씩 보낸다. */
async function runDailySummary(deps: PollerDeps, providers: string[], shared: Shared, signal: AbortSignal): Promise<void> {
  const { config, clock } = deps;
  if (!config.dailySummary.enabled) return;
  const notifierNames = [...new Set(config.watches.flatMap((w) => w.notify))];
  while (!signal.aborted) {
    await clock.sleep(msUntilNext(clock.now(), config.dailySummary.at), signal);
    if (signal.aborted) return;
    const now = clock.now();
    const today = kstDate(now);
    const yesterday = addDays(today, -1);
    const infos = new Map(providers.map((id) => [id, deps.adapters[id]!.describe()]));
    const live = config.watches.filter((w) => !isExpired(w, infos.get(w.provider)!.openingRule, now));
    const expiring = live
      .filter((w) => w.checkIn.to <= addDays(today, EXPIRING_DAYS))
      .map((w) => ({ name: w.name, lastCheckIn: w.checkIn.to }));
    for (const name of notifierNames) {
      await shared.send(name, "daily summary", (chatId) =>
        renderSummary({
          chatId,
          date: yesterday,
          activeWatches: live.length,
          expiring,
          providers: providers.map((id) => {
            const st = shared.stats.get(id);
            const day = st?.days.get(yesterday);
            return { id, status: st?.health.status ?? "ok", rounds: day?.rounds ?? 0, failures: day?.failures ?? 0 };
          }),
        }),
      );
    }
  }
}

async function runProvider(
  deps: PollerDeps,
  providerId: string,
  random: () => number,
  signal: AbortSignal,
  shared: Shared,
): Promise<void> {
  const { config, clock } = deps;
  const log = deps.log ?? (() => {});
  const adapter = deps.adapters[providerId]!;
  const info = adapter.describe();
  const watches = config.watches.filter((w) => w.provider === providerId);
  const intervalMs = (config.providers[providerId]?.pollIntervalSeconds ?? 150) * 1000;

  const ctx = {
    http: createHttpClient({
      transport: deps.transport,
      version: deps.version,
      userAgentSuffix: config.userAgentSuffix,
      pacing: { clock, random, signal },
    }),
  };
  // "알렸음" 상태(영속하지 않는다): 감시 조건 이름 → 알림 대상 이름 → 조회 단위 키 → 이미 알린 자리 이름.
  const notified = new Map<string, Map<string, Map<string, Set<string>>>>();
  // 만료 알림을 이미 보낸 (감시 조건, 알림 대상)
  const expiredSent = new Set<string>();
  let firstCycle = true;
  const health = new ProviderHealth();
  const stat = { health, days: new Map<string, DayStats>() };
  shared.stats.set(providerId, stat);
  const healthNotifiers = [...new Set(watches.flatMap((w) => w.notify))];

  /** 상태가 바뀌었거나 같은 장애가 24시간 이어졌으면 이 예약처의 알림 대상 모두에게 알린다. 하나라도 보내면 알린 것으로 친다. */
  const announceHealth = async () => {
    const notice = health.pendingNotice(clock.now().getTime());
    if (!notice) return;
    let delivered = false;
    for (const name of healthNotifiers) {
      const ok = await shared.send(name, providerId, (chatId) => renderHealth({ chatId, provider: providerId, ...notice }));
      delivered ||= ok;
    }
    if (delivered) health.markAnnounced(clock.now().getTime());
  };

  while (!signal.aborted) {
    // 멈춘 예약처는 조회하지 않고, 같은 상태가 이어지면 24시간마다 리마인드만 한다.
    if (health.stopped) {
      await clock.sleep(health.stoppedWaitMs(intervalMs, clock.now().getTime()), signal);
      if (!signal.aborted) await announceHealth();
      continue;
    }
    const now = clock.now();
    const active: Watch[] = [];
    for (const watch of watches) {
      if (!isExpired(watch, info.openingRule, now)) {
        active.push(watch);
        continue;
      }
      for (const name of watch.notify) {
        const key = `${watch.name}|${name}`;
        if (expiredSent.has(key)) continue;
        const ok = await shared.send(name, watch.name, (chatId) =>
          renderWatchExpired({ chatId, watchName: watch.name, checkIn: watch.checkIn }),
        );
        if (ok) expiredSent.add(key);
      }
    }

    // 같은 조회 단위는 감시 조건이 몇 개든 한 번만 조회한다.
    const plans = active.map((watch) => ({ watch, units: expandWatch(watch, info.openingRule, now) }));
    const results = new Map<string, AvailableSite[] | null>(); // null: 이번 바퀴에 조회 실패
    const queries = new Map<string, AvailabilityQuery>();
    for (const { units } of plans) for (const q of units) queries.set(unitKey(q), q);
    const failures: Failure[] = [];
    const fail = (key: string, err: unknown) => {
      results.set(key, null);
      if (signal.aborted) return; // 종료 중 끊긴 요청은 오류로 기록하지 않는다.
      const kind = err instanceof AdapterError ? err.kind : "error";
      failures.push({ kind, message: errMessage(err) });
      log("query failed", { kind, unit: key, message: errMessage(err) });
    };
    if (adapter.queryAvailabilityBatch && queries.size > 0 && !signal.aborted) {
      try {
        const batch = await adapter.queryAvailabilityBatch([...queries.values()], ctx);
        for (const [key, q] of queries) {
          const found = batch.get(q);
          if (found instanceof Error) fail(key, found);
          else if (found) results.set(key, found);
          else fail(key, new Error("일괄 조회 결과에 조회 단위가 없다"));
        }
      } catch (err) {
        for (const key of queries.keys()) fail(key, err);
      }
    } else {
      for (const [key, q] of queries) {
        if (signal.aborted) break;
        try {
          results.set(key, await adapter.queryAvailability(q, ctx));
        } catch (err) {
          fail(key, err);
          break; // 바퀴 도중 실패하면 그 바퀴를 중단한다. 이미 성공한 결과는 아래에서 반영한다.
        }
      }
    }

    // 알림 대상마다 이번 바퀴의 새 빈자리를 모아 메시지 한 건(넘치면 여러 건)으로 보낸다.
    type Pending = OpeningEntry & { known: Set<string> };
    const pending = new Map<string, Pending[]>();
    for (const { watch, units } of plans) {
      const byNotifier = notified.get(watch.name) ?? new Map<string, Map<string, Set<string>>>();
      notified.set(watch.name, byNotifier);
      for (const name of watch.notify) {
        const perUnit = byNotifier.get(name) ?? new Map<string, Set<string>>();
        byNotifier.set(name, perUnit);
        const planned = new Set(units.map(unitKey));
        // 더 이상 조회하지 않는 단위는 잊는다.
        for (const key of perUnit.keys()) if (!planned.has(key)) perUnit.delete(key);
        for (const q of units) {
          const key = unitKey(q);
          const found = results.get(key);
          if (!found) continue; // 조회 실패: 알림 상태를 건드리지 않는다.
          const sites = filterSeats(found, watch.seats);
          const current = new Set(sites.map((s) => s.name));
          // 사라진 자리는 잊어서, 다시 생기면 새 빈자리로 알린다.
          const known = new Set([...(perUnit.get(key) ?? [])].filter((n) => current.has(n)));
          perUnit.set(key, known);
          const fresh = sites.filter((s) => !known.has(s.name));
          if (fresh.length === 0) continue;
          const list = pending.get(name) ?? [];
          pending.set(name, list);
          list.push({ watchName: watch.name, query: q, sites: fresh, link: adapter.deepLink(q), known });
        }
      }
    }
    for (const [name, entries] of pending) {
      const chatId = config.notifiers[name]!.chatId;
      for (const part of renderOpenings({ chatId, info, entries, startupSnapshot: firstCycle })) {
        const label = [...new Set(part.items.map((i) => i.entry.watchName))].join(", ");
        if (!(await shared.send(name, label, () => part.message))) break; // 순서를 지키려고 뒤 메시지도 다음 바퀴로 미룬다.
        for (const { entry, sites } of part.items) sites.forEach((s) => entry.known.add(s.name)); // 이 메시지에 실린 자리만 기록한다.
      }
    }
    firstCycle = false;
    if (!signal.aborted && queries.size > 0) {
      const at = clock.now();
      health.record(worstFailure(failures), at.getTime());
      const today = kstDate(at);
      const day = stat.days.get(today) ?? { rounds: 0, failures: 0 };
      stat.days.set(today, day);
      // 요약이 읽는 것은 전날뿐이라 그 전 기록은 버린다.
      for (const d of stat.days.keys()) if (d < addDays(today, -1)) stat.days.delete(d);
      day.rounds++;
      if (failures.length > 0) day.failures++;
      await announceHealth();
    }
    if (health.stopped) continue;
    // 바퀴가 끝났고 알림 채널이 정상일 때만 살아 있다고 알린다.
    if (!signal.aborted && config.deadManPingUrl && shared.channelOk()) await pingDeadMan(deps, config.deadManPingUrl, log);
    const quiet = isQuiet(clock.now(), config.quietHours) ? QUIET_INTERVAL_FACTOR : 1;
    await clock.sleep(jittered(health.nextIntervalMs(intervalMs) * quiet, INTERVAL_JITTER, random), signal);
  }
}

/** dead-man 서비스에 GET만 보낸다. 헤더도 본문도 싣지 않는다. 실패해도 폴링은 계속한다. */
async function pingDeadMan(deps: PollerDeps, url: string, log: NonNullable<PollerDeps["log"]>): Promise<void> {
  try {
    const res = await deps.transport({ url, headers: {}, timeoutMs: 10_000 });
    if (res.status >= 400) log("dead-man ping failed", { status: res.status });
  } catch (err) {
    // URL에 비밀 토큰이 들어 있는 경우가 많아 오류 메시지의 URL을 가린다.
    log("dead-man ping failed", { message: errMessage(err).replaceAll(url, "***") });
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
