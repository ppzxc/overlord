import { createServer, type Server } from "node:http";

/** 바퀴 하나가 (조회와 요청 간격을 포함해) 끝나기를 기다려 주는 여유. */
export const LIVENESS_GRACE_MS = 15 * 60_000;

/**
 * 예약처 루프가 살아 있는지 본다. 루프는 쉬기 전에 "이만큼 뒤에는 다시 온다"고 알리고,
 * 그 시각(+여유)을 넘기면 멈춘 것으로 본다. 의도적으로 멈춘 예약처도 24시간 리마인드 주기로 알리므로 멈춘 것이 아니다.
 */
export class Liveness {
  private deadlines = new Map<string, number>();

  constructor(
    private now: () => number,
    private graceMs = LIVENESS_GRACE_MS,
  ) {}

  /** 예약처 루프가 지금 움직였고, 늦어도 expectedMs 뒤에 다시 움직인다고 알린다. */
  beat(providerId: string, expectedMs: number): void {
    this.deadlines.set(providerId, this.now() + expectedMs + this.graceMs);
  }

  /** 멈춘 예약처 이름들. 비어 있으면 살아 있다. */
  stalled(): string[] {
    const now = this.now();
    return [...this.deadlines].filter(([, deadline]) => now > deadline).map(([id]) => id);
  }
}

/** 메인 루프가 살아 있는지만 답한다. 예약처가 stopped여도 200이다. */
export function startHealthz(bind: string, liveness: Liveness): Promise<Server> {
  const at = bind.lastIndexOf(":");
  const host = bind.slice(0, at);
  const port = Number(bind.slice(at + 1));
  const server = createServer((req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404).end();
      return;
    }
    const stalled = liveness.stalled();
    res.writeHead(stalled.length === 0 ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: stalled.length === 0, stalled }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

/** 루프가 멈춘 채 있으면 onStall을 부른다. 반환값을 호출하면 감시를 끝낸다. */
export function startWatchdog(liveness: Liveness, onStall: (stalled: string[]) => void, everyMs = 60_000): () => void {
  const timer = setInterval(() => {
    const stalled = liveness.stalled();
    if (stalled.length > 0) onStall(stalled);
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
