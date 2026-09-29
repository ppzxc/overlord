import { parse } from "yaml";
import { z } from "zod";
import type { ProviderAdapter } from "./types.js";
import { adapters as knownAdapters } from "./adapters/index.js";
import { isValidSeatToken, seatsMatching } from "./seats.js";
import { WEEKDAY_KEYS } from "./schedule.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 형식이어야 한다");

const configSchema = z.strictObject({
  userAgentSuffix: z.string().default(""),
  providers: z
    .record(z.string(), z.strictObject({ pollIntervalSeconds: z.number().min(60, "60초 이상이어야 한다").default(150) }))
    .default({}),
  notifiers: z.record(
    z.string(),
    z.strictObject({
      type: z.literal("telegram"),
      botToken: z.string().min(1),
      chatId: z.union([z.string().min(1), z.number()]).transform(String),
    }),
  ),
  watches: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        provider: z.string(),
        zones: z.array(z.string()).min(1),
        seats: z
          .array(z.string().refine(isValidSeatToken, "자리 번호(A02) 또는 범위(A10-A15) 형식이어야 한다"))
          .min(1)
          .optional(),
        weekdays: z.array(z.enum(WEEKDAY_KEYS)).min(1).optional(),
        checkIn: z.strictObject({ from: date, to: date }),
        nights: z.number().int().min(1).default(1),
        notify: z.array(z.string()).default(["default"]),
      }),
    )
    .min(1),
});

export type Config = z.infer<typeof configSchema>;

export function substituteEnv(text: string, env: Record<string, string | undefined>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const value = env[name];
    if (!value) throw new Error(`환경 변수 ${name}이(가) 비어 있다`);
    return value;
  });
}

/** 설정이 틀렸을 때 던진다. 메시지에 위치와 쓸 수 있는 값이 들어 있다. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`설정이 올바르지 않다:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const where = (path: PropertyKey[]) => path.map(String).join(".") || "(최상위)";

/** 예약처가 아는 값(구역, 최대 박수, 자리)과 맞는지 본다. */
function checkAgainstProviders(config: Config, adapters: Record<string, ProviderAdapter>): string[] {
  const problems: string[] = [];
  for (const id of Object.keys(config.providers)) {
    if (!adapters[id]) problems.push(`providers.${id}: 알 수 없는 예약처다. 쓸 수 있는 값: ${Object.keys(adapters).join(", ")}`);
  }
  config.watches.forEach((w, i) => {
    const at = `watches.${i}(${w.name})`;
    const adapter = adapters[w.provider];
    if (!adapter) {
      problems.push(`${at}.provider: 알 수 없는 예약처 "${w.provider}"다. 쓸 수 있는 값: ${Object.keys(adapters).join(", ")}`);
      return;
    }
    const info = adapter.describe();
    if (w.nights > info.maxNights) {
      problems.push(`${at}.nights: ${w.provider}는 최대 ${info.maxNights}박까지 예약할 수 있다(설정값 ${w.nights})`);
    }
    const codes = info.zones.map((z) => z.code);
    const known = w.zones.filter((z) => codes.includes(z));
    for (const z of w.zones) {
      if (!codes.includes(z)) problems.push(`${at}.zones: 없는 구역 "${z}"다. 쓸 수 있는 값: ${codes.join(", ")}`);
    }
    // 고정된 자리 목록이 없는 구역이 하나라도 있으면 자리 번호를 확인할 수 없다.
    const zoneInfos = info.zones.filter((z) => known.includes(z.code));
    if (w.seats && known.length === w.zones.length && zoneInfos.every((z) => z.seats)) {
      const all = zoneInfos.flatMap((z) => z.seats!);
      for (const token of w.seats) {
        if (seatsMatching(token, all).length === 0) {
          problems.push(`${at}.seats: "${token}"에 맞는 자리가 없다. 쓸 수 있는 값: ${all.join(", ")}`);
        }
      }
    }
  });
  return problems;
}

export function loadConfig(
  yamlText: string,
  env: Record<string, string | undefined>,
  adapters: Record<string, ProviderAdapter> = knownAdapters,
): Config {
  let raw: unknown;
  try {
    raw = parse(substituteEnv(yamlText, env));
  } catch (e) {
    throw new ConfigError([(e as Error).message]);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${where(i.path)}: ${i.message}`));
  }
  const problems = checkAgainstProviders(parsed.data, adapters);
  if (problems.length > 0) throw new ConfigError(problems);
  return parsed.data;
}
