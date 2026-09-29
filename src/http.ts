import type { Clock, HttpClient, Transport, TransportResponse } from "./types.js";

const BASE_UA = "overlord-availability-poller";
const TIMEOUT_MS = 10_000;
/** 같은 예약처로 가는 요청 사이의 최소 간격과 최대 추가 지터. */
export const REQUEST_GAP_MS = 5_000;
export const REQUEST_JITTER_MS = 3_000;

export interface Pacing {
  clock: Clock;
  random: () => number;
  signal: AbortSignal;
}

export function userAgent(version: string, suffix: string): string {
  const base = `${BASE_UA}/${version}`;
  return suffix.trim() ? `${base} ${suffix.trim()}` : base;
}

export function createHttpClient(opts: {
  transport: Transport;
  version: string;
  userAgentSuffix: string;
  /** 주면 요청을 하나씩 순서대로 보내고 요청 사이에 최소 간격과 지터를 둔다. */
  pacing?: Pacing;
}): HttpClient {
  const ua = userAgent(opts.version, opts.userAgentSuffix);
  const { pacing } = opts;
  let queue: Promise<unknown> = Promise.resolve();
  let lastAt: number | undefined;

  const send = (url: string) => opts.transport({ url, headers: { "User-Agent": ua }, timeoutMs: TIMEOUT_MS });

  return {
    async get(url: string): Promise<TransportResponse> {
      // robots.txt가 막은 경로는 어떤 경우에도 호출하지 않는다.
      if (new URL(url).pathname.startsWith("/bbs/")) {
        throw new Error(`robots.txt가 막은 경로는 호출하지 않는다: ${url}`);
      }
      if (!pacing) return send(url);
      const run = queue.then(async () => {
        if (lastAt !== undefined) {
          const wait = lastAt + REQUEST_GAP_MS + pacing.random() * REQUEST_JITTER_MS - pacing.clock.now().getTime();
          if (wait > 0) await pacing.clock.sleep(wait, pacing.signal);
        }
        if (pacing.signal.aborted) throw new Error("중단되었다");
        try {
          return await send(url);
        } finally {
          lastAt = pacing.clock.now().getTime();
        }
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}
