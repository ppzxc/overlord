import { readdirSync, readFileSync } from "node:fs";
import tls from "node:tls";
import { Agent, fetch } from "undici";
import type { Transport } from "./types.js";

export type ClosableTransport = Transport & { close(): Promise<void> };

export interface TransportOptions {
  /**
   * 신뢰하는 루트 목록. 없으면 Node 기본 루트(NODE_EXTRA_CA_CERTS와 시스템 인증서 설정 포함)다.
   * 테스트가 내장 루트 대신 시험용 루트를 쓰려고 바꾼다.
   */
  roots?: string[];
  /** 기본 루트에 더하는 중간 인증서(PEM). 서버가 중간 인증서를 보내지 않는 예약처용이다. 검증은 끄지 않는다. */
  extraCa?: string[];
}

/** 폴더의 `*.pem`을 모두 읽는다. 저장소의 `certs/`가 신뢰 목록에 더하는 중간 인증서다. */
export function loadExtraCa(dir: URL): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".pem"))
    .sort()
    .map((f) => readFileSync(new URL(f, dir), "utf8"));
}

/**
 * 예약처 요청이 지나가는 HTTP transport. 검증된 TLS만 쓴다. 신뢰 목록은 기본 루트에 `extraCa`를 더한 것이다.
 * 실행 중에 인증서를 내려받지 않는다.
 */
export function createTransport(opts: TransportOptions = {}): ClosableTransport {
  const roots = opts.roots ?? defaultRoots();
  const agent = new Agent({ connect: { ca: [...roots, ...(opts.extraCa ?? [])] } });
  const transport: ClosableTransport = async ({ method, url, headers, body, timeoutMs, redirect }) => {
    const res = await fetch(url, {
      method,
      headers,
      body,
      redirect: redirect ?? "follow",
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: agent,
    });
    return {
      status: res.status,
      body: await res.text(),
      // headers.get("set-cookie")는 여러 값을 쉼표로 이어 붙여 Expires의 쉼표와 섞인다.
      setCookie: res.headers.getSetCookie(),
      location: res.headers.get("location") ?? undefined,
    };
  };
  transport.close = () => agent.close();
  return transport;
}

// connect.ca는 기본 루트를 대신하므로 기본 루트를 직접 넘긴다. getCACertificates가 없는 Node는 내장 루트만 쓴다.
function defaultRoots(): string[] {
  return typeof tls.getCACertificates === "function" ? tls.getCACertificates("default") : [...tls.rootCertificates];
}
