import type { Config } from "./config.js";
import { ProviderHealth, worstFailure, type Failure } from "./health.js";
import { createHttpClient } from "./http.js";
import { expandWatch, isExpired, unitKey } from "./schedule.js";
import { filterSeats } from "./seats.js";
import {
  renderHealth,
  renderOpenings,
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
  await Promise.all(
    providers.map(async (id, i) => {
      if (i > 0) await deps.clock.sleep(i * STAGGER_MS + random() * STAGGER_MS, signal);
      await runProvider(deps, id, random, signal);
    }),
  );
}

async function runProvider(
  deps: PollerDeps,
  providerId: string,
  random: () => number,
  signal: AbortSignal,
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
  const healthNotifiers = [...new Set(watches.flatMap((w) => w.notify))];

  const trySend = async (notifierName: string, label: string, msg: (chatId: string) => TelegramMessage) => {
    const notifier = config.notifiers[notifierName]!; // 설정을 읽을 때 notify 이름을 이미 검증했다.
    try {
      await sendWithRetry(
        deps.sink,
        notifier.botToken,
        msg(notifier.chatId),
        (ms) => clock.sleep(ms, signal),
        () => signal.aborted,
      );
      return true;
    } catch (err) {
      // 전송 실패는 기록하지 않아 다음 바퀴에 다시 보낸다. 다른 알림 대상은 계속 진행한다.
      if (!signal.aborted) {
        // sink가 던지는 오류에는 토큰이 없지만, 남의 오류 메시지를 그대로 믿지 않는다.
        const message = errMessage(err).replaceAll(notifier.botToken, "***");
        log("notify failed", { watch: label, notifier: notifierName, message });
      }
      return false;
    }
  };

  /** 상태가 바뀌었거나 같은 장애가 24시간 이어졌으면 이 예약처의 알림 대상 모두에게 알린다. 하나라도 보내면 알린 것으로 친다. */
  const announceHealth = async () => {
    const notice = health.pendingNotice(clock.now().getTime());
    if (!notice) return;
    let delivered = false;
    for (const name of healthNotifiers) {
      const ok = await trySend(name, providerId, (chatId) => renderHealth({ chatId, provider: providerId, ...notice }));
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
        const ok = await trySend(name, watch.name, (chatId) =>
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
        if (!(await trySend(name, label, () => part.message))) break; // 순서를 지키려고 뒤 메시지도 다음 바퀴로 미룬다.
        for (const { entry, sites } of part.items) sites.forEach((s) => entry.known.add(s.name)); // 이 메시지에 실린 자리만 기록한다.
      }
    }
    firstCycle = false;
    if (!signal.aborted && queries.size > 0) {
      health.record(worstFailure(failures), clock.now().getTime());
      await announceHealth();
    }
    if (health.stopped) continue;
    await clock.sleep(jittered(health.nextIntervalMs(intervalMs), INTERVAL_JITTER, random), signal);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
