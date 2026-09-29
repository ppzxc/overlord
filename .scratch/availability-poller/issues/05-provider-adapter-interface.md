# 예약처 어댑터 인터페이스

Type: grilling
Label: wayfinder:grilling
Status: resolved
Assignee: claude (session 2026-09-29b)
Blocked by: 01, 03

## Question

예약처마다 달라지는 부분을 가리는 공통 어댑터 인터페이스는 어떤 모양인가?

- 입력과 출력: 감시 조건 → 빈자리 목록? 아니면 "날짜 범위 × 구역의 가용 현황"을 돌려주고 매칭은 코어가 맡는가?
- 예약처가 스스로 밝히는 속성: 구역 목록, 최대 박수, 롤링 오픈 기간, 딥링크 생성.
- 실패 종류: 네트워크 오류, 차단, 응답 구조 변경, 점검 중.
- 코어가 어댑터에 넘겨줄 공통 도구: 정직한 UA가 붙은 HTTP 클라이언트, 요청 간격 관리, 차단 페이지 감지. UA에 무엇을 넣을지도 정한다. RFC 9110의 `From` 헤더 권고와 개인정보를 넣지 않는다는 원칙이 부딪히니, 도구 이름만 넣을지 프로젝트 URL을 넣을지 정한다.
- 어댑터를 어떻게 분리할지: Playwright 같은 무거운 의존성을 dynamic import나 선택 패키지로 격리한다.
- HTTP 방식과 브라우저 방식 구현이 같은 인터페이스를 쓸 수 있는가? 숲나들e 같은 세션 기반 예약처도 담을 수 있는가?

## Answer (2026-09-29, 사용자 확정)

1. **책임 경계**: 어댑터는 가용 현황만 조회하고, 매칭은 코어가 맡는다.
   - 코어는 감시 조건을 **조회 단위** `(시설, 구역, 입실일, 박수)`로 쪼갠다. 같은 조회 단위를 쓰는 감시 조건들은 조회를 한 번만 하고 결과를 나눠 쓴다.
   - 어댑터 계약: `queryAvailability(q, ctx) → AvailableSite[]`. 돌려주는 값은 **N박 연속으로 비어 있는 자리**뿐이다. 예약처가 박수를 지정해서 조회할 수 없으면, 어댑터가 1박씩 조회한 결과를 이어 붙여 만든다.
   - 자리 필터 적용, 날짜 범위 순회, 중복 알림 판정은 모두 코어가 한다.
2. **`describe()`가 알려 주는 것**
   - 시설 목록, 시설마다 구역 목록(코드, 이름, 유형, 정원)
   - 최대 박수
   - 예약 오픈 규칙: 입실일이 언제 열리는지. 아직 열리지 않은 날짜는 코어가 조회하지 않는다.
   - 딥링크 생성: `(시설, 구역, 입실일) → URL`
   - 구역 목록은 어댑터 코드에 고정값으로 둔다.
3. **실패 분류**
   - `transient`: 네트워크 오류, 타임아웃, 5xx. 백오프한 뒤 다시 시도한다.
   - `blocked`: 차단 페이지를 받았거나 403/429. 해당 예약처의 폴링을 **즉시 멈추고** 알린다. 자동으로 재개하지 않고, 사람이 확인한 뒤에 재개한다.
   - `unrecognized`: 응답 구조가 바뀌어 파서가 읽지 못한다. 폴링을 멈추고 알린다.
   - `unavailable`: 점검 중이거나 휴장 중이라고 표시된다. 간격을 늘려 계속 조회하고, 알림은 한 번만 보낸다.
   - 빈자리 0개는 실패가 아니라 정상 결과다. 그래서 어댑터는 파싱이 성공했다는 근거를 반드시 확인해야 한다. 예: 자리 목록 컨테이너가 응답에 있는지.
4. **User-Agent**: `overlord-availability-poller/<version>`. 설정으로 문구를 덧붙일 수 있다. 공통 HTTP 클라이언트가 붙이며, 어댑터는 바꿀 수 없다. `From` 헤더는 넣지 않는다. 개인정보를 넣지 않는다는 원칙 때문이다. 공개 저장소가 생기면 UA에 프로젝트 URL을 넣는 것을 다시 검토한다.
5. **`AdapterContext`**: 어댑터는 `ctx.http`만 쓴다. 전역 `fetch`는 lint로 금지한다. `ctx.http`가 제공하는 것:
   - 정직한 UA
   - 예약처별로 요청을 직렬화하고 최소 간격을 지킨다
   - 타임아웃
   - 예약처가 등록한 차단 페이지 판별 함수를 모든 응답에 적용하고, 걸리면 `blocked`로 바꾼다
   - 필요한 경우 쿠키 저장소
6. **패키지 구성**: 패키지는 하나다. 어댑터는 `adapters/<provider>/`에 두고, 설정에 있는 예약처만 dynamic import한다. Playwright는 `optionalDependencies`에 넣는다. Docker 빌드 인자로 브라우저를 넣을지 정한다.
7. **세션 기반 예약처**: 선택 메서드 `init?(ctx)`와 `dispose?()`만 자리를 잡아 둔다. 세션이 만료되면 어댑터 안에서 처리한다. 실제 설계는 숲나들e 어댑터를 만들 때 한다(지도의 Not yet specified).

### 인터페이스 스케치

```ts
interface ProviderAdapter {
  readonly id: string;                                   // "goraebul"
  describe(): ProviderInfo;                              // 시설/구역, maxNights, openingRule, deepLink()
  init?(ctx: AdapterContext): Promise<void>;
  queryAvailability(
    q: { facility: string; zone: string; checkIn: LocalDate; nights: number },
    ctx: AdapterContext,
  ): Promise<AvailableSite[]>;                           // N박 연속 빈 자리만
  dispose?(): Promise<void>;
}
// 실패는 AdapterError{ kind: 'transient' | 'blocked' | 'unrecognized' | 'unavailable' }
```

## 후속 변경

- [폴링 스케줄 정책](07-polling-schedule-policy.md)에서 선택 메서드 `queryAvailabilityBatch(units, ctx)`를 추가했고, `describe()`의 오픈 규칙에 당일 마감 시각을 넣었다.
