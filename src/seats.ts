import type { AvailableSite } from "./types.js";

type Matcher = (id: string) => boolean;

/** "A02" 또는 "A10-A15"(끝의 접두어는 생략 가능)를 자리 id 판별 함수로 바꾼다. 형식이 틀리면 null. */
function parseToken(token: string): Matcher | null {
  const t = token.trim();
  const range = /^([A-Za-z]+)(\d+)\s*-\s*([A-Za-z]*)(\d+)$/.exec(t);
  if (range) {
    const [, prefix, lo, endPrefix, hi] = range;
    if (endPrefix && endPrefix.toUpperCase() !== prefix!.toUpperCase()) return null;
    if (+lo! > +hi!) return null;
    return (id) => {
      const m = /^([A-Za-z]+)(\d+)$/.exec(id);
      return !!m && m[1]!.toUpperCase() === prefix!.toUpperCase() && +m[2]! >= +lo! && +m[2]! <= +hi!;
    };
  }
  if (/^[A-Za-z]+\d+$/.test(t)) return (id) => id.toUpperCase() === t.toUpperCase();
  return null;
}

export const isValidSeatToken = (token: string) => parseToken(token) !== null;

/** 자리 필터에 맞는 자리만 남긴다. 필터를 생략하면 모두 남긴다. 토큰은 설정 로딩 때 검증된다. */
export function filterSeats(sites: AvailableSite[], filter: string[] | undefined): AvailableSite[] {
  if (!filter) return sites;
  const matchers = filter.map((t) => parseToken(t)!);
  return sites.filter((s) => matchers.some((m) => m(s.id)));
}
