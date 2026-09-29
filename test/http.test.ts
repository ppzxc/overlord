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
  createHttpClient({ transport, version: "0.1.0", userAgentSuffix: "", blockedPaths: [], ...over });

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
