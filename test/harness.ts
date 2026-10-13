import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";
import { donghaeAdapter } from "../src/adapters/donghae.js";
import { bukguAdapter } from "../src/adapters/bukgu.js";
import { goraebulAdapter } from "../src/adapters/goraebul.js";
import { jungguAdapter } from "../src/adapters/junggu.js";
import { knpsAdapter } from "../src/adapters/knps.js";
import { mirihaeAdapter } from "../src/adapters/mirihae.js";
import { uljuAdapter } from "../src/adapters/ulju.js";
import { xticketAdapter } from "../src/adapters/xticket.js";
import { MAX_REQUEST_WAIT_MS } from "../src/http.js";
import { loadConfig } from "../src/config.js";
import { Liveness } from "../src/liveness.js";
import { runPoller } from "../src/poller.js";
import type { TelegramMessage, TelegramSink } from "../src/telegram.js";
import type { AvailabilityQuery, Clock, HttpClient, ProviderAdapter, Transport, TransportRequest, TransportResponse } from "../src/types.js";

export const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

export class FakeClock implements Clock {
  private current: number;
  constructor(start = "2026-09-29T09:00:00+09:00") {
    this.current = Date.parse(start);
  }
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
    /** 가짜 시계의 시작 시각(ISO). 기본은 2026-09-29 09:00 KST다. */
    now?: string;
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
  const clock = new FakeClock(opts.now);
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
      adapters: opts.adapters ?? { goraebul: goraebulAdapter, donghae: donghaeAdapter, knps: knpsAdapter, xticket: xticketAdapter, ulju: uljuAdapter, junggu: jungguAdapter, bukgu: bukguAdapter, mirihae: mirihaeAdapter },
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
  setCookie: () => {},
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

/** 진입 응답. 실제 응답처럼 대기열을 통과한 뒤의 달력 화면이고 temporaryReducedCounts를 갖는다. */
export const DONGHAE_ENTRY = (reduced: string) =>
  `<html><input type="hidden" id="netfunnel_key" name="netfunnel_key" value=""/><script>var temporaryReducedCounts = { ${reduced} };</script><div class="mCalendar1"><table></table></div></html>`;

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
    /** BD_reservation.do 응답을 바꾼다. 인자는 temporaryReducedCounts 안쪽 문자열이다. */
    entryBody?: (reduced: string) => string;
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
      const reduced = Object.entries(opts.reduced ?? {}).map(([k, v]) => `'${k}' : ${v}`).join(", ");
      return { status: 200, body: opts.entryBody ? opts.entryBody(reduced) : DONGHAE_ENTRY(reduced) };
    }
    if (url.pathname.endsWith("/BD_reservationOrigin.do")) {
      const form = new URLSearchParams(req.body ?? "");
      return { status: 200, body: `<html>${donghaeCalendar(`${form.get("q_year")}-${form.get("q_month")}`, opts.closed)}</html>` };
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

/**
 * 테스트 전용 가짜 어댑터. 시설이 둘(alpha, beta)이고 두 시설에 같은 구역 코드(SH)가 하나 있다.
 * 조회 단위를 calls에 쌓고 자리 하나를 돌려준다.
 */
export function twoFacilityAdapter(): { adapter: ProviderAdapter; calls: AvailabilityQuery[] } {
  const calls: AvailabilityQuery[] = [];
  const adapter: ProviderAdapter = {
    id: "multi",
    describe: () => ({
      id: "multi",
      facilities: [
        {
          code: "alpha",
          name: "알파 시설",
          ref: "A-1",
          zones: [
            { code: "SH", name: "공용구역", type: "테스트", seats: ["S01", "S02"] },
            { code: "AO", name: "알파전용", type: "테스트" },
          ],
        },
        {
          code: "beta",
          name: "베타 시설",
          ref: "B-1",
          zones: [
            { code: "SH", name: "공용구역", type: "테스트", seats: ["T01"] },
            { code: "BO", name: "베타전용", type: "테스트" },
          ],
        },
      ],
      maxNights: 2,
      openingRule: { openDaysBefore: 30, openTime: "00:00", sameDayCutoff: "23:00" },
      blockedPaths: [],
      cookieSession: false,
    }),
    queryAvailability: async (q) => {
      calls.push(q);
      return [{ id: "S01", name: "1번 자리" }];
    },
    deepLink: (q) => `https://multi.example/${q.facility}/${q.zone}/${q.checkIn}`,
  };
  return { adapter, calls };
}

/**
 * 가짜 국립공원 서버. 대기열 서버(netfunnel.knps.or.kr)와 예약처(reservation.knps.or.kr)를 함께 흉내 낸다.
 * campsiteList.do는 기록한 갓바위 응답의 축소본을 그대로 돌려준다.
 */
export function knpsServer(
  opts: {
    /** campsiteList.do 본문. 기본은 기록한 축소본(자리 A01·A04·A08 x 10/13~10/22)이다. */
    list?: (form: URLSearchParams) => string;
    /** 대기열 5101/5002 응답 줄을 바꾼다. 액션(aid)과 그 액션의 몇 번째 요청인지를 받는다. 기본은 바로 통과다. */
    queue?: (aid: string, nth: number) => string | undefined;
    /** campsiteList.do의 HTTP 상태. 기본은 200이다. */
    listStatus?: number;
    /** `/assets/js/lib/netfunnel.js` 본문. 기본은 기록한 버전(2.2.19)과 `TS_HOST`다. */
    script?: string;
    /** selectCampLottery.do 응답. 기본은 기록한 화면의 발췌(6차, 야영장 0 개소)다. */
    lottery?: () => TransportResponse;
    /** searchSimpleCampReservation.do(예약 화면) 응답. 기본은 기록한 화면이다. */
    page?: () => TransportResponse;
  } = {},
) {
  const calls = { keys: 0, queue: new Map<string, number>() };
  const NF_TAIL = "&nwait=0&nnext=0&tps=0.000000&ttl=0&ip=netfunnel.knps.or.kr&port=443";
  return (req: TransportRequest): TransportResponse => {
    const url = new URL(req.url);
    if (url.hostname === "netfunnel.knps.or.kr") {
      const opcode = url.searchParams.get("opcode");
      if (opcode === "5004") return { status: 200, body: `NetFunnel.gRtype=5004;NetFunnel.gControl.result='5004:200:msg="Success"'; NetFunnel.gControl._showResult();` };
      const aid = url.searchParams.get("aid") ?? "";
      const nth = calls.queue.get(aid) ?? 0;
      calls.queue.set(aid, nth + 1);
      const line = opts.queue?.(aid, nth) ?? `5002:200:key=KEY${++calls.keys}${NF_TAIL}`;
      return { status: 200, body: `NetFunnel.gRtype=${opcode};NetFunnel.gControl.result='${line}'; NetFunnel.gControl._showResult();` };
    }
    if (url.hostname !== "reservation.knps.or.kr") return { status: 404, body: "" };
    if (url.pathname === "/reservation/searchSimpleCampReservation.do") {
      if (opts.page) return opts.page();
      return { status: 200, body: fixture("knps-searchSimpleCampReservation.htm"), setCookie: ["JSESSIONID=sess1; Path=/; HttpOnly"] };
    }
    if (url.pathname === "/reservation/selectCampLottery.do") {
      return opts.lottery ? opts.lottery() : { status: 200, body: fixture("knps-selectCampLottery.htm") };
    }
    if (url.pathname === "/reservation/campsiteList.do") {
      const form = new URLSearchParams(req.body ?? "");
      return { status: opts.listStatus ?? 200, body: opts.list ? opts.list(form) : fixture("knps-gatbawi-campsiteList.htm") };
    }
    if (url.pathname === "/assets/js/lib/netfunnel.js") {
      return { status: 200, body: opts.script ?? "/*\n * Version 2.2.19\n */\nNetFunnel.TS_HOST = 'netfunnel.knps.or.kr';\n" };
    }
    return { status: 404, body: "" };
  };
}

export const XTICKET_DALSEO = "f27ad3485cf140b64341e2cc975c376d14561a12aca07349ae393d97379882c7";
export const XTICKET_NAJEONG = "08f2d6ac872d55a829cd62de5a910ff0922eeb57506d4ddbe021224fce47d006";

export interface XticketPlayDate {
  advance_yn: string;
  book_remain_count: number;
  play_date: string;
}
export interface XticketProduct {
  status_code: string;
  select_yn: string;
  product_name: string;
  product_code: string;
  [key: string]: unknown;
}

export interface XticketGroup {
  product_group_code: string;
  product_group_name: string;
  [key: string]: unknown;
}

/** 기록한 상품군 응답(2026-10-12 달서, 나정). 다른 시설의 값은 기록하지 않았으므로 달서 것을 쓴다. */
export const xticketGroups = (_form: URLSearchParams, shopEncode: string): XticketGroup[] =>
  JSON.parse(fixture(`xticket-GetBookProductGroup-${shopEncode === XTICKET_NAJEONG ? "najeong" : "dalseo"}.json`)).data.bookProductGroupList;

/** 기록한 응답(2026-10-12)의 날짜 목록. 202610은 10/12~10/31, 202611은 11/01~11/30이다. */
export const xticketPlayDates = (month: string): XticketPlayDate[] =>
  month === "202610" || month === "202611" ? JSON.parse(fixture(`xticket-GetBookPlayDate-${month}.json`)).data.bookPlayDateList : [];

/** 기록한 카라반(0001) 1015 응답의 자리 목록. 선택가능은 카라반-11, 카라반-13이다. */
export const xticketProducts = (): XticketProduct[] => JSON.parse(fixture("xticket-GetBookProduct010001-0001-20261015.json")).data.bookProductList;

/**
 * 가짜 xticket 서버. 기록한 흐름을 그대로 흉내 낸다: /web/main은 쿠키가 없으면 302 두 번(Set-Cookie JSESSIONID),
 * POST는 form 본문이고 쿠키·Referer·Origin이 없으면 실제 응답처럼 세션 만료 JSON(200)이나 `{}`(200)를 준다.
 */
export function xticketServer(
  opts: {
    /** 달(YYYYMM)의 날짜 목록. 기본은 기록한 응답이다. */
    playDates?: (month: string, shopEncode: string) => XticketPlayDate[];
    /** 자리 목록. 기본은 기록한 응답(카라반-11, 카라반-13이 선택가능)이다. */
    products?: (form: URLSearchParams, shopEncode: string) => XticketProduct[];
    /** 날짜의 상품군 목록(GetBookProductGroup.json). 기본은 시설마다 기록한 응답(달서 4개, 나정 2개)이다. */
    groups?: (form: URLSearchParams, shopEncode: string) => XticketGroup[];
    /** 모든 요청에 앞서 응답을 가로챈다. */
    intercept?: (req: TransportRequest) => TransportResponse | undefined;
  } = {},
) {
  const sessions = new Map<string, string>(); // JSESSIONID -> shopEncode
  const opened: string[] = []; // /web/main이 새 세션을 연 shopEncode
  const json = (body: unknown): TransportResponse => ({ status: 200, body: JSON.stringify(body) });
  const respond = (req: TransportRequest): TransportResponse => {
    const hijacked = opts.intercept?.(req);
    if (hijacked) return hijacked;
    const url = new URL(req.url);
    if (url.hostname !== "camp.xticket.kr") return { status: 404, body: "" };
    const cookie = /JSESSIONID=([^;]+)/.exec(req.headers.Cookie ?? "")?.[1];
    const shop = cookie ? sessions.get(cookie) : undefined;
    if (url.pathname === "/web/main") {
      const value = url.searchParams.get("shopEncode") ?? "";
      if (shop === value) return { status: 200, body: `<html><script>var shopEncode = "${value}";</script></html>` };
      const id = `sess${sessions.size + 1}`;
      sessions.set(id, value);
      opened.push(value);
      return { status: 302, body: "", location: `/Web/Reservation?shop_encode=${value}`, setCookie: [`JSESSIONID=${id}; Path=/; Secure; HttpOnly`] };
    }
    if (url.pathname === "/Web/Reservation") {
      return { status: 302, body: "", location: `/web/main?shopEncode=${url.searchParams.get("shop_encode")}` };
    }
    const post = req.method === "POST" && url.pathname.startsWith("/Web/Book/");
    if (!post) return { status: 404, body: "" };
    if (req.headers["Content-Type"] !== "application/x-www-form-urlencoded; charset=UTF-8") return { status: 400, body: "" };
    if (!req.headers.Referer || !req.headers.Origin) return json({});
    if (!shop) return json({ error: { message: "세션이 만료되었습니다. 다시 시도 부탁드립니다." }, returnUrl: "main?shopEncode=", redirect: true });
    const form = new URLSearchParams(req.body ?? "");
    if (url.pathname === "/Web/Book/GetBookPlayDate.json") {
      return json({ data: { bookPlayDateList: (opts.playDates ?? xticketPlayDates)(form.get("play_month") ?? "", shop) } });
    }
    if (url.pathname === "/Web/Book/GetBookProductGroup.json") {
      return json({ data: { bookProductGroupList: (opts.groups ?? xticketGroups)(form, shop) } });
    }
    if (url.pathname === "/Web/Book/GetBookProduct010001.json") {
      return json({ data: { bookProductList: (opts.products ?? xticketProducts)(form, shop) } });
    }
    return { status: 404, body: "" };
  };
  return Object.assign(respond, { opened });
}

/** 기록한 작천정별빛(C0000001) 2026-10-16 응답(research/raw/ulju, 2026-10-12)의 행. 88자리이고 Y는 11자리(야영데크(4*4) 7, 야영데크(6*4) 4)다. */
export interface UljuRow {
  CAMP_ID: string;
  NAME: string;
  FACILITY_ID: string;
  FACILITY_NAME: string;
  ISRESERVABLE: string;
  SDATE: string;
  EDATE: string;
  [key: string]: unknown;
}

/** 시설(classes)별 기록한 2026-10-16 응답의 행. C0000001 작천정별빛 88, C0000002 등억알프스 68(Y 15), C0000003 작천정달빛 47(Y 9), C0000005 대운산하늘숲 20(Y 0)이다. */
export const uljuRows = (classes = "C0000001"): UljuRow[] => JSON.parse(fixture(`ulju-get_cal_day_data_list-${classes}-20261016.json`)).list;

/** 같은 밤을 가리키도록 SDATE·EDATE를 고친 행. 기록은 10/16 하루뿐이라 다른 밤의 응답은 이 행을 날짜만 바꿔 만든다. */
export const uljuRowsFor = (date: string, rows: UljuRow[] = uljuRows()): UljuRow[] => {
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return rows.map((r) => ({ ...r, SDATE: date, EDATE: next }));
};

/**
 * 가짜 울주 서버. get_cal_day_data_list만 흉내 낸다. 기록한 대로 쿠키·Referer가 없어도 답하고,
 * 본문이 JSON이 아니면 400을 준다. 그 밖의 요청은 404라서 어댑터가 예약 화면 같은 다른 경로를 부르면 드러난다.
 */
export function uljuServer(
  opts: {
    /** 밤(select_date)과 시설 값(classes)별 응답. 기본은 기록한 응답이다. */
    day?: (date: string, classes: string) => TransportResponse;
    intercept?: (req: TransportRequest) => TransportResponse | undefined;
  } = {},
) {
  const body: { sql_state: string; select_date: string; classes: string; facility: string; use_only: string }[] = [];
  const respond = (req: TransportRequest): TransportResponse => {
    const hijacked = opts.intercept?.(req);
    if (hijacked) return hijacked;
    const url = new URL(req.url);
    if (url.hostname !== "camping.ulju.ulsan.kr") return { status: 404, body: "" };
    if (req.method !== "POST" || url.pathname !== "/ujcamping/campsite/get_cal_day_data_list") return { status: 404, body: "" };
    if (req.headers["Content-Type"] !== "application/json") return { status: 400, body: "" };
    const form = JSON.parse(req.body ?? "{}") as (typeof body)[number];
    body.push(form);
    if (opts.day) return opts.day(form.select_date, form.classes);
    return { status: 200, body: JSON.stringify({ result: "ok", list: uljuRowsFor(form.select_date, uljuRows(form.classes)) }) };
  };
  return Object.assign(respond, { bodies: body });
}

/** `research/raw/<provider>`에 기록한 응답 원문을 읽는 함수. 변형은 읽은 원문을 고쳐 만든다. */
const recordedRaw = (provider: string) => (name: string) => readFileSync(new URL(`../research/raw/${provider}/${name}`, import.meta.url), "utf8");

/** 기록한 중구 응답(research/raw/junggu, 2026-10-12)을 읽는다. */
const jungguRaw = recordedRaw("junggu");

/** 중구 시설의 예약 화면 `menuNo`와 기록한 파일. 입화산 제2오토는 #78이 기록했고 황방산·태화연은 #79가 기록했다(research/raw/junggu). */
const JUNGGU_PAGES: Record<string, string> = { "1010300": "pageCont.do_menuNo-1010300.html", "1020300": "pageCont.do_menuNo-1020300.html", "1030300": "pageCont.do_menuNo-1030300.html" };
const jungguMonthlyFile = (cpId: string) => `ajaxGetMonthlyMap.do_${cpId}_2026-10.json`;
/** 입화산 제2오토의 자리 목록 파일 이름에는 cpId가 없다(#78 기록). 다른 시설은 파일 이름에 cpId가 있다. */
const jungguSiteListFile = (cpId: string, csId: string, date: string) =>
  cpId === "iphwa_auto2" ? `ajaxGetSiteList.do_${csId.slice(-2)}_${date}.json` : `ajaxGetSiteList.do_${cpId}_${csId.slice(-2)}_${date}.json`;

/** 기록한 시설 예약 화면. */
export const jungguPage = (menuNo = "1010300"): string => jungguRaw(JUNGGU_PAGES[menuNo] ?? "");

/** 기록한 월 지도(2026-10). 입화산 제2오토·황방산·태화연 모두 10/12~10/31이 선택 가능, 그 앞은 불가이고 중구민 전용일은 없다. */
export const jungguMonthly = (cpId = "iphwa_auto2"): { msg: string; monthlyMap: { calendarList: { date: string; isAbleDate: boolean; isExclusive: boolean; isOtherMonth: string }[] } } =>
  JSON.parse(jungguRaw(jungguMonthlyFile(cpId)));

export interface JungguSite {
  ctId: string;
  ctName: string;
  ctState: string;
  ctIsBookable: string;
  ctIsIng: string;
  lotteryCount: number;
  [key: string]: unknown;
}
export interface JungguSiteList {
  csName: string;
  msg: string;
  currentAppVO: { appProcess: string; [key: string]: unknown };
  siteList: JungguSite[];
  [key: string]: unknown;
}

/**
 * 기록한 `ajaxGetSiteList.do` 응답. 기록한 (시설, 구역 끝 두 자리, 날짜)만 있다.
 * 입화산 제2오토: 31은 10/14(CLOSED)·10/17(RESERVED)·10/20(열림), 32·33·35·36은 10/20이다. 황방산·태화연은 모든 구역의 10/20이다.
 * 황방산 10/20은 전 자리 CLOSED, 태화연 10/20은 `오토 101…`에 열림(ACTIVE)과 RESERVED가 섞여 있고 소형·이동식카라반은 전부 열림이다.
 */
export const jungguSiteList = (csId: string, date: string, cpId = "iphwa_auto2"): JungguSiteList =>
  JSON.parse(jungguRaw(jungguSiteListFile(cpId, csId, date)));

/**
 * 가짜 중구 서버. 대기열 서버(campwait.junggu.ulsan.kr)와 예약처(camping.junggu.ulsan.kr)를 함께 흉내 낸다.
 * 응답은 기록한 원문이다. 기록하지 않은 (구역, 날짜)나 달은 404라서 어댑터가 엉뚱한 곳을 부르면 드러난다.
 */
export function jungguServer(
  opts: {
    /** 대기열 5101/5002 응답 줄을 바꾼다. 액션(aid)과 그 액션의 몇 번째 요청인지를 받는다. 기본은 바로 통과다. */
    queue?: (aid: string, nth: number) => string | undefined;
    /** `ajaxGetMonthlyMap.do`(searchDate는 그 달 1일) 응답을 바꾼다. 기본은 기록한 2026-10 지도다. */
    monthly?: (searchDate: string, cpId: string) => TransportResponse | undefined;
    /** `ajaxGetSiteList.do` 응답을 바꾼다. 기본은 기록한 응답이다. */
    siteList?: (form: { searchDate: string; cpId: string; csId: string; isExclusive: string }) => TransportResponse | undefined;
    /** `pageCont.do` 응답을 바꾼다. */
    page?: (menuNo: string) => TransportResponse | undefined;
    /** `/camping/js/netfunnel.js` 본문을 바꾼다. 기본은 기록한 머리 20줄이다(버전 2.2.19, TS_HOST). */
    script?: string;
    /** 모든 요청에 앞서 응답을 가로챈다. */
    intercept?: (req: TransportRequest) => TransportResponse | undefined;
  } = {},
) {
  const calls = { keys: 0, queue: new Map<string, number>() };
  const NF_TAIL = "&nwait=0&nnext=0&tps=0.000000&ttl=0&ip=campwait.junggu.ulsan.kr&port=443";
  const forms: { path: string; form: Record<string, string> }[] = [];
  const respond = (req: TransportRequest): TransportResponse => {
    const hijacked = opts.intercept?.(req);
    if (hijacked) return hijacked;
    const url = new URL(req.url);
    if (url.hostname === "campwait.junggu.ulsan.kr") {
      const opcode = url.searchParams.get("opcode");
      if (opcode === "5004") return { status: 200, body: `NetFunnel.gRtype=5004;NetFunnel.gControl.result='5004:200:msg="Success"'; NetFunnel.gControl._showResult();` };
      const aid = url.searchParams.get("aid") ?? "";
      const nth = calls.queue.get(aid) ?? 0;
      calls.queue.set(aid, nth + 1);
      const line = opts.queue?.(aid, nth) ?? `5002:200:key=KEY${++calls.keys}${NF_TAIL}`;
      return { status: 200, body: `NetFunnel.gRtype=${opcode};NetFunnel.gControl.result='${line}'; NetFunnel.gControl._showResult();` };
    }
    if (url.hostname !== "camping.junggu.ulsan.kr") return { status: 404, body: "" };
    if (req.method === "GET" && url.pathname === "/camping/pageCont.do") {
      const menuNo = url.searchParams.get("menuNo") ?? "";
      const recorded = JUNGGU_PAGES[menuNo];
      return opts.page?.(menuNo) ?? (recorded ? { status: 200, body: jungguRaw(recorded), setCookie: ["JSESSIONID=sess1; Path=/camping; Secure; HttpOnly; SameSite=None"] } : { status: 404, body: "" });
    }
    if (req.method === "GET" && url.pathname === "/camping/js/netfunnel.js") return opts.script ? { status: 200, body: opts.script } : { status: 200, body: jungguRaw("netfunnel.excerpt.js") };
    if (req.method !== "POST") return { status: 404, body: "" };
    const form = Object.fromEntries(new URLSearchParams(req.body ?? ""));
    forms.push({ path: url.pathname, form });
    if (url.pathname === "/camping/ajaxGetMonthlyMap.do") {
      const custom = opts.monthly?.(form.searchDate ?? "", form.cpId ?? "");
      if (custom) return custom;
      if (form.searchDate !== "2026-10-01") return { status: 404, body: "" };
      try {
        return { status: 200, body: jungguRaw(jungguMonthlyFile(form.cpId ?? "")) };
      } catch {
        return { status: 404, body: "" };
      }
    }
    if (url.pathname === "/camping/ajaxGetSiteList.do") {
      const args = { searchDate: form.searchDate ?? "", cpId: form.cpId ?? "", csId: form.csId ?? "", isExclusive: form.isExclusive ?? "" };
      const custom = opts.siteList?.(args);
      if (custom) return custom;
      try {
        return { status: 200, body: jungguRaw(jungguSiteListFile(args.cpId, args.csId, args.searchDate)) };
      } catch {
        return { status: 404, body: "" };
      }
    }
    return { status: 404, body: "" };
  };
  return Object.assign(respond, { forms });
}

/** 기록한 북구 응답(research/raw/bukgu, 2026-10-13 00시 전후)을 읽는다. */
const bukguRaw = recordedRaw("bukgu");

/**
 * 기록한 `reservationCntAjax.do` 응답(`priceCode` 빈 값, 시설 전체 표). 기본은 강동(`010100`).
 * 강동: 10/14(예약가능 18), 10/17·10/31(모두 예약종료), 10/18(11), 10/20(22), 10/22(21), 10/25(15), 11/01(25, 추첨 접수 기간).
 * 당사(`010200`, 20자리): 10/14(17), 10/17(2), 10/20(20), 10/25(18), 11/01(20, 추첨 접수 기간).
 */
export const bukguTable = (date: string, siteKindCode = "010100"): string => bukguRaw(`reservationCntAjax.do_${siteKindCode}_${date}.html`);

/**
 * 기록한 예약 화면(`Pmreservation.do`). 달력 상한 `d2`(2026-11-01 00:00 KST + 밀리초)와 `resEndDay` '16' 등 페이지 변수가 있다.
 * `d2`의 밀리초는 요청 시각이 실려 요청마다 달라진다(2026-10-13 두 번 받아 `.072`와 `.038`).
 */
export const bukguPage = (): string => bukguRaw("Pmreservation.do.html");

/**
 * 가짜 북구 서버. `reservationCntAjax.do`와 예약 화면 GET을 흉내 낸다. 쿠키 없이도 답하고(기록), 기록하지 않은 날짜나 그 밖의 요청은 404라서
 * 어댑터가 다른 경로를 부르면 드러난다.
 */
export function bukguServer(
  opts: {
    /** 응답을 바꾼다. 기본은 기록한 표다. */
    table?: (form: { resDate: string; siteKindCode: string; priceCode: string }) => TransportResponse | undefined;
    /** 예약 화면 응답을 바꾼다. 기본은 기록한 화면이다. */
    page?: () => TransportResponse | undefined;
    /** 모든 요청에 앞서 응답을 가로챈다. */
    intercept?: (req: TransportRequest) => TransportResponse | undefined;
  } = {},
) {
  const forms: { resDate: string; siteKindCode: string; priceCode: string }[] = [];
  const respond = (req: TransportRequest): TransportResponse => {
    const hijacked = opts.intercept?.(req);
    if (hijacked) return hijacked;
    const url = new URL(req.url);
    if (url.hostname !== "camping.ubimc.or.kr") return { status: 404, body: "" };
    if (req.method === "GET" && url.pathname === "/Pmreservation.do") return opts.page?.() ?? { status: 200, body: bukguPage(), setCookie: ["JSESSIONID=sess1; Path=/; Secure; HttpOnly"] };
    if (req.method !== "POST" || url.pathname !== "/ajax/reservationCntAjax.do") return { status: 404, body: "" };
    const raw = Object.fromEntries(new URLSearchParams(req.body ?? ""));
    const form = { resDate: raw.resDate ?? "", siteKindCode: raw.siteKindCode ?? "", priceCode: raw.priceCode ?? "" };
    forms.push(form);
    const custom = opts.table?.(form);
    if (custom) return custom;
    try {
      return { status: 200, body: bukguTable(form.resDate, form.siteKindCode), setCookie: ["JSESSIONID=sess1; Path=/; Secure; HttpOnly"] };
    } catch {
      return { status: 404, body: "" };
    }
  };
  return Object.assign(respond, { forms });
}

/** 기록한 미리해 응답(research/raw/mirihae, 2026-10-13 09:24 ~ 09:31 KST)을 읽는다. */
const mirihaeRaw = recordedRaw("mirihae");

/** 가짜 서버가 입장 토큰·대기 토큰 자리(`<MASKED>`)에 채워 주는 시험용 값. 기록에서는 토큰을 가렸다. */
export const MIRIHAE_ENTERING_TOKEN = "TEST-ENTERING-TOKEN";
export const MIRIHAE_WAITING_TOKEN = "TEST-WAITING-TOKEN";
const MIRIHAE_PAGE_PATH = "/dytc/camping/V39628874";

/**
 * 기록한 천동 예약 화면(2026-10-13 09:26 KST). 이번 달(2026-10)이고 10/14 ~ 10/31 칸이 `click`이며 구역 야영장A·B·C의 남은 수가 칸마다 있다.
 * 10/14는 A 18, B 18, C 29다. 이 화면은 `<input name="tocken">`의 값만 가렸고 나머지는 원문 그대로다.
 */
export const mirihaePage = (): string => mirihaeRaw("camping_V39628874.html");

/**
 * 기록한 예약 화면을 고친 변형. 칸(`div.td#YYYY-MM-DD`)을 cheerio로 고쳐서 만든다. 기록은 10/14 ~ 10/31의 칸만 구역 남은 수를 갖는다.
 * `counts`는 날짜 → 구역 이름 → 남은 수이고 그 칸의 `dt`만 바꾼다. 날짜 칸의 구조를 바꾸려면 `edit`을 쓴다.
 */
export function mirihaePageWith(counts: Record<string, Record<string, number | string>>, edit?: ($: cheerio.CheerioAPI) => void): string {
  return withCounts(mirihaePage(), counts, edit);
}

/** 기록한 `calendar.do` 응답(2026-11 또는 2026-12)을 고친 변형. `counts`와 `edit`은 `mirihaePageWith`와 같다. 기록이 아니라 기록을 고쳐 만든 합성 응답이다. */
export function mirihaeCalendarWith(month: string, counts: Record<string, Record<string, number | string>>, edit?: ($: cheerio.CheerioAPI) => void): string {
  return withCounts(mirihaeRaw(`calendar.do_V39628874_${month}.html`), counts, edit);
}

function withCounts(html: string, counts: Record<string, Record<string, number | string>>, edit?: ($: cheerio.CheerioAPI) => void): string {
  const $ = cheerio.load(html);
  for (const [date, zones] of Object.entries(counts)) {
    for (const [zone, n] of Object.entries(zones)) {
      const dl = $(`div.td[id="${date}"] dl.schedule`).filter((_, el) => $(el).find("dd").text().trim() === zone);
      dl.find("dt").text(String(n));
    }
  }
  edit?.($);
  return $.html();
}

/** 기록한 `/api/entering` 401 응답 본문. */
const mirihaeEntering401 = () => mirihaeRaw("api_entering_401.json");

/**
 * 가짜 미리해 서버. 기록한 흐름을 흉내 낸다: 예약 화면은 `gateToken`이 없으면 302로 게이트 화면(`cdn.mirihae.com:9443/entering.html?uri=…`)에 보내고,
 * `/api/entering`은 `X-Mirihae-Reservation-Token` 헤더가 없으면 401, 있으면 200 `{enteringToken, uri}`를 주며,
 * `POST /api/waiting`은 대기 토큰을, `GET /api/waiting`은 대기 토큰 헤더를 보면 200 `{enteringToken, uri}`를 준다.
 * 응답 본문은 기록한 원문이고 토큰 자리만 시험용 값으로 채운다. 425(대기 중)는 기록하지 못해 `waiting`으로 `waiting.js`가 읽는 모양으로 만들어 준다(기록 아님).
 */
export function mirihaeServer(
  opts: {
    /** `GET /api/waiting`의 몇 번째(0부터) 요청에 줄 응답. 없으면 기록한 대로 바로 200이다. */
    waiting?: (nth: number) => TransportResponse | undefined;
    /** `/api/entering`의 몇 번째(0부터) 요청에 줄 응답. 없으면 기록한 대로 토큰이 없으면 401, 있으면 200이다. */
    entering?: (nth: number, req: TransportRequest) => TransportResponse | undefined;
    /** `POST /api/waiting` 응답. 없으면 기록한 대로 200과 대기 토큰이다. */
    waitingPost?: () => TransportResponse | undefined;
    /** 입장 토큰을 단 예약 화면 요청에 줄 응답. 없으면 기록한 화면이다. */
    page?: (req: TransportRequest) => TransportResponse | undefined;
    /** 모든 요청에 앞서 응답을 가로챈다. */
    intercept?: (req: TransportRequest) => TransportResponse | undefined;
    /** 예약 화면 경로(여럿이면 시설 여럿). 없으면 천동이다. 어느 경로든 같은 기록한 화면을 주므로 시설마다 다르게 주려면 `page`가 요청 경로를 본다. */
    pagePath?: string | string[];
    /** `POST /camping/calendar.do`에 줄 응답. 없으면 `selectMonth`에 맞는 기록한 달력(2026-11, 2026-12)이다. */
    calendar?: (month: string, req: TransportRequest) => TransportResponse | undefined;
  } = {},
) {
  const pagePaths = [opts.pagePath ?? MIRIHAE_PAGE_PATH].flat();
  const nth = { entering: 0, waiting: 0 };
  const enteringBody = () => mirihaeRaw("api_entering_200.json").replace("<MASKED>", MIRIHAE_ENTERING_TOKEN);
  const respond = (req: TransportRequest): TransportResponse => {
    const hijacked = opts.intercept?.(req);
    if (hijacked) return hijacked;
    const url = new URL(req.url);
    if (url.hostname === "cdn.mirihae.com" && url.port === "9443") return { status: 200, body: mirihaeRaw("entering.html") };
    if (url.hostname === "cdn.mirihae.com") {
      if (url.pathname === "/api/entering" && req.method === "GET") {
        const n = nth.entering++;
        const custom = opts.entering?.(n, req);
        if (custom) return custom;
        return req.headers["X-Mirihae-Reservation-Token"] === MIRIHAE_ENTERING_TOKEN
          ? { status: 200, body: enteringBody() }
          : { status: 401, body: mirihaeEntering401() };
      }
      if (url.pathname === "/api/waiting" && req.method === "POST") {
        return opts.waitingPost?.() ?? { status: 200, body: MIRIHAE_WAITING_TOKEN };
      }
      if (url.pathname === "/api/waiting" && req.method === "GET") {
        const n = nth.waiting++;
        const custom = opts.waiting?.(n);
        if (custom) return custom;
        return req.headers["X-Mirihae-Waiting-Token"] === MIRIHAE_WAITING_TOKEN
          ? { status: 200, body: mirihaeRaw("api_waiting_GET_1_200.json").replace("<MASKED>", MIRIHAE_ENTERING_TOKEN) }
          : { status: 401, body: "" };
      }
      return { status: 404, body: "" };
    }
    if (url.hostname !== "mirihae.com") return { status: 404, body: "" };
    if (req.method === "GET" && pagePaths.includes(url.pathname)) {
      if (url.searchParams.get("gateToken") !== MIRIHAE_ENTERING_TOKEN) {
        return { status: 302, body: "", location: `https://cdn.mirihae.com:9443/entering.html?uri=https://mirihae.com${url.pathname}` };
      }
      return opts.page?.(req) ?? { status: 200, body: mirihaePage(), setCookie: ["mirihae=sess1; Path=/; Secure; HttpOnly; SameSite=Lax"] };
    }
    if (req.method === "POST" && url.pathname === "/camping/calendar.do") {
      const month = new URLSearchParams(req.body ?? "").get("selectMonth") ?? "";
      return opts.calendar?.(month, req) ?? mirihaeRecordedCalendar(month) ?? { status: 404, body: "" };
    }
    return { status: 404, body: "" };
  };
  return respond;
}

/** 기록한 `POST /camping/calendar.do` 응답(2026-10-13 09:28 KST, research/raw/mirihae). 11월은 11/01 ~ 11/14가 `click`이고 12월은 모두 닫혀 있다. 그 밖의 달은 기록이 없다. */
export const mirihaeRecordedCalendar = (month: string): TransportResponse | undefined =>
  ["2026-11", "2026-12"].includes(month) ? { status: 200, body: mirihaeRaw(`calendar.do_V39628874_${month}.html`) } : undefined;
