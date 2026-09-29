export type Command =
  | { kind: "catalog"; provider: string | undefined; live: boolean }
  | { kind: "telegram"; sub: "chats" | undefined }
  | { kind: "healthcheck"; configPath: string }
  | { kind: "run"; configPath: string };

/**
 * 첫 인자가 "catalog", "telegram", "healthcheck"이면 하위 명령이고, 아니면 설정 파일 경로다.
 * 설정 파일 이름이 catalog라면 ./catalog처럼 경로로 쓴다.
 */
export function parseArgs(argv: string[]): Command {
  const [first, ...rest] = argv;
  if (first === "catalog") {
    return { kind: "catalog", provider: rest.find((a) => !a.startsWith("--")), live: rest.includes("--live") };
  }
  if (first === "telegram") return { kind: "telegram", sub: rest[0] === "chats" ? "chats" : undefined };
  if (first === "healthcheck") return { kind: "healthcheck", configPath: rest[0] ?? "config.yaml" };
  return { kind: "run", configPath: first ?? "config.yaml" };
}
