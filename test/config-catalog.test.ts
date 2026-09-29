import { describe, expect, it } from "vitest";
import { goraebulAdapter } from "../src/adapters/goraebul.js";
import { renderCatalog } from "../src/catalog.js";
import { renderLiveDiff } from "../src/catalog-live.js";
import { parseArgs } from "../src/cli.js";
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
    const out = await run();
    expect(requests).toHaveLength(9);
    expect(out).toContain("DKA: 일치 (38자리)");
    expect(out).toContain("차이 없음");
  });

  it("--live: 사라지거나 새로 생긴 자리를 보고한다", async () => {
    const { run } = live((z) => layout(z, z === "DKA" ? [...seq(37), 40] : seq(1)));
    const out = await run();
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
