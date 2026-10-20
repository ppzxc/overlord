import { describe, expect, it } from "vitest";
import { runCatalog } from "../src/commands.js";
import { adapters } from "../src/adapters/index.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { createHttpClient } from "../src/http.js";
import type { TransportRequest, TransportResponse } from "../src/types.js";
import { CONFIG_YAML, ENV, configWith, settle, startPoller } from "./harness.js";
import { FOREST_ENV, FOREST_PASSWORD, FOREST_USER, foresttripServer, type ForestOptions } from "./foresttrip-server.js";

// 가짜 숲나들e 서버(test/foresttrip-server.ts)로 폴러 전체를 돌린다. 유명산(0101, 주별 WEEK, 예약 가능 마지막 날 2026-11-24)을 쓴다.
// 응답은 스파이크 문서의 필드 목록으로 다시 만든 것이다(기록 원문 없음). 세션·`_csrf`·계정은 모두 가짜 값이다.
const NOW = "2026-10-20T14:00:00+09:00"; // 화요일

const watch = (zones = ["02002"], checkIn = "2026-10-24", extra = "") => `
  - name: 유명산 감시
    provider: foresttrip
    facility: yumyeongsan
    zones: [${zones.map((z) => `"${z}"`).join(", ")}]
    checkIn: { from: ${checkIn}, to: ${checkIn} }
    nights: 1
    notify: [default]${extra}`;

/** 야영데크(101)만 빈자리이고 나머지는 마감·공사·휴무·모르는 상태·추첨·우선예약이다. */
const mixedStatus: ForestOptions["status"] = (goods, date) => {
  if (date !== "2026-10-24") return { rsrvtAvail: "Y", rsrvtCnt: 1 };
  switch (goods.name) {
    case "야영데크(101)":
      return { rsrvtAvail: "Y", rsrvtCnt: 0 };
    case "야영데크(102)":
      return { rsrvtAvail: "Y", rsrvtCnt: 1 }; // 마감
    case "야영데크(103)":
      return { rsrvtAvail: "REPAIR" };
    case "야영데크(104)":
      return { rsrvtAvail: "PRNSL_DAY" };
    case "야영데크(105)":
      return { rsrvtAvail: "NEW_STATE_X" };
    case "야영데크(106)":
      return { rsrvtAvail: "DRLTS" };
    default:
      return { rsrvtAvail: "PRIOR" };
  }
};

const run = (opts: { server?: ForestOptions; zones?: string[]; checkIn?: string; env?: Record<string, string | undefined>; yaml?: string } = {}) => {
  const server = foresttripServer(opts.server);
  const p = startPoller(() => ({ status: 404, body: "" }), {
    yaml: opts.yaml ?? configWith(watch(opts.zones, opts.checkIn)),
    server,
    env: opts.env ?? FOREST_ENV,
    now: NOW,
  });
  return { p, server };
};

const label = (r: TransportRequest) => {
  const u = new URL(r.url);
  if (u.hostname === "nf.foresttrip.go.kr") return `NF ${u.searchParams.get("opcode")} ${u.searchParams.get("aid")}`;
  return `${r.method} ${u.pathname}`;
};

type Poller = ReturnType<typeof run>["p"];

/** 로그·알림 어디에도 비밀 값(비밀번호, 아이디, `_csrf`, JSESSIONID)이 없다. */
const expectNoSecrets = (p: Poller, server: ReturnType<typeof foresttripServer>, extra: string[] = []) => {
  const text = JSON.stringify({ logs: p.logs, sent: p.sent });
  for (const secret of [FOREST_PASSWORD, FOREST_USER, ...extra, ...server.state.csrfs, ...server.state.sessions]) expect(text).not.toContain(secret);
  for (const word of ["Set-Cookie", "set-cookie", "loginPwd", "JSESSIONID"]) expect(text).not.toContain(word);
};

describe("숲나들e 폴러", () => {
  describe("빈자리 알림", () => {
    it("상태가 예약가능이고 예약 건수가 0인 자리만 시설, 구역, 자리 이름, 숙박 구간, 예약 화면 링크와 함께 한 건으로 알린다", async () => {
      const { p, server } = run({ server: { status: mixedStatus } });
      await settle();
      expect(p.sent).toHaveLength(1);
      const text = p.sent[0]!.text;
      expect(text).toContain("유명산자연휴양림");
      expect(text).toContain("야영데크");
      expect(text).toContain("야영데크(101)");
      expect(text).toContain("2026-10-24");
      expect(text).toContain("1박");
      // 마감, 공사, 휴무, 모르는 상태, 추첨, 우선예약은 알리지 않는다.
      for (const n of [102, 103, 104, 105, 106, 107]) expect(text).not.toContain(`야영데크(${n})`);
      expect(JSON.stringify(p.sent[0]!.reply_markup)).toContain(
        "https://www.foresttrip.go.kr/rep/or/sssn/monthRsrvtStatus.do?hmpgId=FRIP&menuId=001004&upperGoodsClsscCd=02&insttId=0101",
      );
      expectNoSecrets(p, server);
      await p.stop();
    });

    it("모르는 상태와 추첨·우선예약은 빈자리로 치지 않고 로그에 남긴다", async () => {
      const { p } = run({ server: { status: mixedStatus } });
      await settle();
      const noted = p.logs.filter((l) => l.msg.startsWith("foresttrip") && l.fields?.status !== undefined).map((l) => `${l.msg}:${String(l.fields!.status)}`);
      expect(noted).toEqual(expect.arrayContaining(["foresttrip unknown status:NEW_STATE_X", "foresttrip status not treated as opening:DRLTS", "foresttrip status not treated as opening:PRIOR"]));
      await p.stop();
    });

    it("빈자리가 없으면 알리지 않고 실패로 치지 않는다", async () => {
      const { p } = run();
      await settle();
      expect(p.sent).toHaveLength(0);
      expect(p.logs.filter((l) => l.msg === "query failed")).toEqual([]);
      await p.stop();
    });

    it("예약 가능 마지막 날 밖의 날짜는 빈자리로 치지 않는다", async () => {
      const { p } = run({ checkIn: "2026-11-25", server: { status: () => ({ rsrvtAvail: "Y", rsrvtCnt: 0 }) } });
      await settle();
      expect(p.sent).toHaveLength(0);
      await p.stop();
    });

    it("기간 밖(OVER_DATE)과 지난 날짜(BEFORE_DATE) 칸은 빈자리가 아니다", async () => {
      const { p } = run({ server: { status: (_g, date) => (date === "2026-10-24" ? { rsrvtAvail: "OVER_DATE", rsrvtCnt: 0 } : { rsrvtAvail: "BEFORE_DATE", rsrvtCnt: 0 }) } });
      await settle();
      expect(p.sent).toHaveLength(0);
      await p.stop();
    });

    it("예약 건수를 읽을 수 없는 예약가능 칸은 빈자리로 치지 않는다", async () => {
      const { p } = run({ server: { status: () => ({ rsrvtAvail: "Y", rsrvtCnt: "알수없음" }) } });
      await settle();
      expect(p.sent).toHaveLength(0);
      await p.stop();
    });

    it("시설이 둘이어도 알림에 시설 이름이 담긴다", async () => {
      // 카탈로그에 시설이 둘 이상이면 메시지가 시설 이름을 싣는다.
      expect(adapters.foresttrip!.describe().facilities.length).toBeGreaterThan(1);
      const { p } = run({ server: { status: mixedStatus } });
      await settle();
      expect(p.sent[0]!.text).toContain("유명산자연휴양림");
      await p.stop();
    });
  });

  describe("요청 흐름", () => {
    it("로그인, 정책, 상품 목록(대기열 키), 잔여(상품 5개씩) 순서로 요청이 나간다", async () => {
      const { p, server } = run({ server: { status: mixedStatus } });
      await settle();
      expect(p.allRequests.map(label)).toEqual([
        "GET /com/login.do",
        "POST /com/crawlingCheck.do",
        "POST /com/login",
        "NF 5101 action3",
        "GET /rep/or/sssn/monthRsrvtStatus.do",
        "NF 5004 action3",
        "POST /rep/or/selectSthngListForMonthRsrvt.do",
        "NF 5101 action8",
        "POST /rep/or/sssn/selectRsrvtGoodsListForMonthRsrvt.do",
        "NF 5004 action8",
        "POST /rep/or/selectRsrvtAvailInfoListForMonthRsrvt.do", // 야영데크 7개 중 5개
        "POST /rep/or/selectRsrvtAvailInfoListForMonthRsrvt.do", // 나머지 2개
      ]);
      expect(server.state.logins).toBe(1);
      expect(server.state.availCalls).toEqual([
        { requested: 5, returned: 5 },
        { requested: 2, returned: 2 },
      ]);
      await p.stop();
    });

    it("구역이 둘이면 정책은 한 번이고 상품 목록은 구역마다 받으며 구역 필터와 inqurSctin=02를 쓴다", async () => {
      const { p } = run({ zones: ["02002", "01002"] });
      await settle();
      const labels = p.allRequests.map(label);
      expect(labels.filter((l) => l === "POST /rep/or/selectSthngListForMonthRsrvt.do")).toHaveLength(1);
      expect(labels.filter((l) => l === "POST /rep/or/sssn/selectRsrvtGoodsListForMonthRsrvt.do")).toHaveLength(2);
      const goodsBodies = p.allRequests.filter((r) => label(r).includes("selectRsrvtGoodsList")).map((r) => JSON.parse(r.body!) as Record<string, unknown>);
      expect(goodsBodies.map((b) => [b.goodsClsscCd, b.upperGoodsClsscCd, b.inqurSctin, b.lastDay])).toEqual([
        ["02002", "02", "02", "20261124"],
        ["01002", "01", "02", "20261124"],
      ]);
      const avail = p.allRequests.filter((r) => label(r).includes("selectRsrvtAvailInfo")).map((r) => (JSON.parse(r.body!) as { goodsIdList: string[] }).goodsIdList.length);
      expect(avail).toEqual([5, 2, 2]);
      await p.stop();
    });

    it("대기열 키는 상품 목록 호출에만 본문과 NetFunnel_ID 쿠키로 싣고 잔여·정책 호출에는 싣지 않는다", async () => {
      const { p } = run();
      await settle();
      for (const r of p.allRequests.filter((r) => new URL(r.url).hostname === "www.foresttrip.go.kr" && r.method === "POST")) {
        const isGoods = label(r).includes("selectRsrvtGoodsList");
        expect("netfunnelKey" in (r.body?.startsWith("{") ? (JSON.parse(r.body) as object) : {})).toBe(isGoods);
      }
      await p.stop();
    });

    it("조회 호출은 JSON Content-Type과 월별 현황 화면에서 받은 X-CSRF-TOKEN을 싣고 로그인 POST는 폼이다", async () => {
      const { p, server } = run();
      await settle();
      const post = (path: string) => p.allRequests.find((r) => new URL(r.url).pathname === path)!;
      const login = post("/com/login");
      expect(login.headers["Content-Type"]).toContain("application/x-www-form-urlencoded");
      expect(Object.fromEntries(new URLSearchParams(login.body!))).toMatchObject({ loginId: FOREST_USER, loginPwd: FOREST_PASSWORD, socialToken: "", passCI: "", simpleCI: "", targetUrl: "/main.do?hmpgId=FRIP" });
      const policy = post("/rep/or/selectSthngListForMonthRsrvt.do");
      expect(policy.headers["Content-Type"]).toBe("application/json; charset=UTF-8");
      expect(policy.headers["X-CSRF-TOKEN"]).toBe(server.state.csrfs.find((c) => c.startsWith("AJAXCSRF")));
      expect(policy.headers["User-Agent"]).toBe("overlord-availability-poller/0.1.0 (ops)");
      await p.stop();
    });

    it("로그인 302가 alert.do를 가리켜도 따라가지 않고 비밀번호 변경 화면에도 요청하지 않는다", async () => {
      const { p } = run({ server: { status: mixedStatus } });
      await settle();
      const paths = p.allRequests.map((r) => new URL(r.url).pathname);
      expect(paths).not.toContain("/com/alert.do");
      expect(paths.some((x) => x.startsWith("/pot/mc/"))).toBe(false);
      expect(p.sent).toHaveLength(1); // 알림 없이 성공으로 본다.
      expect(p.logs.some((l) => l.msg.includes("alert.do redirect not followed"))).toBe(true);
      await p.stop();
    });

    it("다음 바퀴는 로그인하지 않고 같은 세션으로 조회한다", async () => {
      const { p, server } = run();
      await settle();
      const first = p.allRequests.length;
      await p.clock.advance(600_000);
      await settle();
      // 상품 목록은 24시간 캐시라 다시 받지 않는다(Ticket-5).
      expect(p.allRequests.slice(first).map(label)).toEqual([
        "POST /rep/or/selectSthngListForMonthRsrvt.do",
        "POST /rep/or/selectRsrvtAvailInfoListForMonthRsrvt.do",
        "POST /rep/or/selectRsrvtAvailInfoListForMonthRsrvt.do",
      ]);
      expect(server.state.logins).toBe(1);
      await p.stop();
    });

    it("요청은 호스트 쪽으로 5초 이상 간격으로 한 줄씩 나간다", async () => {
      const { p } = run({ zones: ["02002", "01002"] });
      await settle();
      const times = p.allRequests.flatMap((r, i) => (new URL(r.url).hostname === "www.foresttrip.go.kr" ? [p.requestTimes[i]!] : []));
      expect(times.length).toBeGreaterThan(8);
      for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(4_000);
      await p.stop();
    });
  });

  describe("계정 값", () => {
    const yaml = configWith(watch());

    it("숲나들e 감시 조건이 있는데 계정 값이 없으면 설정 로드가 거부한다", () => {
      const message = (env: Record<string, string | undefined>) => {
        try {
          loadConfig(yaml, env);
        } catch (e) {
          expect(e).toBeInstanceOf(ConfigError);
          return (e as Error).message;
        }
        return "";
      };
      expect(message(ENV)).toMatch(/FORESTTRIP_USERNAME, FORESTTRIP_PASSWORD/);
      expect(message({ ...ENV, FORESTTRIP_USERNAME: FOREST_USER })).toMatch(/FORESTTRIP_PASSWORD/);
      expect(message({ ...ENV, FORESTTRIP_USERNAME: FOREST_USER })).not.toMatch(/FORESTTRIP_USERNAME/);
      expect(message({ ...ENV, FORESTTRIP_USERNAME: "", FORESTTRIP_PASSWORD: FOREST_PASSWORD })).toMatch(/FORESTTRIP_USERNAME/);
      expect(message({ ...ENV, ...FOREST_ENV })).toBe("");
    });

    it("숲나들e 감시 조건이 없으면 계정 값이 없어도 시작한다", () => {
      expect(() => loadConfig(CONFIG_YAML, ENV)).not.toThrow();
    });

    it("비밀번호의 $와 ${…}는 확장되지 않고 로그인 본문에 그대로 실린다", async () => {
      expect(FOREST_PASSWORD).toContain("${HOME}");
      const { p, server } = run({ server: { status: mixedStatus } });
      await settle();
      expect(server.state.logins).toBe(1);
      expect(p.sent).toHaveLength(1);
      await p.stop();
    });

    it("폴링 간격 하한은 300초다", () => {
      expect(() => loadConfig(yaml.replace("goraebul: { pollIntervalSeconds: 150 }", "foresttrip: { pollIntervalSeconds: 200 }"), { ...ENV, ...FOREST_ENV })).toThrow(/foresttrip는 300초 이상/);
    });
  });

  describe("멈춤(stopped)과 일시 오류(degraded)", () => {
    const json403 = (path: string, res: TransportResponse) => (req: TransportRequest) => (new URL(req.url).pathname === path ? res : undefined);
    const POLICY = "/rep/or/selectSthngListForMonthRsrvt.do";

    const cases: { name: string; server?: ForestOptions; env?: Record<string, string>; reason: RegExp }[] = [
      { name: "crawlingCheck.do가 거짓을 내면", server: { crawling: "false" }, reason: /crawlingCheck\.do가 거부했다/ },
      { name: "crawlingCheck.do가 403이면", server: { intercept: json403("/com/crawlingCheck.do", { status: 403, body: "" }) }, reason: /crawlingCheck\.do: HTTP 403/ },
      { name: "조회가 403이면", server: { intercept: json403(POLICY, { status: 403, body: "" }) }, reason: /시설 정책: HTTP 403/ },
      { name: "조회가 429이면", server: { intercept: json403(POLICY, { status: 429, body: "" }) }, reason: /시설 정책: HTTP 429/ },
      {
        name: "JSON 자리에 봇 탐지 화면이 오면",
        server: { intercept: json403(POLICY, { status: 200, body: "<html><script src='/botmanager/check.js'></script>접속이 차단되었습니다</html>" }) },
        reason: /시설 정책: JSON 대신 봇 탐지 화면/,
      },
      { name: "로그인 비밀번호가 틀려 -6이 나오면", env: { FORESTTRIP_USERNAME: FOREST_USER, FORESTTRIP_PASSWORD: "wrong-password-xyz" }, reason: /로그인 실패\(loginErrorCode -6, HTTP 403\)/ },
      { name: "조회 중 세션이 끊겨 -5가 나오면", server: { intercept: json403(POLICY, { status: 401, body: '<script>var loginErrorCode = "-5";</script>' }) }, reason: /세션이 끊겼다\(loginErrorCode -5/ },
      { name: "리다이렉트가 접근 금지 경로(비밀번호 변경 화면)에 닿으면", server: { intercept: json403(POLICY, { status: 302, body: "", location: "/pot/mc/pu/updatePssrdChngExpiredView.do" }) }, reason: /접근 금지 경로/ },
    ];

    it.each(cases)("$name 예약처가 멈추고 사유가 알림에 나온다", async ({ server: serverOpts, env, reason }) => {
      const { p, server } = run({ ...(serverOpts ? { server: serverOpts } : {}), ...(env ? { env } : {}) });
      await settle();
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0]!.text).toContain("차단");
      expect(p.sent[0]!.text).toMatch(reason);
      // 멈춘 예약처는 더 조회하지 않는다.
      const sentRequests = p.allRequests.length;
      await p.clock.advance(3 * 3_600_000);
      await settle();
      expect(p.allRequests).toHaveLength(sentRequests);
      expect(p.allRequests.some((r) => new URL(r.url).pathname.startsWith("/pot/mc/"))).toBe(false);
      expectNoSecrets(p, server, env ? [env.FORESTTRIP_PASSWORD!] : []);
      await p.stop();
    });

    it("로그인 실패는 재시도하지 않아 로그인 POST가 한 번이다", async () => {
      const { p } = run({ env: { FORESTTRIP_USERNAME: FOREST_USER, FORESTTRIP_PASSWORD: "wrong-password-xyz" } });
      await settle();
      await p.clock.advance(3 * 3_600_000);
      await settle();
      expect(p.allRequests.filter((r) => label(r) === "POST /com/login")).toHaveLength(1);
      await p.stop();
    });

    it("로그인 응답이 302로 로그인 화면에 되돌려 보내면 멈춘다", async () => {
      const { p } = run({ server: { login: () => ({ status: 302, body: "", location: "/com/login.do" }) } });
      await settle();
      expect(p.sent[0]!.text).toMatch(/로그인 화면으로 되돌려 보냈다/);
      await p.stop();
    });

    it("5xx는 멈추지 않고 degraded 경로로 간다", async () => {
      const { p } = run({ server: { intercept: json403(POLICY, { status: 503, body: "" }) } });
      await settle();
      expect(p.sent).toHaveLength(0); // 한두 바퀴의 일시 오류는 알리지 않는다.
      for (let i = 0; i < 6; i++) {
        await p.clock.advance(1_800_000);
        await settle();
      }
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0]!.text).toContain("계속 실패");
      expect(p.sent[0]!.text).not.toContain("차단");
      expect(p.allRequests.filter((r) => label(r) === POLICY.replace(/^/, "POST ")).length).toBeGreaterThan(5);
      await p.stop();
    });

    it("로그인 단계의 네트워크 오류는 일시 오류이고 오류 문구의 비밀 값은 가려진다", async () => {
      const { p, server } = run({
        server: {
          intercept: (req) => {
            if (new URL(req.url).pathname === "/com/login") throw new Error(`연결 끊김: ${req.body}`);
            return undefined;
          },
        },
      });
      await settle();
      const failed = p.logs.filter((l) => l.msg === "query failed");
      expect(failed.length).toBeGreaterThan(0);
      expect(failed[0]!.fields).toMatchObject({ kind: "transient" });
      expectNoSecrets(p, server, [encodeURIComponent(FOREST_PASSWORD)]);
      await p.stop();
    });

    it("응답 모양이 다르면(잔여 목록 키가 없음) 빈자리 없음으로 착각하지 않고 구조 변경으로 본다", async () => {
      const { p } = run({ server: { avail: () => ({ status: 200, body: JSON.stringify({ unexpected: [] }) }) } });
      await settle();
      const failed = p.logs.filter((l) => l.msg === "query failed");
      expect(failed[0]!.fields).toMatchObject({ kind: "unrecognized" });
      expect(p.sent).toHaveLength(0);
      await p.stop();
    });

    it("모르는 예약 주기 시설은 빈자리 없음으로 착각하지 않고 구조 변경으로 본다", async () => {
      const { p } = run({ server: { policy: (base) => ({ ...base, rsrvtPolcy: { rsrvtCycleTpeCd: "QTR", monthLastDay: "20261130" } }) } });
      await settle();
      expect(p.logs.find((l) => l.msg === "query failed")!.fields).toMatchObject({ kind: "unrecognized" });
      await p.stop();
    });
  });

  describe("접근 금지 경로", () => {
    it("어댑터가 쓰는 경로는 모두 통과하고 비밀번호 변경 화면과 alert.do는 HTTP 층이 막는다", async () => {
      const sent: string[] = [];
      const http = createHttpClient({
        transport: async (r) => (sent.push(r.url), { status: 200, body: "" }),
        version: "0.1.0",
        userAgentSuffix: "",
        blockedPaths: adapters.foresttrip!.describe().blockedPaths,
        cookieSession: true,
      });
      const origin = "https://www.foresttrip.go.kr";
      for (const blocked of ["/pot/mc/pu/updatePssrdChngExpiredView.do", "/pot/mc/ms/insertStplatAgreeView.do", "/com/alert.do", "/COM/ALERT.DO"]) {
        await expect(http.get(`${origin}${blocked}`), blocked).rejects.toThrow(/접근 금지/);
      }
      expect(sent).toEqual([]);
      const used = [
        "/com/login.do?targetUrl=/main.do?hmpgId=FRIP",
        "/com/crawlingCheck.do?_csrf=x",
        "/com/login",
        "/rep/or/sssn/monthRsrvtStatus.do?hmpgId=FRIP&menuId=001004",
        "/rep/or/selectSthngListForMonthRsrvt.do",
        "/rep/or/sssn/selectRsrvtGoodsListForMonthRsrvt.do",
        "/rep/or/selectRsrvtAvailInfoListForMonthRsrvt.do",
      ];
      for (const path of used) await http.get(`${origin}${path}`);
      expect(sent).toHaveLength(used.length);
    });
  });

  describe("catalog", () => {
    const catalog = async (facility?: string) => {
      const out: string[] = [];
      const requests: TransportRequest[] = [];
      const code = await runCatalog(
        { kind: "catalog", provider: "foresttrip", ...(facility ? { facility } : {}), live: false },
        { adapters, transport: async (r) => (requests.push(r), { status: 404, body: "" }), version: "0.1.0", now: () => new Date(NOW), sleep: async () => {}, random: () => 0.5, out: (t) => void out.push(t), err: () => {} },
      );
      return { code, out: out.join(""), requests };
    };

    it("시설 목록은 slug와 이름을, 시설은 구역 코드와 이름을 보이고 요청은 보내지 않는다", async () => {
      const list = await catalog();
      expect(list.out).toMatch(/^yumyeongsan\s+유명산자연휴양림\s+4곳$/m);
      const one = await catalog("yumyeongsan");
      expect(one.out).toMatch(/^02002\s+야영데크/m);
      expect(one.out).toMatch(/^01002\s+휴양관/m);
      expect(list.requests.length + one.requests.length).toBe(0);
    });
  });
});
