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
  /** 구역 유형. 예: 카라반, 숲속야영장 */
  type: string;
  /** 정원(명). 예약처에서 확인하지 못한 구역은 없다. */
  capacity?: number;
  /** 구역 안의 모든 자리 id. 어댑터에 고정된 목록이며, 확인하지 못한 구역은 없다. */
  seats?: string[];
}

/** 입실일 D는 D−openDaysBefore일 openTime에 열리고, 당일 입실은 sameDayCutoff에 마감된다. 한국 시각. */
export interface OpeningRule {
  openDaysBefore: number;
  openTime: string; // HH:MM
  sameDayCutoff: string; // HH:MM
}

export interface ProviderInfo {
  id: string;
  facility: string;
  zones: ZoneInfo[];
  maxNights: number;
  openingRule: OpeningRule;
}

export interface AvailabilityQuery {
  zone: string;
  checkIn: string; // YYYY-MM-DD
  nights: number;
}

export interface AvailableSite {
  /** 설정의 자리 필터가 쓰는 표기. 예: A02 */
  id: string;
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
  /**
   * 조회 단위 여러 개를 한 번에 묻는다. 예약처의 요약 화면으로 먼저 거를 수 있는 어댑터만 구현한다.
   * 없으면 코어가 조회 단위마다 queryAvailability를 따로 호출한다.
   * 결과 키는 넘겨받은 조회 단위 객체다. 단위 하나만 실패하면 그 값에 AdapterError를 담고, 차단처럼 전체가 실패하면 던진다.
   */
  queryAvailabilityBatch?(
    units: AvailabilityQuery[],
    ctx: AdapterContext,
  ): Promise<Map<AvailabilityQuery, AvailableSite[] | AdapterError>>;
  deepLink(q: AvailabilityQuery): string;
  /** 예약 여부와 관계없이 구역의 모든 자리 id를 읽는다. catalog --live가 고정 목록과 비교한다. */
  listSeats(q: AvailabilityQuery, ctx: AdapterContext): Promise<string[]>;
}
