import { parse } from "yaml";
import { z } from "zod";
import type { ProviderAdapter } from "./types.js";
import { checkAgainstProviders } from "./provider-check.js";
import { adapters as knownAdapters } from "./adapters/index.js";
import { isValidSeatToken } from "./seats.js";
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
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string, offset: number) => {
    const value = env[name];
    if (!value) {
      const line = text.slice(0, offset).split("\n").length;
      throw new Error(`${line}번째 줄: 환경 변수 ${name}이(가) 비어 있다`);
    }
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
