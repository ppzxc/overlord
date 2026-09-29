import { readFileSync } from "node:fs";
import { adapters } from "./adapters/index.js";
import { parseArgs } from "./cli.js";
import { readConfig, runCatalog, runTelegram } from "./commands.js";
import { ConfigError } from "./config.js";
import { runPoller } from "./poller.js";
import { TelegramError, type TelegramSink } from "./telegram.js";
import type { Clock, Transport } from "./types.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const transport: Transport = async ({ url, headers, timeoutMs }) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, body: await res.text() };
};

const clock: Clock = {
  now: () => new Date(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      function done() {
        clearTimeout(timer);
        resolve();
      }
    }),
};

async function telegramCall(botToken: string, method: string, body: unknown): Promise<{ result?: unknown }> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // 원본 오류 메시지에 토큰이 든 URL이 들어갈 수 있어 버린다.
    throw new TelegramError(`Telegram ${method} 네트워크 오류`);
  }
  if (!res.ok) {
    const retryAfter = ((await res.json().catch(() => null)) as { parameters?: { retry_after?: number } } | null)
      ?.parameters?.retry_after;
    throw new TelegramError(`Telegram ${method} 실패: HTTP ${res.status}`, res.status, retryAfter);
  }
  return (await res.json()) as { result?: unknown };
}

const sink: TelegramSink = {
  async sendMessage(botToken, { chatId, ...rest }) {
    await telegramCall(botToken, "sendMessage", { chat_id: chatId, ...rest });
  },
  async getUpdates(botToken) {
    const { result } = await telegramCall(botToken, "getUpdates", { timeout: 0 });
    return Array.isArray(result) ? result : [];
  },
};

const command = parseArgs(process.argv.slice(2));

if (command.kind === "telegram") {
  process.exit(
    await runTelegram(command, {
      sink,
      env: process.env,
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
    }),
  );
}

if (command.kind === "catalog") {
  process.exit(
    await runCatalog(command, {
      adapters,
      transport,
      version: pkg.version,
      now: () => new Date(),
      sleep: (ms) => clock.sleep(ms),
      random: Math.random,
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
    }),
  );
}

let config;
try {
  config = readConfig(command.configPath, process.env);
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

await runPoller(
  {
    config,
    adapters,
    transport,
    clock,
    sink,
    version: pkg.version,
    log: (msg, fields) => console.log(JSON.stringify({ msg, ...fields })),
  },
  controller.signal,
);
