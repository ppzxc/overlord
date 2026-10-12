import type { FacilityInfo, ProviderInfo } from "./types.js";

/**
 * 예약처 안의 시설 하나를 고른다. 코드를 안 주면 첫 시설이다(시설이 하나인 예약처용).
 * 없는 코드는 다른 시설로 바꾸지 않고 던진다.
 */
export function resolveFacility(info: Pick<ProviderInfo, "id" | "facilities">, code?: string): FacilityInfo {
  const found = code === undefined ? info.facilities[0] : info.facilities.find((f) => f.code === code);
  if (!found) {
    throw new Error(`${info.id}에 없는 시설: ${code}. 쓸 수 있는 값: ${info.facilities.map((f) => f.code).join(", ")}`);
  }
  return found;
}

/**
 * 시설을 안 골랐을 때 쓰는 기본 시설. 시설이 하나뿐이고 예약처가 시설 선택을 요구하지 않을 때만 있다.
 * 둘 이상이거나 `facilityRequired`면 undefined이고 호출자가 시설을 고르게 해야 한다.
 */
export function defaultFacility(info: Pick<ProviderInfo, "facilities" | "facilityRequired">): FacilityInfo | undefined {
  return info.facilities.length === 1 && !info.facilityRequired ? info.facilities[0] : undefined;
}

/** 메시지에 쓰는 구역 이름. 모르는 시설이나 구역이면 구역 코드를 그대로 쓴다. */
export function zoneName(info: Pick<ProviderInfo, "facilities">, facilityCode: string, zoneCode: string): string {
  const facility = info.facilities.find((f) => f.code === facilityCode);
  return facility?.zones.find((z) => z.code === zoneCode)?.name ?? zoneCode;
}
