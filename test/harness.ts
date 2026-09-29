import { readFileSync } from "node:fs";
import { goraebulAdapter } from "../src/adapters/goraebul.js";
import { loadConfig } from "../src/config.js";
import { runPoller } from "../src/poller.js";
import type { TelegramMessage, TelegramSink } from "../src/telegram.js";
import type { Clock, Transport, TransportRequest } from "../src/types.js";

export const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

export class FakeClock implements Clock {
  private current = Date.parse("2026-09-29T09:00:00+09:00");
  private timers: { at: number; resolve: () => void }[] = [];
  now = () => new Date(this.current);
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      this.timers.push({ at: this.current + ms, resolve });
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  async advance(ms: number): Promise<void> {
    this.current += ms;
    const due = this.timers.filter((t) => t.at <= this.current);
    this.timers = this.timers.filter((t) => t.at > this.current);
    due.forEach((t) => t.resolve());
    await settle();
  }
}

export const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

export const CONFIG_YAML = `
userAgentSuffix: "\${UA_SUFFIX}"
providers:
  goraebul: { pollIntervalSeconds: 150 }
notifiers:
  default: { type: telegram, botToken: \${TELEGRAM_BOT_TOKEN}, chatId: \${TELEGRAM_CHAT_ID} }
watches:
  - name: 9월 말 숲속야영장
    provider: goraebul
    zones: [DKA]
    checkIn: { from: 2026-09-29, to: 2026-09-29 }
    nights: 1
    notify: [default]
`;

export const ENV = { UA_SUFFIX: "(ops)", TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "42" };

/** 폴러 전체를 실제 설정으로 띄우고 Transport, Clock, Telegram Sink만 교체한다. */
export function startPoller(
  respond: (req: TransportRequest) => { status: number; body: string },
  opts: { failSend?: () => boolean; yaml?: string } = {},
) {
  const requests: TransportRequest[] = [];
  const sent: TelegramMessage[] = [];
  const clock = new FakeClock();
  const transport: Transport = async (req) => {
    requests.push(req);
    return respond(req);
  };
  const sink: TelegramSink = {
    sendMessage: async (_t, msg) => {
      if (opts.failSend?.()) throw new Error("전송 실패");
      sent.push(msg);
    },
  };
  const controller = new AbortController();
  const done = runPoller(
    {
      config: loadConfig(opts.yaml ?? CONFIG_YAML, ENV),
      adapters: { goraebul: goraebulAdapter },
      transport,
      clock,
      sink,
      version: "0.1.0",
    },
    controller.signal,
  );
  return { requests, sent, clock, stop: () => (controller.abort(), done) };
}

const HEAD = `
userAgentSuffix: "\${UA_SUFFIX}"
providers:
  goraebul: { pollIntervalSeconds: 150 }
notifiers:
  default: { type: telegram, botToken: \${TELEGRAM_BOT_TOKEN}, chatId: \${TELEGRAM_CHAT_ID} }
watches:
`;

/** 감시 조건 블록(YAML 조각)들로 설정을 만든다. */
export const configWith = (...watches: string[]) => HEAD + watches.join("\n");

/** 요청 URL에서 조회 단위 값을 읽는다. */
export const queryOf = (r: TransportRequest) => {
  const u = new URL(r.url);
  return {
    checkIn: u.searchParams.get("res_Day"),
    zone: u.searchParams.get("room_Code"),
    nights: u.searchParams.get("site_date"),
  };
};
