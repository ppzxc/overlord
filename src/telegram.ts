import type { HealthStatus, NoticeStatus } from "./health.js";
import type { AvailabilityQuery, AvailableSite, ProviderInfo } from "./types.js";
import { kstStamp } from "./schedule.js";

export interface TelegramMessage {
  chatId: string;
  text: string;
  parse_mode: "HTML";
  /** true면 알림음 없이 보낸다 */
  disable_notification?: true;
  reply_markup?: { inline_keyboard: { text: string; url: string }[][] };
}

/** Telegram Bot API가 요청을 거절했거나 응답하지 못했을 때. status가 없으면 네트워크 오류다. */
export class TelegramError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** 429 응답이 알려 준 대기 시간(초) */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

/** Telegram Bot API 경계. 테스트에서 기록용으로 바꿔 끼운다. */
export interface TelegramSink {
  sendMessage(botToken: string, msg: TelegramMessage): Promise<void>;
  /** getUpdates의 result 배열 */
  getUpdates(botToken: string): Promise<unknown[]>;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export function weekday(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? "";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface OpeningEntry {
  watchName: string;
  query: AvailabilityQuery;
  sites: AvailableSite[];
  link: string;
}

/** 메시지 한 건의 글자 수 한도. */
const MAX_TEXT = 4096;
/** 첫 줄에 "(10/12)" 같은 쪽 표시가 붙어 늘어나는 글자 수의 여유. */
const PAGE_MARK_ROOM = 12;
const MAX_BUTTONS = 8;
/** 자리가 아주 많은 구역 한 곳이 메시지 한 건을 혼자 넘지 않도록 한 줄에 쓰는 자리 수의 상한. */
const MAX_SITES_PER_LINE = 60;

/**
 * 알림 대상 하나에 이번 바퀴에 나갈 빈자리들을 메시지로 만든다. 한도를 넘으면 여러 건으로 나누고,
 * 어느 항목이 어느 메시지에 들어갔는지 돌려준다. 버튼은 메시지마다 최대 8개이고, 넘치는 항목은 본문 링크로 쓴다.
 */
export function renderOpenings<E extends OpeningEntry>(opts: {
  chatId: string;
  info: ProviderInfo;
  entries: E[];
  /** 프로세스를 시작한 뒤 첫 바퀴에서 나가는 메시지인가 */
  startupSnapshot?: boolean;
}): { message: TelegramMessage; items: { entry: E; sites: AvailableSite[] }[] }[] {
  const header = opts.startupSnapshot ? "🔄 재시작 직후 현황" : "🏕 빈자리 발견";
  const limit = MAX_TEXT - PAGE_MARK_ROOM;
  interface Page {
    lines: string[];
    length: number;
    buttons: { text: string; url: string }[];
    items: Map<E, AvailableSite[]>;
    watchName?: string;
  }
  const newPage = (): Page => ({ lines: [header], length: header.length, buttons: [], items: new Map() });
  const pages: Page[] = [];
  let page = newPage();

  for (const entry of opts.entries) {
    const q = entry.query;
    const zoneName = opts.info.zones.find((z) => z.code === q.zone)?.name ?? q.zone;
    for (let i = 0; i < entry.sites.length; i += MAX_SITES_PER_LINE) {
      const chunkSites = entry.sites.slice(i, i + MAX_SITES_PER_LINE);
      // 남은 수를 세는 예약처는 자리 이름 대신 남은 수를 보인다. 연박의 남은 수는 밤마다 센 최솟값이다.
      const counted = chunkSites.every((s) => s.remaining !== undefined);
      const detail = counted
        ? `${q.nights > 1 ? "밤마다 남은 최소" : "남은"} ${chunkSites.map((s) => s.remaining).join(", ")}${q.nights > 1 ? " (같은 자리 연속 보장 없음)" : ""}`
        : chunkSites.map((s) => escapeHtml(s.name)).join(", ");
      const base = `${q.checkIn}(${weekday(q.checkIn)}) ${q.nights}박 · ${escapeHtml(zoneName)} · ${detail}`;
      const tryAdd = (p: Page) => {
        const linked = p.buttons.some((b) => b.url === entry.link);
        const room = linked || p.buttons.length < MAX_BUTTONS;
        const added = [
          ...(p.watchName === entry.watchName ? [] : [`<b>${escapeHtml(entry.watchName)}</b>`]),
          room ? base : `${base} · <a href="${escapeHtml(entry.link)}">예약 화면</a>`,
        ];
        return { added, addButton: room && !linked, size: added.reduce((n, l) => n + l.length + 1, 0) };
      };
      let placed = tryAdd(page);
      if (page.items.size > 0 && page.length + placed.size > limit) {
        pages.push(page);
        page = newPage();
        placed = tryAdd(page);
      }
      page.lines.push(...placed.added);
      page.length += placed.size;
      page.watchName = entry.watchName;
      const chunk = entry.sites.slice(i, i + MAX_SITES_PER_LINE);
      page.items.set(entry, [...(page.items.get(entry) ?? []), ...chunk]);
      if (placed.addButton) page.buttons.push({ text: `${zoneName} ${q.checkIn} 예약 화면`, url: entry.link });
    }
  }
  if (page.items.size > 0) pages.push(page);

  return pages.map((p, i) => {
    const lines = [...p.lines];
    if (pages.length > 1) lines[0] = `${header} (${i + 1}/${pages.length})`;
    return {
      message: {
        chatId: opts.chatId,
        text: lines.join("\n"),
        parse_mode: "HTML",
        ...(p.buttons.length > 0 ? { reply_markup: { inline_keyboard: p.buttons.map((b) => [b]) } } : {}),
      },
      items: [...p.items].map(([entry, sites]) => ({ entry, sites })),
    };
  });
}

const MAX_RETRIES = 3;
/** 5xx와 네트워크 오류 뒤 재시도 전 대기(ms). */
const BACKOFF_MS = [2_000, 4_000, 8_000];
/** 이보다 오래 기다리라는 429는 다음 바퀴로 미룬다. */
const MAX_RETRY_AFTER_MS = 120_000;

/** 다시 시도할 만한 오류면 기다릴 시간(ms)을, 아니면 undefined를 돌려준다. */
function retryDelayMs(err: unknown, attempt: number): number | undefined {
  const status = err instanceof TelegramError ? err.status : undefined;
  if (status === 429) {
    const ms = ((err as TelegramError).retryAfterSeconds ?? 5) * 1000;
    return ms > MAX_RETRY_AFTER_MS ? undefined : ms;
  }
  return status === undefined || status >= 500 ? BACKOFF_MS[attempt] : undefined;
}

/**
 * 메시지 한 건을 보낸다. 429는 retry_after만큼, 5xx와 네트워크 오류는 점점 늘려 가며 최대 3회 다시 시도한다.
 * 그 밖의 거절(잘못된 토큰이나 chat 등)은 다시 시도해도 소용없으므로 바로 던진다.
 */
export async function sendWithRetry(
  sink: TelegramSink,
  botToken: string,
  msg: TelegramMessage,
  sleep: (ms: number) => Promise<void>,
  aborted: () => boolean,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sink.sendMessage(botToken, msg);
    } catch (err) {
      if (attempt >= MAX_RETRIES || aborted()) throw err;
      const waitMs = retryDelayMs(err, attempt);
      if (waitMs === undefined) throw err;
      await sleep(waitMs);
    }
  }
}

export interface TelegramChat {
  id: string;
  type: string;
  /** 그룹 이름이나 사용자 이름을 사람이 알아볼 수 있게 이어 붙인 값 */
  name: string;
}

/** getUpdates 결과에서 chat을 중복 없이 모은다. */
export function chatsFromUpdates(updates: unknown[]): TelegramChat[] {
  const chats = new Map<string, TelegramChat>();
  for (const update of updates) {
    if (typeof update !== "object" || update === null) continue;
    for (const value of Object.values(update)) {
      const chat = (value as { chat?: Record<string, unknown> } | null)?.chat;
      if (!chat || (typeof chat.id !== "number" && typeof chat.id !== "string")) continue;
      const id = String(chat.id);
      const name = [chat.title, chat.username && `@${String(chat.username)}`, chat.first_name, chat.last_name]
        .filter((v): v is string => typeof v === "string" && v !== "")
        .join(" ");
      chats.set(id, { id, type: String(chat.type ?? ""), name });
    }
  }
  return [...chats.values()];
}

export function renderWatchExpired(opts: {
  chatId: string;
  watchName: string;
  checkIn: { from: string; to: string };
}): TelegramMessage {
  const text = [
    "⌛ 감시 조건 만료",
    `<b>${escapeHtml(opts.watchName)}</b>`,
    `입실일 범위 ${opts.checkIn.from} ~ ${opts.checkIn.to}가 모두 지났다. 더 이상 조회하지 않는다.`,
  ].join("\n");
  return { chatId: opts.chatId, text, parse_mode: "HTML" };
}

const HEALTH_TITLES: Record<NoticeStatus, string> = {
  blocked: "🚫 예약처가 폴러를 차단했다",
  unrecognized: "🧩 예약처 화면 구조가 바뀌었다",
  unavailable: "🛠 예약처가 점검 중이다",
  degraded: "⚠️ 예약처 조회가 계속 실패한다",
  recovered: "✅ 예약처 조회가 회복됐다",
};

const HEALTH_ACTIONS: Record<NoticeStatus, string> = {
  blocked: "차단을 풀 방법이 없으니 이 예약처의 조회를 멈췄다. 원인을 확인한 뒤 폴러를 재시작해야 조회를 다시 시작한다.",
  unrecognized: "빈자리 없음으로 착각하지 않도록 이 예약처의 조회를 멈췄다. 어댑터를 고친 뒤 폴러를 재시작해야 한다.",
  unavailable: "30분 간격으로 계속 확인한다. 같은 상태가 이어지는 동안은 24시간마다 한 번만 다시 알린다.",
  degraded: "간격을 늘려 계속 재시도한다. 회복되면 알린다.",
  recovered: "정상으로 돌아왔다.",
};

export function renderHealth(opts: {
  chatId: string;
  provider: string;
  status: NoticeStatus;
  detail: string;
  reminder?: boolean;
}): TelegramMessage {
  const lines = [
    `${opts.reminder ? "🔁 (계속) " : ""}${HEALTH_TITLES[opts.status]}`,
    `예약처: <b>${escapeHtml(opts.provider)}</b>`,
  ];
  if (opts.detail) lines.push(`상세: ${escapeHtml(opts.detail)}`);
  lines.push(HEALTH_ACTIONS[opts.status]);
  return { chatId: opts.chatId, text: lines.join("\n"), parse_mode: "HTML" };
}

export interface SummaryProvider {
  id: string;
  status: HealthStatus;
  /** 전날 기록. 없으면 알 수 없다. */
  day?: { rounds: number; failures: number } | undefined;
  /** 마지막으로 바퀴가 성공한 시각. 아직 없으면 알 수 없다. */
  lastSuccessAt?: Date | undefined;
  /** 지금 상태가 시작된 시각. */
  statusSince?: Date | undefined;
}

const STATUS_LABELS: Record<HealthStatus, string> = {
  ok: "정상",
  degraded: "일시 오류 지속",
  unavailable: "점검 중",
  stopped: "멈춤",
};

const statusText = (p: SummaryProvider) =>
  `${STATUS_LABELS[p.status]}${p.status !== "ok" && p.statusSince ? ` (${kstStamp(p.statusSince)}부터)` : ""}`;
const lastSuccessText = (p: SummaryProvider) => `마지막 성공 ${p.lastSuccessAt ? kstStamp(p.lastSuccessAt) : "없음"}`;

export function renderHourlySummary(opts: {
  chatId: string;
  /** 바퀴 수와 실패 수를 센 간격(시간) */
  everyHours: number;
  providers: SummaryProvider[];
}): TelegramMessage {
  const lines = ["🕐 시간별 요약"];
  for (const p of opts.providers) {
    const counts = p.day ? `지난 ${opts.everyHours}시간 바퀴 ${p.day.rounds}회, 실패한 바퀴 ${p.day.failures}회` : "기록 없음";
    lines.push(`예약처 <b>${escapeHtml(p.id)}</b>: ${statusText(p)} · ${counts} · ${lastSuccessText(p)}`);
  }
  return { chatId: opts.chatId, text: lines.join("\n"), parse_mode: "HTML", disable_notification: true };
}

export function renderSummary(opts: {
  chatId: string;
  /** 바퀴 수와 실패 수를 센 날짜(전날) */
  date: string;
  providers: SummaryProvider[];
  activeWatches: number;
  expiring: { name: string; lastCheckIn: string }[];
  /** 프로세스 가동 시작 시각. 바퀴 수를 세기 시작한 기준이다. */
  startedAt: Date;
}): TelegramMessage {
  const lines = ["📋 일일 요약", `활성 감시 조건: ${opts.activeWatches}건`, `가동 시작 ${kstStamp(opts.startedAt)}`];
  for (const p of opts.providers) {
    lines.push(`예약처 <b>${escapeHtml(p.id)}</b>: ${statusText(p)} · ${opts.date} ${p.day ? `바퀴 ${p.day.rounds}회, 실패한 바퀴 ${p.day.failures}회` : "기록 없음"} · ${lastSuccessText(p)}`);
  }
  if (opts.expiring.length > 0) {
    lines.push("곧 만료:");
    for (const e of opts.expiring) lines.push(`· ${escapeHtml(e.name)} (입실일 범위 끝 ${e.lastCheckIn})`);
  }
  return { chatId: opts.chatId, text: lines.join("\n"), parse_mode: "HTML", disable_notification: true };
}
