export interface TransportRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  /** POST 본문. form 인코딩된 문자열이다. */
  body?: string;
  timeoutMs: number;
  /** manual이면 리다이렉트를 따라가지 않고 3xx 응답을 그대로 돌려준다. 없으면 따라간다. */
  redirect?: "manual";
}

export interface TransportResponse {
  status: number;
  body: string;
  /** Set-Cookie 헤더 값들. 한 줄에 쿠키 하나다. */
  setCookie?: string[];
  /** 3xx 응답의 Location 헤더. */
  location?: string;
}

/** 실제 네트워크 호출 경계. 테스트에서 바꿔 끼운다. */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface Clock {
  now(): Date;
  /** ms만큼 쉰다. signal이 abort되면 즉시 끝난다. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface RequestOptions {
  /** 요청 간격 큐를 거치지 않고 바로 보낸다. 간격 계산에도 끼지 않는다. 대기열 서버 요청용이다. */
  unpaced?: boolean;
  /** POST 본문의 Content-Type. 없으면 form 인코딩이다. 본문을 문자열로 줄 때 쓴다. */
  contentType?: string;
  /** 중단 신호가 서 있어도 보낸다. 종료 때 대기열에 마무리를 알리는 요청용이다. */
  ignoreAbort?: boolean;
}

/** 예약처 하나가 쓰는 HTTP 클라이언트. 예약처가 쿠키 세션을 쓰면 받은 쿠키를 같은 클라이언트의 다음 요청에 싣는다. */
export interface HttpClient {
  get(url: string, opts?: RequestOptions): Promise<TransportResponse>;
  /** form이 문자열이면 그대로 본문으로 보낸다. */
  post(url: string, form: Record<string, string> | string, opts?: RequestOptions): Promise<TransportResponse>;
  /** 들고 있던 쿠키를 모두 버린다. */
  clearSession(): void;
}

export interface AdapterContext {
  http: HttpClient;
  /** 대기 시간을 재고 쉬는 데 쓴다. */
  clock: Clock;
  /** 종료 중이면 쉬는 것을 바로 끝낸다. */
  signal?: AbortSignal;
  /** 경고처럼 알림까진 필요 없는 관찰을 남긴다. */
  log?: (msg: string, fields?: Record<string, unknown>) => void;
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
  /** 어떤 경우에도 호출하지 않는 경로 접두어. 예: robots.txt가 막은 /bbs/ */
  blockedPaths: string[];
  /** 받은 쿠키를 들고 다음 요청에 싣는다. 세션이 필요한 예약처만 켠다. */
  cookieSession: boolean;
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
  /** 구역 단위로만 잔여를 아는 예약처가 주는 남은 수. N박이면 밤마다의 최솟값이다. */
  remaining?: number;
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
  /** 예약처 루프가 끝날 때(프로세스 종료) 한 번 부른다. 들고 있던 세션을 마무리한다. 실패는 무시된다. */
  close?(ctx: AdapterContext): Promise<void>;
  /**
   * 예약 여부와 관계없이 구역의 모든 자리 id를 읽는다. catalog --live가 고정 목록과 비교한다.
   * 자리 단위로 보지 않는 예약처는 구현하지 않는다.
   */
  listSeats?(q: AvailabilityQuery, ctx: AdapterContext): Promise<string[]>;
}
