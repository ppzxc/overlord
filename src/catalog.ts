import { createHttpClient } from "./http.js";
import { addDays, kstDate } from "./schedule.js";
import type { AdapterContext, ProviderAdapter, Transport, ZoneInfo } from "./types.js";

/** A01,A02,A03,A05 → "A01-A03, A05". 번호가 연속인 것만 묶는다. */
function compact(ids: string[]): string {
  const parsed = ids.map((id) => /^(\D+)(\d+)$/.exec(id));
  if (parsed.some((m) => !m)) return ids.join(", ");
  const parts: string[] = [];
  let start = 0;
  for (let i = 1; i <= ids.length; i++) {
    const prev = parsed[i - 1]!;
    const cur = parsed[i];
    if (cur && cur[1] === prev[1] && +cur[2]! === +prev[2]! + 1) continue;
    parts.push(start === i - 1 ? ids[start]! : `${ids[start]}-${ids[i - 1]}`);
    start = i;
  }
  return parts.join(", ");
}

const seatsText = (z: ZoneInfo) => (z.seats ? `${z.seats.length}자리: ${compact(z.seats)}` : "(고정 목록 없음)");

/** 터미널에서 한글은 두 칸을 차지한다. */
const visualWidth = (text: string) => [...text].reduce((n, ch) => n + (/[가-힣]/.test(ch) ? 2 : 1), 0);

/** 구역 표: 코드, 이름, 유형, 정원, 자리 번호. */
export function renderCatalog(adapter: ProviderAdapter): string {
  const info = adapter.describe();
  const rows = [
    ["코드", "이름", "유형", "정원", "자리"],
    ...info.zones.map((z) => [z.code, z.name, z.type, z.capacity ? `${z.capacity}인` : "-", seatsText(z)]),
  ];
  const widths = [0, 1, 2, 3].map((c) => Math.max(...rows.map((r) => visualWidth(r[c]!))));
  const lines = rows.map((r) =>
    [...r.slice(0, 4).map((cell, c) => cell + " ".repeat(widths[c]! - visualWidth(cell))), r[4]!].join("  ").trimEnd(),
  );
  return `${info.id} (최대 ${info.maxNights}박)\n${lines.join("\n")}\n`;
}

export interface LiveOptions {
  transport: Transport;
  version: string;
  userAgentSuffix?: string;
  now: Date;
  /** 요청 사이에 쉰다. 예약처에 연달아 요청하지 않으려는 것이다. */
  pause: () => Promise<void>;
}

/** 구역마다 실제 자리 배치를 한 번 조회해서 고정 목록과 비교한다. */
export async function renderLiveDiff(adapter: ProviderAdapter, opts: LiveOptions): Promise<string> {
  if (!adapter.listSeats) return `${adapter.id}는 실제 자리 목록 조회를 지원하지 않는다\n`;
  const ctx: AdapterContext = {
    http: createHttpClient({ transport: opts.transport, version: opts.version, userAgentSuffix: opts.userAgentSuffix ?? "" }),
  };
  // 당일 입실은 18:00에 마감되므로 내일 날짜로 묻는다.
  const checkIn = addDays(kstDate(opts.now), 1);
  const lines: string[] = [];
  let differences = 0;
  let first = true;
  for (const zone of adapter.describe().zones) {
    if (!first) await opts.pause();
    first = false;
    const actual = await adapter.listSeats(({ zone: zone.code, checkIn, nights: 1 }), ctx);
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
