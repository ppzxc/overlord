import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { adapters } from "../src/adapters/index.js";
import { runCatalog } from "../src/commands.js";
import type { TransportRequest, TransportResponse } from "../src/types.js";
import {
  ENV,
  configWith,
  mirihaeGangcheonPage,
  mirihaeRecordedCalendar,
  mirihaeServer,
  mirihaeYeojuGsmcPage,
  mirihaeYeojuWellingPage,
  settle,
  startPoller,
} from "./harness.js";

// 나머지 여주 시설(#111): 대신 웰빙(epoc/B24626523), 금은모래(gsmc/Q86949745), 강천섬(camp.yjcf.or.kr/gangcheon/camping/Y35294962).
// 기록한 화면(2026-10-13 13:09 ~ 13:15 KST, research/raw/mirihae)을 fixture로 쓴다. 이번 달(2026-10)은 10/14 ~ 10/31이 click이다.
// 대신 웰빙 10/14 파쇄석 79·데크 7. 금은모래 10/14 가구역 53·나구역 16·다구역 15·금모래구역 17·은모래구역 42.
// 강천섬 10/14 세종대왕 7·원경왕후 9·효종대왕 7·인현왕후 10·명성황후 14, 10/17은 세종대왕 1·효종대왕 0·명성황후 1만 칸에 나온다.
const NOW = "2026-10-13T13:20:00+09:00";
const YEOJU = "yeojuuc.or.kr";
const GANGCHEON = "camp.yjcf.or.kr";

const watch = (facility: string, zones: string[], from: string, nights = 1) => `
  - name: ${facility} ${from}
    provider: mirihae
    facility: ${facility}
    zones: [${zones.join(", ")}]
    checkIn: { from: ${from}, to: ${from} }
    nights: ${nights}
    notify: [default]`;

type ServerOpts = Parameters<typeof mirihaeServer>[0];
const yeojuServer = (pagePath: string, pageBody: () => string, opts: ServerOpts = {}) =>
  mirihaeServer({
    pagePath,
    host: YEOJU,
    gatePort: "",
    redirectStatus: 301,
    calendarPath: "/camping/camping/calendar.do",
    pageBody,
    pageCookie: "mirihae=yeoju-sess; Path=/camping/; Secure; HttpOnly; SameSite=Lax",
    ...opts,
  });
const gangcheonServer = (opts: ServerOpts = {}) => mirihaeServer({ pagePath: "/gangcheon/camping/Y35294962", host: GANGCHEON, gatePort: "9443", pageBody: mirihaeGangcheonPage, ...opts });

const WELLING = { code: "yeoju-daesin-welling", path: "/camping/epoc/camping/B24626523", page: mirihaeYeojuWellingPage };
const GSMC = { code: "yeoju-geumeunmoraet", path: "/camping/gsmc/camping/Q86949745", page: mirihaeYeojuGsmcPage };
const welling = (opts?: ServerOpts) => yeojuServer(WELLING.path, WELLING.page, opts);
const gsmc = (opts?: ServerOpts) => yeojuServer(GSMC.path, GSMC.page, opts);
const DANYANG_PATH = "/dytc/camping/V39628874";

/**
 * 화면 호스트와 경로로 시설마다 다른 가짜 서버를 고른다. 게이트(`cdn.mirihae.com`)와 다른 달 달력 요청은 마지막으로 화면을 요청한 시설의 서버가 받는다.
 * 시설마다 가짜 서버가 게이트 횟수를 따로 세므로 시설이 바뀌면 그 서버가 처음부터 401 -> 200을 준다.
 */
function router(...servers: { host: string; path: string; server: ReturnType<typeof mirihaeServer> }[]) {
  let current = servers[0]!.server;
  return (r: TransportRequest): TransportResponse => {
    const u = new URL(r.url);
    const hit = servers.find((s) => u.host === s.host && u.pathname === s.path);
    if (hit) current = hit.server;
    return current(r);
  };
}

const line = (r: { method: string; url: string }) => {
  const u = new URL(r.url);
  return `${r.method} ${u.host}${u.pathname}${u.search.includes("gateToken") ? "?gateToken" : ""}`;
};
const failedKinds = (p: { logs: { msg: string; fields?: Record<string, unknown> }[] }) => p.logs.filter((l) => l.msg === "query failed").map((l) => l.fields?.kind);

const catalog = async (facility?: string, server?: (r: TransportRequest) => TransportResponse) => {
  const out: string[] = [];
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
      err: () => {},
    },
  );
  return { code, out: out.join(""), requests };
};

describe("catalog mirihae: 나머지 여주 시설", () => {
  it("시설 목록에 새 여주 시설이 단양·대신 오토와 함께 나오고 요청은 보내지 않는다", async () => {
    const r = await catalog();
    expect(r.out).toMatch(/^yeoju-daesin-welling\s+여주 대신 웰빙캠핑장\s+2곳$/m);
    expect(r.out).toMatch(/^yeoju-geumeunmoraet\s+여주 금은모래 캠핑장\s+5곳$/m);
    expect(r.out).toMatch(/^yeoju-gangcheonseom\s+여주 강천섬 캠핑장\s+5곳$/m);
    expect(r.out).toMatch(/^yeoju-daesin-auto\s/m);
    expect(r.out).toMatch(/^danyang-cheondong\s/m);
    expect(r.requests).toEqual([]);
  });

  it.each([
    { code: "yeoju-daesin-welling", zones: ["파쇄석", "데크"] },
    { code: "yeoju-geumeunmoraet", zones: ["가구역", "나구역", "다구역", "금모래구역", "은모래구역"] },
    { code: "yeoju-gangcheonseom", zones: ["세종대왕", "원경왕후", "효종대왕", "인현왕후", "명성황후"] },
  ])("$code 구역 표를 요청 없이 보인다", async ({ code, zones }) => {
    const r = await catalog(code);
    for (const z of zones) expect(r.out).toContain(z);
    expect(r.requests).toEqual([]);
  });

  it.each([
    { title: "대신 웰빙", code: WELLING.code, server: () => welling(), first: `GET ${YEOJU}${WELLING.path}`, last: `GET ${YEOJU}${WELLING.path}?gateToken`, count: 2 },
    { title: "금은모래", code: GSMC.code, server: () => gsmc(), first: `GET ${YEOJU}${GSMC.path}`, last: `GET ${YEOJU}${GSMC.path}?gateToken`, count: 5 },
    {
      title: "강천섬(9443 게이트, 구역 밖의 이용료 dd와 행사 문구는 구역이 아니다)",
      code: "yeoju-gangcheonseom",
      server: () => gangcheonServer(),
      first: `GET ${GANGCHEON}/gangcheon/camping/Y35294962`,
      last: `GET ${GANGCHEON}/gangcheon/camping/Y35294962?gateToken`,
      count: 5,
    },
  ])("--live는 $title 예약 화면을 한 번 읽고 구역이 같으면 구역 일치다", async ({ code, server, first, last, count }) => {
    const r = await catalog(code, server());
    expect(r.code).toBe(0);
    expect(r.out).toContain(`구역 일치 (${count}곳)`);
    expect(r.requests.map(line)).toEqual([first, "GET cdn.mirihae.com/api/entering", "POST cdn.mirihae.com/api/waiting", "GET cdn.mirihae.com/api/waiting", "GET cdn.mirihae.com/api/entering", last]);
  });

  it("--live는 화면에서 사라진 구역과 새로 생긴 구역을 보고한다(금은모래)", async () => {
    const changed = gsmc({ pageBody: () => GSMC.page().replaceAll("<dd>나구역</dd>", "<dd>라구역</dd>") });
    const r = await catalog(GSMC.code, changed);
    expect(r.code).toBe(0); // 구역 차이는 보고만 하고 종료 코드는 0이다(기존 규칙)
    expect(r.out).toContain("나구역");
    expect(r.out).toContain("라구역");
    expect(r.requests).toHaveLength(6);
  });
});

describe("미리해 폴러: 나머지 여주 시설", () => {
  it("강천섬 알림은 구역 이름, 남은 수, 자체 도메인 딥링크를 담고 게이트는 9443을 따른다", async () => {
    const p = startPoller(() => ({ status: 404, body: "" }), { yaml: configWith(watch("yeoju-gangcheonseom", ["세종대왕", "명성황후"], "2026-10-14")), server: gangcheonServer(), now: NOW });
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]!.text).toContain("여주 강천섬 캠핑장 · 세종대왕 · 남은 7");
    expect(p.sent[0]!.text).toContain("명성황후 · 남은 14");
    expect(JSON.stringify(p.sent[0]!.reply_markup)).toContain(`https://${GANGCHEON}/gangcheon/camping/Y35294962`);
    expect(p.allRequests[1]!.headers.Origin).toBe("https://cdn.mirihae.com:9443");
    expect(p.allRequests.some((r) => new URL(r.url).host === "mirihae.com")).toBe(false);
    await p.stop();
  });

  it("강천섬의 이용료·행사 문구는 구역으로 읽지 않아 구역 변동 경고가 없고, 칸에 나오지 않은 구역은 알리지 않는다", async () => {
    const p = startPoller(() => ({ status: 404, body: "" }), { yaml: configWith(watch("yeoju-gangcheonseom", ["인현왕후"], "2026-10-17")), server: gangcheonServer(), now: NOW });
    await settle();
    expect(p.sent).toHaveLength(0);
    expect(failedKinds(p)).toEqual([]);
    expect(p.logs.filter((l) => l.msg === "mirihae zone drift")).toEqual([]);
    await p.stop();
  });

  it("강천섬의 다른 달 달력은 같은 호스트의 /camping/calendar.do로 한 번 읽는다(화면 JS의 절대 경로)", async () => {
    // 단양 달력 기록의 구역 이름만 강천섬 구역으로 바꾼 합성 응답이다(강천섬 다른 달 응답은 기록하지 못했다).
    const calendar = (month: string) => ({ status: 200, body: mirihaeRecordedCalendar(month)!.body.replaceAll("야영장A", "세종대왕") });
    const p = startPoller(() => ({ status: 404, body: "" }), { yaml: configWith(watch("yeoju-gangcheonseom", ["세종대왕"], "2026-11-02")), server: gangcheonServer({ calendar }), now: NOW });
    await settle();
    await p.clock.advance(10_000);
    await settle();
    const posts = p.allRequests.filter((r) => r.method === "POST" && r.url.includes("calendar.do"));
    expect(posts.map((r) => r.url)).toEqual([`https://${GANGCHEON}/camping/calendar.do`]);
    expect(p.sent).toHaveLength(1);
    await p.stop();
  });

  it("단양 시설 하나와 여주 시설 둘(웰빙·강천섬)을 한 바퀴에 감시하고 시설마다 알림이 간다", async () => {
    const server = router(
      { host: "mirihae.com", path: DANYANG_PATH, server: mirihaeServer() },
      { host: YEOJU, path: WELLING.path, server: welling() },
      { host: GANGCHEON, path: "/gangcheon/camping/Y35294962", server: gangcheonServer() },
    );
    const p = startPoller(() => ({ status: 404, body: "" }), {
      yaml: configWith(watch("danyang-cheondong", ["야영장A"], "2026-10-14"), watch(WELLING.code, ["데크"], "2026-10-14"), watch("yeoju-gangcheonseom", ["효종대왕"], "2026-10-14")),
      server,
      now: NOW,
    });
    await settle();
    await p.clock.advance(120_000);
    await settle();
    const texts = p.sent.map((m) => m.text).join("\n");
    expect(texts).toContain("단양 천동 오토캠핑장 · 야영장A");
    expect(texts).toContain("여주 대신 웰빙캠핑장 · 데크 · 남은 7");
    expect(texts).toContain("여주 강천섬 캠핑장 · 효종대왕 · 남은 7");
    expect(failedKinds(p)).toEqual([]);
    await p.stop();
  });

  it("여주 시설 하나의 구조 변경은 다음 시설(단양 포함)의 조회를 막지 않는다", async () => {
    const broken = yeojuServer(GSMC.path, () => GSMC.page().replaceAll('id="2026-', 'data-x="2026-'));
    const server = router({ host: YEOJU, path: GSMC.path, server: broken }, { host: "mirihae.com", path: DANYANG_PATH, server: mirihaeServer() });
    const p = startPoller(() => ({ status: 404, body: "" }), {
      yaml: configWith(watch(GSMC.code, ["가구역"], "2026-10-14"), watch("danyang-cheondong", ["야영장A"], "2026-10-14")),
      server,
      now: NOW,
    });
    await settle();
    await p.clock.advance(120_000);
    await settle();
    expect(failedKinds(p)).toContain("unrecognized");
    expect(p.sent.map((m) => m.text).join("\n")).toContain("단양 천동 오토캠핑장 · 야영장A");
    await p.stop();
  });

  it("여주 시설에서 blocked(403)가 나면 남은 시설에 요청을 보내지 않는다", async () => {
    const blocked = welling({ page: () => ({ status: 403, body: "" }) });
    const server = router({ host: YEOJU, path: WELLING.path, server: blocked }, { host: "mirihae.com", path: DANYANG_PATH, server: mirihaeServer() });
    const p = startPoller(() => ({ status: 404, body: "" }), {
      yaml: configWith(watch(WELLING.code, ["데크"], "2026-10-14"), watch("danyang-cheondong", ["야영장A"], "2026-10-14")),
      server,
      now: NOW,
    });
    await settle();
    expect(failedKinds(p)).toEqual(["blocked", "blocked"]);
    expect(p.allRequests.some((r) => new URL(r.url).host === "mirihae.com")).toBe(false);
    expect(p.sent.map((m) => m.text).join("\n")).not.toContain("야영장A"); // 단양 조회는 나가지 않았고 알림도 없다
    await p.stop();
  });

  it("금은모래 예약 화면이 예약확인 경로로 리다이렉트하면 그리로 요청하지 않고 blocked다", async () => {
    const location = `https://${YEOJU}/camping/gsmc/camping/reservation/list.do`;
    const p = startPoller(() => ({ status: 404, body: "" }), { yaml: configWith(watch(GSMC.code, ["가구역"], "2026-10-14")), server: gsmc({ page: () => ({ status: 302, body: "", location }) }), now: NOW });
    await settle();
    expect(failedKinds(p)).toEqual(["blocked"]);
    expect(p.allRequests.some((r) => r.url === location)).toBe(false);
    await p.stop();
  });

  it.each(["/gangcheon/login.do", "/gangcheon/camping/reservation/list.do", "/mypage.do", "/logout.do"])("강천섬 예약 화면이 %s 로 리다이렉트하면 그리로 요청하지 않고 blocked다", async (path) => {
    const location = `https://${GANGCHEON}${path}`;
    const p = startPoller(() => ({ status: 404, body: "" }), {
      yaml: configWith(watch("yeoju-gangcheonseom", ["세종대왕"], "2026-10-14")),
      server: gangcheonServer({ page: () => ({ status: 302, body: "", location }) }),
      now: NOW,
    });
    await settle();
    expect(failedKinds(p)).toEqual(["blocked"]);
    expect(p.allRequests.some((r) => r.url === location)).toBe(false);
    await p.stop();
  });

  it("강천섬 세션 쿠키는 게이트로, 입장 토큰 쿠키는 화면 호스트로 가지 않는다", async () => {
    const p = startPoller(() => ({ status: 404, body: "" }), {
      yaml: configWith(watch("yeoju-gangcheonseom", ["세종대왕"], "2026-10-14")),
      server: gangcheonServer({ pageCookie: "mirihae=gc-sess; Path=/; Secure; HttpOnly" }),
      now: NOW,
    });
    await settle();
    await p.clock.advance(10_000);
    await settle();
    for (const r of p.allRequests.filter((x) => new URL(x.url).host === "cdn.mirihae.com")) expect(r.headers.Cookie ?? "").not.toContain("gc-sess");
    for (const r of p.allRequests.filter((x) => new URL(x.url).host === GANGCHEON)) expect(r.headers.Cookie ?? "").not.toContain("X-Mirihae-Reservation-Token");
    await p.stop();
  });
});

describe("나머지 여주 시설의 최대 박수", () => {
  it.each([
    { code: WELLING.code, zone: "데크" },
    { code: GSMC.code, zone: "가구역" },
    { code: "yeoju-gangcheonseom", zone: "세종대왕" },
  ])("$code 2박 감시 조건은 설정 검증이 거부하고 1박은 받는다", ({ code, zone }) => {
    expect(() => loadConfig(configWith(watch(code, [zone], "2026-10-14", 2)), ENV)).toThrow(ConfigError);
    expect(() => loadConfig(configWith(watch(code, [zone], "2026-10-14", 1)), ENV)).not.toThrow();
  });
});
