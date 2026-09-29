import { readFileSync } from "node:fs";
import { donghaeAdapter } from "../src/adapters/donghae.js";
import { goraebulAdapter } from "../src/adapters/goraebul.js";
import { MAX_REQUEST_WAIT_MS } from "../src/http.js";
import { loadConfig } from "../src/config.js";
import { Liveness } from "../src/liveness.js";
import { runPoller } from "../src/poller.js";
import type { TelegramMessage, TelegramSink } from "../src/telegram.js";
import type { Clock, HttpClient, ProviderAdapter, Transport, TransportRequest, TransportResponse } from "../src/types.js";

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
  /** true면 advance가 시각만 옮기고 타이머는 깨우지 않는다. 루프가 멈춘 상황을 흉내 낸다. */
  freezeTimers = false;
  async advance(ms: number): Promise<void> {
    this.current += ms;
    if (this.freezeTimers) return;
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
dailySummary: { enabled: false }
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
  respondDetail: (req: TransportRequest) => TransportResponse,
  opts: {
    /** true나 Error를 돌려주면 그 전송 시도가 실패한다. */
    failSend?: () => boolean | Error;
    yaml?: string;
    /** 캘린더 잔여. 기본은 모든 (구역, 날짜)에 잔여가 있다. */
    remaining?: (zone: string, date: string) => number;
    random?: () => number;
    /** 기본은 고래불 어댑터 하나. 예약처를 더 두려면 가짜 어댑터를 넣는다. */
    adapters?: Record<string, ProviderAdapter>;
    /** 주면 모든 요청을 이 함수가 답한다. 동해시처럼 고래불 캘린더 흉내가 필요 없는 서버용이다. */
    server?: (req: TransportRequest) => TransportResponse;
  } = {},
) {
  const respond = (req: TransportRequest) =>
    opts.server
      ? opts.server(req)
      : isCalendar(req)
      ? { status: 200, body: calendarHtml(calendarMonth(req), opts.remaining) }
      : respondDetail(req);
  const allRequests: TransportRequest[] = [];
  const requests: TransportRequest[] = []; // 상세 조회(zoneAreaAjax)만
  const requestTimes: number[] = [];
  const sent: TelegramMessage[] = [];
  const logs: { msg: string; fields?: Record<string, unknown> }[] = [];
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
  const liveness = new Liveness(() => clock.now().getTime());
  const controller = new AbortController();
  const done = runPoller(
    {
      config: loadConfig(opts.yaml ?? CONFIG_YAML, ENV, opts.adapters),
      adapters: opts.adapters ?? { goraebul: goraebulAdapter, donghae: donghaeAdapter },
      transport,
      clock,
      sink,
      version: "0.1.0",
      liveness,
      log: (msg, fields) => logs.push({ msg, fields }),
      random: opts.random ?? (() => 0.5), // 지터 0: 바퀴 간격 150초, 요청 간격 6.5초
    },
    controller.signal,
  );
  return { liveness, requests, allRequests, requestTimes, sent, logs, attempts: () => attempts, clock, stop: () => (controller.abort(), done) };
}

const HEAD = `
userAgentSuffix: "\${UA_SUFFIX}"
dailySummary: { enabled: false }
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

/** GET만 흉내 내는 HttpClient. 어댑터를 폴러 없이 직접 부를 때 쓴다. */
export const fakeHttp = (get: (url: string) => Promise<TransportResponse>): HttpClient => ({
  get,
  post: async (url) => {
    throw new Error(`POST는 흉내 내지 않는다: ${url}`);
  },
  clearSession: () => {},
});

export const DONGHAE_ZONES = ["전통한옥", "캐빈하우스", "든바다", "난바다", "허허바다", "자동차캠핑장", "캐라반", "글램핑(4인)", "글램핑(2인)"];

/** 동해시 월 달력 화면의 조각. 열린 날은 예약현황보기 링크, 닫힌 날은 예약마감이다. */
function donghaeCalendar(month: string, closed?: (date: string) => boolean): string {
  const [y, m] = month.split("-") as [string, string];
  const last = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
  const cells = Array.from({ length: last }, (_, i) => {
    const d = i + 1;
    const date = `${month}-${String(d).padStart(2, "0")}`;
    return closed?.(date)
      ? `<td class=""><div class="gDay"><div class="day"><div class="da">${d}</div></div><div class="lst"><ul><li class="end"><span>예약마감</span></li></ul></div></div></td>`
      : `<td class="pointer" onclick="jsChkInDt('${y}','${Number(m)}','${d}',this);"><div class="gDay"><div class="day"><div class="da">${d}</div></div><div class="lst forW"><ul id="${d}"><li><a class="reserve" href="#none" onclick="getFcltyCntAll('${d}'); return false;"><span>예약현황보기</span></a></li></ul></div></div></td>`;
  });
  return `<input type="hidden" id="q_year" name="q_year" value="${y}"><input type="hidden" id="q_month" name="q_month" value="${m}"><div class="mCalendar1"><table><tbody><tr>${cells.join("")}</tr></tbody></table></div>`;
}

/** 진입 페이지 응답. 대기열 키 등록 흐름 문자열을 갖춘 정상 형태다. 실제 응답처럼 temporaryReducedCounts는 없다. */
export const DONGHAE_ENTRY = () =>
  `<html><input type="hidden" id="netfunnel_key" name="netfunnel_key" value=''/><script>$.post("/user/reservation/ND_setNfKey.do", {}); NetFunnel_Action({action_id:"reserve"}, {});</script></html>`;

/** 가짜 동해시 서버. 대기열 서버와 www를 함께 흉내 낸다. 값을 문자열로 주면 그대로 응답에 넣는다. */
export function donghaeServer(
  opts: {
    /** 구역·날짜별 남은 수. 기본은 모두 예약완료다. */
    counts?: (zone: string, date: string) => number | string;
    reduced?: Record<string, number>;
    /** 대기열 응답 순서. 다 쓰면 마지막을 되풀이한다. 기본은 바로 통과다. */
    queue?: string[];
    detailBody?: (date: string) => string | undefined;
    /** 월 달력에서 예약마감으로 보일 날짜. 기본은 모두 열려 있다. */
    closed?: (date: string) => boolean;
    /** ND_checkNfKeyAvail.do가 키를 받아 주는지. 기본은 받아 준다. */
    keyAvailable?: (key: string) => boolean;
    /** BD_reservation.do 응답을 바꾼다. */
    entryBody?: () => string;
    /** BD_reservationOrigin.do 응답을 바꾼다. 인자는 temporaryReducedCounts 안쪽 문자열이다. */
    calendarBody?: (reduced: string, calendar: string) => string;
    /** www 요청(ND_setNfKey 제외)을 가로채 응답을 바꾼다. */
    intercept?: (req: TransportRequest) => TransportResponse | undefined;
  } = {},
) {
  let queueStep = 0;
  const seen = { keys: 0 };
  const respond = (req: TransportRequest): TransportResponse => {
    const url = new URL(req.url);
    if (url.hostname === "nf.campingkorea.or.kr") {
      if (url.searchParams.get("opcode") === "5004") {
        return { status: 200, body: "NetFunnel.gRtype=5004;NetFunnel.gControl.result='5004:200:key=done'; NetFunnel.gControl._showResult();" };
      }
      const list = opts.queue ?? [`5002:200:key=KEY${++seen.keys}&nwait=0&nnext=0&tps=0.000000&ttl=0&ip=nf.campingkorea.or.kr&port=443`];
      const line = list[Math.min(queueStep++, list.length - 1)]!;
      return { status: 200, body: `NetFunnel.gRtype=4999;NetFunnel.gControl.result='${line}'; NetFunnel.gControl._showResult();` };
    }
    const hijacked = url.hostname !== "nf.campingkorea.or.kr" ? opts.intercept?.(req) : undefined;
    if (hijacked) return hijacked;
    if (url.pathname.endsWith("/ND_setNfKey.do")) {
      return { status: 200, body: '{ "success" : true }', setCookie: ["DHCMP_JSESSIONID=sess1; Path=/; HttpOnly"] };
    }
    if (url.pathname.endsWith("/ND_checkNfKeyAvail.do")) {
      const key = new URLSearchParams(req.body ?? "").get("netfunnel_key") ?? "";
      const ok = opts.keyAvailable ? opts.keyAvailable(key) : true;
      return { status: 200, body: JSON.stringify({ result: true, message: ok ? "Available" : "NOT Available" }) };
    }
    if (url.pathname.endsWith("/BD_reservation.do")) {
      return { status: 200, body: opts.entryBody ? opts.entryBody() : DONGHAE_ENTRY() };
    }
    if (url.pathname.endsWith("/BD_reservationOrigin.do")) {
      const form = new URLSearchParams(req.body ?? "");
      const reduced = Object.entries(opts.reduced ?? {}).map(([k, v]) => `'${k}' : ${v}`).join(", ");
      const calendar = donghaeCalendar(`${form.get("q_year")}-${form.get("q_month")}`, opts.closed);
      return {
        status: 200,
        body: opts.calendarBody ? opts.calendarBody(reduced, calendar) : `<html><script>var temporaryReducedCounts = { ${reduced} };</script>${calendar}</html>`,
      };
    }
    if (url.pathname.endsWith("/ND_selectFcltyCalendarDetail.do")) {
      const form = new URLSearchParams(req.body ?? "");
      const date = `${form.get("q_year")}-${form.get("q_month")}-${form.get("qDay")!.padStart(2, "0")}`;
      const custom = opts.detailBody?.(date);
      if (custom !== undefined) return { status: 200, body: custom };
      const value = DONGHAE_ZONES.map((z) => {
        const n = opts.counts?.(z, date) ?? "예약완료";
        return `${z}:${n}`;
      }).join("|^|");
      return { status: 200, body: JSON.stringify({ ipAdres: null, paramMap: {}, result: true, value, message: null }) };
    }
    return { status: 404, body: "" };
  };
  return respond;
}
