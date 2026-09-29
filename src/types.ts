export interface TransportRequest {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface TransportResponse {
  status: number;
  body: string;
}

/** 실제 네트워크 호출 경계. 테스트에서 바꿔 끼운다. */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface Clock {
  now(): Date;
  /** ms만큼 쉰다. signal이 abort되면 즉시 끝난다. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface HttpClient {
  get(url: string): Promise<TransportResponse>;
}

export interface AdapterContext {
  http: HttpClient;
}

export interface ZoneInfo {
  code: string;
  name: string;
}

export interface ProviderInfo {
  id: string;
  facility: string;
  zones: ZoneInfo[];
  maxNights: number;
}

export interface AvailabilityQuery {
  zone: string;
  checkIn: string; // YYYY-MM-DD
  nights: number;
}

export interface AvailableSite {
  /** 예약처가 쓰는 자리 이름. 예: 텐트사이트 A02호 */
  name: string;
}

export class AdapterError extends Error {
  constructor(
    readonly kind: "transient" | "blocked" | "unrecognized" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export interface ProviderAdapter {
  readonly id: string;
  describe(): ProviderInfo;
  queryAvailability(q: AvailabilityQuery, ctx: AdapterContext): Promise<AvailableSite[]>;
  deepLink(q: AvailabilityQuery): string;
}
