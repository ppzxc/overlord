import { compact } from "./catalog.js";
import { createHttpClient } from "./http.js";
import { addDays, kstDate } from "./schedule.js";
import { AdapterError, type AdapterContext, type Clock, type ProviderAdapter, type Transport, type ZoneInfo, type ZoneObservation } from "./types.js";

export interface LiveOptions {
  transport: Transport;
  version: string;
  now: Date;
  /** 요청 사이 간격(5초 + 0~3초 지터)을 지키는 데 쓰는 시계와 난수. 폴러와 같은 원칙이다. */
  clock: Clock;
  random: () => number;
}

export interface LiveResult {
  text: string;
  /** 조회에 실패한 구역이 있거나 차단되어 중단했다. */
  failed: boolean;
}

/**
 * 구역마다 실제 자리 배치를 한 번 조회해서 고정 목록과 비교한다.
 * 한 구역이 실패해도 나머지는 계속 조회한다. 차단되면 더 부담을 주지 않도록 멈춘다.
 */
export async function renderLiveDiff(adapter: ProviderAdapter, opts: LiveOptions): Promise<LiveResult> {
  const info = adapter.describe();
  const ctx: AdapterContext = {
    clock: opts.clock,
    http: createHttpClient({
      transport: opts.transport,
      version: opts.version,
      userAgentSuffix: "",
      blockedPaths: info.blockedPaths,
      cookieSession: info.cookieSession,
      pacing: { clock: opts.clock, random: opts.random, signal: new AbortController().signal },
    }),
  };
  try {
    return await compareLive(adapter, info.zones, addDays(kstDate(opts.now), 1), ctx);
  } finally {
    // 대기열에 들어갔던 예약처는 종료할 때 마무리 신호를 보낸다.
    await adapter.close?.(ctx);
  }
}

async function compareLive(adapter: ProviderAdapter, zones: ZoneInfo[], checkIn: string, ctx: AdapterContext): Promise<LiveResult> {
  if (adapter.listZones) return renderZoneDiff(adapter.listZones.bind(adapter), zones, checkIn, ctx);
  if (!adapter.listSeats) {
    return { text: `${adapter.describe().id}는 자리 단위로 보지 않는 예약처라 비교할 자리 목록이 없다\n`, failed: false };
  }
  const listSeats = adapter.listSeats.bind(adapter);
  const lines: string[] = [];
  let differences = 0;
  let failures = 0;
  for (const zone of zones) {
    let actual: string[];
    try {
      actual = await listSeats({ zone: zone.code, checkIn, nights: 1 }, ctx);
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

/** 구역 이름 집합만 알 수 있는 예약처: 한 번 조회해서 고정 구역과 비교한다. */
async function renderZoneDiff(
  listZones: NonNullable<ProviderAdapter["listZones"]>,
  zones: ZoneInfo[],
  checkIn: string,
  ctx: AdapterContext,
): Promise<LiveResult> {
  let seen: ZoneObservation;
  try {
    seen = await listZones({ zone: "", checkIn, nights: 1 }, ctx);
  } catch (e) {
    if (!(e instanceof AdapterError)) throw e;
    return { text: `조회 실패(${e.kind}): ${e.message}\n`, failed: true };
  }
  const fixed = zones.map((z) => z.name);
  const missing = fixed.filter((n) => !seen.zones.includes(n));
  const added = seen.zones.filter((n) => !fixed.includes(n));
  const lines: string[] = [];
  for (const u of seen.unknown) lines.push(`모르는 값: ${u.zone}=${u.value}`);
  if (missing.length) lines.push(`예약처에서 사라진 구역 ${missing.join(", ")}`);
  if (added.length) lines.push(`예약처에 새로 생긴 구역 ${added.join(", ")}`);
  if (lines.length === 0) lines.push(`구역 일치 (${fixed.length}곳)`);
  return { text: `${lines.join("\n")}\n`, failed: false };
}
