import { readFileSync } from "node:fs";
import { donghaeAdapter } from "../src/adapters/donghae.js";
import { goraebulAdapter } from "../src/adapters/goraebul.js";
import { knpsAdapter } from "../src/adapters/knps.js";
import { xticketAdapter } from "../src/adapters/xticket.js";
import { MAX_REQUEST_WAIT_MS } from "../src/http.js";
import { loadConfig } from "../src/config.js";
import { Liveness } from "../src/liveness.js";
import { runPoller } from "../src/poller.js";
import type { TelegramMessage, TelegramSink } from "../src/telegram.js";
import type { AvailabilityQuery, Clock, HttpClient, ProviderAdapter, Transport, TransportRequest, TransportResponse } from "../src/types.js";

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
      adapters: opts.adapters ?? { goraebul: goraebulAdapter, donghae: donghaeAdapter, knps: knpsAdapter, xticket: xticketAdapter },
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
    if (url.pathname === "/Web/Book/GetBookProduct010001.json") {
      return json({ data: { bookProductList: (opts.products ?? xticketProducts)(form, shop) } });
    }
    return { status: 404, body: "" };
  };
  return Object.assign(respond, { opened });
}
