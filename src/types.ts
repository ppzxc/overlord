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
  /** 이 요청에만 더하는 헤더. Referer·Origin처럼 예약처가 브라우저 요청인지 보는 값에 쓴다. */
  headers?: Record<string, string>;
}

/** 예약처 하나가 쓰는 HTTP 클라이언트. 예약처가 쿠키 세션을 쓰면 받은 쿠키를 같은 클라이언트의 다음 요청에 싣는다. */
export interface HttpClient {
  get(url: string, opts?: RequestOptions): Promise<TransportResponse>;
  /** form이 문자열이면 그대로 본문으로 보낸다. */
  post(url: string, form: Record<string, string> | string, opts?: RequestOptions): Promise<TransportResponse>;
  /** 호스트 쿠키 하나를 직접 넣는다(경로 `/`). 같은 이름은 덮고, 쿠키 세션 설정과 무관하게 다음 요청부터 싣는다. */
  setCookie(host: string, name: string, value: string): void;
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

/** 예약처가 새 날짜를 여는 시각 앞뒤로 바퀴를 돌지 않는 구간. 한국 시각 HH:MM, from 포함 to 제외. */
export interface OpeningRush {
  from: string;
  to: string;
}

/** 예약처 안의 캠핑장·휴양림 한 곳. */
export interface FacilityInfo {
  /** 사람이 읽는 slug. 설정의 `facility`가 쓴다. 예: goraebul, mangsang */
  code: string;
  name: string;
  /** 예약처가 시설을 가리키는 값. 예약처마다 모양이 달라 문자열 하나 또는 작은 레코드다. 없으면 비운다. */
  ref?: string | Record<string, string>;
  zones: ZoneInfo[];
}

export interface ProviderInfo {
  id: string;
  /** 예약처 안의 시설. 하나 이상이다. */
  facilities: FacilityInfo[];
  maxNights: number;
  openingRule: OpeningRule;
  /** 오픈 경쟁 시간의 기본값. 설정의 `providers.<id>.openingRush`가 덮어쓴다. 없으면 쉬지 않는다. */
  openingRush?: OpeningRush;
  /** 기본 폴링 간격(초). 설정의 `providers.<id>.pollIntervalSeconds`가 덮어쓴다. 선언하지 않으면 150초. */
  defaultPollIntervalSeconds?: number;
  /** 어떤 경우에도 호출하지 않는 경로 접두어. 예: robots.txt가 막은 /bbs/ */
  blockedPaths: string[];
  /** 받은 쿠키를 들고 다음 요청에 싣는다. 세션이 필요한 예약처만 켠다. */
  cookieSession: boolean;
}

export interface AvailabilityQuery {
  /** 시설 코드. 어댑터가 카탈로그에서 ref를 찾는 데 쓴다. */
  facility: string;
  zone: string;
  checkIn: string; // YYYY-MM-DD
  nights: number;
  /** 이 조회 단위를 쓰는 감시 조건들이 `seats:`로 고른 자리 필터(토큰) 합집합. 어댑터가 관심 자리가 응답에서 사라졌는지 알아보는 데만 쓴다. 필터가 없으면 생략한다. */
  seats?: string[];
}

export interface AvailableSite {
  /** 설정의 자리 필터가 쓰는 표기. 예: A02 */
  id: string;
  /** 예약처가 쓰는 자리 이름. 예: 텐트사이트 A02호 */
  name: string;
  /** 구역 단위로만 잔여를 아는 예약처가 주는 남은 수. N박이면 밤마다의 최솟값이다. */
  remaining?: number;
}

/** 예약처 응답에서 실제로 본 구역 이름과, 어댑터가 모르는 값을 준 구역. */
export interface ZoneObservation {
  zones: string[];
  unknown: { zone: string; value: string }[];
}

/** 예약처 응답 하나로 본 시설의 구역과 자리. 구역마다 응답이 따로 필요 없는 예약처용이다. */
export interface FacilityObservation {
  zones: {
    name: string;
    /** 응답이 그 구역의 칸에 실은 구역 코드. 칸이 모두 닫혀 있으면 비어 있다. */
    codes: string[];
    seats: string[];
  }[];
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
  /**
   * 자리 목록 대신 구역 이름 집합만 알 수 있는 예약처가 구현한다. catalog --live가 고정 구역과 비교한다.
   * 모르는 값은 실패가 아니라 관찰 결과에 담는다.
   */
  listZones?(q: AvailabilityQuery, ctx: AdapterContext): Promise<ZoneObservation>;
  /**
   * 시설 하나의 모든 구역·자리를 한 번의 조회로 돌려준다. catalog --live가 구역 코드와 자리를 고정 목록과 비교한다.
   * 구현하면 구역마다 listSeats를 부르지 않는다.
   */
  observeFacility?(facility: string, ctx: AdapterContext): Promise<FacilityObservation>;
}
