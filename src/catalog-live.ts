import { compact } from "./catalog.js";
import { createHttpClient } from "./http.js";
import { addDays, kstDate } from "./schedule.js";
import type { AdapterContext, ProviderAdapter, Transport } from "./types.js";

export interface LiveOptions {
  transport: Transport;
  version: string;
  now: Date;
  /** 요청 사이에 쉰다. 예약처에 연달아 요청하지 않으려는 것이다. */
  pause: () => Promise<void>;
}

/** 구역마다 실제 자리 배치를 한 번 조회해서 고정 목록과 비교한다. */
export async function renderLiveDiff(adapter: ProviderAdapter, opts: LiveOptions): Promise<string> {
  const ctx: AdapterContext = {
    http: createHttpClient({ transport: opts.transport, version: opts.version, userAgentSuffix: "" }),
  };
  // 당일 입실은 18:00에 마감되므로 내일 날짜로 묻는다.
  const checkIn = addDays(kstDate(opts.now), 1);
  const lines: string[] = [];
  let differences = 0;
  let first = true;
  for (const zone of adapter.describe().zones) {
    if (!first) await opts.pause();
    first = false;
    const actual = await adapter.listSeats({ zone: zone.code, checkIn, nights: 1 }, ctx);
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
  lines.push(differences === 0 ? "차이 없음" : `차이 있는 구역 ${differences}곳: 어댑터의 고정 목록을 갱신해야 한다`);
  return `${lines.join("\n")}\n`;
}
