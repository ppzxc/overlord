import { describe, expect, it } from "vitest";
import { AdapterError, type AdapterContext, type HttpClient, type TransportResponse } from "../src/types.js";
import {
  acquireKey,
  completeQueue,
  enterQueue,
  enterQueues,
  jsEscape,
  releaseKey,
  setNetFunnelCookie,
  type NetFunnelQueue,
} from "../src/netfunnel.js";
import { FakeClock } from "./harness.js";

const QUEUE: NetFunnelQueue = { tsUrl: "https://nf.example.kr/ts.wseq", sid: "service_1", aid: "reserve" };

const result = (code: number, fields: string) => ({ status: 200, body: `NetFunnel.gControl.result='5101:${code}:${fields}'` });
const OK = { status: 200, body: "" };

/** 대기열 서버를 흉내 낸다. 요청 URL과 도착 시각을 기록하고 준비한 응답을 차례로 돌려준다. */
function server(responses: TransportResponse[]) {
  const clock = new FakeClock();
  const calls: { url: string; opts: unknown; at: number }[] = [];
  const cookies: [string, string, string][] = [];
  const http: HttpClient = {
    get: async (url, opts) => {
      calls.push({ url, opts, at: clock.now().getTime() });
      const next = responses.shift();
      if (!next) throw new Error(`준비한 응답이 없다: ${url}`);
      return next;
    },
    post: async () => {
      throw new Error("POST는 흉내 내지 않는다");
    },
    setCookie: (host, name, value) => cookies.push([host, name, value]),
    clearSession: () => {},
  };
  const ctx: AdapterContext = { http, clock };
  return { ctx, calls, cookies, clock };
}
const query = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe("NetFunnel 대기열 진입", () => {
  it("5101로 들어가 200이면 키를 받고, 요청은 예약처가 고른 주소·sid·aid로 간격 큐 밖에서 나간다", async () => {
    const s = server([result(200, "key=ABC&nwait=0&ttl=0")]);
    const pass = await enterQueue(s.ctx, QUEUE);
    expect(pass).toEqual({ key: "ABC", waitedMs: 0, result: "5101:200:key=ABC&nwait=0&ttl=0" });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url.startsWith("https://nf.example.kr/ts.wseq?")).toBe(true);
    expect(query(s.calls[0]!.url)).toMatchObject({ opcode: "5101", nfid: "0", sid: "service_1", aid: "reserve", js: "yes" });
    expect(query(s.calls[0]!.url).key).toBeUndefined();
    expect(s.calls[0]!.opts).toEqual({ unpaced: true });
  });

  it("201이면 서버가 준 ttl만큼 쉬고 같은 키로 5002를 반복해 200에 통과하며 기다린 시간을 잰다", async () => {
    const s = server([result(201, "key=K1&nwait=5&ttl=3"), result(201, "key=K1&nwait=2&ttl=2"), result(200, "key=K1&nwait=0&ttl=0")]);
    const pass = await enterQueue(s.ctx, QUEUE);
    expect(pass).toMatchObject({ key: "K1", waitedMs: 5_000 });
    expect(s.calls.map((c) => query(c.url).opcode)).toEqual(["5101", "5002", "5002"]);
    expect(s.calls.map((c) => c.at - s.calls[0]!.at)).toEqual([0, 3_000, 5_000]);
    expect(query(s.calls[1]!.url).key).toBe("K1");
  });

  it.each([301, 302])("%i는 곧바로 blocked이고 대기 요청을 더 보내지 않는다", async (code) => {
    const s = server([result(code, "key=X&nwait=9&ttl=1"), result(200, "key=X")]);
    await expect(enterQueue(s.ctx, QUEUE)).rejects.toMatchObject({ kind: "blocked" });
    expect(s.calls).toHaveLength(1);
  });

  it("기다림이 120초 상한을 넘기게 되면 transient로 포기한다", async () => {
    const s = server(Array.from({ length: 30 }, () => result(201, "key=K&nwait=9&ttl=7")));
    await expect(enterQueue(s.ctx, QUEUE)).rejects.toMatchObject({ kind: "transient" });
    expect(s.calls.length).toBeLessThan(30);
  });

  it("연결 실패·HTTP 오류·키 없는 200·읽을 수 없는 응답은 transient다", async () => {
    const failing = server([]);
    failing.ctx.http.get = async () => {
      throw new Error("ECONNRESET");
    };
    await expect(enterQueue(failing.ctx, QUEUE)).rejects.toMatchObject({ kind: "transient" });
    await expect(enterQueue(server([{ status: 503, body: "" }]).ctx, QUEUE)).rejects.toMatchObject({ kind: "transient" });
    await expect(enterQueue(server([result(200, "nwait=0")]).ctx, QUEUE)).rejects.toMatchObject({ kind: "transient" });
    await expect(enterQueue(server([{ status: 200, body: "<html>" }]).ctx, QUEUE)).rejects.toBeInstanceOf(AdapterError);
  });
});

describe("여러 단계 액션 흐름", () => {
  it("액션 id를 차례로 지나며 단계마다 키를 돌려준다", async () => {
    const s = server([result(200, "key=A1"), result(200, "key=A2")]);
    const passes = await enterQueues(s.ctx, QUEUE, ["landingCamp", "reservation2"]);
    expect(passes.map((p) => p.key)).toEqual(["A1", "A2"]);
    expect(s.calls.map((c) => query(c.url).aid)).toEqual(["landingCamp", "reservation2"]);
  });

  it("앞 단계가 막히면 다음 단계는 보내지 않는다", async () => {
    const s = server([result(302, "key=A1"), result(200, "key=A2")]);
    await expect(enterQueues(s.ctx, QUEUE, ["landingCamp", "reservation2"])).rejects.toMatchObject({ kind: "blocked" });
    expect(s.calls).toHaveLength(1);
  });
});

describe("setComplete(5004)", () => {
  it("키를 실어 5004를 보내고, 실패해도 던지지 않는다", async () => {
    const s = server([OK]);
    await completeQueue(s.ctx, QUEUE, "KEY 1");
    expect(query(s.calls[0]!.url)).toMatchObject({ opcode: "5004", key: "KEY 1", sid: "service_1", aid: "reserve" });
    expect(s.calls[0]!.opts).toEqual({ unpaced: true, ignoreAbort: false });
    const failing = server([]);
    await expect(completeQueue(failing.ctx, QUEUE, "K", true)).resolves.toBeUndefined();
  });
});

describe("NetFunnel_ID 쿠키 전달", () => {
  it("5101 결과 문자열을 escape()로 인코딩해 호스트 쿠키로 심는다", () => {
    const s = server([]);
    setNetFunnelCookie(s.ctx.http, "reservation.knps.or.kr", "5002:200:key=A B&ttl=0");
    expect(s.cookies).toEqual([["reservation.knps.or.kr", "NetFunnel_ID", "5002%3A200%3Akey%3DA%20B%26ttl%3D0"]]);
  });
});

describe("escape()", () => {
  it("JS escape()와 같게 안전 문자는 두고 라틴-1은 %XX, 그 밖은 %uXXXX로 쓴다", () => {
    expect(jsEscape("a@*_+-./Z9")).toBe("a@*_+-./Z9");
    expect(jsEscape("é 가~")).toBe("%E9%20%uAC00%7E");
  });
});

describe("키 재사용", () => {
  const MIN = 60_000;
  const setup = (responses: TransportResponse[], confirms: boolean[]) => {
    const s = server(responses);
    const asked: string[] = [];
    const opts = {
      ttlMs: 120 * MIN,
      completeAfterMs: 5 * MIN,
      confirm: async (key: string) => {
        asked.push(key);
        return confirms.shift() ?? true;
      },
      enter: async (pass: { key: string }) => `page-${pass.key}`,
    };
    return { s, asked, acquire: () => acquireKey(s.ctx, QUEUE, opts) };
  };
  const opcodes = (s: ReturnType<typeof server>) => s.calls.map((c) => query(c.url).opcode);

  it("처음엔 대기열에 들어 키를 받고, 다음엔 서버 확인만 거쳐 같은 키를 기다림 0으로 다시 쓴다", async () => {
    const t = setup([result(200, "key=K1&ttl=0")], [true]);
    const first = await t.acquire();
    expect(first.pass).toEqual({ key: "K1", waitedMs: 0 });
    expect(first.lease.extra).toBe("page-K1");
    const second = await t.acquire();
    expect(second.lease).toBe(first.lease);
    expect(second.pass).toEqual({ key: "K1", waitedMs: 0 });
    expect(t.s.calls).toHaveLength(1);
    expect(t.asked).toEqual(["K1"]);
  });

  it("2시간이 지난 키는 확인 없이 새로 진입한다", async () => {
    const t = setup([result(200, "key=K1"), OK, result(200, "key=K2")], []);
    await t.acquire();
    await t.s.clock.advance(121 * MIN);
    const next = await t.acquire();
    expect(next.pass.key).toBe("K2");
    expect(t.asked).toEqual([]);
  });

  it("서버가 거절한 키는 버리고 새로 진입하며, 새 키까지 곧바로 거절되면 구조 변경이다", async () => {
    const ok = setup([result(200, "key=K1"), result(200, "key=K2")], [false, true]);
    await ok.acquire();
    expect((await ok.acquire()).pass.key).toBe("K2");
    expect(ok.asked).toEqual(["K1", "K2"]);

    const bad = setup([result(200, "key=K1"), result(200, "key=K2")], [false, false]);
    await bad.acquire();
    await expect(bad.acquire()).rejects.toMatchObject({ kind: "unrecognized" });
  });

  it("진입 5분 뒤 첫 사용에서 5004를 한 번 보내고, 이미 보냈으면 닫을 때 다시 보내지 않는다", async () => {
    const t = setup([result(200, "key=K1"), OK], []);
    await t.acquire();
    await t.s.clock.advance(6 * MIN);
    await t.acquire();
    await t.acquire();
    expect(opcodes(t.s)).toEqual(["5101", "5004"]);
    await releaseKey(t.s.ctx, QUEUE);
    expect(opcodes(t.s)).toEqual(["5101", "5004"]);
  });

  it("5분이 안 됐어도 닫을 때 아직 안 보냈으면 5004를 보낸다", async () => {
    const t = setup([result(200, "key=K1"), OK], []);
    await t.acquire();
    await releaseKey(t.s.ctx, QUEUE);
    expect(opcodes(t.s)).toEqual(["5101", "5004"]);
  });
});
