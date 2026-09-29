import { describe, expect, it } from "vitest";
import { goraebulAdapter } from "../src/adapters/goraebul.js";
import { renderCatalog } from "../src/catalog.js";
import { renderLiveDiff } from "../src/catalog-live.js";
import { parseArgs } from "../src/cli.js";
import { liveGapMs, readConfig, runCatalog, runTelegram } from "../src/commands.js";
import { ConfigError, loadConfig } from "../src/config.js";
import type { Transport } from "../src/types.js";
import { ENV, configWith, fixture } from "./harness.js";

const watch = (extra: string, name = "w") =>
  `  - name: ${name}\n    provider: goraebul\n    zones: [DKA]\n    checkIn: { from: 2026-10-02, to: 2026-10-02 }\n${extra}`;

const messageOf = (yaml: string, env: Record<string, string | undefined> = ENV) => {
  try {
    loadConfig(yaml, env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error("설정이 받아들여졌다");
};

describe("설정 검증", () => {
  it("필드가 없으면 위치를 담아 거부한다", () => {
    const msg = messageOf(configWith("  - name: x\n    provider: goraebul\n    checkIn: { from: 2026-10-02, to: 2026-10-02 }\n"));
    expect(msg).toContain("watches.0.zones");
  });

  it("형식이 틀리면 위치를 담아 거부한다", () => {
    const msg = messageOf(configWith("  - name: x\n    provider: goraebul\n    zones: [DKA]\n    checkIn: { from: 내일, to: 2026-10-02 }\n"));
    expect(msg).toContain("watches.0.checkIn.from");
  });

  it("없는 구역 코드는 쓸 수 있는 구역을 보여 주며 거부한다", () => {
    const msg = messageOf(configWith(watch("").replace("[DKA]", "[ZZZ]")));
    expect(msg).toContain("ZZZ");
    expect(msg).toContain("DKA, DKB, DKC");
  });

  it("없는 자리 번호는 쓸 수 있는 자리를 보여 주며 거부한다", () => {
    const msg = messageOf(configWith(watch("    seats: [A99]")));
    expect(msg).toContain("A99");
    expect(msg).toContain("A01-A38");
  });

  it("모든 구역에서 자리 번호 오타를 잡는다", () => {
    for (const [zone, seat] of [["CAB", "CAB99"], ["DKC", "C21"], ["AUA", "AUA01"], ["PEA", "PEA02"]]) {
      const yaml = configWith(watch(`    seats: [${seat}]`).replace("[DKA]", `[${zone}]`));
      expect(messageOf(yaml)).toContain(seat);
    }
  });

  it("범위가 구역의 자리와 겹치기만 하면 받아들인다", () => {
    expect(() => loadConfig(configWith(watch('    seats: ["A30-A45"]')), ENV)).not.toThrow();
  });

  it("예약처의 최대 박수를 넘는 nights를 거부한다", () => {
    expect(messageOf(configWith(watch("    nights: 3")))).toContain("최대 2박");
    expect(() => loadConfig(configWith(watch("    nights: 2")), ENV)).not.toThrow();
  });

  it("pollIntervalSeconds가 정수가 아니면 거부한다", () => {
    const yaml = configWith(watch("")).replace("pollIntervalSeconds: 150", "pollIntervalSeconds: 90.5");
    expect(messageOf(yaml)).toContain("정수");
  });

  it("알 수 없는 예약처를 거부한다", () => {
    expect(messageOf(configWith(watch("").replace("provider: goraebul", "provider: nowhere")))).toContain("goraebul");
  });

  it("pollIntervalSeconds가 60보다 작으면 거부한다", () => {
    const yaml = configWith(watch("")).replace("pollIntervalSeconds: 150", "pollIntervalSeconds: 30");
    expect(messageOf(yaml)).toContain("providers.goraebul.pollIntervalSeconds");
    expect(() => loadConfig(yaml.replace("30", "60"), ENV)).not.toThrow();
  });

  it("참조한 환경 변수가 비어 있으면 거부한다", () => {
    expect(messageOf(configWith(watch("")), { ...ENV, TELEGRAM_BOT_TOKEN: "" })).toMatch(/\d+번째 줄: .*TELEGRAM_BOT_TOKEN/);
    expect(messageOf(configWith(watch("")), { ...ENV, TELEGRAM_CHAT_ID: undefined })).toContain("TELEGRAM_CHAT_ID");
  });

  it("여러 문제를 한 번에 알려 준다", () => {
    const msg = messageOf(configWith(watch("    nights: 3").replace("[DKA]", "[ZZZ]")));
    expect(msg).toContain("ZZZ");
    expect(msg).toContain("최대 2박");
  });
});

describe("catalog", () => {
  it("구역의 코드, 이름, 유형, 정원과 자리 번호를 표로 보여 준다", () => {
    const out = renderCatalog(goraebulAdapter);
    expect(out).toMatch(/^코드\s+이름\s+유형\s+정원\s+자리$/m);
    expect(out).toMatch(/^DKA\s+숲속야영장 A\s+숲속야영장\s+-\s+38자리: A01-A38$/m);
    expect(out).toMatch(/^CAA\s+카라반 4인실\s+카라반\s+4인\s+9자리: CAA01-CAA02, CAA06-CAA07, CAA11-CAA12, CAA20-CAA22$/m);
    expect(out).toContain("DKC");
  });

  const live = (respond: (zone: string) => string) => {
    const requests: string[] = [];
    const transport: Transport = async ({ url }) => {
      requests.push(url);
      return { status: 200, body: respond(new URL(url).searchParams.get("room_Code")!) };
    };
    const run = () =>
      renderLiveDiff(goraebulAdapter, { transport, version: "0.1.0", now: new Date("2026-09-29T00:00:00Z"), pause: async () => {} });
    return { requests, run };
  };

  // 실제 배치 fixture에서 구역만 바꿔 쓴다.
  const layout = (zone: string, ids: number[]) =>
    `<div id="zone_${zone.toLowerCase()}" class="select_room">${ids
      .map((n) => `<a href="#" id="${zone.toLowerCase()}_${n}" class="num ban"><span>X</span></a>`)
      .join("")}</div>`;
  const seq = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  // 요소 id(dka_2)의 번호를 고정 목록에서 뽑아 응답을 만든다.
  const fixedLayout = (zone: string) => {
    const seats = goraebulAdapter.describe().zones.find((z) => z.code === zone)!.seats!;
    return layout(zone, seats.map((id) => +/(\d+)$/.exec(id)![1]!));
  };

  it("--live: 고정값과 실제 자리가 같으면 차이 없음을 보고한다", async () => {
    const { requests, run } = live((z) => (z === "DKA" ? fixture("dka-2026-09-29-1night.htm") : fixedLayout(z)));
    const { text: out, failed } = await run();
    expect(failed).toBe(false);
    expect(requests).toHaveLength(9);
    expect(out).toContain("DKA: 일치 (38자리)");
    expect(out).toContain("차이 없음");
  });

  it("--live: 사라지거나 새로 생긴 자리를 보고한다", async () => {
    const { run } = live((z) => layout(z, z === "DKA" ? [...seq(37), 40] : seq(1)));
    const { text: out } = await run();
    expect(out).toContain("DKA: 예약처에서 사라진 자리 A38");
    expect(out).toContain("DKA: 예약처에 새로 생긴 자리 A40");
    expect(out).toContain("어댑터의 고정 목록을 갱신해야 한다");
  });
});

describe("명령행 인자", () => {
  it("catalog는 하위 명령이고 그 밖의 첫 인자는 설정 파일 경로다", () => {
    expect(parseArgs(["catalog", "goraebul", "--live"])).toEqual({ kind: "catalog", provider: "goraebul", live: true });
    expect(parseArgs(["my.yaml"])).toEqual({ kind: "run", configPath: "my.yaml" });
    expect(parseArgs(["./catalog"])).toEqual({ kind: "run", configPath: "./catalog" });
    expect(parseArgs([])).toEqual({ kind: "run", configPath: "config.yaml" });
  });
});

describe("catalog --live 실패 처리", () => {
  const page = (zone: string) => `<div id="zone_${zone.toLowerCase()}" class="select_room"><a id="${zone.toLowerCase()}_1" class="num ban"></a></div>`;
  const run = (respond: (zone: string) => { status: number; body: string }) => {
    const zones: string[] = [];
    const transport: Transport = async ({ url }) => {
      const zone = new URL(url).searchParams.get("room_Code")!;
      zones.push(zone);
      return respond(zone);
    };
    return { zones, run: () => renderLiveDiff(goraebulAdapter, { transport, version: "0.1.0", now: new Date("2026-09-29T00:00:00Z"), pause: async () => {} }) };
  };

  it("한 구역이 실패해도 나머지를 조회하고 실패로 보고한다", async () => {
    const { zones, run: go } = run((z) => (z === "CAB" ? { status: 200, body: "<html></html>" } : { status: 200, body: page(z) }));
    const result = await go();
    expect(zones).toHaveLength(9);
    expect(result.failed).toBe(true);
    expect(result.text).toContain("CAB: 조회 실패(unrecognized)");
    expect(result.text).toContain("조회에 실패한 구역 1곳");
    expect(result.text).not.toContain("차이 없음");
  });

  it("차단되면 나머지 조회를 멈춘다", async () => {
    const { zones, run: go } = run((z) => (z === "CAB" ? { status: 200, body: "영덕군 전산팀" } : { status: 200, body: page(z) }));
    const result = await go();
    expect(zones).toEqual(["CAA", "CAB"]);
    expect(result.text).toContain("차단되어 나머지 구역 조회를 멈춘다");
    expect(result.failed).toBe(true);
  });
});

describe("catalog 명령", () => {
  const deps = (over: Partial<Parameters<typeof runCatalog>[1]> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const sleeps: number[] = [];
    return {
      out,
      err,
      sleeps,
      deps: {
        adapters: { goraebul: goraebulAdapter },
        transport: (async () => ({ status: 500, body: "" })) as Transport,
        version: "0.1.0",
        now: () => new Date("2026-09-29T00:00:00Z"),
        sleep: async (ms: number) => void sleeps.push(ms),
        random: () => 0.5,
        out: (s: string) => void out.push(s),
        err: (s: string) => void err.push(s),
        ...over,
      },
    };
  };

  it("예약처를 빼면 사용법을 알리고 1을 돌려준다", async () => {
    const d = deps();
    expect(await runCatalog({ kind: "catalog", provider: undefined, live: false }, d.deps)).toBe(1);
    expect(d.err.join("")).toContain("goraebul");
  });

  it("--live 없이는 표만 출력하고 예약처에 묻지 않는다", async () => {
    const d = deps({ transport: async () => { throw new Error("호출되면 안 된다"); } });
    expect(await runCatalog({ kind: "catalog", provider: "goraebul", live: false }, d.deps)).toBe(0);
    expect(d.out.join("")).toContain("DKA");
  });

  it("listSeats가 없는 예약처에 --live를 하면 묻지 않고 안내만 한다", async () => {
    const zoneOnly = { ...goraebulAdapter, listSeats: undefined };
    const d = deps({
      adapters: { goraebul: zoneOnly },
      transport: async () => { throw new Error("호출되면 안 된다"); },
    });
    expect(await runCatalog({ kind: "catalog", provider: "goraebul", live: true }, d.deps)).toBe(0);
    expect(d.out.join("")).toContain("자리 단위로 보지 않는 예약처");
    expect(d.sleeps).toEqual([]);
  });

  it("--live 조회에 실패하면 1을 돌려주고, 요청 사이에 5초에 0~3초 지터를 쉰다", async () => {
    const d = deps();
    expect(await runCatalog({ kind: "catalog", provider: "goraebul", live: true }, d.deps)).toBe(1);
    expect(d.sleeps).toHaveLength(8);
    expect(d.sleeps.every((ms) => ms === 6500)).toBe(true);
    expect(liveGapMs(() => 0)).toBe(5000);
    expect(liveGapMs(() => 0.999)).toBeLessThan(8000);
  });
});

describe("설정 오류 위치와 시설", () => {
  const yaml = configWith(watch("    nights: 3"));
  it("예약처 규칙 오류에도 줄 번호를 담는다", () => {
    const line = yaml.split("\n").findIndex((l) => l.includes("nights: 3")) + 1;
    expect(messageOf(yaml)).toContain(`${line}번째 줄 watches.0.nights`);
  });

  it("스키마 오류에도 줄 번호를 담는다", () => {
    const bad = configWith(watch("").replace("2026-10-02, to", "내일, to"));
    expect(messageOf(bad)).toMatch(/\d+번째 줄 watches\.0\.checkIn\.from/);
  });

  it("없는 시설을 거부하고 고를 수 있는 값을 보여 준다", () => {
    const msg = messageOf(configWith(watch("    facility: nowhere")));
    expect(msg).toContain("watches.0.facility");
    expect(msg).toContain("goraebul");
  });

  it("시설은 생략하거나 맞게 쓸 수 있다", () => {
    expect(() => loadConfig(configWith(watch("    facility: goraebul")), ENV)).not.toThrow();
  });

  it("설정 파일이 없으면 경로를 담아 거부한다", () => {
    expect(() => readConfig("/no/such/config.yaml", ENV)).toThrow(/설정 파일을 찾을 수 없다: \/no\/such\/config.yaml/);
  });
});

describe("telegram chats", () => {
  const run = async (updates: unknown[] | Error, env: Record<string, string | undefined> = ENV) => {
    let out = "";
    let err = "";
    const code = await runTelegram(parseArgs(["telegram", "chats"]) as never, {
      sink: {
        sendMessage: async () => {},
        getUpdates: async () => {
          if (updates instanceof Error) throw updates;
          return updates;
        },
      },
      env,
      out: (t) => (out += t),
      err: (t) => (err += t),
    });
    return { code, out, err };
  };

  it("최근 업데이트의 chat을 중복 없이 나열한다", async () => {
    const r = await run([
      { update_id: 1, message: { chat: { id: 42, type: "private", first_name: "홍", last_name: "길동" } } },
      { update_id: 2, message: { chat: { id: 42, type: "private", first_name: "홍", last_name: "길동" } } },
      { update_id: 3, my_chat_member: { chat: { id: -100123, type: "supergroup", title: "캠핑" } } },
    ]);
    expect(r.code).toBe(0);
    expect(r.out.match(/^42\t/gm)).toHaveLength(1);
    expect(r.out).toContain("-100123\tsupergroup\t캠핑");
  });

  it("업데이트가 없으면 안내한다", async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("봇에게 메시지를 보내");
  });

  it("토큰이 없으면 실패하고 API 오류에는 토큰이 나오지 않는다", async () => {
    expect((await run([], {})).code).toBe(1);
    const r = await run(new Error("fetch https://api.telegram.org/bottok/getUpdates"));
    expect(r.code).toBe(1);
    expect(r.err).not.toContain("tok/");
  });
});
