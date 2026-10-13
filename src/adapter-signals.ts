// 울산 중구(junggu)와 북구(bukgu) 어댑터가 같이 쓰는 신호 분류의 공통부. 두 어댑터에서 글자까지 같던 것만 모았다.
import { AdapterError, type TransportResponse } from "./types.js";
import { BlockedPathError } from "./http.js";

/** 봇 탐지 장치·captcha 표지. ADR 0002가 넘지 않는 선으로 꼽은 장치의 이름이다. 나타나면 새 신호로 보고 멈춘다(`blocked`). */
export const BOT_DETECTION = /botmanager|crawlingCheck|dynapath|captcha/i;

/** 응답 상태를 판정한다. 401·403·429는 차단, 5xx는 일시 오류, 그 밖의 200 아님은 구조 변경이다. */
export function assertOk(res: TransportResponse, where: string): void {
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new AdapterError("blocked", `${where}: HTTP ${res.status}`);
  if (res.status >= 500) throw new AdapterError("transient", `${where}: HTTP ${res.status}`);
  if (res.status !== 200) throw new AdapterError("unrecognized", `${where}: 예상 밖 HTTP ${res.status}`);
}

/** 요청 하나를 보낸다. 접근 금지 경로(로그인으로 리다이렉트 포함)는 차단, 연결 실패·시간 초과는 일시 오류다. */
export async function send<T extends TransportResponse>(where: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (e) {
    if (e instanceof BlockedPathError) throw new AdapterError("blocked", `${where}: 로그인·접근 금지 경로로 보내졌다(${e.message})`);
    if (e instanceof AdapterError) throw e;
    // 원인(예: TLS 검증 실패의 cause.code)을 `tlsStreakRound`가 읽을 수 있게 cause로 남긴다.
    throw new AdapterError("transient", `${where}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/** 요청 없이 한 조회 단위만 보고 나온 구조 변경 판정. 그 단위만 실패로 치고 다른 단위의 조회는 막지 않는다. */
export class UnitStructureError extends AdapterError {
  constructor(message: string) {
    super("unrecognized", message);
  }
}
