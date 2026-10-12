import type { ProviderAdapter, ZoneInfo } from "./types.js";
import { resolveFacility } from "./facility.js";

/** A01,A02,A03,A05 → "A01-A03, A05". 번호가 연속인 것만 묶는다. 번호만(1,2,3)인 이름도 묶는다. */
export function compact(ids: string[]): string {
  const parsed = ids.map((id) => /^(\D*)(\d+)$/.exec(id));
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

/** 행들을 열마다 가장 넓은 칸에 맞춘다. 마지막 열은 패딩 없이 그대로 둔다. */
function renderRows(rows: string[][]): string {
  const last = rows[0]!.length - 1;
  const widths = Array.from({ length: last }, (_, c) => Math.max(...rows.map((r) => visualWidth(r[c]!))));
  return rows
    .map((r) => r.map((cell, c) => (c < last ? cell + " ".repeat(widths[c]! - visualWidth(cell)) : cell)).join("  ").trimEnd())
    .join("\n");
}

/** 시설 목록: 코드, 이름, 구역 수. 시설이 둘 이상인 예약처에서 시설을 고르게 한다. */
export function renderFacilities(adapter: ProviderAdapter): string {
  const info = adapter.describe();
  const rows = info.facilities.map((f) => [f.code, f.name, `${f.zones.length}곳`]);
  return `${info.id} (최대 ${info.maxNights}박)\n${renderRows(rows)}\n`;
}

/** 구역 표: 코드, 이름, 유형, 정원, 자리 번호. 시설을 안 고르면 첫 시설이다(시설이 하나인 예약처용). */
export function renderCatalog(adapter: ProviderAdapter, facilityCode?: string): string {
  const info = adapter.describe();
  const facility = resolveFacility(info, facilityCode);
  const rows = [
    ["코드", "이름", "유형", "정원", "자리"],
    ...facility.zones.map((z) => [z.code, z.name, z.type, z.capacity ? `${z.capacity}인` : "-", seatsText(z)]),
  ];
  return `${info.id} (최대 ${info.maxNights}박)\n${renderRows(rows)}\n`;
}
