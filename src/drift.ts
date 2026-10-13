// 카탈로그와 응답의 차이(드리프트) 경고. 같은 세션에서 같은 차이는 한 번만 남긴다.
import type { AdapterContext, HttpClient } from "./types.js";

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

/** 응답에만 있는 값("new")을 먼저, 카탈로그에만 있는 값("gone")을 그다음에 `report`로 넘긴다. */
export function eachDrift(seen: ReadonlySet<string>, known: ReadonlySet<string>, report: (change: "new" | "gone", value: string) => void): void {
  for (const v of seen) if (!known.has(v)) report("new", v);
  for (const v of known) if (!seen.has(v)) report("gone", v);
}
