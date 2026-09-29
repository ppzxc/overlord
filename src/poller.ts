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

  while (!signal.aborted) {
    try {
      const sites = await adapter.queryAvailability(query, ctx);
      if (sites.length > 0) {
        const link = adapter.deepLink(query);
        for (const name of watch.notify) {
          const notifier = config.notifiers[name];
          if (!notifier) continue;
          const msg = renderOpenings({
            chatId: notifier.chatId,
            watchName: watch.name,
            info: adapter.describe(),
            query,
            sites,
            link,
          });
          await deps.sink.sendMessage(notifier.botToken, msg);
        }
      }
    } catch (err) {
      const kind = err instanceof AdapterError ? err.kind : "error";
      log("cycle failed", { kind, message: err instanceof Error ? err.message : String(err) });
    }
    await clock.sleep(intervalMs, signal);
  }
}
