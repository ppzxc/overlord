import { compact, renderRows } from "./catalog.js";
import { liveContext, type LiveOptions, type LiveResult } from "./catalog-live.js";
import { GOODS_PER_CALL, readFacilityLive, type ForestLiveView } from "./adapters/foresttrip.js";
import { resolveFacility } from "./facility.js";
import { kstDate } from "./schedule.js";
import { AdapterError, type FacilityInfo, type ProviderAdapter } from "./types.js";

/** 한 시설의 한 바퀴 호출 상한(상품 100개). 넘으면 폴러는 그 시설을 조회하지 않는다. */
export const CALL_LIMIT = 20;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3600_000;

export interface ForestFilter {
  /** 보려는 구역(유형 코드). 없으면 응답의 모든 구역이다. */
  zones?: string[] | undefined;
  /** 보려는 자리(상품 이름, 정확 일치). 없으면 구역의 모든 상품이다. */
  seats?: string[] | undefined;
}

const insttIdOf = (facility: FacilityInfo) => (typeof facility.ref === "object" ? facility.ref.insttId : undefined) ?? "-";

/** 시설의 구역 코드, 라벨, 상품 수. 상품 수는 로그인 응답에서만 알 수 있어 카탈로그 표에서는 비운다. */
export function renderForestZones(facility: FacilityInfo): string {
  const rows = [["구역 코드", "라벨", "상품 수"], ...facility.zones.map((z) => [z.code, z.name, "-"])];
  return `foresttrip ${facility.code} (${facility.name}, insttId ${insttIdOf(facility)})\n${renderRows(rows)}\n상품 수는 로그인 응답에서만 알 수 있다. --live로 확인한다\n`;
}

/** 예약 개시 시각(`HHMM`) 5분 전부터 30분 후까지. 주별 시설은 매일, 그 밖의 시설은 매월 1일이다. 개시 시각을 모르면 쉬지 않는다. */
function inOpeningRush(now: Date, policy: { cycle: string | undefined; beginTime: string | undefined }): boolean {
  const m = /^(\d{2})(\d{2})$/.exec(policy.beginTime ?? "");
  if (!m) return false;
  if (policy.cycle !== "WEEK" && kstDate(now).slice(8) !== "01") return false;
  const nowOfDay = (now.getTime() + KST_MS) % DAY_MS;
  const sinceOpen = (nowOfDay - (+m[1]! * 60 + +m[2]!) * MINUTE_MS + DAY_MS) % DAY_MS;
  return sinceOpen < 30 * MINUTE_MS || sinceOpen >= DAY_MS - 5 * MINUTE_MS;
}

const callsFor = (goods: number) => Math.ceil(goods / GOODS_PER_CALL);

function compare(facility: FacilityInfo, view: ForestLiveView, filter: ForestFilter): string[] {
  const lines: string[] = [];
  let differences = 0;
  const rows = [["구역 코드", "라벨", "상품 수", "대조"]];
  for (const zone of facility.zones) {
    const actual = view.zones.find((z) => z.code === zone.code);
    if (!actual) {
      differences++;
      rows.push([zone.code, zone.name, "-", "예약처에서 사라진 구역"]);
    } else if (actual.label !== zone.name) {
      differences++;
      rows.push([zone.code, actual.label, String(actual.goods.length), `라벨이 다르다(카탈로그 ${zone.name})`]);
    } else rows.push([zone.code, zone.name, String(actual.goods.length), "일치"]);
  }
  for (const z of view.zones.filter((a) => !facility.zones.some((f) => f.code === a.code))) {
    differences++;
    rows.push([z.code, z.label, String(z.goods.length), "예약처에 새로 생긴 구역"]);
  }
  lines.push(renderRows(rows));
  lines.push(differences > 0 ? `차이 있는 구역 ${differences}곳: 카탈로그를 갱신해야 한다` : "차이 없음");

  lines.push("", "상품 목록");
  for (const z of view.zones) lines.push(`${z.code} ${z.label}: ${z.goods.length}개 ${compact(z.goods)}`);

  // 예상 호출 수: 구역 필터와 자리 필터로 줄인 상품을 5개씩 묶은 잔여 호출이다. 상품 목록 호출은 캐시되어 한 바퀴마다 나가지 않는다.
  const scoped = view.zones.filter((z) => !filter.zones || filter.zones.includes(z.code));
  const callRows = [["구역 코드", "라벨", "조회 상품", "호출"]];
  let total = 0;
  for (const z of scoped) {
    const goods = filter.seats ? z.goods.filter((g) => filter.seats!.includes(g)) : z.goods;
    total += callsFor(goods.length);
    callRows.push([z.code, z.label, String(goods.length), `${callsFor(goods.length)}번`]);
  }
  lines.push("", `예상 호출 수(한 바퀴, 잔여 상품 ${GOODS_PER_CALL}개씩)`, renderRows(callRows));
  for (const code of (filter.zones ?? []).filter((c) => !view.zones.some((z) => z.code === c))) lines.push(`없는 구역: ${code}`);
  for (const name of (filter.seats ?? []).filter((n) => !scoped.some((z) => z.goods.includes(n)))) lines.push(`없는 자리 이름: ${name}`);
  lines.push(
    total > CALL_LIMIT
      ? `합계 ${total}번: 상한 ${CALL_LIMIT}번을 넘는다. 이 조건은 조회되지 않는다. 구역(--zones)이나 자리(--seats)를 줄인다`
      : `합계 ${total}번 (상한 ${CALL_LIMIT}번)`,
  );
  return lines;
}

/** `catalog foresttrip <시설> --live`: `insttId`로 시설 하나를 읽어 카탈로그의 구역과 대조하고 상품 목록과 예상 호출 수를 보인다. */
export async function renderForestLive(adapter: ProviderAdapter, opts: LiveOptions, filter: ForestFilter): Promise<LiveResult> {
  const info = adapter.describe();
  const facility = resolveFacility(info, opts.facility);
  const ctx = liveContext(info, opts);
  try {
    const view = await readFacilityLive(facility.code, ctx, (policy) =>
      inOpeningRush(opts.now, policy) ? `이 시설의 오픈 경쟁 시간(예약 개시 ${policy.beginTime} 5분 전~30분 후)이라 상품 목록을 조회하지 않는다. 그 뒤에 다시 실행하라` : undefined,
    );
    if ("stopped" in view) return { text: `${view.stopped}\n`, failed: true };
    return { text: `${compare(facility, view, filter).join("\n")}\n`, failed: false };
  } catch (e) {
    if (!(e instanceof AdapterError)) throw e;
    return { text: `조회 실패(${e.kind}): ${e.message}\n`, failed: true };
  } finally {
    await adapter.close?.(ctx);
  }
}
