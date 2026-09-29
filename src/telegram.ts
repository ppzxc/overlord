import type { AvailabilityQuery, AvailableSite, ProviderInfo } from "./types.js";

export interface TelegramMessage {
  chatId: string;
  text: string;
  parse_mode: "HTML";
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
/** "(2/3)" 같은 쪽 표시를 붙일 여유. */
const PAGE_MARK_ROOM = 12;
const MAX_BUTTONS = 8;
/** 한 줄이 한도를 넘지 않도록 자리 이름을 나누는 단위. */
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
  const fresh = (): Page => ({ lines: [header], length: header.length, buttons: [], items: new Map() });
  const pages: Page[] = [];
  let page = fresh();

  for (const entry of opts.entries) {
    const q = entry.query;
    const zoneName = opts.info.zones.find((z) => z.code === q.zone)?.name ?? q.zone;
    for (let i = 0; i < entry.sites.length; i += MAX_SITES_PER_LINE) {
      const names = entry.sites
        .slice(i, i + MAX_SITES_PER_LINE)
        .map((s) => escapeHtml(s.name))
        .join(", ");
      const base = `${q.checkIn}(${weekday(q.checkIn)}) ${q.nights}박 · ${escapeHtml(zoneName)} · ${names}`;
      const place = (p: Page) => {
        const linked = p.buttons.some((b) => b.url === entry.link);
        const room = linked || p.buttons.length < MAX_BUTTONS;
        const added = [
          ...(p.watchName === entry.watchName ? [] : [`<b>${escapeHtml(entry.watchName)}</b>`]),
          room ? base : `${base} · <a href="${escapeHtml(entry.link)}">예약 화면</a>`,
        ];
        return { added, addButton: room && !linked, size: added.reduce((n, l) => n + l.length + 1, 0) };
      };
      let placed = place(page);
      if (page.items.size > 0 && page.length + placed.size > limit) {
        pages.push(page);
        page = fresh();
        placed = place(page);
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
      const status = err instanceof TelegramError ? err.status : undefined;
      let wait: number;
      if (status === 429) {
        wait = ((err as TelegramError).retryAfterSeconds ?? 5) * 1000;
        if (wait > MAX_RETRY_AFTER_MS) throw err;
      } else if (status === undefined || status >= 500) {
        wait = BACKOFF_MS[attempt]!;
      } else {
        throw err;
      }
      await sleep(wait);
    }
  }
}

export interface TelegramChat {
  id: string;
  type: string;
  title: string;
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
      chats.set(id, { id, type: String(chat.type ?? ""), title: name });
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
