import { readFileSync } from "node:fs";
import { adapters } from "./adapters/index.js";
import { renderCatalog } from "./catalog.js";
import { renderLiveDiff } from "./catalog-live.js";
import { parseArgs } from "./cli.js";
import { ConfigError, loadConfig } from "./config.js";
import { runPoller } from "./poller.js";
import type { TelegramSink } from "./telegram.js";
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

const sink: TelegramSink = {
  async sendMessage(botToken, { chatId, ...rest }) {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...rest }),
    });
    if (!res.ok) throw new Error(`Telegram sendMessage 실패: HTTP ${res.status}`);
  },
};

const command = parseArgs(process.argv.slice(2));

if (command.kind === "catalog") {
  const adapter = adapters[command.provider ?? ""];
  if (!adapter) {
    console.error(`사용법: catalog <예약처> [--live]. 쓸 수 있는 예약처: ${Object.keys(adapters).join(", ")}`);
    process.exit(1);
  }
  process.stdout.write(renderCatalog(adapter));
  if (command.live) {
    process.stdout.write("\n실제 예약처와 비교:\n");
    try {
      process.stdout.write(
        await renderLiveDiff(adapter, {
          transport,
          version: pkg.version,
          now: new Date(),
          pause: () => clock.sleep(3000),
        }),
      );
    } catch (e) {
      console.error(`예약처 조회에 실패했다: ${(e as Error).message}`);
      process.exit(1);
    }
  }
  process.exit(0);
}

const configPath = command.configPath;
let config;
try {
  config = loadConfig(readFileSync(configPath, "utf8"), process.env);
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
