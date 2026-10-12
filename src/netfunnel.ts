import { AdapterError, type AdapterContext, type HttpClient } from "./types.js";

/**
 * NetFunnel 대기열 공용 모듈(ADR 0001). 예약처가 고르는 것은 대기열 서버 주소, `sid`, `aid`, 여러 단계 액션 흐름,
 * 5004를 보낼지, 키를 어떻게 싣는지다. 대기열 서버 요청은 HTTP 간격 큐 밖(`unpaced`)에서 페이지 간격대로 나간다.
 */

/** 예약처가 고르는 대기열 서버와 서비스·액션. */
export interface NetFunnelQueue {
  /** 대기열 서버 요청 주소. 예: `https://nf.campingkorea.or.kr/ts.wseq` */
  tsUrl: string;
  sid: string;
  aid: string;
}

/** 대기열을 통과해 받은 키와 기다린 시간(ms). */
export interface QueuePass {
  key: string;
  waitedMs: number;
}

/** `enterQueue`가 돌려주는 값. 대기열 서버가 준 결과 문자열(`5002:200:key=…&nwait=0…`)을 함께 든다. 페이지는 이 문자열 전체를 `NetFunnel_ID` 쿠키에 싣는다. */
export interface EnteredPass extends QueuePass {
  result: string;
}

/** 5002 재확인을 서버가 준 간격대로 반복하되, 이만큼 넘게 기다리면 그 바퀴를 포기한다. */
const MAX_WAIT_MS = 120_000;

/** `NetFunnel.gControl.result='5002:200:key=…&nwait=0&ttl=0…'`에서 코드와 필드를 읽는다. */
function parseNf(body: string): { code: number; fields: URLSearchParams; result: string } {
  const m = /NetFunnel\.gControl\.result='(\d+):(\d+):([^']*)'/.exec(body);
  if (!m) throw new AdapterError("transient", "대기열 응답을 읽지 못했다");
  return { code: Number(m[2]), fields: new URLSearchParams(m[3]), result: `${m[1]}:${m[2]}:${m[3]}` };
}

// 5101은 기록으로 확인했다. 5002의 URL 형태는 기록에 없어 표준 NetFunnel 형식을 따른 것이며 미검증이다.
const nfUrl = (q: NetFunnelQueue, opcode: number, now: number, key?: string) =>
  `${q.tsUrl}?opcode=${opcode}&nfid=0&prefix=NetFunnel.gRtype=${opcode};&sid=${q.sid}&aid=${q.aid}&js=yes${key ? `&key=${encodeURIComponent(key)}` : ""}&${now}`;

/**
 * 대기열에 참여해 키와 기다린 시간(ms)을 받는다. 301/302는 곧바로 `blocked`이고 가상 대기에 참여하지 않는다.
 * 연결 실패·키 미수신·상한 초과는 `transient`다.
 */
export async function enterQueue(ctx: AdapterContext, queue: NetFunnelQueue): Promise<EnteredPass> {
  const started = ctx.clock.now().getTime();
  let opcode = 5101;
  let key: string | undefined;
  for (;;) {
    let body: string;
    try {
      const res = await ctx.http.get(nfUrl(queue, opcode, ctx.clock.now().getTime(), key), { unpaced: true });
      if (res.status !== 200) throw new AdapterError("transient", `대기열 HTTP ${res.status}`);
      body = res.body;
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      throw new AdapterError("transient", `대기열 서버에 연결하지 못했다: ${(e as Error).message}`);
    }
    const { code, fields, result } = parseNf(body);
    if (code === 301 || code === 302) throw new AdapterError("blocked", `대기열이 차단 신호(${code})를 줬다`);
    key = fields.get("key") ?? key;
    if (code === 200) {
      if (!key) throw new AdapterError("transient", "대기열이 키를 주지 않았다");
      return { key, waitedMs: ctx.clock.now().getTime() - started, result };
    }
    if (code !== 201 || !key) throw new AdapterError("transient", `대기열이 예상 밖 코드(${code})를 줬다`);
    const waited = ctx.clock.now().getTime() - started;
    const ttlMs = Math.max(1, Number(fields.get("ttl")) || 1) * 1000;
    if (waited + ttlMs > MAX_WAIT_MS) throw new AdapterError("transient", "대기가 상한(120초)을 넘었다");
    opcode = 5002;
    await ctx.clock.sleep(ttlMs, ctx.signal);
  }
}

/** 페이지처럼 setComplete(5004)를 보낸다. 응답과 실패는 조회에 영향을 주지 않는다. */
export async function completeQueue(ctx: AdapterContext, queue: NetFunnelQueue, key: string, ignoreAbort = false): Promise<void> {
  try {
    await ctx.http.get(nfUrl(queue, 5004, ctx.clock.now().getTime(), key), { unpaced: true, ignoreAbort });
  } catch {
    // 마무리 알림이라 실패해도 조회는 계속한다.
  }
}

/** JS `escape()`. 영숫자와 `@*_+-./`만 그대로 두고, 나머지는 `%XX`, 255를 넘는 문자는 `%uXXXX`로 쓴다. */
export function jsEscape(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const n = s.charCodeAt(i);
    if (/[A-Za-z0-9@*_+\-./]/.test(c)) out += c;
    else out += n < 256 ? `%${n.toString(16).toUpperCase().padStart(2, "0")}` : `%u${n.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

/** 키를 `NetFunnel_ID` 쿠키로 싣는 예약처용. 5101 결과 문자열을 페이지 JS처럼 `escape()`해 경로 `/`로 심는다. */
export function setNetFunnelCookie(http: HttpClient, host: string, result: string): void {
  http.setCookie(host, "NetFunnel_ID", jsEscape(result));
}

/** 세션(HttpClient)이 들고 있는 대기열 키와 예약처가 진입 때 얻은 값. */
export interface KeyLease<T> {
  key: string;
  issuedAt: number;
  enteredAt: number;
  completed: boolean;
  /** 이 키를 받으려고 대기열에서 기다린 시간(ms). */
  waitedMs: number;
  /** `enter`가 돌려준 값. */
  extra: T;
}

export interface KeyHooks<T> {
  /** 예약처가 정한 키 수명. 이 안에서만 같은 세션이 키를 다시 쓴다. */
  ttlMs: number;
  /** 주면 진입 뒤 이 시간이 지난 첫 사용에서 5004를 한 번 보낸다. 안 주면 타이머로는 보내지 않는다. */
  completeAfterMs?: number;
  /** 서버가 키를 아직 받아 주는지 묻는다. */
  confirm(key: string): Promise<boolean>;
  /** 새 키로 예약처에 들어간다(키 등록·예약 화면 진입 등). 돌려준 값이 `lease.extra`가 된다. */
  enter(pass: QueuePass): Promise<T>;
}

/** 세션 사이로 옮기지 않으려고 HttpClient에 묶는다. */
const leases = new WeakMap<HttpClient, KeyLease<unknown>>();

async function enterNew<T>(ctx: AdapterContext, queue: NetFunnelQueue, hooks: KeyHooks<T>): Promise<KeyLease<T>> {
  const pass = await enterQueue(ctx, queue);
  const issuedAt = ctx.clock.now().getTime();
  const extra = await hooks.enter(pass);
  const lease: KeyLease<T> = { key: pass.key, issuedAt, enteredAt: ctx.clock.now().getTime(), completed: false, waitedMs: pass.waitedMs, extra };
  leases.set(ctx.http, lease);
  return lease;
}

/**
 * 이 세션이 쓸 키를 정한다. 수명 안의 키는 서버 확인을 거쳐 다시 쓰고, 아니면 새로 진입한다.
 * 다시 쓰려던 키가 거절되면 실패가 아니라 새 진입이다. 새 키까지 곧바로 거절되면 구조 변경이다.
 */
export async function acquireKey<T>(
  ctx: AdapterContext,
  queue: NetFunnelQueue,
  hooks: KeyHooks<T>,
): Promise<{ lease: KeyLease<T>; pass: QueuePass }> {
  let lease = leases.get(ctx.http) as KeyLease<T> | undefined;
  const now = ctx.clock.now().getTime();
  if (lease && hooks.completeAfterMs !== undefined && !lease.completed && now - lease.enteredAt >= hooks.completeAfterMs) {
    lease.completed = true;
    await completeQueue(ctx, queue, lease.key);
  }
  if (lease && now - lease.issuedAt >= hooks.ttlMs) lease = undefined;
  let rejected = false;
  if (lease) {
    if (await hooks.confirm(lease.key)) return { lease, pass: { key: lease.key, waitedMs: 0 } };
    rejected = true;
  }
  leases.delete(ctx.http);
  const fresh = await enterNew(ctx, queue, hooks);
  if (rejected && !(await hooks.confirm(fresh.key))) {
    leases.delete(ctx.http);
    throw new AdapterError("unrecognized", "새로 받은 키를 서버가 곧바로 거절했다(NOT Available)");
  }
  return { lease: fresh, pass: { key: fresh.key, waitedMs: fresh.waitedMs } };
}

/** 들고 있던 키를 버린다. 예약처가 키를 거절했을 때 쓴다. */
export function forgetKey(ctx: AdapterContext): void {
  leases.delete(ctx.http);
}

/** 닫을 때 아직 5004를 보내지 않았으면 보낸다. 종료 중에도 나간다. */
export async function releaseKey(ctx: AdapterContext, queue: NetFunnelQueue): Promise<void> {
  const lease = leases.get(ctx.http);
  if (lease && !lease.completed) {
    lease.completed = true;
    await completeQueue(ctx, queue, lease.key, true);
  }
}
