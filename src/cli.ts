export type Command =
  | { kind: "catalog"; provider: string | undefined; facility?: string; live: boolean; configPath?: string; zones?: string[]; seats?: string[] }
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
    // 값을 받는 옵션. 값은 위치 인자로 세지 않는다.
    const valueOf = (name: string): string | undefined => rest[rest.indexOf(name) + 1];
    const optionIndexes = new Set(["--config", "--zones", "--seats"].flatMap((n) => (rest.includes(n) ? [rest.indexOf(n), rest.indexOf(n) + 1] : [])));
    const configPath = rest.includes("--config") ? valueOf("--config") : undefined;
    // 숲나들e `--live`의 예상 호출 수를 줄여 볼 구역(유형 코드)과 자리(상품 이름). 쉼표로 나눈다.
    const list = (name: string) => (rest.includes(name) ? valueOf(name)?.split(",").filter((v) => v !== "") : undefined);
    const zones = list("--zones");
    const seats = list("--seats");
    const [provider, facility] = rest.filter((a, i) => !a.startsWith("--") && !optionIndexes.has(i));
    return {
      kind: "catalog",
      provider,
      ...(facility ? { facility } : {}),
      live: rest.includes("--live"),
      ...(configPath ? { configPath } : {}),
      ...(zones?.length ? { zones } : {}),
      ...(seats?.length ? { seats } : {}),
    };
  }
  if (first === "telegram") return { kind: "telegram", sub: rest[0] === "chats" ? "chats" : undefined };
  if (first === "healthcheck") return { kind: "healthcheck", configPath: rest[0] ?? "config.yaml" };
  return { kind: "run", configPath: first ?? "config.yaml" };
}
