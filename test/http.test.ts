import { describe, expect, it } from "vitest";
import { goraebulAdapter } from "../src/adapters/goraebul.js";
import { createHttpClient } from "../src/http.js";
import type { Transport, TransportRequest, TransportResponse } from "../src/types.js";
import { FakeClock } from "./harness.js";

const recording = (respond: (req: TransportRequest) => TransportResponse = () => ({ status: 200, body: "" })) => {
  const requests: TransportRequest[] = [];
  const transport: Transport = async (req) => {
    requests.push(req);
    return respond(req);
  };
  return { requests, transport };
};

const client = (transport: Transport, over: Partial<Parameters<typeof createHttpClient>[0]> = {}) =>
  createHttpClient({ transport, version: "0.1.0", userAgentSuffix: "", blockedPaths: [], cookieSession: true, ...over });

describe("HTTP 요청", () => {
  it("GET은 본문 없이, POST는 form 본문과 Content-Type을 싣는다", async () => {
    const { requests, transport } = recording();
    const http = client(transport);
    await http.get("https://example.com/a");
    await http.post("https://example.com/b", { fcltyCode: "1001", date: "2026-10-03" });
    expect(requests[0]).toMatchObject({ method: "GET", headers: { "User-Agent": "overlord-availability-poller/0.1.0" } });
    expect(requests[0]!.body).toBeUndefined();
    expect(requests[1]).toMatchObject({
      method: "POST",
      body: "fcltyCode=1001&date=2026-10-03",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    });
  });

  it("요청별 headers는 그 요청에만 더해지고 User-Agent를 덮지 않는다", async () => {
    const { requests, transport } = recording();
    const http = client(transport);
    await http.post("https://example.com/a", { x: "1" }, { headers: { Referer: "https://example.com/" } });
    await http.post("https://example.com/b", { x: "1" });
    expect(requests[0]!.headers).toMatchObject({ Referer: "https://example.com/", "User-Agent": "overlord-availability-poller/0.1.0" });
    expect(requests[1]!.headers.Referer).toBeUndefined();
  });

  it("어댑터가 선언한 경로는 GET이든 POST든 보내지 않는다", async () => {
    const { requests, transport } = recording();
    const http = client(transport, { blockedPaths: ["/bbs/"] });
    await expect(http.get("https://example.com/bbs/list")).rejects.toThrow(/접근 금지/);
    await expect(http.post("https://example.com/bbs/write", {})).rejects.toThrow(/접근 금지/);
    await expect(http.get("https://example.com/bbs/x", { unpaced: true })).rejects.toThrow(/접근 금지/);
    await http.get("https://example.com/pages/bbs/x"); // 경로 앞부분만 본다
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual(["/pages/bbs/x"]);
  });

  it("고래불은 /bbs/를 접근 금지로 선언한다", () => {
    expect(goraebulAdapter.describe().blockedPaths).toContain("/bbs/");
  });
});

describe("쿠키 세션", () => {
  const withCookies = () =>
    recording((req) =>
      new URL(req.url).pathname === "/enter"
        ? { status: 200, body: "", setCookie: ["DHCMP_JSESSIONID=abc; Path=/; HttpOnly", "NetFunnel_ID=k%3D1; Expires=Wed, 30 Sep 2026 00:00:00 GMT"] }
        : { status: 200, body: "" },
    );

  it("Set-Cookie로 받은 쿠키를 같은 클라이언트의 다음 요청에 싣는다", async () => {
    const { requests, transport } = withCookies();
    const http = client(transport);
    await http.get("https://example.com/enter");
    await http.post("https://example.com/next", {});
    expect(requests[0]!.headers.Cookie).toBeUndefined();
    expect(requests[1]!.headers.Cookie).toBe("DHCMP_JSESSIONID=abc; NetFunnel_ID=k%3D1");
  });

  it("같은 이름의 쿠키는 새 값으로 바꾸고 Max-Age=0이거나 Expires가 지났으면 지운다", async () => {
    let step = 0;
    const { requests, transport } = recording(() => {
      step++;
      if (step === 1) return { status: 200, body: "", setCookie: ["a=1", "b=2", "c=3", "d=4"] };
      if (step === 2)
        return { status: 200, body: "", setCookie: ["a=5", "b=; Max-Age=0", "c=; Expires=Thu, 01 Jan 1970 00:00:00 GMT", "d="] };
      return { status: 200, body: "" };
    });
    const http = client(transport);
    await http.get("https://example.com/1");
    await http.get("https://example.com/2");
    await http.get("https://example.com/3");
    expect(requests[2]!.headers.Cookie).toBe("a=5; d=");
  });

  it("다른 예약처의 클라이언트에는 쿠키가 새지 않는다", async () => {
    const { requests, transport } = withCookies();
    const donghae = client(transport);
    const goraebul = client(transport);
    await donghae.get("https://example.com/enter");
    await goraebul.get("https://example.com/next");
    expect(requests[1]!.headers.Cookie).toBeUndefined();
    expect(requests[1]!.headers).toEqual({ "User-Agent": "overlord-availability-poller/0.1.0" });
  });

  it("쿠키 세션을 쓰지 않는 예약처는 Set-Cookie를 받아도 싣지 않는다", async () => {
    const { requests, transport } = withCookies();
    const http = client(transport, { cookieSession: false });
    await http.get("https://example.com/enter");
    await http.get("https://example.com/next");
    expect(requests[1]!.headers).toEqual({ "User-Agent": "overlord-availability-poller/0.1.0" });
  });

  it("고래불은 쿠키 세션을 쓰지 않는다", () => {
    expect(goraebulAdapter.describe().cookieSession).toBe(false);
  });

  it("세션을 버리면 쿠키를 더 싣지 않는다", async () => {
    const { requests, transport } = withCookies();
    const http = client(transport);
    await http.get("https://example.com/enter");
    http.clearSession();
    await http.get("https://example.com/next");
    expect(requests[1]!.headers.Cookie).toBeUndefined();
  });

  it("큐에서 기다리던 요청도 앞 요청이 받은 쿠키를 싣는다", async () => {
    const { requests, transport } = withCookies();
    const clock = new FakeClock();
    const http = client(transport, { pacing: { clock, random: () => 0.5, signal: new AbortController().signal } });
    const first = http.get("https://example.com/enter");
    const second = http.get("https://example.com/next");
    await Promise.all([first, second]);
    expect(requests[1]!.headers.Cookie).toContain("DHCMP_JSESSIONID=abc");
  });
});

describe("간격 큐 밖 요청", () => {
  const paced = (transport: Transport, clock = new FakeClock()) => {
    const http = client(transport, { pacing: { clock, random: () => 0.5, signal: new AbortController().signal } });
    return { clock, http };
  };

  it("간격을 기다리지 않고, 큐 안 요청의 간격 계산에도 끼지 않는다", async () => {
    const times: Record<string, number> = {};
    const clock = new FakeClock();
    const transport: Transport = async (req) => {
      times[new URL(req.url).pathname] = clock.now().getTime();
      return { status: 200, body: "" };
    };
    const { http } = paced(transport, clock);
    await http.get("https://example.com/a");
    const aAt = times["/a"]!;
    await clock.advance(3_000);
    await http.get("https://example.com/u", { unpaced: true });
    expect(times["/u"]).toBe(aAt + 3_000); // 6.5초를 기다리지 않았다
    await http.get("https://example.com/c");
    expect(times["/c"]).toBe(aAt + 6_500); // /u가 아니라 /a를 기준으로 쟀다
  });

  it("중단된 뒤에는 큐 밖 요청도 보내지 않는다", async () => {
    const { requests, transport } = recording();
    const controller = new AbortController();
    const http = client(transport, { pacing: { clock: new FakeClock(), random: () => 0.5, signal: controller.signal } });
    controller.abort();
    await expect(http.get("https://example.com/u", { unpaced: true })).rejects.toThrow(/중단/);
    expect(requests).toEqual([]);
  });

  it("큐 안 요청이 응답을 기다리는 중에도 바로 나간다", async () => {
    let release!: () => void;
    const hang = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const transport: Transport = async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/slow") await hang;
      order.push(path);
      return { status: 200, body: "" };
    };
    const { http } = paced(transport);
    const slow = http.get("https://example.com/slow");
    await http.post("https://example.com/queue", {}, { unpaced: true });
    expect(order).toEqual(["/queue"]);
    release();
    await slow;
    expect(order).toEqual(["/queue", "/slow"]);
  });
});

describe("호스트별 쿠키", () => {
  const respondBy = (byHost: Record<string, string[]>) =>
    recording((req) => ({ status: 200, body: "", setCookie: req.url.endsWith("/set") ? byHost[new URL(req.url).hostname] : undefined }));

  it("Domain 속성이 없는 쿠키는 받은 호스트에만 싣는다", async () => {
    const { requests, transport } = respondBy({ "www.camp.kr": ["SID=www"] });
    const http = client(transport);
    await http.get("https://www.camp.kr/set");
    await http.get("https://nf.camp.kr/a");
    await http.get("https://www.camp.kr/b");
    expect(requests[1]!.headers.Cookie).toBeUndefined();
    expect(requests[2]!.headers.Cookie).toBe("SID=www");
  });

  it("Domain 속성이 있으면 그 도메인과 하위 호스트에 싣고, 맞지 않는 Domain은 버린다", async () => {
    const { requests, transport } = respondBy({ "nf.camp.kr": ["NF=1; Domain=.camp.kr", "X=1; Domain=other.kr"] });
    const http = client(transport);
    await http.get("https://nf.camp.kr/set");
    await http.get("https://www.camp.kr/a");
    await http.get("https://camp.kr/b");
    await http.get("https://other.kr/c");
    expect(requests[1]!.headers.Cookie).toBe("NF=1");
    expect(requests[2]!.headers.Cookie).toBe("NF=1");
    expect(requests[3]!.headers.Cookie).toBeUndefined();
  });

  it("호스트가 다르면 같은 이름의 쿠키도 따로 둔다", async () => {
    const { requests, transport } = respondBy({ "a.kr": ["SID=a"], "b.kr": ["SID=b"] });
    const http = client(transport);
    await http.get("https://a.kr/set");
    await http.get("https://b.kr/set");
    await http.get("https://a.kr/x");
    expect(requests[2]!.headers.Cookie).toBe("SID=a");
  });
});

describe("리다이렉트", () => {
  const redirecting = (routes: Record<string, TransportResponse>) =>
    recording((req) => routes[new URL(req.url).pathname] ?? { status: 200, body: "done" });

  it("Transport에는 따라가지 말라고 하고, 클라이언트가 Location을 따라간다", async () => {
    const { requests, transport } = redirecting({ "/a": { status: 302, body: "", location: "/b" } });
    const res = await client(transport).get("https://example.com/a");
    expect(res).toMatchObject({ status: 200, body: "done" });
    expect(requests.map((r) => [r.url, r.redirect])).toEqual([
      ["https://example.com/a", "manual"],
      ["https://example.com/b", "manual"],
    ]);
  });

  it("중간 응답의 쿠키를 담아 다음 홉에 싣는다", async () => {
    const { requests, transport } = redirecting({ "/login": { status: 302, body: "", location: "/home", setCookie: ["SID=1"] } });
    await client(transport).get("https://example.com/login");
    expect(requests[1]!.headers.Cookie).toBe("SID=1");
  });

  it("302·303은 POST를 본문 없는 GET으로 바꾸고, 307은 그대로 다시 보낸다", async () => {
    const { requests, transport } = redirecting({
      "/p302": { status: 302, body: "", location: "/x" },
      "/p307": { status: 307, body: "", location: "/y" },
    });
    const http = client(transport);
    await http.post("https://example.com/p302", { a: "1" });
    await http.post("https://example.com/p307", { a: "1" });
    expect(requests[1]).toMatchObject({ method: "GET", body: undefined });
    expect(requests[1]!.headers["Content-Type"]).toBeUndefined();
    expect(requests[3]).toMatchObject({ method: "POST", body: "a=1" });
  });

  it("접근 금지 경로로 가는 리다이렉트는 따라가지 않는다", async () => {
    const { requests, transport } = redirecting({ "/a": { status: 302, body: "", location: "https://example.com/bbs/x" } });
    await expect(client(transport, { blockedPaths: ["/bbs/"] }).get("https://example.com/a")).rejects.toThrow(/접근 금지/);
    expect(requests).toHaveLength(1);
  });

  it("리다이렉트가 끝없이 이어지면 멈춘다", async () => {
    const { requests, transport } = redirecting({ "/loop": { status: 302, body: "", location: "/loop" } });
    await expect(client(transport).get("https://example.com/loop")).rejects.toThrow(/리다이렉트/);
    expect(requests.length).toBeLessThanOrEqual(6);
  });

  it("리다이렉트를 따라가는 동안은 간격 한 칸만 쓴다", async () => {
    const clock = new FakeClock();
    const times: number[] = [];
    const transport: Transport = async (req) => {
      times.push(clock.now().getTime());
      return new URL(req.url).pathname === "/a" ? { status: 302, body: "", location: "/b" } : { status: 200, body: "" };
    };
    const http = client(transport, { pacing: { clock, random: () => 0.5, signal: new AbortController().signal } });
    await http.get("https://example.com/a");
    expect(times[1]).toBe(times[0]);
  });
});
