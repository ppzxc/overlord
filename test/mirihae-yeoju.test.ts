import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { adapters } from "../src/adapters/index.js";
import { runCatalog } from "../src/commands.js";
import type { TransportRequest } from "../src/types.js";
import { ENV, MIRIHAE_ENTERING_TOKEN, configWith, mirihaeServer, mirihaeYeojuPage, mirihaeYeojuPageWith, settle, startPoller } from "./harness.js";

// 여주 대신 오토캠핑장(yeoju-daesin-auto, https://yeojuuc.or.kr/camping/epoc/camping/Z65332353)의 기록한 응답(2026-10-13 13:11 KST, research/raw/mirihae)을 fixture로 쓴다.
// 기록한 이번 달(2026-10) 화면은 10/14 ~ 10/31 칸이 click이고(10/20·10/27은 정기 휴장일이라 click 없음) 구역은 `파쇄석` 하나다. 10/14 73, 10/17 0.
// 다른 달 달력(`/camping/camping/calendar.do`)은 기록하지 못했다. 아래의 11월 달력은 기록한 10월 화면의 달력 조각을 11월로 고친 합성 응답이다(기록 아님).
// 게이트는 `cdn.mirihae.com`(443)이고 리다이렉트는 301이다(기록).
const NOW = "2026-10-13T13:20:00+09:00";
const HOST = "yeojuuc.or.kr";
const PAGE = `https://${HOST}/camping/epoc/camping/Z65332353`;
const FACILITY = "yeoju-daesin-auto";

const watch = (from: string, to = from, zones = ["파쇄석"], nights = 1) => `
  - name: 대신 오토 ${from}
    provider: mirihae
    facility: ${FACILITY}
    zones: [${zones.join(", ")}]
    checkIn: { from: ${from}, to: ${to} }
    nights: ${nights}
    notify: [default]`;

const yeojuServer = (opts: Parameters<typeof mirihaeServer>[0] = {}) =>
  mirihaeServer({
    pagePath: "/camping/epoc/camping/Z65332353",
    host: HOST,
    gatePort: "",
    redirectStatus: 301,
    calendarPath: "/camping/camping/calendar.do",
    pageBody: mirihaeYeojuPage,
    pageCookie: "mirihae=yeoju-sess; Path=/camping/; Secure; HttpOnly; SameSite=Lax",
    ...opts,
  });

const run = (from: string, opts: { server?: ReturnType<typeof mirihaeServer>; to?: string; nights?: number; pollIntervalSeconds?: number } = {}) => {
  const base = configWith(watch(from, opts.to, ["파쇄석"], opts.nights));
  return startPoller(() => ({ status: 404, body: "" }), {
    yaml: opts.pollIntervalSeconds === undefined ? base : base.replace("providers:\n", `providers:\n  mirihae: { pollIntervalSeconds: ${opts.pollIntervalSeconds} }\n`),
    server: opts.server ?? yeojuServer(),
    now: NOW,
  });
};

const line = (r: { method: string; url: string }) => {
  const u = new URL(r.url);
  return `${r.method} ${u.host}${u.pathname}${u.search.includes("gateToken") ? "?gateToken" : ""}`;
};
const failedKinds = (p: ReturnType<typeof run>) => p.logs.filter((l) => l.msg === "query failed").map((l) => l.fields?.kind);

/**
 * 기록한 10월 화면의 달력 조각(`.calendar-in`)을 11월 달력으로 고친 합성 응답이다(기록 아님). 10/14 ~ 10/18 칸을 11/01 ~ 11/05로 바꿔 click을 주고
 * 남은 수는 11/03만 12, 나머지는 0이다. 그 밖의 칸은 10월 칸 그대로라 11월에 속하지 않아 읽히지 않는다(앞 달 칸과 같다).
 */
const novemberCalendar = (): string => {
  const $ = cheerio.load(mirihaeYeojuPage());
  const $f = cheerio.load($.html($(".calendar-in").first()));
  $f(".calendar-top-month").first().text("11");
  $f("div.td[id]").each((_, el) => {
    const day = Number($f(el).attr("id")!.slice(8));
    if (day < 14 || day > 18) return;
    const id = `2026-11-0${day - 13}`;
    $f(el).attr("id", id);
    $f(el).find("dl.schedule dt").html(`<span style="font-size:0px;display:none">0</span>${id === "2026-11-03" ? 12 : 0}`);
  });
  return $f.html();
};

describe("미리해 폴러: 여주 자체 도메인(대신 오토)", () => {
  it("남은 수가 있는 구역은 구역 이름, 남은 수, 자체 도메인 예약 화면 딥링크가 담긴 메시지 한 건으로 알린다", async () => {
    const p = run("2026-10-14");
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("2026-10-14(수) 1박 · 여주 대신 오토캠핑장 · 파쇄석 · 남은 73"); // dt의 숨은 0 칸이 아니라 보이는 값
    const markup = JSON.stringify(p.sent[0]!.reply_markup);
    expect(markup).toContain(PAGE);
    expect(markup).not.toContain("gateToken");
    await p.stop();
  });

  it("남은 수 0과 click 없는 날(정기 휴장일)은 알리지 않고, 모든 dl에 붙은 soldout 클래스는 품절로 읽지 않는다", async () => {
    const full = run("2026-10-17"); // 남은 수 0
    await settle();
    expect(full.sent).toHaveLength(0);
    expect(failedKinds(full)).toEqual([]);
    await full.stop();
    const closed = run("2026-10-20"); // 정기 휴장일
    await settle();
    expect(closed.sent).toHaveLength(0);
    expect(failedKinds(closed)).toEqual([]);
    await closed.stop();
  });

  it("요청 순서는 자체 도메인 화면 → 리다이렉트가 알려 준 게이트 API → gateToken을 붙인 자체 도메인 화면이다(mirihae.com으로는 가지 않는다)", async () => {
    const p = run("2026-10-14");
    await settle();
    expect(p.allRequests.map(line)).toEqual([
      `GET ${HOST}/camping/epoc/camping/Z65332353`,
      "GET cdn.mirihae.com/api/entering",
      "POST cdn.mirihae.com/api/waiting",
      "GET cdn.mirihae.com/api/waiting",
      "GET cdn.mirihae.com/api/entering",
      `GET ${HOST}/camping/epoc/camping/Z65332353?gateToken`,
    ]);
    expect(p.allRequests[5]!.url).toBe(`${PAGE}?gateToken=${MIRIHAE_ENTERING_TOKEN}`);
    expect(p.allRequests[1]!.url).toBe(`https://cdn.mirihae.com/api/entering?uri=${encodeURIComponent(PAGE)}`);
    // 게이트 요청의 Origin·Referer는 리다이렉트가 알려 준 게이트 화면(포트 없음 = 443)이다. 9443으로 고정하지 않는다.
    expect(p.allRequests[1]!.headers.Origin).toBe("https://cdn.mirihae.com");
    expect(p.allRequests[1]!.headers.Referer).toBe(`https://cdn.mirihae.com/entering.html?uri=${PAGE}`);
    expect(p.allRequests.some((r) => new URL(r.url).host === "mirihae.com" || r.url.includes(":9443"))).toBe(false);
    await p.stop();
  });

  it("게이트 화면이 9443으로 알려 주면 그 주소를 따른다(강천섬 같은 자체 도메인)", async () => {
    const p = run("2026-10-14", { server: yeojuServer({ gatePort: "9443" }) });
    await settle();
    expect(p.allRequests[1]!.headers.Origin).toBe("https://cdn.mirihae.com:9443");
    expect(p.allRequests[1]!.headers.Referer).toBe(`https://cdn.mirihae.com:9443/entering.html?uri=${PAGE}`);
    expect(p.sent).toHaveLength(1);
    await p.stop();
  });

  it("쿠키와 입장 토큰은 다른 호스트로 가지 않는다", async () => {
    const p = run("2026-11-03", { server: yeojuServer({ calendar: () => ({ status: 200, body: novemberCalendar() }) }) });
    await settle();
    await p.clock.advance(10_000);
    await settle();
    const gateRequests = p.allRequests.filter((r) => new URL(r.url).host === "cdn.mirihae.com");
    const screenRequests = p.allRequests.filter((r) => new URL(r.url).host === HOST);
    expect(gateRequests).toHaveLength(4);
    expect(screenRequests).toHaveLength(3); // 화면 302, gateToken 화면, calendar.do
    // 입장 토큰 쿠키는 게이트 호스트에만 가고 자체 도메인에는 가지 않는다. 자체 도메인 세션 쿠키는 게이트로 가지 않는다.
    for (const r of screenRequests) expect(r.headers.Cookie ?? "").not.toContain("X-Mirihae-Reservation-Token");
    for (const r of gateRequests) expect(r.headers.Cookie ?? "").not.toContain("mirihae=yeoju-sess");
    expect(gateRequests[3]!.headers.Cookie).toContain(`X-Mirihae-Reservation-Token=${MIRIHAE_ENTERING_TOKEN}`);
    expect(screenRequests[2]!.headers.Cookie).toBe("mirihae=yeoju-sess"); // calendar.do는 자체 도메인 세션을 싣는다
    await p.stop();
  });

  it("다른 달 입실일은 자체 도메인의 /camping/camping/calendar.do로 한 번만 읽는다", async () => {
    const p = run("2026-11-03", { server: yeojuServer({ calendar: () => ({ status: 200, body: novemberCalendar() }) }) });
    await settle();
    await p.clock.advance(10_000);
    await settle();
    expect(p.allRequests.map(line).slice(5)).toEqual([`GET ${HOST}/camping/epoc/camping/Z65332353?gateToken`, `POST ${HOST}/camping/camping/calendar.do`]);
    const post = p.allRequests.find((r) => r.method === "POST" && r.url.includes("calendar.do"))!;
    expect(post.url).toBe(`https://${HOST}/camping/camping/calendar.do`);
    expect(new URLSearchParams(post.body).get("selectMonth")).toBe("2026-11");
    expect(new URLSearchParams(post.body).get("groupCode")).toBe("epoc");
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("2026-11-03(화) 1박 · 여주 대신 오토캠핑장 · 파쇄석 · 남은 12");
    await p.stop();
  });

  it("수명 안의 다음 바퀴는 게이트 없이 같은 gateToken으로 자체 도메인 화면부터 연다", async () => {
    const p = run("2026-10-14", { pollIntervalSeconds: 120 });
    await settle();
    await p.clock.advance(144_000);
    await settle();
    expect(p.allRequests.map(line).slice(6)).toEqual([`GET ${HOST}/camping/epoc/camping/Z65332353?gateToken`]);
    await p.stop();
  });

  describe("접근 금지 경로", () => {
    const redirected = (location: string) => yeojuServer({ page: () => ({ status: 302, body: "", location }) });

    it.each([
      `https://${HOST}/camping/epoc/camping/reservation/list.do`,
      `https://${HOST}/camping/camping/pay/orderReqForm.do`,
      `https://${HOST}/camping/mypage.do`,
      `https://${HOST}/camping/logout.do`,
      `https://${HOST}/epoc/login.do`,
      `https://${HOST}/camping/cert/epoc/yj-approvalCheckPopoup.do`,
    ])("예약 화면이 %s 로 리다이렉트하면 그리로 요청을 보내지 않고 blocked다", async (location) => {
      const p = run("2026-10-14", { server: redirected(location) });
      await settle();
      expect(failedKinds(p)).toEqual(["blocked"]);
      expect(p.allRequests.some((r) => r.url === location)).toBe(false);
      await p.stop();
    });

    it("단양 경로는 막지 않는다(다른 달 달력과 예약 화면이 그대로 나간다)", async () => {
      const danyang = startPoller(() => ({ status: 404, body: "" }), {
        yaml: configWith(`
  - name: 천동
    provider: mirihae
    facility: danyang-cheondong
    zones: [야영장A]
    checkIn: { from: 2026-11-02, to: 2026-11-02 }
    nights: 1
    notify: [default]`),
        server: mirihaeServer(),
        now: "2026-10-13T09:30:00+09:00",
      });
      await settle();
      await danyang.clock.advance(10_000);
      await settle();
      expect(danyang.allRequests.map(line).slice(5)).toEqual(["GET mirihae.com/dytc/camping/V39628874?gateToken", "POST mirihae.com/camping/calendar.do"]);
      await danyang.stop();
    });
  });

  it("단양과 여주를 한 프로세스에서 함께 감시한다", async () => {
    // 한 서버가 두 호스트를 모두 맡는다.
    const danyang = mirihaeServer();
    const yeoju = yeojuServer();
    const server = (r: TransportRequest) => (new URL(r.url).host === HOST ? yeoju(r) : danyang(r));
    const p = startPoller(() => ({ status: 404, body: "" }), {
      yaml: configWith(
        `
  - name: 천동
    provider: mirihae
    facility: danyang-cheondong
    zones: [야영장A]
    checkIn: { from: 2026-10-14, to: 2026-10-14 }
    nights: 1
    notify: [default]`,
        watch("2026-10-14"),
      ),
      server,
      now: NOW,
    });
    await settle();
    await p.clock.advance(60_000);
    await settle();
    const texts = p.sent.map((m) => m.text);
    expect(texts.some((t) => t.includes("단양 천동 오토캠핑장 · 야영장A"))).toBe(true);
    expect(texts.some((t) => t.includes("여주 대신 오토캠핑장 · 파쇄석 · 남은 73"))).toBe(true);
    await p.stop();
  });

  it("최대 박수(1박)를 넘는 감시 조건은 설정 검증이 거부한다", () => {
    expect(() => loadConfig(configWith(watch("2026-10-14", "2026-10-14", ["파쇄석"], 2)), ENV)).toThrow(ConfigError);
  });

  it("구조가 바뀌어 달력 칸이 없으면 unrecognized다", async () => {
    const p = run("2026-10-14", { server: yeojuServer({ pageBody: () => mirihaeYeojuPageWith({}, ($) => void $("div.td[id]").removeAttr("id")) }) });
    await settle();
    expect(failedKinds(p)).toEqual(["unrecognized"]);
    await p.stop();
  });
});

describe("catalog mirihae: 여주 대신 오토", () => {
  const catalog = async (facility?: string, server?: ReturnType<typeof mirihaeServer>) => {
    const out: string[] = [];
    const err: string[] = [];
    const requests: TransportRequest[] = [];
    const code = await runCatalog(
      { kind: "catalog", provider: "mirihae", ...(facility ? { facility } : {}), live: server !== undefined },
      {
        adapters,
        transport: async (r) => (requests.push(r), server ? server(r) : { status: 404, body: "" }),
        version: "0.1.0",
        now: () => new Date(NOW),
        sleep: async () => {},
        random: () => 0.5,
        out: (s) => void out.push(s),
        err: (s) => void err.push(s),
      },
    );
    return { code, out: out.join(""), err: err.join(""), requests };
  };

  it("시설 목록에 단양 시설과 함께 대신 오토가 나오고 요청은 보내지 않는다", async () => {
    const r = await catalog();
    expect(r.out).toMatch(/^danyang-cheondong\s+단양 천동 오토캠핑장\s+3곳$/m);
    expect(r.out).toMatch(/^yeoju-daesin-auto\s+여주 대신 오토캠핑장\s+1곳$/m);
    expect(r.requests).toEqual([]);
  });

  it("대신 오토 구역 표를 요청 없이 보인다", async () => {
    const r = await catalog(FACILITY);
    expect(r.out).toContain("파쇄석");
    expect(r.requests).toEqual([]);
  });

  it("--live는 자체 도메인 예약 화면을 한 번 읽고 구역이 같으면 구역 일치다", async () => {
    const r = await catalog(FACILITY, yeojuServer());
    expect(r.code).toBe(0);
    expect(r.out).toContain("구역 일치 (1곳)");
    expect(r.requests.map(line)).toEqual([
      `GET ${HOST}/camping/epoc/camping/Z65332353`,
      "GET cdn.mirihae.com/api/entering",
      "POST cdn.mirihae.com/api/waiting",
      "GET cdn.mirihae.com/api/waiting",
      "GET cdn.mirihae.com/api/entering",
      `GET ${HOST}/camping/epoc/camping/Z65332353?gateToken`,
    ]);
  });
});
