import type { AvailabilityQuery, AvailableSite, ProviderInfo } from "./types.js";

export interface TelegramMessage {
  chatId: string;
  text: string;
  parse_mode: "HTML";
  reply_markup?: { inline_keyboard: { text: string; url: string }[][] };
}

/** Telegram Bot API sendMessage 경계. 테스트에서 기록용으로 바꿔 끼운다. */
export interface TelegramSink {
  sendMessage(botToken: string, msg: TelegramMessage): Promise<void>;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export function weekday(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? "";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderOpenings(opts: {
  chatId: string;
  watchName: string;
  info: ProviderInfo;
  query: AvailabilityQuery;
  sites: AvailableSite[];
  link: string;
}): TelegramMessage {
  const { query: q } = opts;
  const zoneName = opts.info.zones.find((z) => z.code === q.zone)?.name ?? q.zone;
  const text = [
    "🏕 빈자리 발견",
    `<b>${escapeHtml(opts.watchName)}</b>`,
    `${q.checkIn}(${weekday(q.checkIn)}) ${q.nights}박 · ${escapeHtml(zoneName)}`,
    opts.sites.map((s) => escapeHtml(s.name)).join(", "),
  ].join("\n");
  return {
    chatId: opts.chatId,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: `${zoneName} ${q.checkIn} 예약 화면`, url: opts.link }]] },
  };
}
