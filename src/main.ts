import { readFileSync } from "node:fs";
import { goraebulAdapter } from "./adapters/goraebul.js";
import { loadConfig } from "./config.js";
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

const configPath = process.argv[2] ?? "config.yaml";
const config = loadConfig(readFileSync(configPath, "utf8"), process.env);
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

await runPoller(
  {
    config,
    adapters: { goraebul: goraebulAdapter },
    transport,
    clock,
    sink,
    version: pkg.version,
    log: (msg, fields) => console.log(JSON.stringify({ msg, ...fields })),
  },
  controller.signal,
);
