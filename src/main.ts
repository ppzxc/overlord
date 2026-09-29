import { readFileSync } from "node:fs";
import { pino } from "pino";
import { adapters } from "./adapters/index.js";
import { parseArgs } from "./cli.js";
import { readConfig, runCatalog, runTelegram } from "./commands.js";
import { ConfigError } from "./config.js";
import { checkHealthz, startHealthz } from "./healthz.js";
import { Liveness, startWatchdog } from "./liveness.js";
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

const TELEGRAM_TIMEOUT_MS = 15_000;

async function telegramCall(botToken: string, method: string, body: unknown): Promise<{ result?: unknown }> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
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
  if (command.kind === "healthcheck") process.exit(await checkHealthz(config.healthz.bind));
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
// JSON 줄 단위로 stdout에 남긴다. 비밀값은 아래 log가 가린다.
const logger = pino({
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
});
// 오류 문구에 URL이 섞여 들어와도 비밀값은 남기지 않는다.
const secrets = [
  ...Object.values(config.notifiers).map((n) => n.botToken),
  ...(config.deadManPingUrl ? [config.deadManPingUrl] : []),
];
const scrub = (text: string) => secrets.reduce((t, secret) => t.replaceAll(secret, "***"), text);
const log = (msg: string, fields?: Record<string, unknown>) =>
  logger.info(JSON.parse(scrub(JSON.stringify(fields ?? {}))) as object, scrub(msg));

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

const liveness = new Liveness(() => Date.now());
const healthzServer = await startHealthz(config.healthz.bind, liveness).catch((e: unknown) => {
  logger.fatal({ bind: `${config.healthz.bind.host}:${config.healthz.bind.port}`, message: e instanceof Error ? e.message : String(e) }, "healthz 시작 실패");
  process.exit(1);
});
// 루프가 멈추면 프로세스를 끝내 Docker restart 정책이 다시 띄우게 한다.
startWatchdog(liveness, (stalled) => {
  logger.fatal({ stalled }, "메인 루프가 멈췄다. 프로세스를 종료한다");
  process.exit(1);
});

await runPoller(
  {
    config,
    adapters,
    transport,
    clock,
    sink,
    version: pkg.version,
    liveness,
    log,
  },
  controller.signal,
);
healthzServer.close();
