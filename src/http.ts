import type { HttpClient, Transport, TransportResponse } from "./types.js";

const BASE_UA = "overlord-availability-poller";
const TIMEOUT_MS = 10_000;

export function userAgent(version: string, suffix: string): string {
  const base = `${BASE_UA}/${version}`;
  return suffix.trim() ? `${base} ${suffix.trim()}` : base;
}

export function createHttpClient(opts: {
  transport: Transport;
  version: string;
  userAgentSuffix: string;
}): HttpClient {
  const ua = userAgent(opts.version, opts.userAgentSuffix);
  return {
    async get(url: string): Promise<TransportResponse> {
      // robots.txt가 막은 경로는 어떤 경우에도 호출하지 않는다.
      if (new URL(url).pathname.startsWith("/bbs/")) {
        throw new Error(`robots.txt가 막은 경로는 호출하지 않는다: ${url}`);
      }
      return opts.transport({ url, headers: { "User-Agent": ua }, timeoutMs: TIMEOUT_MS });
    },
  };
}
