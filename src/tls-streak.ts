import { AdapterError, type HttpClient } from "./types.js";

/** 인증서 검증 실패를 가리키는 OpenSSL 오류 코드(Node가 `cause.code`에 싣는다). */
const TLS_VERIFY_CODE = /^(UNABLE_TO_|CERT_|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED|ERR_TLS_CERT_|HOSTNAME_MISMATCH|INVALID_CA|INVALID_PURPOSE|PATH_LENGTH_EXCEEDED)/;

/** 오류와 그 `cause` 사슬에서 TLS 검증 실패 코드를 찾는다. */
export function tlsVerifyCode(e: unknown): string | undefined {
  for (let cur = e, depth = 0; cur instanceof Error && depth < 5; cur = cur.cause, depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && TLS_VERIFY_CODE.test(code)) return code;
  }
  return undefined;
}

/** 세션(HttpClient)마다 TLS 검증이 연속으로 실패한 바퀴 수. 검증 실패 없이 끝난 바퀴가 있으면 지운다. */
const streaks = new WeakMap<HttpClient, number>();

/**
 * 한 바퀴의 TLS 검증 실패를 센다. TLS 검증 실패는 일시 오류지만 두 바퀴 연속이면 구조 변경으로 친다(인증서가 바뀌었을 수 있다).
 * `classify`는 TLS 검증 실패면 연속 바퀴 수로 종류를 정한 어댑터 오류를, 아니면 undefined를 준다. 바퀴가 끝나면 `finish`를 부른다.
 */
export function tlsRound(http: HttpClient): { classify(e: unknown): AdapterError | undefined; finish(): void } {
  const prior = streaks.get(http) ?? 0;
  let failed = false;
  return {
    classify(e) {
      const code = tlsVerifyCode(e);
      if (code === undefined) return undefined;
      failed = true;
      const kind = prior + 1 >= 2 ? "unrecognized" : "transient";
      return new AdapterError(kind, `TLS 인증서 검증에 실패했다(${code}, 연속 ${prior + 1}바퀴): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    },
    finish() {
      if (failed) streaks.set(http, prior + 1);
      else streaks.delete(http);
    },
  };
}
