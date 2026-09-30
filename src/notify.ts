import type { PollerDeps } from "./poller.js";
import type { ProviderHealth } from "./health.js";
import { isQuiet } from "./schedule.js";
import { sendWithRetry, type TelegramMessage } from "./telegram.js";

export interface DayStats {
  rounds: number;
  /** 실패가 하나라도 있었던 바퀴 수 */
  failures: number;
}

export type Sender = (notifierName: string, label: string, msg: (chatId: string) => TelegramMessage) => Promise<boolean>;

/** 예약처 바퀴들과 일일 요약이 함께 쓰는 것. */
export interface Shared {
  send: Sender;
  /** 알림 대상 모두의 마지막 전송이 성공했는가. 아직 보낸 적 없는 대상은 정상으로 본다(보내 보기 전에는 알 수 없고, 그때까지 ping을 끊으면 조용한 설정이 오경보를 낸다). */
  channelOk(): boolean;
  /** dead-man 서비스에 살아 있다고 알린다. deadManPingUrl이 없으면 아무것도 하지 않는다. */
  pingDeadMan(): Promise<void>;
  /** 예약처별 상태와 날짜(KST)별 바퀴 수·실패한 바퀴 수. 일일 요약이 읽는다. */
  stats: Map<string, ProviderStat>;
  /** 프로세스 가동 시작 시각. 바퀴 수를 세기 시작한 기준이다. */
  startedAt: Date;
}

export interface ProviderStat {
  health: ProviderHealth;
  days: Map<string, DayStats>;
  /** KST 시(YYYY-MM-DDTHH)별 바퀴 수·실패한 바퀴 수. 시간별 요약이 읽는다. */
  hours: Map<string, DayStats>;
  /** 실패 없이 끝난 마지막 바퀴의 시각. 아직 없으면 undefined. */
  lastSuccessAt?: Date | undefined;
  /** 지금 상태가 시작된 시각. 상태가 한 번도 바뀌지 않았으면 undefined. */
  statusSince?: Date | undefined;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createShared(deps: PollerDeps, signal: AbortSignal): Shared {
  const { config, clock } = deps;
  const log = deps.log ?? (() => {});
  const results = new Map<string, boolean>();

  /** 알림 한 건을 재시도 정책으로 보낸다. 조용한 시간이면 무음으로 보낸다. 실패해도 던지지 않는다. */
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
      log("notify sent", { watch: label, notifier: notifierName });
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

  // 예약처가 여럿이어도 ping은 가장 짧은 바퀴 간격의 절반에 한 번만 나간다.
  const minIntervalMs = Math.min(
    ...config.watches.map((w) => (config.providers[w.provider]?.pollIntervalSeconds ?? 150) * 1000),
  );
  let lastPingAt = -Infinity;
  const pingDeadMan = async () => {
    const url = config.deadManPingUrl;
    if (!url || signal.aborted) return;
    const nowMs = clock.now().getTime();
    if (nowMs - lastPingAt < minIntervalMs / 2) return;
    lastPingAt = nowMs;
    try {
      // 헤더도 본문도 싣지 않는 GET만 보낸다.
      const res = await deps.transport({ method: "GET", url, headers: {}, timeoutMs: 10_000 });
      if (res.status >= 400) log("dead-man ping failed", { status: res.status });
    } catch (err) {
      // URL에 비밀 토큰이 들어 있는 경우가 많아 오류 메시지의 URL을 가린다.
      log("dead-man ping failed", { message: errMessage(err).replaceAll(url, "***") });
    }
  };

  return { send, channelOk: () => [...results.values()].every(Boolean), pingDeadMan, stats: new Map(), startedAt: clock.now() };
}
