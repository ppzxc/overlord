# 01: 워킹 스켈레톤: 감시 조건 하나로 고래불 빈자리를 찾아 Telegram으로 알림

**What to build:** 설정 파일에 고래불 감시 조건 하나를 적고 폴러를 띄운다. 폴러는 그 조건의 조회 단위 하나를 고래불 자리 배치 조회로 확인한다. 빈 자리가 있으면 Telegram으로 단순한 메시지를 보낸다. 이후 고정 간격으로 바퀴를 반복한다. 전체 흐름이 끝까지 한 번 이어지는 것이 목표이고, 이 흐름을 검증하는 테스트 seam 하네스도 함께 만든다. 근거: [spec](../../availability-poller/spec.md)

- TypeScript/Node 단일 패키지 골격. 어댑터 코드에서 전역 `fetch`를 쓰면 lint가 막는다.
- 최소 설정 로딩: YAML을 읽고 `${VAR}`를 환경 변수로 치환한다.
- 공통 HTTP 클라이언트(`ctx.http`): 정직한 UA `overlord-availability-poller/<version>`에 설정 suffix만 덧붙인다. 타임아웃은 10초다. 실제 호출은 주입된 Transport에 위임한다.
- 고래불 어댑터 `describe()`는 구역 목록을 고정값으로 두고 딥링크를 만든다. `queryAvailability`는 `zoneAreaAjax`를 박수에 맞춰 조회한다. 빈 자리는 class가 `num` 하나뿐이고 `zone_area_select` onclick이 붙은 자리다.
- 테스트 seam: 폴러 전체를 실제 설정으로 띄우고 Transport, Clock, Telegram Sink만 교체한다. 조사 단계의 고래불 HTML(`availability-poller/research/raw/`)을 테스트 fixture로 복사해 고정한다.

**Blocked by:** None (can start immediately)

**Status:** done

- [ ] 빈 자리가 있는 fixture를 주면 자리 번호와 딥링크가 담긴 Telegram 메시지가 Sink에 한 건 기록된다.
- [ ] 빈 자리가 없는 fixture를 주면 메시지가 나가지 않는다.
- [ ] 모든 요청에 정직한 UA가 붙고, 브라우저 UA나 개인정보 헤더(`From` 등)는 붙지 않는다.
- [ ] 어떤 경우에도 `/bbs/` 경로로 요청하지 않는다.
- [ ] 가짜 시계를 돌리면 고정 간격마다 바퀴가 반복된다.
- [ ] 어댑터에서 전역 `fetch`를 쓰면 lint가 실패한다.
