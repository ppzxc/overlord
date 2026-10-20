import { compact } from "./catalog.js";
import { resolveFacility } from "./facility.js";
import { createHttpClient } from "./http.js";
import { addDays, kstDate } from "./schedule.js";
import { AdapterError, type AdapterContext, type Clock, type ProviderAdapter, type Transport, type FacilityInfo, type ProviderInfo, type FacilityObservation, type ZoneObservation } from "./types.js";

export interface LiveOptions {
  transport: Transport;
  version: string;
  now: Date;
  /** 요청 사이 간격(5초 + 0~3초 지터)을 지키는 데 쓰는 시계와 난수. 폴러와 같은 원칙이다. */
  clock: Clock;
  random: () => number;
  /** 대조할 시설 코드. 없으면 첫 시설이다(시설이 하나인 예약처용). */
  facility?: string;
  /** 어댑터가 `ProviderInfo.secrets`로 선언한 값(환경 변수 이름 → 값). */
  env?: Record<string, string | undefined>;
}

export interface LiveResult {
  text: string;
  /** 조회에 실패한 구역이 있거나 차단되어 중단했다. */
  failed: boolean;
}

/** 요청 간격을 지키는 HTTP 클라이언트와 비밀 값을 담은, `--live` 조회용 어댑터 맥락. */
export function liveContext(info: ProviderInfo, opts: LiveOptions): AdapterContext {
  const secrets = Object.fromEntries((info.secrets ?? []).flatMap((name) => (opts.env?.[name] ? [[name, opts.env[name]!]] : [])));
  return {
    clock: opts.clock,
    ...(info.secrets ? { secrets } : {}),
    http: createHttpClient({
      transport: opts.transport,
      version: opts.version,
      userAgentSuffix: "",
      blockedPaths: info.blockedPaths,
      cookieSession: info.cookieSession,
      pacing: { clock: opts.clock, random: opts.random, signal: new AbortController().signal },
    }),
  };
}

/**
 * 구역마다 실제 자리 배치를 한 번 조회해서 고정 목록과 비교한다.
 * 한 구역이 실패해도 나머지는 계속 조회한다. 차단되면 더 부담을 주지 않도록 멈춘다.
 */
export async function renderLiveDiff(adapter: ProviderAdapter, opts: LiveOptions): Promise<LiveResult> {
  const info = adapter.describe();
  const ctx = liveContext(info, opts);
  try {
    return await compareLive(adapter, resolveFacility(info, opts.facility), addDays(kstDate(opts.now), 1), ctx);
  } finally {
    // 대기열에 들어갔던 예약처는 종료할 때 마무리 신호를 보낸다.
    await adapter.close?.(ctx);
  }
}

async function compareLive(adapter: ProviderAdapter, facility: FacilityInfo, checkIn: string, ctx: AdapterContext): Promise<LiveResult> {
  if (adapter.observeFacility) return renderFacilityDiff(adapter.observeFacility.bind(adapter), facility, ctx);
  if (adapter.listZones) return renderZoneDiff(adapter.listZones.bind(adapter), facility, checkIn, ctx);
  if (!adapter.listSeats) {
    return { text: `${adapter.describe().id}는 자리 단위로 보지 않는 예약처라 비교할 자리 목록이 없다\n`, failed: false };
  }
  const listSeats = adapter.listSeats.bind(adapter);
  const lines: string[] = [];
  let differences = 0;
  let failures = 0;
  for (const zone of facility.zones) {
    let actual: string[];
    try {
      actual = await listSeats({ facility: facility.code, zone: zone.code, checkIn, nights: 1 }, ctx);
    } catch (e) {
      if (!(e instanceof AdapterError)) throw e;
      failures++;
      lines.push(`${zone.code}: 조회 실패(${e.kind}): ${e.message}`);
      if (e.kind === "blocked") {
        lines.push("차단되어 나머지 구역 조회를 멈춘다");
        break;
      }
      continue;
    }
    if (!zone.seats) {
      lines.push(`${zone.code}: 고정 목록이 없다. 실제 ${actual.length}자리: ${compact(actual)}`);
      continue;
    }
    const missing = zone.seats.filter((s) => !actual.includes(s));
    const added = actual.filter((s) => !zone.seats!.includes(s));
    if (missing.length === 0 && added.length === 0) {
      lines.push(`${zone.code}: 일치 (${actual.length}자리)`);
      continue;
    }
    differences++;
    if (missing.length) lines.push(`${zone.code}: 예약처에서 사라진 자리 ${compact(missing)}`);
    if (added.length) lines.push(`${zone.code}: 예약처에 새로 생긴 자리 ${compact(added)}`);
  }
  if (failures > 0) lines.push(`조회에 실패한 구역 ${failures}곳: 결과가 완전하지 않다`);
  if (differences > 0) lines.push(`차이 있는 구역 ${differences}곳: 어댑터의 고정 목록을 갱신해야 한다`);
  if (failures === 0 && differences === 0) lines.push("차이 없음");
  return { text: `${lines.join("\n")}\n`, failed: failures > 0 };
}

/** 시설 하나를 한 번 조회해서 구역마다 코드와 자리를 고정 목록과 비교한다. */
async function renderFacilityDiff(observe: NonNullable<ProviderAdapter["observeFacility"]>, facility: FacilityInfo, ctx: AdapterContext): Promise<LiveResult> {
  let seen: FacilityObservation;
  try {
    seen = await observe(facility.code, ctx);
  } catch (e) {
    if (!(e instanceof AdapterError)) throw e;
    return { text: `조회 실패(${e.kind}): ${e.message}\n`, failed: true };
  }
  if (seen.nothingToCompare) return { text: `${seen.nothingToCompare}\n`, failed: false };
  const lines: string[] = [];
  let differences = 0;
  for (const zone of facility.zones) {
    const actual = seen.zones.find((z) => z.name === zone.name);
    if (!actual) {
      differences++;
      lines.push(`${zone.code}: 예약처 응답에 구역이 없다(${zone.name})`);
      continue;
    }
    if (actual.codes.length > 0 && !actual.codes.includes(zone.code)) {
      differences++;
      lines.push(`${zone.code}: 구역 코드가 다르다(카탈로그 ${zone.code}, 예약처 ${actual.codes.join(", ")})`);
    }
    if (!zone.seats) {
      lines.push(`${zone.code}: 고정 목록이 없다. 실제 ${actual.seats.length}자리: ${compact(actual.seats)}`);
      continue;
    }
    const missing = zone.seats.filter((s) => !actual.seats.includes(s));
    const added = actual.seats.filter((s) => !zone.seats!.includes(s));
    if (missing.length === 0 && added.length === 0) {
      lines.push(`${zone.code}: 일치 (${actual.seats.length}자리)`);
      continue;
    }
    differences++;
    if (missing.length) lines.push(`${zone.code}: 예약처에서 사라진 자리 ${compact(missing)}`);
    if (added.length) lines.push(`${zone.code}: 예약처에 새로 생긴 자리 ${compact(added)}`);
  }
  for (const z of seen.zones.filter((a) => !facility.zones.some((f) => f.name === a.name))) {
    differences++;
    lines.push(`예약처에 새로 생긴 구역 ${z.name}(${z.codes.join(", ") || "코드 미확인"}): ${z.seats.length}자리`);
  }
  for (const u of seen.unattributed ?? []) {
    differences++;
    lines.push(`구역을 가릴 수 없는 자리 ${compact(u.seats)}: ${u.reason}`);
  }
  if (differences > 0) lines.push(`차이 있는 구역 ${differences}곳: 카탈로그를 갱신해야 한다`);
  else lines.push("차이 없음");
  if (seen.note) lines.push(seen.note);
  return { text: `${lines.join("\n")}\n`, failed: false };
}

/** 구역 이름 집합만 알 수 있는 예약처: 한 번 조회해서 고정 구역과 비교한다. */
async function renderZoneDiff(
  listZones: NonNullable<ProviderAdapter["listZones"]>,
  facility: FacilityInfo,
  checkIn: string,
  ctx: AdapterContext,
): Promise<LiveResult> {
  let seen: ZoneObservation;
  try {
    seen = await listZones({ facility: facility.code, zone: "", checkIn, nights: 1 }, ctx);
  } catch (e) {
    if (!(e instanceof AdapterError)) throw e;
    return { text: `조회 실패(${e.kind}): ${e.message}\n`, failed: true };
  }
  if (seen.nothingToCompare) return { text: `${seen.nothingToCompare}\n`, failed: false };
  const fixed = facility.zones.map((z) => z.name);
  const missing = fixed.filter((n) => !seen.zones.includes(n));
  const added = seen.zones.filter((n) => !fixed.includes(n));
  const lines: string[] = [];
  for (const u of seen.unknown) lines.push(`모르는 값: ${u.zone}=${u.value}`);
  if (missing.length) lines.push(`예약처에서 사라진 구역 ${missing.join(", ")}`);
  if (added.length) lines.push(`예약처에 새로 생긴 구역 ${added.join(", ")}`);
  if (lines.length === 0) lines.push(`구역 일치 (${fixed.length}곳)`);
  return { text: `${lines.join("\n")}\n`, failed: false };
}
