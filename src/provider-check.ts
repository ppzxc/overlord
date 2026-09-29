import type { Config } from "./config.js";
import { compact } from "./catalog.js";
import { seatsMatching } from "./seats.js";
import type { ProviderAdapter } from "./types.js";

export interface Problem {
  /** 설정 안의 위치. 예: ["watches", 0, "zones"] */
  path: (string | number)[];
  message: string;
}

/** 예약처가 아는 값(시설, 구역, 최대 박수, 자리)과 맞는지 본다. */
export function checkAgainstProviders(config: Config, adapters: Record<string, ProviderAdapter>): Problem[] {
  const problems: Problem[] = [];
  const providerIds = Object.keys(adapters).join(", ");
  for (const id of Object.keys(config.providers)) {
    if (!adapters[id]) problems.push({ path: ["providers", id], message: `알 수 없는 예약처다. 쓸 수 있는 값: ${providerIds}` });
  }
  config.watches.forEach((w, i) => {
    const at = (field: string) => ["watches", i, field];
    const adapter = adapters[w.provider];
    if (!adapter) {
      problems.push({ path: at("provider"), message: `알 수 없는 예약처 "${w.provider}"다. 쓸 수 있는 값: ${providerIds}` });
      return;
    }
    const info = adapter.describe();
    if (w.facility !== undefined && w.facility !== info.facility) {
      problems.push({ path: at("facility"), message: `없는 시설 "${w.facility}"다. 쓸 수 있는 값: ${info.facility}` });
    }
    if (w.nights > info.maxNights) {
      problems.push({ path: at("nights"), message: `${w.provider}는 최대 ${info.maxNights}박까지 예약할 수 있다(설정값 ${w.nights})` });
    }
    const codes = info.zones.map((z) => z.code);
    for (const z of w.zones) {
      if (!codes.includes(z)) problems.push({ path: at("zones"), message: `없는 구역 "${z}"다. 쓸 수 있는 값: ${codes.join(", ")}` });
    }
    // 구역 코드가 틀렸으면 구역 오류만 알린다. 자리 번호는 구역이 맞아야 확인할 수 있다.
    const requested = info.zones.filter((z) => w.zones.includes(z.code));
    if (w.seats && requested.length === w.zones.length && requested.every((z) => z.seats)) {
      const allSeats = requested.flatMap((z) => z.seats!);
      for (const token of w.seats) {
        if (seatsMatching(token, allSeats).length === 0) {
          problems.push({ path: at("seats"), message: `"${token}"에 맞는 자리가 없다. 쓸 수 있는 값: ${compact(allSeats)}` });
        }
      }
    }
  });
  return problems;
}
