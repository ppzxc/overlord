import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { checkHealthz, startHealthz } from "../src/healthz.js";
import { Liveness, startWatchdog } from "../src/liveness.js";
import { AdapterError } from "../src/types.js";
import { CONFIG_YAML, ENV, fixture, settle, startPoller } from "./harness.js";

const open = () => ({ status: 200, body: fixture("dka-2026-09-29-1night.htm") });
const blocked = () => {
  throw new AdapterError("blocked", "차단됨");
};

const servers: { close(): unknown }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function healthz(liveness: Liveness) {
  const server = await startHealthz({ host: "127.0.0.1", port: 0 }, liveness);
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return (path = "/healthz") => fetch(`http://127.0.0.1:${port}${path}`);
}

describe("/healthz와 watchdog", () => {
  it("바퀴가 돌고 있으면 200이다", async () => {
    const p = startPoller(open);
    await settle();
    const get = await healthz(p.liveness);
    expect((await get()).status).toBe(200);
    await p.clock.advance(150_000);
    expect((await get()).status).toBe(200);
    await p.stop();
  });

  it("바퀴가 간격+여유를 넘겨 멈추면 503이고 watchdog이 멈춘 예약처를 알린다", async () => {
    const p = startPoller(open);
    await settle();
    const stalls: string[][] = [];
    const stop = startWatchdog(p.liveness, (s) => stalls.push(s), 10);
    const get = await healthz(p.liveness);
    expect((await get()).status).toBe(200);
    // 시계만 앞으로 돌린다. 바퀴 타이머는 깨우지 않아 루프가 멈춘 것과 같다.
    p.clock.freezeTimers = true;
    await p.clock.advance(150_000 * 1.2 + 15 * 60_000 + 1);
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, stalled: ["goraebul"] });
    await new Promise((r) => setTimeout(r, 30));
    expect(stalls.length).toBeGreaterThan(0);
    stop();
    p.clock.freezeTimers = false;
    await p.stop();
  });

  it("차단으로 멈춘 예약처는 24시간 리마인드 주기 안에서 200이다", async () => {
    const p = startPoller(blocked);
    await settle();
    const get = await healthz(p.liveness);
    await p.clock.advance(23 * 3600_000);
    expect((await get()).status).toBe(200);
    await p.stop();
  });

  it("/healthz 밖의 경로는 404다", async () => {
    const get = await healthz(new Liveness(() => 0));
    expect((await get("/other")).status).toBe(404);
  });
});

describe("healthz 설정", () => {
  it("생략하면 localhost에만 바인드한다", () => {
    expect(loadConfig(CONFIG_YAML, ENV).healthz.bind).toEqual({ host: "127.0.0.1", port: 8080 });
  });

  it("포트가 범위를 넘으면 시작을 거부한다", () => {
    expect(() => loadConfig(`healthz: { bind: "127.0.0.1:99999" }\n${CONFIG_YAML}`, ENV)).toThrow(/65535/);
  });

  it("host:port가 아니면 시작을 거부한다", () => {
    expect(() => loadConfig(CONFIG_YAML + "\n", ENV).healthz).not.toThrow();
    expect(() => loadConfig(`healthz: { bind: "8080" }\n${CONFIG_YAML}`, ENV)).toThrow(/healthz\.bind/);
  });
});

it("healthcheck는 설정한 주소의 응답을 종료 코드로 바꾼다", async () => {
  const server = await startHealthz({ host: "127.0.0.1", port: 0 }, new Liveness(() => 0));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  expect(await checkHealthz({ host: "127.0.0.1", port })).toBe(0);
  server.close();
  expect(await checkHealthz({ host: "127.0.0.1", port })).toBe(1);
});
