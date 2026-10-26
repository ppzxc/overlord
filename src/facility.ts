import { AdapterError, type FacilityInfo, type ProviderInfo } from "./types.js";

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

const findZone = (info: Pick<ProviderInfo, "facilities">, facilityCode: string, zoneCode: string) =>
  info.facilities.find((f) => f.code === facilityCode)?.zones.find((z) => z.code === zoneCode);

/** 메시지에 쓰는 구역 이름. 모르는 시설이나 구역이면 구역 코드를 그대로 쓴다. */
export function zoneName(info: Pick<ProviderInfo, "facilities">, facilityCode: string, zoneCode: string): string {
  return findZone(info, facilityCode, zoneCode)?.name ?? zoneCode;
}

/** 구역의 정원(카탈로그). 모르는 시설·구역이거나 정원을 확인하지 못한 구역이면 undefined다. */
export function zoneCapacity(info: Pick<ProviderInfo, "facilities">, facilityCode: string, zoneCode: string): number | undefined {
  return findZone(info, facilityCode, zoneCode)?.capacity;
}

/** 구역의 자리 목록(카탈로그). 모르는 시설·구역이거나 자리 목록이 없으면 undefined다. */
export function zoneSeats(info: Pick<ProviderInfo, "facilities">, facilityCode: string, zoneCode: string): readonly string[] | undefined {
  return findZone(info, facilityCode, zoneCode)?.seats;
}

/**
 * 시설의 `ref`를 문자열로 읽는다. 시설이 카탈로그에 없거나 `ref`가 문자열이 아니면 `AdapterError("unrecognized")`다.
 * `what`은 오류 메시지에 쓰는 값 이름이다. 메시지는 `… 시설 X에 값이 없다: what` 꼴이라 이름 뒤에 조사가 붙지 않는다.
 */
export function stringRef(info: Pick<ProviderInfo, "id" | "facilities">, facility: string, what: string): string {
  const ref = info.facilities.find((f) => f.code === facility)?.ref;
  if (typeof ref !== "string" || !ref) throw new AdapterError("unrecognized", `${info.id} 시설 ${facility}에 값이 없다: ${what}`);
  return ref;
}

/**
 * 시설의 `ref`를 키-값으로 읽는다. 시설이 카탈로그에 없거나 `ref`가 객체가 아니거나 `required` 키 중 하나라도 비면 `AdapterError("unrecognized")`다.
 * 돌려주는 객체는 `ref` 전체라 선택 키도 읽을 수 있다.
 */
export function fieldsRef<K extends string>(info: Pick<ProviderInfo, "id" | "facilities">, facility: string, required: readonly K[]): Record<K, string> & Record<string, string> {
  const ref = info.facilities.find((f) => f.code === facility)?.ref;
  if (typeof ref !== "object" || required.some((k) => !ref[k])) {
    throw new AdapterError("unrecognized", `${info.id} 시설 ${facility}에 ${required.join("·")}가 없다`);
  }
  return ref as Record<K, string> & Record<string, string>;
}
