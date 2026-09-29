import type { Clock, HttpClient, RequestOptions, Transport, TransportRequest, TransportResponse } from "./types.js";

const BASE_UA = "overlord-availability-poller";
const TIMEOUT_MS = 10_000;
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded; charset=UTF-8";
/** 같은 예약처로 가는 요청 사이의 최소 간격과 최대 추가 지터. */
export const REQUEST_GAP_MS = 5_000;
export const REQUEST_JITTER_MS = 3_000;
/** 요청 사이에 기다리는 시간의 상한(지터 최대). */
export const MAX_REQUEST_WAIT_MS = REQUEST_GAP_MS + REQUEST_JITTER_MS;

export interface Pacing {
  clock: Clock;
  random: () => number;
  signal: AbortSignal;
}

export function userAgent(version: string, suffix: string): string {
  const base = `${BASE_UA}/${version}`;
  return suffix.trim() ? `${base} ${suffix.trim()}` : base;
}

/** Set-Cookie 값들을 쿠키 이름별로 담는다. Max-Age=0이거나 값이 비면 지운다. 도메인과 경로는 보지 않는다. */
function storeCookies(jar: Map<string, string>, setCookie: string[]): void {
  for (const line of setCookie) {
    const [pair, ...attrs] = line.split(";");
    const eq = pair!.indexOf("=");
    if (eq <= 0) continue;
    const name = pair!.slice(0, eq).trim();
    const value = pair!.slice(eq + 1).trim();
    const expired = attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a));
    if (expired || value === "") jar.delete(name);
    else jar.set(name, value);
  }
}

export function createHttpClient(opts: {
  transport: Transport;
  version: string;
  userAgentSuffix: string;
  /** 어떤 경우에도 호출하지 않는 경로 접두어. 어댑터가 선언한다. */
  blockedPaths: string[];
  /** 주면 요청을 하나씩 순서대로 보내고 요청 사이에 최소 간격과 지터를 둔다. */
  pacing?: Pacing;
}): HttpClient {
  const ua = userAgent(opts.version, opts.userAgentSuffix);
  const { pacing } = opts;
  let queue: Promise<unknown> = Promise.resolve();
  let lastAt: number | undefined;
  const jar = new Map<string, string>();

  // 쿠키는 보내는 순간에 싣는다. 큐에서 기다리던 요청도 앞 요청이 받은 쿠키를 가져가야 한다.
  const send = async (method: TransportRequest["method"], url: string, body?: string) => {
    const headers: Record<string, string> = { "User-Agent": ua };
    if (body !== undefined) headers["Content-Type"] = FORM_CONTENT_TYPE;
    if (jar.size > 0) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await opts.transport({ method, url, headers, body, timeoutMs: TIMEOUT_MS });
    if (res.setCookie) storeCookies(jar, res.setCookie);
    return res;
  };

  const request = (
    method: TransportRequest["method"],
    url: string,
    body: string | undefined,
    reqOpts: RequestOptions = {},
  ): Promise<TransportResponse> => {
    const { pathname } = new URL(url);
    const blocked = opts.blockedPaths.find((p) => pathname.startsWith(p));
    if (blocked) return Promise.reject(new Error(`접근 금지 경로(${blocked})는 호출하지 않는다: ${url}`));
    if (!pacing || reqOpts.unpaced) return send(method, url, body);
    const run = queue.then(async () => {
      if (lastAt !== undefined) {
        const wait = lastAt + REQUEST_GAP_MS + pacing.random() * REQUEST_JITTER_MS - pacing.clock.now().getTime();
        if (wait > 0) await pacing.clock.sleep(wait, pacing.signal);
      }
      if (pacing.signal.aborted) throw new Error("중단되었다");
      try {
        return await send(method, url, body);
      } finally {
        lastAt = pacing.clock.now().getTime();
      }
    });
    queue = run.catch(() => {});
    return run;
  };

  return {
    get: (url, reqOpts) => request("GET", url, undefined, reqOpts),
    post: (url, form, reqOpts) => request("POST", url, new URLSearchParams(form).toString(), reqOpts),
    clearSession: () => jar.clear(),
  };
}
