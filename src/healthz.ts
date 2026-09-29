import { createServer, type Server } from "node:http";
import type { Liveness } from "./liveness.js";

export interface HealthzBind {
  host: string;
  port: number;
}

/** 정체(Stall)가 없으면 200, 있으면 503. 예약처가 stopped여도 200이다. */
export function startHealthz({ host, port }: HealthzBind, liveness: Liveness): Promise<Server> {
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


/** 컨테이너 HEALTHCHECK용. 설정한 바인드 주소의 /healthz를 찌르고 종료 코드를 돌려준다. */
export async function checkHealthz({ host, port }: HealthzBind): Promise<number> {
  try {
    const res = await fetch(`http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/healthz`, {
      signal: AbortSignal.timeout(4_000),
    });
    return res.ok ? 0 : 1;
  } catch {
    return 1;
  }
}
