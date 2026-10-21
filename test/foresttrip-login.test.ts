import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TransportRequest, TransportResponse } from "../src/types.js";
import { configWith, settle, startPoller } from "./harness.js";
import { FOREST_ENV, FOREST_PASSWORD, FOREST_USER, foresttripServer, type ForestOptions } from "./foresttrip-server.js";

// 로그인 운영 정책(Spec #142 / Ticket-2): 세션 끊김(-5) 재로그인, 로그인 실패 코드와 지문 파일. 가짜 서버는 test/foresttrip-server.ts를 쓴다.
const NOW = "2026-10-20T14:00:00+09:00";
const POLICY = "/rep/or/selectSthngListForMonthRsrvt.do";
const GOODS = "/rep/or/sssn/selectRsrvtGoodsListForMonthRsrvt.do";
const MINUTE = 60_000;

const WATCH = `
  - name: 유명산 감시
    provider: foresttrip
    facility: yumyeongsan
    zones: ["02002"]
    checkIn: { from: 2026-10-24, to: 2026-10-24 }
    nights: 1
    notify: [default]`;

/** 야영데크(101)만 빈자리다. */
const oneOpen: ForestOptions["status"] = (goods, date) => (date === "2026-10-24" && goods.name === "야영데크(101)" ? { rsrvtAvail: "Y", rsrvtCnt: 0 } : { rsrvtAvail: "Y", rsrvtCnt: 1 });

const unauthorized: TransportResponse = { status: 401, body: '<script>var loginErrorCode = "-5"; // 로그인이 필요한 페이지</script>' };
const loginError = (code: string, status = 403): TransportResponse => ({ status, body: `<script>var loginErrorCode = "${code}"; // 원문 안내 문구</script>` });
const pathOf = (r: TransportRequest) => new URL(r.url).pathname;

const run = (opts: { server?: ForestOptions; env?: Record<string, string | undefined> } = {}) => {
  const server = foresttripServer(opts.server);
  const p = startPoller(() => ({ status: 404, body: "" }), { yaml: configWith(WATCH), server, env: opts.env ?? FOREST_ENV, now: NOW });
  return { p, server };
};

const loginPosts = (p: ReturnType<typeof run>["p"]) => p.allRequests.filter((r) => r.method === "POST" && pathOf(r) === "/com/login").length;

/** 로그·알림·기록 파일 어디에도 비밀 값과 요청·응답 원문이 없다. */
const expectClean = (p: ReturnType<typeof run>["p"], server: ReturnType<typeof foresttripServer>, extra: string[] = []) => {
  const file = existsSync(process.env.FORESTTRIP_LOGIN_STATE_FILE!) ? readFileSync(process.env.FORESTTRIP_LOGIN_STATE_FILE!, "utf8") : "";
  const text = JSON.stringify({ logs: p.logs, sent: p.sent }) + file;
  for (const secret of [FOREST_PASSWORD, FOREST_USER, ...extra, ...server.state.csrfs, ...server.state.sessions]) expect(text).not.toContain(secret);
  for (const word of ["Set-Cookie", "set-cookie", "loginPwd", "JSESSIONID", "원문 안내 문구"]) expect(text).not.toContain(word);
};

describe("숲나들e 로그인 운영 정책", () => {
  describe("세션이 끊겼을 때(-5)", () => {
    it("조회 중 -5가 한 번 나오면 재로그인 1회 뒤 같은 호출을 이어 가고 빈자리를 알린다", async () => {
      let policyCalls = 0;
      const { p, server } = run({
        server: { status: oneOpen, intercept: (req) => (pathOf(req) === POLICY && ++policyCalls === 1 ? unauthorized : undefined) },
      });
      await settle();
      expect(server.state.logins).toBe(2);
      expect(p.allRequests.filter((r) => pathOf(r) === POLICY)).toHaveLength(2);
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0]!.text).toContain("야영데크(101)");
      expect(p.sent[0]!.text).not.toContain("차단");
      expectClean(p, server);
      await p.stop();
    });

    it("세션이 죽어 accessDenied.do로 302가 오면(실제 서버 동작) -5처럼 재로그인 1회 뒤 같은 호출을 이어 간다", async () => {
      let policyCalls = 0;
      const denied: TransportResponse = { status: 302, body: "", location: "https://www.foresttrip.go.kr/com/accessDenied.do" };
      const { p, server } = run({
        server: { status: oneOpen, intercept: (req) => (pathOf(req) === POLICY && ++policyCalls === 1 ? denied : undefined) },
      });
      await settle();
      expect(server.state.logins).toBe(2);
      expect(p.allRequests.filter((r) => pathOf(r) === POLICY)).toHaveLength(2);
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0]!.text).toContain("야영데크(101)");
      expect(p.sent[0]!.text).not.toContain("구조");
      await p.stop();
    });

    it("대기열 키가 걸린 상품 목록 호출도 재로그인 뒤 새 대기열 키로 다시 부른다", async () => {
      let goodsCalls = 0;
      const { p, server } = run({ server: { status: oneOpen, intercept: (req) => (pathOf(req) === GOODS && ++goodsCalls === 1 ? unauthorized : undefined) } });
      await settle();
      expect(server.state.logins).toBe(2);
      expect(p.sent).toHaveLength(1);
      await p.stop();
    });

    it("재로그인 직후 다음 호출이 또 -5이면 예약처가 멈추고 더 조회하지 않는다", async () => {
      const { p, server } = run({ server: { intercept: (req) => (pathOf(req) === POLICY ? unauthorized : undefined) } });
      await settle();
      expect(server.state.logins).toBe(2);
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0]!.text).toContain("차단");
      expect(p.sent[0]!.text).toMatch(/세션이 끊겼다\(loginErrorCode -5, HTTP 401\)/);
      expect(p.sent[0]!.text).toMatch(/재로그인 직후/);
      const before = p.allRequests.length;
      await p.clock.advance(3 * 60 * MINUTE);
      await settle();
      expect(p.allRequests).toHaveLength(before);
      expectClean(p, server);
      await p.stop();
    });

    it("1시간에 재로그인이 3회를 넘으면 멈춘다", async () => {
      let policyCalls = 0;
      // 바퀴마다 첫 정책 호출만 -5이다(재로그인 직후 호출은 성공).
      const { p, server } = run({ server: { intercept: (req) => (pathOf(req) === POLICY && ++policyCalls % 2 === 1 ? unauthorized : undefined) } });
      await settle();
      for (let i = 0; i < 2; i++) {
        await p.clock.advance(10 * MINUTE);
        await settle();
      }
      // 처음 로그인 1회 + 재로그인 3회까지는 허용한다.
      expect(server.state.logins).toBe(4);
      expect(p.sent).toHaveLength(0);
      await p.clock.advance(10 * MINUTE);
      await settle();
      expect(server.state.logins).toBe(4); // 네 번째 재로그인은 하지 않는다.
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0]!.text).toContain("차단");
      expect(p.sent[0]!.text).toMatch(/1시간에 재로그인이 3회를 넘/);
      await p.stop();
    });

    it("재로그인이 1시간 밖으로 흩어지면 멈추지 않는다", async () => {
      let policyCalls = 0;
      const { p, server } = run({ server: { intercept: (req) => (pathOf(req) === POLICY && ++policyCalls % 2 === 1 ? unauthorized : undefined) } });
      await settle();
      for (let i = 0; i < 5; i++) {
        await p.clock.advance(25 * MINUTE);
        await settle();
      }
      expect(server.state.logins).toBe(7); // 첫 바퀴 2회(로그인, 재로그인) + 이후 바퀴마다 재로그인 1회
      expect(p.sent.filter((m) => m.text.includes("차단"))).toHaveLength(0);
      await p.stop();
    });

    it("첫 -5가 로그인 후 30분 안이면 경과 시간이 담긴 특수 출력을 남기고, 그 뒤에는 남기지 않는다", async () => {
      let policyCalls = 0;
      // 첫 바퀴(로그인 직후)와 두 번째 -5(재로그인 한참 뒤)에 -5. 정책 호출은 -5마다 재시도 호출이 따라 붙는다.
      const drops = new Set([1, 6]); // 6번째 호출은 다섯 번째 바퀴(재로그인 약 40분 뒤)다.
      const { p } = run({ server: { intercept: (req) => (pathOf(req) === POLICY && drops.has(++policyCalls) ? unauthorized : undefined) } });
      await settle();
      const early = () => p.logs.filter((l) => l.msg === "foresttrip session dropped early");
      expect(early()).toHaveLength(1);
      expect(early()[0]!.fields).toMatchObject({ elapsedSeconds: expect.any(Number) });
      expect(early()[0]!.fields!.elapsedSeconds as number).toBeLessThan(30 * 60);
      for (let i = 0; i < 6; i++) {
        await p.clock.advance(10 * MINUTE);
        await settle();
      }
      expect(p.logs.filter((l) => l.msg === "foresttrip session dropped early")).toHaveLength(1);
      expect(p.logs.filter((l) => l.msg === "foresttrip session dropped")).toHaveLength(1);
      await p.stop();
    });
  });

  describe("로그인 실패 코드", () => {
    const cases = [
      { code: "-6", status: 403, reason: /비밀번호가 일치하지 않/ },
      { code: "-8", status: 403, reason: /사이트에서 직접 처리한 뒤 재시작/ },
      { code: "-9", status: 403, reason: /사이트에서 직접 처리한 뒤 재시작/ },
      { code: "-10", status: 403, reason: /잠겼/ },
    ];

    it.each(cases)("$code는 재시도 없이 멈추고 사유와 코드·HTTP 상태만 알린다", async ({ code, status, reason }) => {
      const { p, server } = run({ server: { login: () => loginError(code, status) } });
      await settle();
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0]!.text).toContain("차단");
      expect(p.sent[0]!.text).toContain(`loginErrorCode ${code}, HTTP ${status}`);
      expect(p.sent[0]!.text).toMatch(reason);
      expect(p.sent[0]!.text).toContain("ca***"); // 아이디는 앞 2자만
      await p.clock.advance(3 * 60 * MINUTE);
      await settle();
      expect(loginPosts(p)).toBe(1);
      expectClean(p, server);
      await p.stop();
    });

    it("재로그인 중에 로그인 실패 코드가 나와도 재시도 없이 멈춘다", async () => {
      let policyCalls = 0;
      let logins = 0;
      const { p, server } = run({
        server: {
          intercept: (req) => (pathOf(req) === POLICY && ++policyCalls === 1 ? unauthorized : undefined),
          login: () => (++logins === 2 ? loginError("-10") : undefined),
        },
      });
      await settle();
      expect(p.sent[0]!.text).toContain("loginErrorCode -10");
      expect(loginPosts(p)).toBe(2);
      expect(server.state.logins).toBe(1);
      await p.stop();
    });
  });

  describe("자격증명 지문 파일", () => {
    const wrong = { FORESTTRIP_USERNAME: FOREST_USER, FORESTTRIP_PASSWORD: "wrong-password-xyz" };

    it("로그인 실패를 지문과 함께 기록하고 비밀번호·아이디 원문은 파일에 없다", async () => {
      const { p, server } = run({ env: wrong });
      await settle();
      const path = process.env.FORESTTRIP_LOGIN_STATE_FILE!;
      expect(existsSync(path)).toBe(true);
      const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(record).toMatchObject({ loginErrorCode: "-6", fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(readFileSync(path, "utf8")).not.toContain("wrong-password-xyz");
      expect(readFileSync(path, "utf8")).not.toContain(FOREST_USER);
      expectClean(p, server, ["wrong-password-xyz"]);
      await p.stop();
    });

    it("재시작해도 같은 자격증명이면 로그인 요청이 나가지 않고 사유가 알려진다", async () => {
      const first = run({ env: wrong });
      await settle();
      await first.p.stop();

      const second = run({ env: wrong });
      await settle();
      expect(second.p.allRequests).toHaveLength(0);
      expect(second.p.sent).toHaveLength(1);
      expect(second.p.sent[0]!.text).toContain("차단");
      expect(second.p.sent[0]!.text).toMatch(/loginErrorCode -6/);
      expect(second.p.sent[0]!.text).toMatch(/비밀번호를 바꾸/);
      await second.p.stop();
    });

    it("비밀번호를 바꾸면 지문이 달라져 다시 로그인한다", async () => {
      const first = run({ env: wrong });
      await settle();
      await first.p.stop();

      const second = run({ env: FOREST_ENV, server: { status: oneOpen } });
      await settle();
      expect(second.server.state.logins).toBe(1);
      expect(second.p.sent).toHaveLength(1);
      expect(second.p.sent[0]!.text).toContain("야영데크(101)");
      await second.p.stop();
    });

    it("로그인에 성공해도 기록 파일을 만들지 않는다", async () => {
      const { p } = run({ server: { status: oneOpen } });
      await settle();
      expect(existsSync(process.env.FORESTTRIP_LOGIN_STATE_FILE!)).toBe(false);
      await p.stop();
    });
  });
});
