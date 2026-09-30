import type { AdapterError } from "./types.js";

export type FailureKind = AdapterError["kind"] | "error";
export interface Failure {
  kind: FailureKind;
  message: string;
}

/** 예약처별 상태. stopped는 프로세스를 다시 시작해야 풀린다. */
export type HealthStatus = "ok" | "degraded" | "unavailable" | "stopped";

export type NoticeStatus = "blocked" | "unrecognized" | "unavailable" | "degraded" | "recovered";

export interface HealthNotice {
  status: NoticeStatus;
  detail: string;
  /** 같은 상태가 이어져서 다시 알리는 것인가 */
  reminder: boolean;
}

const MINUTE_MS = 60_000;
/** transient 백오프와 점검 중 확인 간격의 상한. */
const MAX_BACKOFF_MS = 30 * MINUTE_MS;
const UNAVAILABLE_INTERVAL_MS = 30 * MINUTE_MS;
const DEGRADED_ROUNDS = 5;
const DEGRADED_AFTER_MS = 15 * MINUTE_MS;
const UNRECOGNIZED_ROUNDS = 2;
export const REMINDER_MS = 24 * 60 * MINUTE_MS;

/** 한 바퀴의 실패 중 가장 무거운 것. 차단 > 점검 > 구조 변경 > 일시 오류 순이다. */
const SEVERITY: FailureKind[] = ["blocked", "unavailable", "unrecognized", "transient", "error"];
export function worstFailure(failures: Failure[]): Failure | undefined {
  return [...failures].sort((a, b) => SEVERITY.indexOf(a.kind) - SEVERITY.indexOf(b.kind))[0];
}

/** 예약처 하나의 헬스 상태 머신. 바퀴 결과를 먹이면 다음 간격과 보낼 알림을 알려 준다. */
export class ProviderHealth {
  status: HealthStatus = "ok";
  /** 지금 상태가 시작된 시각(ms). 상태가 한 번도 바뀌지 않았으면 undefined. */
  statusSince: number | undefined;
  private stopKind: "blocked" | "unrecognized" = "blocked";
  private transientStreak = 0;
  private transientSince = 0;
  private unrecognizedStreak = 0;
  private lastKind: FailureKind | undefined;
  private detail = "";
  /** 사용자에게 마지막으로 알린 상태와 시각. 전송이 성공했을 때만 갱신한다. */
  private announced: HealthStatus = "ok";
  private announcedAt = 0;

  get stopped(): boolean {
    return this.status === "stopped";
  }

  /** 바퀴 하나의 결과를 반영한다. failure가 없으면 성공이다. */
  record(failure: Failure | undefined, nowMs: number): void {
    const before = this.status;
    this.apply(failure, nowMs);
    if (this.status !== before) this.statusSince = nowMs;
  }

  private apply(failure: Failure | undefined, nowMs: number): void {
    this.lastKind = failure?.kind;
    if (!failure) {
      this.transientStreak = 0;
      this.unrecognizedStreak = 0;
      this.status = "ok";
      return;
    }
    this.detail = failure.message;
    if (failure.kind === "blocked") return this.stop("blocked");
    if (failure.kind === "unrecognized") {
      this.transientStreak = 0;
      if (++this.unrecognizedStreak >= UNRECOGNIZED_ROUNDS) this.stop("unrecognized");
      else this.status = "ok"; // 첫 바퀴는 아직 장애로 치지 않는다.
      return;
    }
    this.unrecognizedStreak = 0;
    if (failure.kind === "unavailable") {
      this.transientStreak = 0;
      this.status = "unavailable";
      return;
    }
    if (this.transientStreak++ === 0) this.transientSince = nowMs;
    const degraded = this.transientStreak >= DEGRADED_ROUNDS && nowMs - this.transientSince >= DEGRADED_AFTER_MS;
    this.status = degraded ? "degraded" : "ok"; // 점검이 끝나고 일시 오류로 바뀐 경우도 여기서 풀린다.
  }

  private stop(kind: "blocked" | "unrecognized"): void {
    this.status = "stopped";
    this.stopKind = kind;
  }

  /** 멈춘 예약처가 다음에 깨어날 때까지의 시간. 첫 알림이 아직 안 갔으면 기본 간격으로 다시 시도한다. */
  stoppedWaitMs(baseMs: number, nowMs: number): number {
    const first = this.pendingNotice(nowMs);
    return first && !first.reminder ? baseMs : REMINDER_MS;
  }

  /** 다음 바퀴까지 기다릴 기준 시간(지터 전). */
  nextIntervalMs(baseMs: number): number {
    if (this.lastKind === "unavailable") return Math.max(baseMs, UNAVAILABLE_INTERVAL_MS);
    if (this.transientStreak > 0) return Math.min(baseMs * 2 ** this.transientStreak, Math.max(baseMs, MAX_BACKOFF_MS));
    return baseMs;
  }

  /** 지금 보내야 할 알림. 상태가 바뀌었거나 같은 장애가 24시간 이어졌을 때만 있다. */
  pendingNotice(nowMs: number): HealthNotice | undefined {
    const { status } = this;
    if (status === "ok") {
      if (this.announced === "ok") return undefined;
      return { status: "recovered", detail: "", reminder: false };
    }
    const noticeStatus = status === "stopped" ? this.stopKind : status;
    if (this.announced !== status) return { status: noticeStatus, detail: this.detail, reminder: false };
    if (nowMs - this.announcedAt >= REMINDER_MS) return { status: noticeStatus, detail: this.detail, reminder: true };
    return undefined;
  }

  /** notice를 사용자에게 보냈다고 기록한다. */
  markAnnounced(nowMs: number): void {
    this.announced = this.status;
    this.announcedAt = nowMs;
  }
}
