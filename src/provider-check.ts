import type { Config } from "./config.js";
import { compact } from "./catalog.js";
import { seatsMatching } from "./seats.js";
import type { ProviderAdapter } from "./types.js";

/** 예약처가 아는 값(구역, 최대 박수, 자리)과 맞는지 본다. */
export function checkAgainstProviders(config: Config, adapters: Record<string, ProviderAdapter>): string[] {
  const problems: string[] = [];
  for (const id of Object.keys(config.providers)) {
    if (!adapters[id]) problems.push(`providers.${id}: 알 수 없는 예약처다. 쓸 수 있는 값: ${Object.keys(adapters).join(", ")}`);
  }
  config.watches.forEach((w, i) => {
    const at = `watches.${i}(${w.name})`;
    const adapter = adapters[w.provider];
    if (!adapter) {
      problems.push(`${at}.provider: 알 수 없는 예약처 "${w.provider}"다. 쓸 수 있는 값: ${Object.keys(adapters).join(", ")}`);
      return;
    }
    const info = adapter.describe();
    if (w.nights > info.maxNights) {
      problems.push(`${at}.nights: ${w.provider}는 최대 ${info.maxNights}박까지 예약할 수 있다(설정값 ${w.nights})`);
    }
    const codes = info.zones.map((z) => z.code);
    const knownCodes = w.zones.filter((z) => codes.includes(z));
    for (const z of w.zones) {
      if (!codes.includes(z)) problems.push(`${at}.zones: 없는 구역 "${z}"다. 쓸 수 있는 값: ${codes.join(", ")}`);
    }
    // 고정된 자리 목록이 없는 구역이 하나라도 있으면 자리 번호를 확인할 수 없다.
    const requestedZones = info.zones.filter((z) => knownCodes.includes(z.code));
    if (w.seats && knownCodes.length === w.zones.length && requestedZones.every((z) => z.seats)) {
      const allSeats = requestedZones.flatMap((z) => z.seats!);
      for (const token of w.seats) {
        if (seatsMatching(token, allSeats).length === 0) {
          problems.push(`${at}.seats: "${token}"에 맞는 자리가 없다. 쓸 수 있는 값: ${compact(allSeats)}`);
        }
      }
    }
  });
  return problems;
}
