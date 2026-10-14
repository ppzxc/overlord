import type { Config } from "./config.js";
import { compact } from "./catalog.js";
import { defaultFacility } from "./facility.js";
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
    const adapter = adapters[id];
    if (!adapter) {
      problems.push({ path: ["providers", id], message: `알 수 없는 예약처다. 쓸 수 있는 값: ${providerIds}` });
      continue;
    }
    // 예약처가 공통 하한(60초)보다 느린 하한을 선언했으면 그보다 짧은 간격은 거부한다.
    const floor = adapter.describe().minPollIntervalSeconds;
    const seconds = config.providers[id]?.pollIntervalSeconds;
    if (floor !== undefined && seconds !== undefined && seconds < floor) {
      problems.push({ path: ["providers", id, "pollIntervalSeconds"], message: `${id}는 ${floor}초 이상이어야 한다(설정값 ${seconds})` });
    }
  }
  config.watches.forEach((w, i) => {
    const at = (field: string) => ["watches", i, field];
    const adapter = adapters[w.provider];
    if (!adapter) {
      problems.push({ path: at("provider"), message: `알 수 없는 예약처 "${w.provider}"다. 쓸 수 있는 값: ${providerIds}` });
      return;
    }
    const info = adapter.describe();
    const facilityCodes = info.facilities.map((f) => f.code).join(", ");
    // 시설이 하나면 생략할 수 있다. 둘 이상이면 어느 시설인지 골라야 한다.
    const facility = w.facility === undefined ? defaultFacility(info) : info.facilities.find((f) => f.code === w.facility);
    if (w.facility === undefined && !facility) {
      problems.push({ path: at("facility"), message: `시설을 골라야 한다. 쓸 수 있는 값: ${facilityCodes}` });
    } else if (w.facility !== undefined && !facility) {
      problems.push({ path: at("facility"), message: `없는 시설 "${w.facility}"다. 쓸 수 있는 값: ${facilityCodes}` });
    }
    const maxNights = facility?.maxNights ?? info.maxNights;
    if (w.nights > maxNights) {
      problems.push({ path: at("nights"), message: `${w.provider}는 최대 ${maxNights}박까지 예약할 수 있다(설정값 ${w.nights})` });
    }
    // 시설이 정해지지 않았으면 구역·자리는 확인할 수 없다.
    if (!facility) return;
    const zones = facility.zones;
    const codes = zones.map((z) => z.code);
    for (const z of w.zones) {
      if (!codes.includes(z)) problems.push({ path: at("zones"), message: `없는 구역 "${z}"다. 쓸 수 있는 값: ${codes.join(", ")}` });
    }
    // 자리 목록이 없는 구역은 자리로 거를 수 없다.
    if (w.seats) {
      const noSeats = zones.filter((z) => w.zones.includes(z.code) && !z.seats).map((z) => z.code);
      if (noSeats.length > 0) {
        problems.push({ path: at("seats"), message: `${noSeats.join(", ")}은(는) 자리를 볼 수 없어 seats를 쓸 수 없다` });
        return;
      }
    }
    // 구역 코드가 틀렸으면 구역 오류만 알린다. 자리 번호는 구역이 맞아야 확인할 수 있다.
    const requested = zones.filter((z) => w.zones.includes(z.code));
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
