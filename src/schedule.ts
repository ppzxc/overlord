import type { AvailabilityQuery, OpeningRule } from "./types.js";

// 예약처가 한국 시각 기준으로 열고 닫는다.
const KST_MS = 9 * 3600_000;
const DAY_MS = 86_400_000;

export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export function kstDate(now: Date): string {
  return new Date(now.getTime() + KST_MS).toISOString().slice(0, 10);
}

/** 한국 시각 date의 hhmm("HH:MM")에 해당하는 절대 시각(ms). */
function kstInstant(date: string, hhmm: string): number {
  return Date.parse(`${date}T${hhmm}:00+09:00`);
}

/** 한국 시각 "MM-DD HH:mm". 요약 메시지에서 시각을 보여 줄 때 쓴다. */
export function kstStamp(now: Date): string {
  return new Date(now.getTime() + KST_MS).toISOString().slice(5, 16).replace("T", " ");
}

const HOUR_MS = 3600_000;

/** 한국 시각 "YYYY-MM-DDTHH". 시간별 통계의 키다. */
export function kstHourKey(now: Date): string {
  return new Date(now.getTime() + KST_MS).toISOString().slice(0, 13);
}

/** 한국 시각 정각 가운데 시(hour)가 everyHours의 배수인 다음 시각(now 이후, 같은 시각 제외)까지 남은 ms. */
export function msUntilNextHourMark(now: Date, everyHours: number): number {
  const step = everyHours * HOUR_MS;
  const local = now.getTime() + KST_MS;
  return (Math.floor(local / step) + 1) * step - local;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function weekdayKey(date: string): WeekdayKey {
  return WEEKDAY_KEYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

export interface WatchWindow {
  checkIn: { from: string; to: string };
  weekdays?: WeekdayKey[] | undefined;
  nights: number;
}

/** 입실일 범위 안에서 요일 필터에 맞고 아직 지나가지 않은 날짜. 오픈 여부는 보지 않는다. */
function remainingDates(w: WatchWindow, rule: OpeningRule, now: Date): string[] {
  const today = kstDate(now);
  const dates: string[] = [];
  for (let d = w.checkIn.from; d <= w.checkIn.to; d = addDays(d, 1)) {
    if (d < today) continue;
    if (d === today && now.getTime() >= kstInstant(d, rule.sameDayCutoff)) continue;
    if (w.weekdays && !w.weekdays.includes(weekdayKey(d))) continue;
    dates.push(d);
  }
  return dates;
}

export function isExpired(w: WatchWindow, rule: OpeningRule, now: Date): boolean {
  return remainingDates(w, rule, now).length === 0;
}

/** 지금 조회해야 하는 조회 단위: 남은 날짜 가운데 이미 열린 날짜만 구역마다 펼친다. */
export function expandWatch(w: WatchWindow & { zones: string[] }, rule: OpeningRule, now: Date): AvailabilityQuery[] {
  const open = remainingDates(w, rule, now).filter(
    (d) => now.getTime() >= kstInstant(addDays(d, -rule.openDaysBefore), rule.openTime),
  );
  return w.zones.flatMap((zone) => open.map((checkIn) => ({ zone, checkIn, nights: w.nights })));
}

export const unitKey = (q: AvailabilityQuery) => `${q.zone}|${q.checkIn}|${q.nights}`;

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** 한국 시각으로 지금이 조용한 시간대인가. from > to면 자정을 넘는 구간이다. from은 포함, to는 제외한다. */
export function isQuiet(now: Date, quiet: { from: string; to: string } | undefined): boolean {
  if (!quiet) return false;
  const t = Math.floor(((now.getTime() + KST_MS) % DAY_MS) / 60_000);
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  return from < to ? t >= from && t < to : t >= from || t < to;
}

/** now가 오픈 경쟁 시간 안이면 구간 끝까지 남은 ms, 아니면 0. from > to면 자정을 넘는 구간이다. */
export function msUntilRushEnd(now: Date, rush: { from: string; to: string } | undefined): number {
  if (!rush || !isQuiet(now, rush)) return 0;
  return msUntilNext(now, rush.to);
}

/** now 이후(같은 시각 제외) 처음 오는 한국 시각 hhmm까지 남은 ms. */
export function msUntilNext(now: Date, hhmm: string): number {
  const today = kstDate(now);
  const at = kstInstant(today, hhmm);
  return (at > now.getTime() ? at : kstInstant(addDays(today, 1), hhmm)) - now.getTime();
}
