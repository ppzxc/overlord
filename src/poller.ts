import type { Config } from "./config.js";
import { createHttpClient } from "./http.js";
import { expandWatch, isExpired, unitKey } from "./schedule.js";
import { filterSeats } from "./seats.js";
import { renderOpenings, renderWatchExpired, type TelegramSink } from "./telegram.js";
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
/** 바퀴 간격의 ±비율. */
const INTERVAL_JITTER = 0.2;

type Watch = Config["watches"][number];

/** 예약처마다 바퀴 루프를 하나씩 돌린다. */
export async function runPoller(deps: PollerDeps, signal: AbortSignal): Promise<void> {
  const providers = [...new Set(deps.config.watches.map((w) => w.provider))];
  for (const id of providers) {
    if (!deps.adapters[id]) throw new Error(`알 수 없는 예약처: ${id}`);
  }
  // 예약처가 여럿이면 첫 바퀴 시작 시각을 분산한다. 첫 예약처는 바로 시작한다.
  await Promise.all(
    providers.map(async (id, i) => {
      if (i > 0) await deps.clock.sleep(i * STAGGER_MS + (deps.random ?? Math.random)() * STAGGER_MS, signal);
      await runProvider(deps, id, signal);
    }),
  );
}

async function runProvider(deps: PollerDeps, providerId: string, signal: AbortSignal): Promise<void> {
  const { config, clock } = deps;
  const log = deps.log ?? (() => {});
  const adapter = deps.adapters[providerId]!;
  const info = adapter.describe();
  const watches = config.watches.filter((w) => w.provider === providerId);
  const intervalMs = (config.providers[providerId]?.pollIntervalSeconds ?? 150) * 1000;

  const random = deps.random ?? Math.random;
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

  const trySend = async (notifierName: string, watch: Watch, build: (chatId: string) => Parameters<TelegramSink["sendMessage"]>[1]) => {
    const notifier = config.notifiers[notifierName];
    if (!notifier) {
      log("unknown notifier", { watch: watch.name, notifier: notifierName });
      return true; // 다시 시도해도 소용없다
    }
    try {
      await deps.sink.sendMessage(notifier.botToken, build(notifier.chatId));
      return true;
    } catch (err) {
      // 전송 실패는 기록하지 않아 다음 바퀴에 다시 보낸다. 다른 알림 대상은 계속 진행한다.
      log("notify failed", { watch: watch.name, notifier: notifierName, message: errMessage(err) });
      return false;
    }
  };

  while (!signal.aborted) {
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
        const ok = await trySend(name, watch, (chatId) =>
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
    const fail = (key: string, err: unknown) => {
      results.set(key, null);
      const kind = err instanceof AdapterError ? err.kind : "error";
      log("query failed", { kind, unit: key, message: errMessage(err) });
    };
    if (adapter.queryAvailabilityBatch && queries.size > 0) {
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
        }
      }
    }

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
          const link = adapter.deepLink(q);
          const ok = await trySend(name, watch, (chatId) =>
            renderOpenings({
              chatId,
              watchName: watch.name,
              info,
              query: q,
              sites: fresh,
              link,
              startupSnapshot: firstCycle,
            }),
          );
          if (ok) fresh.forEach((s) => known.add(s.name));
        }
      }
    }
    firstCycle = false;
    await clock.sleep(intervalMs * (1 + (random() * 2 - 1) * INTERVAL_JITTER), signal);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
