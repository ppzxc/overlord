import { parse } from "yaml";
import { z } from "zod";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 형식이어야 한다");

const configSchema = z.strictObject({
  userAgentSuffix: z.string().default(""),
  providers: z
    .record(z.string(), z.strictObject({ pollIntervalSeconds: z.number().default(150) }))
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

export function loadConfig(yamlText: string, env: Record<string, string | undefined>): Config {
  return configSchema.parse(parse(substituteEnv(yamlText, env)));
}
