import { CookieJar } from "./cookies.js";
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

/** 한 요청이 따라가는 리다이렉트의 상한. */
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function createHttpClient(opts: {
  transport: Transport;
  version: string;
  userAgentSuffix: string;
  /** 어떤 경우에도 호출하지 않는 경로 접두어. 어댑터가 선언한다. */
  blockedPaths: string[];
  /** 켜면 받은 쿠키를 들고 다음 요청에 싣는다. 끄면 Set-Cookie를 무시한다. */
  cookieSession: boolean;
  /** 주면 요청을 하나씩 순서대로 보내고 요청 사이에 최소 간격과 지터를 둔다. */
  pacing?: Pacing;
}): HttpClient {
  const ua = userAgent(opts.version, opts.userAgentSuffix);
  const { pacing } = opts;
  let queue: Promise<unknown> = Promise.resolve();
  let lastAt: number | undefined;
  const jar = new CookieJar();

  const assertAllowed = (url: string) => {
    const { pathname } = new URL(url);
    const blocked = opts.blockedPaths.find((p) => pathname.startsWith(p));
    if (blocked) throw new Error(`접근 금지 경로(${blocked})는 호출하지 않는다: ${url}`);
  };

  // 쿠키는 보내는 순간에 싣는다. 큐에서 기다리던 요청도 앞 요청이 받은 쿠키를 가져가야 한다.
  const sendOnce = async (method: TransportRequest["method"], url: string, body?: string, contentType = FORM_CONTENT_TYPE, extra?: Record<string, string>) => {
    const { hostname } = new URL(url);
    const headers: Record<string, string> = { "User-Agent": ua, ...extra };
    if (body !== undefined) headers["Content-Type"] = contentType;
    const cookie = jar.header(hostname);
    if (cookie) headers.Cookie = cookie;
    const res = await opts.transport({ method, url, headers, body, timeoutMs: TIMEOUT_MS, redirect: "manual" });
    if (opts.cookieSession && res.setCookie) {
      jar.store(hostname, res.setCookie, (pacing?.clock.now() ?? new Date()).getTime());
    }
    return res;
  };

  // 리다이렉트를 직접 따라간다. 홉마다 접근 금지 경로를 검사하고 쿠키를 담고 싣는다. 간격은 한 칸만 쓴다.
  const send = async (method: TransportRequest["method"], url: string, body?: string, contentType?: string, extra?: Record<string, string>) => {
    for (let hop = 0; ; hop++) {
      assertAllowed(url);
      const res = await sendOnce(method, url, body, contentType, extra);
      if (!REDIRECT_STATUSES.has(res.status) || !res.location) return res;
      if (hop === MAX_REDIRECTS) throw new Error(`리다이렉트가 ${MAX_REDIRECTS}번을 넘었다: ${url}`);
      url = new URL(res.location, url).toString();
      // fetch처럼 303과, POST에 대한 301·302는 본문 없는 GET으로 바꾼다. 307·308은 그대로 다시 보낸다.
      if (res.status === 303 || (method === "POST" && (res.status === 301 || res.status === 302))) {
        method = "GET";
        body = undefined;
      }
    }
  };

  const request = (
    method: TransportRequest["method"],
    url: string,
    body: string | undefined,
    reqOpts: RequestOptions = {},
  ): Promise<TransportResponse> => {
    try {
      assertAllowed(url);
    } catch (e) {
      return Promise.reject(e);
    }
    if (pacing?.signal.aborted && !reqOpts.ignoreAbort) return Promise.reject(new Error("중단되었다"));
    if (!pacing || reqOpts.unpaced) return send(method, url, body, reqOpts.contentType, reqOpts.headers);
    const run = queue.then(async () => {
      if (lastAt !== undefined) {
        const wait = lastAt + REQUEST_GAP_MS + pacing.random() * REQUEST_JITTER_MS - pacing.clock.now().getTime();
        if (wait > 0) await pacing.clock.sleep(wait, pacing.signal);
      }
      if (pacing.signal.aborted) throw new Error("중단되었다");
      try {
        return await send(method, url, body, reqOpts.contentType, reqOpts.headers);
      } finally {
        lastAt = pacing.clock.now().getTime();
      }
    });
    queue = run.catch(() => {});
    return run;
  };

  return {
    get: (url, reqOpts) => request("GET", url, undefined, reqOpts),
    post: (url, form, reqOpts) =>
      request("POST", url, typeof form === "string" ? form : new URLSearchParams(form).toString(), reqOpts),
    clearSession: () => jar.clear(),
  };
}
