import type { AvailableSite } from "./types.js";

/** "A02" 또는 "A10-A15"(끝의 접두어는 생략 가능)를 자리 id 판별 함수로 바꾼다. */
function parseToken(token: string): (id: string) => boolean {
  const range = /^([A-Za-z]+)(\d+)\s*-\s*(?:[A-Za-z]+)?(\d+)$/.exec(token.trim());
  if (range) {
    const [, prefix, lo, hi] = range;
    return (id) => {
      const m = /^([A-Za-z]+)(\d+)$/.exec(id);
      return !!m && m[1]!.toUpperCase() === prefix!.toUpperCase() && +m[2]! >= +lo! && +m[2]! <= +hi!;
    };
  }
  return (id) => id.toUpperCase() === token.trim().toUpperCase();
}

/** 자리 필터에 맞는 자리만 남긴다. 필터를 생략하면 모두 남긴다. */
export function filterSites(sites: AvailableSite[], filter: string[] | undefined): AvailableSite[] {
  if (!filter) return sites;
  const matchers = filter.map(parseToken);
  return sites.filter((s) => matchers.some((m) => m(s.id)));
}
