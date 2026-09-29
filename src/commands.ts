import { readFileSync } from "node:fs";
import { renderCatalog } from "./catalog.js";
import { renderLiveDiff } from "./catalog-live.js";
import type { Command } from "./cli.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { TelegramError, chatsFromUpdates, type TelegramSink } from "./telegram.js";
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

export interface TelegramDeps {
  sink: TelegramSink;
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** telegram 하위 명령을 실행하고 종료 코드를 돌려준다. 봇 토큰은 환경 변수 TELEGRAM_BOT_TOKEN에서 읽는다. */
export async function runTelegram(command: Extract<Command, { kind: "telegram" }>, deps: TelegramDeps): Promise<number> {
  if (command.sub !== "chats") {
    deps.err("사용법: telegram chats\n");
    return 1;
  }
  const token = deps.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    deps.err("환경 변수 TELEGRAM_BOT_TOKEN이 비어 있다.\n");
    return 1;
  }
  let updates: unknown[];
  try {
    updates = await deps.sink.getUpdates(token);
  } catch (e) {
    // 토큰이 들어 있을 수 있는 원문 대신 상태만 알린다.
    const status = e instanceof TelegramError ? ` (HTTP ${e.status ?? "네트워크 오류"})` : "";
    deps.err(`업데이트를 가져오지 못했다${status}. 토큰을 확인한다.\n`);
    return 1;
  }
  const chats = chatsFromUpdates(updates);
  if (chats.length === 0) {
    deps.out("최근 받은 업데이트가 없다. 봇에게 메시지를 보내거나 그룹에 봇을 초대한 뒤 다시 실행한다.\n");
    return 0;
  }
  deps.out(["chatId\t종류\t이름", ...chats.map((c) => `${c.id}\t${c.type}\t${c.title}`)].join("\n") + "\n");
  return 0;
}
