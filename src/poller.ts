import type { Config } from "./config.js";
import { createHttpClient } from "./http.js";
import { renderOpenings, type TelegramSink } from "./telegram.js";
import { AdapterError, type Clock, type ProviderAdapter, type Transport } from "./types.js";

export interface PollerDeps {
  config: Config;
  adapters: Record<string, ProviderAdapter>;
  transport: Transport;
  clock: Clock;
  sink: TelegramSink;
  version: string;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/** 워킹 스켈레톤: 첫 감시 조건의 첫 구역·첫 입실일을 고정 간격으로 반복 조회한다. */
export async function runPoller(deps: PollerDeps, signal: AbortSignal): Promise<void> {
  const { config, clock } = deps;
  const log = deps.log ?? (() => {});
  const watch = config.watches[0];
  if (!watch) return;
  const adapter = deps.adapters[watch.provider];
  if (!adapter) throw new Error(`알 수 없는 예약처: ${watch.provider}`);
  const zone = watch.zones[0];
  if (!zone) return;
  const intervalMs = (config.providers[watch.provider]?.pollIntervalSeconds ?? 150) * 1000;

  const ctx = {
    http: createHttpClient({
      transport: deps.transport,
      version: deps.version,
      userAgentSuffix: config.userAgentSuffix,
    }),
  };
  const query = { zone, checkIn: watch.checkIn.from, nights: watch.nights };
  // 알림 대상별 "알렸음" 상태. 키: 감시 조건·구역·입실일·박수 범위 안의 자리 이름. 영속하지 않는다.
  const scope = [watch.name, query.zone, query.checkIn, query.nights].join("|");
  const notified = new Map<string, Set<string>>();
  const sentBefore = new Set<string>();

  while (!signal.aborted) {
    try {
      const sites = await adapter.queryAvailability(query, ctx);
      const current = new Set(sites.map((s) => s.name));
      const link = adapter.deepLink(query);
      for (const name of watch.notify) {
        const notifier = config.notifiers[name];
        if (!notifier) continue;
        // 사라진 자리는 잊어서, 다시 생기면 새 빈자리로 알린다.
        const known = new Set([...(notified.get(`${name}|${scope}`) ?? [])].filter((n) => current.has(n)));
        notified.set(`${name}|${scope}`, known);
        const fresh = sites.filter((s) => !known.has(s.name));
        if (fresh.length === 0) continue;
        try {
          const msg = renderOpenings({
            chatId: notifier.chatId,
            watchName: watch.name,
            info: adapter.describe(),
            query,
            sites: fresh,
            link,
            afterRestart: !sentBefore.has(name),
          });
          await deps.sink.sendMessage(notifier.botToken, msg);
          fresh.forEach((s) => known.add(s.name));
          sentBefore.add(name);
        } catch (err) {
          // 전송 실패는 기록하지 않아 다음 바퀴에 다시 보낸다. 다른 알림 대상은 계속 진행한다.
          log("notify failed", { notifier: name, message: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch (err) {
      const kind = err instanceof AdapterError ? err.kind : "error";
      log("cycle failed", { kind, message: err instanceof Error ? err.message : String(err) });
    }
    await clock.sleep(intervalMs, signal);
  }
}
