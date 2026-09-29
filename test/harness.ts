import { readFileSync } from "node:fs";
import { goraebulAdapter } from "../src/adapters/goraebul.js";
import { MAX_REQUEST_WAIT_MS } from "../src/http.js";
import { loadConfig } from "../src/config.js";
import { runPoller } from "../src/poller.js";
import type { TelegramMessage, TelegramSink } from "../src/telegram.js";
import type { Clock, ProviderAdapter, Transport, TransportRequest } from "../src/types.js";

export const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

export class FakeClock implements Clock {
  private current = Date.parse("2026-09-29T09:00:00+09:00");
  private timers: { at: number; resolve: () => void }[] = [];
  now = () => new Date(this.current);
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    // 요청 사이의 짧은 대기는 바로 지나간 것으로 친다. 바퀴 간격 같은 긴 대기만 advance로 넘긴다.
    if (ms <= MAX_REQUEST_WAIT_MS) {
      this.current += ms;
      return Promise.resolve();
    }
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

const ZONE_CODES = ["CAA", "CAB", "DKA", "DKB", "DKC", "AUA", "PEA", "PEB", "PEC"];

/** 월 캘린더 HTML을 만든다. remaining이 없는 (구역, 날짜)는 기본으로 잔여 9다. 0이면 (마감)이다. */
export function calendarHtml(
  month: string,
  remaining: (zone: string, date: string) => number = () => 9,
): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const cells = Array.from({ length: new Date(Date.UTC(y, m, 0)).getUTCDate() }, (_, i) => {
    const day = i + 1;
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const items = ZONE_CODES.map((zone) => {
      const n = remaining(zone, date);
      return n > 0
        ? `<li><a href='/pages/sub.htm?nav_code=gor1501675800&mode=step01&type=${zone}&today=${date}&col=0' class='point_blue'>${zone}</a><em>(${n})</em></li>`
        : `<li>${zone}(마감)</li>`;
    }).join("");
    return `<td ><span class='day'>${day}</span><ul class='list'>${items}</ul></td>`;
  });
  return `<table class="t_calendar"><tr>${cells.join("")}</tr></table>`;
}

/** 캘린더 요청 URL의 월(YYYY-MM). */
const calendarMonth = (r: TransportRequest) => {
  const q = new URL(r.url).searchParams;
  return `${q.get("view_cate")}-${q.get("view_cate2")!.padStart(2, "0")}`;
};

const isCalendar = (r: TransportRequest) => new URL(r.url).pathname.endsWith("/sub.htm");

/** 폴러 전체를 실제 설정으로 띄우고 Transport, Clock, Telegram Sink만 교체한다. */
export function startPoller(
  respondDetail: (req: TransportRequest) => { status: number; body: string },
  opts: {
    /** true나 Error를 돌려주면 그 전송 시도가 실패한다. */
    failSend?: () => boolean | Error;
    yaml?: string;
    /** 캘린더 잔여. 기본은 모든 (구역, 날짜)에 잔여가 있다. */
    remaining?: (zone: string, date: string) => number;
    random?: () => number;
    /** 기본은 고래불 어댑터 하나. 예약처를 더 두려면 가짜 어댑터를 넣는다. */
    adapters?: Record<string, ProviderAdapter>;
  } = {},
) {
  const respond = (req: TransportRequest) =>
    isCalendar(req)
      ? { status: 200, body: calendarHtml(calendarMonth(req), opts.remaining) }
      : respondDetail(req);
  const allRequests: TransportRequest[] = [];
  const requests: TransportRequest[] = []; // 상세 조회(zoneAreaAjax)만
  const requestTimes: number[] = [];
  const sent: TelegramMessage[] = [];
  let attempts = 0;
  const clock = new FakeClock();
  const transport: Transport = async (req) => {
    allRequests.push(req);
    if (!isCalendar(req)) requests.push(req);
    requestTimes.push(clock.now().getTime());
    return respond(req);
  };
  const sink: TelegramSink = {
    sendMessage: async (_t, msg) => {
      attempts++;
      const fail = opts.failSend?.();
      if (fail) throw fail instanceof Error ? fail : new Error("전송 실패");
      sent.push(msg);
    },
    getUpdates: async () => [],
  };
  const controller = new AbortController();
  const done = runPoller(
    {
      config: loadConfig(opts.yaml ?? CONFIG_YAML, ENV, opts.adapters),
      adapters: opts.adapters ?? { goraebul: goraebulAdapter },
      transport,
      clock,
      sink,
      version: "0.1.0",
      random: opts.random ?? (() => 0.5), // 지터 0: 바퀴 간격 150초, 요청 간격 6.5초
    },
    controller.signal,
  );
  return { requests, allRequests, requestTimes, sent, attempts: () => attempts, clock, stop: () => (controller.abort(), done) };
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
