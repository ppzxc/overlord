import { readFileSync } from "node:fs";
import { renderCatalog } from "./catalog.js";
import { renderLiveDiff } from "./catalog-live.js";
import type { Command } from "./cli.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import type { ProviderAdapter, Transport } from "./types.js";

export interface CatalogDeps {
  adapters: Record<string, ProviderAdapter>;
  transport: Transport;
  version: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** 요청 사이 최소 간격 5초에 0~3초 지터를 더한다. */
export const liveGapMs = (random: () => number) => 5000 + Math.floor(random() * 3000);

/** catalog 명령을 실행하고 종료 코드를 돌려준다. */
export async function runCatalog(command: Extract<Command, { kind: "catalog" }>, deps: CatalogDeps): Promise<number> {
  const adapter = deps.adapters[command.provider ?? ""];
  if (!adapter) {
    deps.err(`사용법: catalog <예약처> [--live]. 쓸 수 있는 예약처: ${Object.keys(deps.adapters).join(", ")}\n`);
    return 1;
  }
  deps.out(renderCatalog(adapter));
  if (!command.live) return 0;
  deps.out("\n실제 예약처와 비교:\n");
  const result = await renderLiveDiff(adapter, {
    transport: deps.transport,
    version: deps.version,
    now: deps.now(),
    pause: () => deps.sleep(liveGapMs(deps.random)),
  });
  deps.out(result.text);
  return result.failed ? 1 : 0;
}

/** 설정 파일을 읽어 검증한다. 실패하면 사용자에게 보여 줄 메시지를 담아 던진다. */
export function readConfig(path: string, env: Record<string, string | undefined>): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigError([`설정 파일을 찾을 수 없다: ${path}`]);
    throw e;
  }
  return loadConfig(text, env);
}
