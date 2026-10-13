// 어댑터가 같이 쓰는 신호 분류의 공통부. 울산 중구(junggu)와 북구(bukgu)가 글자까지 같게 쓰던 것에 리다이렉트 판정(`redirectOf`)을 더했다.
import { AdapterError, type AdapterContext, type AvailabilityQuery, type AvailableSite, type HttpClient, type TransportResponse } from "./types.js";
import { BlockedPathError } from "./http.js";

/** 봇 탐지 장치·captcha 표지. ADR 0002가 넘지 않는 선으로 꼽은 장치의 이름이다. 나타나면 새 신호로 보고 멈춘다(`blocked`). */
export const BOT_DETECTION = /botmanager|crawlingCheck|dynapath|captcha/i;

/** 응답 상태를 판정한다. 401·403·429는 차단, 5xx는 일시 오류, 그 밖의 200 아님은 구조 변경이다. */
export function assertOk(res: TransportResponse, where: string): void {
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new AdapterError("blocked", `${where}: HTTP ${res.status}`);
  if (res.status >= 500) throw new AdapterError("transient", `${where}: HTTP ${res.status}`);
  if (res.status !== 200) throw new AdapterError("unrecognized", `${where}: 예상 밖 HTTP ${res.status}`);
}

/** 요청이 나가거나 돌아오지 못한 연결 실패·시간 초과(일시 오류). 예약처 전체의 문제일 수 있어 어댑터가 다른 시설 조회를 이어갈지 가를 때 쓴다. */
export class ConnectionFailure extends AdapterError {
  constructor(message: string, options?: ErrorOptions) {
    super("transient", message, options);
  }
}

/** 요청 하나를 보낸다. 접근 금지 경로(로그인으로 리다이렉트 포함)는 차단, 연결 실패·시간 초과는 일시 오류(`ConnectionFailure`)다. */
export async function send<T extends TransportResponse>(where: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (e) {
    if (e instanceof BlockedPathError) throw new AdapterError("blocked", `${where}: 로그인·접근 금지 경로로 보내졌다(${e.message})`);
    if (e instanceof AdapterError) throw e;
    // 원인(예: TLS 검증 실패의 cause.code)을 `tlsStreakRound`가 읽을 수 있게 cause로 남긴다.
    throw new ConnectionFailure(`${where}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/** 3xx 응답의 이동 주소(`base` 기준 절대 주소). 3xx가 아니거나 `Location`이 없으면 undefined다. 로그인 화면으로 보내면 차단이다. */
export function redirectOf(res: TransportResponse, base: string, where: string): URL | undefined {
  if (!(res.status >= 300 && res.status < 400 && res.location)) return undefined;
  const to = new URL(res.location, base);
  if (/\/login/i.test(to.pathname)) throw new AdapterError("blocked", `${where}: 로그인(${to.pathname})으로 보냈다`);
  return to;
}

/** 어댑터가 알지 못하는 곳으로 가는 3xx는 구조 변경이다. */
export const unknownRedirect = (to: URL, where: string): AdapterError => new AdapterError("unrecognized", `${where}: 알 수 없는 곳(${to.host}${to.pathname})으로 보냈다`);

/** 요청 없이 한 조회 단위만 보고 나온 구조 변경 판정. 그 단위만 실패로 치고 다른 단위의 조회는 막지 않는다. */
export class UnitStructureError extends AdapterError {
  constructor(message: string) {
    super("unrecognized", message);
  }
}

/** 세션(HttpClient)마다 이미 경고한 차이(키 문자열). */
const warnedDrift = new WeakMap<HttpClient, Set<string>>();

/** 같은 세션에서 같은 `key`의 차이는 한 번만 로그로 남긴다. 구역·자리 차이 경고용이다. */
export function warnDriftOnce(ctx: AdapterContext, key: string, msg: string, fields: Record<string, unknown>): void {
  const warned = warnedDrift.get(ctx.http) ?? new Set<string>();
  warnedDrift.set(ctx.http, warned);
  if (warned.has(key)) return;
  warned.add(key);
  ctx.log?.(msg, fields);
}

/**
 * 일괄 조회만 구현한 어댑터의 단건 조회. 결과가 오류면 던지고, 결과가 없으면 구조 변경으로 본다.
 */
export async function queryOneViaBatch(
  provider: string,
  batch: (units: AvailabilityQuery[], ctx: AdapterContext) => Promise<Map<AvailabilityQuery, AvailableSite[] | Error>>,
  q: AvailabilityQuery,
  ctx: AdapterContext,
): Promise<AvailableSite[]> {
  const result = (await batch([q], ctx)).get(q);
  if (result instanceof Error) throw result;
  if (result === undefined) throw new AdapterError("unrecognized", `${provider}: 일괄 조회가 조회 단위의 결과를 돌려주지 않았다`);
  return result;
}
