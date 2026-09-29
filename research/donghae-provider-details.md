# 동해시 예약처 세부 동작 조사 (2026-09-29)

[#24](https://github.com/ppzxc/overlord/issues/24)를 풀려고 조사했다. 지도는 [#23](https://github.com/ppzxc/overlord/issues/23)이다. 대상은 예약처 동해시 관광지 통합 예약시스템(`www.campingkorea.or.kr`)이고, 첫 시설은 망상오토캠핑리조트다.

조사 방법은 이렇다.

- 2026-09-29 13:16~13:25 KST 사이에 읽기 전용 GET 22회를 보냈다. 요청 사이 간격은 3.5초 이상이었다. 요청 목록은 `raw/donghae/requests.log`에 있다.
- UA는 `overlord-availability-poller/0.1 (research)` 하나만 썼다. 개인 헤더는 넣지 않았고 쿠키는 보내지 않았다. 요청마다 새 세션으로 보냈다.
- POST는 한 번도 보내지 않았다. 폼 제출, 로그인, NetFunnel 참여도 하지 않았다.
- archive.org CDX를 한 번 조회했다. 이 조회는 대상 서버를 거치지 않는다.
- 차단 신호는 없었다. 21회는 정상 크기의 200이었고, 나머지 1회는 `robots.txt`의 404였다.
- 원본은 `raw/donghae/`에 있다. 원본 HTML에 박혀 있던 방문자 IP(`anlzClientIp`), 분석용 세션 id(`anlzSessionId`), `DHCMP_JSESSIONID` 쿠키는 `REDACTED`로 지웠다. 응답 헤더 파일은 올리지 않았다.

**핵심 결론을 먼저 적는다.** 빈자리 조회 화면은 NetFunnel 대기열 뒤에 있다. 대기열에서 받은 키를 서버 세션에 등록한 뒤 폼을 POST해야 들어갈 수 있고, 이 구조는 JS와 서버 엔드포인트 이름으로 확인했다. 그 뒤에서 실제로 빈자리를 묻는 요청은 보지 못했다(**미검증**). 그 요청의 URL과 파라미터가 무엇인지, 요청마다 키를 검사하는지, 로그인이 필요한지는 모두 모른다. 우회를 하지 않고서는 알아낼 방법이 없었다.

## 1. 접근 조건

### robots.txt

`GET /robots.txt`는 **404**다. 응답 본문은 예약처 공통 404 페이지(`div.mError1`, "요청하신 페이지를 찾을 수 없습니다")다. 선언된 금지 경로가 없다. 따라서 이 예약처의 접근 금지 목록은 robots.txt 기준으로 비어 있다. 다만 어댑터가 쓸 필요가 없는 경로는 목록에 넣어 두기를 권한다. `/login/`, `/user/join/`, `/user/myPage/`, `/user/bbs/`(게시판)가 그런 경로다.

### 첫 화면과 NetFunnel(`index`)

- `GET /`는 162바이트짜리 JS 리다이렉트이고 `location.href="/index.do"`로 보낸다. 주석으로 막힌 `indexWait.do`도 들어 있다.
- `GET /index.do`(200)는 로드되자마자 `NetFunnel_Action({action_id:"index"}, cb)`를 호출한다. 콜백은 `q_complete=Y`를 담아 `index.do`로 POST한다. 첫 화면에도 대기열이 걸려 있는 셈이다.

### 예약 화면과 NetFunnel(`reserve`), 키 등록

`GET /user/reservation/BD_reservation.do`(200, 로그아웃 상태)는 달력을 주지 않는다. 대신 반투명 대기 레이어(`#div_reservationWait_waiting`)와 숨은 폼 하나만 준다.

```html
<form id="dataForm" name="dataForm" action="BD_reservation.do" method="post">
	<input type="hidden" id="q_complete" name="q_complete" value="" />
	<input type="hidden" id="q_trrsrtCd" name="q_trrsrtCd" value=''/>
	<input type="hidden" id="trrsrtCode" name="trrsrtCode" value=''/>
	<input type="hidden" id="q_year"     name="q_year"     value=''/>
	<input type="hidden" id="q_month"    name="q_month"    value=''/>
	<input type="hidden" id="netfunnel_key" name="netfunnel_key" value=''/>
</form>
```

페이지 JS(`raw/donghae/BD_reservation.do.html` 150~290행 부근)를 읽고 정리한 정상 흐름은 아래와 같다.

1. `needNewToken()`이 `sessionStorage`에서 `dhscamp_pass_netfunnelkey`와 `…_date`를 읽는다.
   - 키가 없거나 발급된 지 **2시간**이 지났으면 새 키가 필요하다.
   - 키가 있으면 `POST /user/reservation/ND_checkNfKeyAvail.do`(`netfunnel_key=<키>`)로 서버에 물어본다. 응답 `message`에 `NOT Available`이 있으면 새 키가 필요하다.
2. 새 키가 필요하면 `NetFunnel_Action({action_id:"reserve"}, cb)`를 호출한다. 여기서 대기열에 참여하고 순번을 기다린다.
   - 통과하면 `ret.data.key`로 키를 받는다.
   - 키를 받지 못하면 8초 뒤에 페이지를 새로 고친다.
3. 받은 키는 `POST /user/reservation/ND_setNfKey.do`로 보낸다. 요청 본문은 키 문자열 그대로이고 `Content-Type: application/json`이다. 서버는 이 키를 **세션에 등록한다**. 키는 `sessionStorage`에도 저장된다.
4. `fGotoNext()`가 `q_complete=Y`와 `netfunnel_key=<키>`를 담아 `BD_reservation.do`로 **POST**한다.
   - 이때 `q_trrsrtCd`, `trrsrtCode`, `q_year`, `q_month`는 **일부러 빈 값으로 둔다**.
   - 이 POST의 응답이 실제 예약 화면일 것으로 보인다(미검증).
5. 숨은 iframe이 `/www/util/remain.jsp?mode=html`을 계속 띄워 세션을 유지한다. 서버 세션 상태가 조회에 쓰인다는 뜻이다.

NetFunnel 설정은 `/resources/user/js/netfunnel.js`에 있다. STCLab 2.2.25_hotfix다.

| 항목 | 값 |
|---|---|
| 대기열 서버 | `https://nf.campingkorea.or.kr:443/ts.wseq` |
| `TS_COOKIE_TIME` | 10분 |
| `TS_MAX_TTL` | 30초 |
| `TS_BYPASS` | `false` |
| `TS_BLOCK_MSG` | `'Service Block!!'` |
| `TS_IPBLOCK_WAIT_TIME` | 10000ms |
| `TS_IPBLOCK_WAIT_COUNT` | 200 |

opcode는 5101(getTidChkEnter), 5002(chkEnter), 5003(aliveNotice), 5004(setComplete)이다. 결과 코드는 200 정상, 201 대기 계속, 300 서버 측 Bypass, 301 Block, 302 IP Block이다.

매크로 방지 파라미터는 다음과 같다.

- `MP_USE=false`. 클라이언트 쪽 매크로 방지는 꺼져 있다.
- 값 자체는 정의되어 있다. `MP_TIMELIMIT=20000ms`, `MP_MAXREQLIMIT=MP_TIMELIMIT/1100`(20초에 약 18회)이다.
- 요청 주기의 표준편차 한도는 `MP_DEVLIMIT=20ms`이고, 표본 수는 `MP_DEVCNTLIMIT=7`이다.
- `MP_REQONLYLIMIT=10`은 setComplete 없이 getTidChkEnter만 보낸 횟수의 한도다.

서버 쪽에 같은 규칙이 있는지는 모른다(미검증). 규칙의 뜻은 분명하다. 너무 일정한 주기로 짧게 반복하는 것, 그리고 입장만 하고 완료(setComplete)를 보내지 않는 것을 매크로로 본다.

**어댑터가 절대 쓰면 안 되는 것.** 페이지 JS에는 디버그 스위치가 있다. `localStorage.nfdebug1`이 `Y`나 `true`이면 `netfunnel_key` 필드를 지운 채 제출한다. 호스트가 `localhost`일 때는 대기열을 건너뛰고 `'localhost'`를 키로 등록한다. 둘 다 대기열을 건너뛰는 길이다. 이번 조사에서 둘 다 쓰지 않았고 시험하지도 않았다. 어댑터도 쓰면 안 된다.

### 판정: 조회에 NetFunnel 키가 필요한가

| 질문 | 답 | 근거 |
|---|---|---|
| 예약 화면에 들어가려면 키가 필요한가 | **필요하다 (확인)** | 페이지가 키 없이는 달력을 주지 않는다. 서버에 키를 등록하는 전용 엔드포인트(`ND_setNfKey.do`)와 확인 엔드포인트(`ND_checkNfKeyAvail.do`)가 있다. |
| 빈자리를 묻는 개별 요청(달력 이동, 자리 배치 AJAX 등)이 매번 키를 검사하는가 | **미검증** | 그 요청은 대기열 뒤에 있어서 보지 못했다. 세션에 키를 등록하는 구조로 보아, 세션 단위로 검사할 가능성이 높다(추정). |
| 키를 얼마나 오래 쓰는가 | 페이지 자체는 **2시간** 동안 같은 키를 다시 쓴다 | `needNewToken()`. 서버가 `NOT Available`로 답하면 그보다 일찍 새 키를 받는다. |

예약처 페이지의 정상 흐름에서도 한 세션 안에서는 키 하나를 2시간까지 다시 쓴다. 이것은 지도의 "키 재사용 금지"와 부딪칠 수 있다. 예약처가 정한 TTL 안에서, 같은 세션에서, 서버가 받아 주는 동안 쓰는 것은 브라우저의 정상 동작과 같다. 이것을 금지하는 "재사용"으로 볼지는 [#26](https://github.com/ppzxc/overlord/issues/26)에서 정해야 한다. 이번 조사에서 정하지 않았다.

정상 참여는 GET만으로 끝나지 않는다는 점도 #26에서 함께 정해야 한다. 새 키를 받을 때마다 다음 요청이 든다.

- NetFunnel `ts.wseq` 호출 여러 번과 setComplete
- `POST ND_setNfKey.do`
- 폼 `POST BD_reservation.do`

2시간 TTL이 다가오면 적어도 `POST ND_checkNfKeyAvail.do`를 한 번 보내야 한다. 이것은 지도의 "읽기 전용 GET 위주" 원칙과 맞지 않는다. 다만 셋 다 로그아웃한 방문자의 브라우저가 보내는 요청이고 예약 상태를 만들지 않는다.

### 판정: 로그인이 필요한가

- **예약**은 로그인해야 한다(확인). 예약안내(`useGuidance01.jsp`)에 "온라인예약은 회원가입후 가능합니다"라고 적혀 있다.
- **빈자리 보기**에 로그인이 필요한지는 **미검증**이다. 로그아웃 상태에서 받은 `BD_reservation.do` 대기 화면은 로그인으로 보내지 않았다. 하지만 대기열 뒤 화면은 보지 못했다. 공지 [20260721173512015]에 "정상루트로 예약실행 시 특정일에 이미 예약한 객실이 있을 경우 그 특정일로는 온라인 예약하기에서 진입이 안됩니다"라는 문구가 있다. 이 문장만 보면 날짜를 고르는 단계부터 회원을 식별하는 것으로 읽힌다. 다만 그 단계가 로그인을 요구하는지는 알 수 없다.
- **로그인 방식**(`/login/BD_loginForm.do`, 폼만 보고 제출하지 않음)
  - 아이디와 비밀번호를 `POST /login/ND_loginAction.do`(AJAX)로 보낸다. 비밀번호는 클라이언트에서 `opEncrypt()`로 암호화한다. 이 함수는 `openworks.global.js`에 없었고, 알고리즘은 미검증이다.
  - 폼에 captcha는 **없다**.
  - 응답의 `reorganCrtfc === 'N'`이면 `/user/join/BD_NiceAuthenticationReorganCrtfc.do`로 보낸다. **NICE 본인인증 재인증**을 요구하는 분기가 있다는 뜻이다. 언제 이 분기가 뜨는지(주기적 재인증인지, 한 번만인지)는 미검증이다.
  - 카카오와 네이버 간편로그인도 있다.
- **회원가입**(`/user/join/BD_insertTermsAgreeForm.do`)은 `BD_NiceAuthentication.do`로 가는 "본인인증" 버튼을 거친다. 계정을 만들 때 휴대폰 본인인증을 거쳐야 할 가능성이 높다(미검증). 이것은 사람이 한 번 하면 되는 일이다. 매 로그인 때 본인인증을 요구하는 것과는 다르다. 지도의 no-go 조건("휴대폰 본인인증이나 captcha가 끼면")에서 이 차이를 가려야 한다.

## 2. 요청 순서

확인한 부분과 미검증 부분을 나눠 적는다.

```
[확인] GET  /user/reservation/BD_reservation.do          → 대기 레이어 + 숨은 폼 (쿠키 DHCMP_JSESSIONID 발급)
[JS 읽기] NetFunnel reserve 참여 (nf.campingkorea.or.kr/ts.wseq, opcode 5101 → 5002 …)
[JS 읽기] POST /user/reservation/ND_setNfKey.do  body=<키>   → 서버 세션에 키 등록
[JS 읽기] POST /user/reservation/BD_reservation.do  q_complete=Y&netfunnel_key=<키>&q_trrsrtCd=&trrsrtCode=&q_year=&q_month=
[미검증] 응답: 관광지(trrsrtCode) 선택 → 월 달력(q_year, q_month) → 구역·자리 선택 … 의 요청들
```

- 폼 필드 이름(`q_trrsrtCd`, `trrsrtCode`, `q_year`, `q_month`)을 보면, 대기열 뒤 화면에서 관광지와 연월을 고르는 것으로 보인다(추정).
- 조회 단위 하나에 요청이 몇 번 드는지는 **미검증**이다. 월 달력이 남은 자리 수를 보여 주어 선필터로 쓸 수 있는지도 **미검증**이다.
- archive.org에는 `BD_reservation.do`의 2026-02-05 캡처 하나만 있었다. 이것은 GET 결과여서 대기 화면일 것이고, 대기열 뒤 화면의 과거 모습은 얻을 수 없다.

## 3. 계층 매핑 (안내 페이지 기준)

시설 안내 페이지(`/user/guide/BD_selectFcltyDetailInfo.do`)의 URL 계층은 `trrsrtCode` > `upperFcltyCode` > `fcltyCode`이고, 페이지마다 `fcltyTyCode`(유형 코드)가 붙는다. 예약 화면이 같은 코드를 쓰는지는 **미검증**이다. 폼에 `trrsrtCode`가 있으니 적어도 최상위는 같을 것으로 보인다.

`trrsrtCode`는 관광지다. 우리 모델에서는 **시설**이다.

| trrsrtCode | 시설 | deptCode | 오픈 시각 |
|---|---|---|---|
| 1000 | 망상오토캠핑리조트 | `msAtCpRs` | 11:00 |
| 2000 | 망상제2오토캠핑장 | `msAt2Cp` | 12:00 |
| 3000 | 무릉힐링캠프장 | `mrHrCp` | 13:00 |
| 4000 | 추암오토캠핑장 | `caAtCp` | 14:00 |

망상(1000)의 `upperFcltyCode`와 `fcltyCode`는 아래와 같다. 안내 메뉴와 상세 페이지에서 읽었다.

| upperFcltyCode | 이름 | fcltyCode(탭) | fcltyTyCode 예 | 정원 | 자리 |
|---|---|---|---|---|---|
| 1100 | 망상해변한옥마을(해안) | 1101 단독객실, 1102 단층연립(A) 누마루, 1103 단층연립(A) 일반형, 1104 단층연립(B), 1105 단층연립(C), 1106 복층연립 누마루, 1107 복층연립 일반형, 1108 동해당, 1109 단독객실(6인)-814호 | KH_101 | 1101: 4명 | 1101: 831·832·836·837호 |
| 1200 | 캐빈하우스 | (탭 없음) | CH_302 | 4명 | 4동 |
| 1300 | 든바다 | 1301 | (미확인) | | |
| 1400 | 난바다 | 1401 | (`NAB_F1`이 JS에 나옴) | | |
| 1500 | 허허바다 | 1501 | (미확인) | | |
| **1600** | **자동차캠핑장** | (탭 없음) | MA_001 | 4명, 주차 1대 | **1번~41번** (1~32, 38~41번은 3.6×5.4m, 33~37번은 3×4.8m) |
| 1700 | 캐라반 | (탭 없음) | CV_601 | 6명 | 6대 |
| 1800 | 글램핑 | 1801 글램핑(4인), 1802 글램핑(2인) | CP_002 | 4명 / 2명 | 1801: 701·702호 |

우리 모델에 맞춰 보면 이렇게 제안한다.

- **시설** = `trrsrtCode`. 망상은 `1000`이다.
- **구역** = 유형과 가격이 같은 묶음이다.
  - 탭이 없는 곳은 `upperFcltyCode`를 쓴다. 1600 자동차캠핑장, 1700 캐라반, 1200 캐빈하우스가 여기에 든다.
  - 탭이 있는 곳은 `fcltyCode`를 쓴다. 1101 단독객실, 1801 글램핑(4인) 등이다. 탭마다 페이지가 따로 있어서 요금표도 탭마다 다를 것이고, 그렇다면 가격이 같은 묶음은 `fcltyCode` 쪽이다. `upperFcltyCode`마다 탭 하나만 받아 봤으므로 이 부분은 추정이다.
  - 예약처 원문의 "시설(`fcltyCode`)"은 **자리가 아니라 구역**이다. 탭 하나에 자리 번호(호실)가 여러 개 딸려 있기 때문이다.
- **자리** = 번호다. 1600은 1~41번, 1101은 831호 등이다.
- 구역 코드로 `upperFcltyCode`를 쓸지 `fcltyCode`를 쓸지, `fcltyTyCode`를 쓸지는 예약 화면의 실제 파라미터를 본 뒤 [#25](https://github.com/ppzxc/overlord/issues/25)에서 정한다.
- 1600 자동차캠핑장은 안내 페이지에 fcltyCode 탭이 없다. 예약 화면에서는 따로 코드(예: 1601)를 쓸 수도 있다(미검증).

지도의 "숙박시설이 박 단위인가"라는 질문에는 이렇게 답한다. 요금표가 모두 1박 단가(성수기, 주말·공휴일전, 평일)이고, 예약 규정이 "최대 3박4일"이다. 따라서 한옥, 캐빈, 캐라반, 글램핑도 박 단위로 보인다. 예약 화면에서 확인하지는 않았다.

## 4. 오픈·예약 규칙

모두 공식 공지와 안내 페이지에서 읽었다. 실제 오픈 순간은 관찰하지 않았다.

- **오픈 시각**: 입실일 D는 **D−30일 11:00**(망상)에 열린다.
  - 예약안내에는 "예약은 오늘날짜 하루뒤부터 30일(망상오토캠핑리조트 오전 11시 …)까지"라고 적혀 있다.
  - 공지 [20210217101522607]에는 "모든 예약은 희망일 30일전 오전 11시부터"라고 적혀 있다.
  - 공지의 예시는 "10월 1일~2일(1박2일) 사용을 원할시 9월 1일 낮 11시부터"다. 10월 1일의 30일 전은 9월 1일이므로 D−30과 맞는다.
  - `OpeningRule`로는 `openDaysBefore: 30`, `openTime: "11:00"`이다.
- **당일 입실**: "오늘날짜 하루뒤부터"라는 문구로 보아 **당일 입실 예약은 받지 않는 것**으로 읽힌다. 공지 [20251016190925018]("망상리조트 당일예약 결제 안내")도 당일 입실 이야기가 아니다. 본문은 "망상리조트는 예약 당일 자정 (24:00) 까지 결제가 완료되어야 예약이 확정 되는 시스템으로 운영되고 있습니다"이고, 이어서 카드결제와 가상계좌(23:30 전 입금)의 결제 기한만 다룬다. 여기서 "당일"은 예약한 날이다.
  - 그래서 `sameDayCutoff`는 "당일 입실 불가"로 표현해야 한다. 지금 `OpeningRule`은 당일 마감 시각만 표현할 수 있으므로 모델을 조정해야 할 수 있다. 예를 들어 cutoff를 `00:00`으로 두는 방법이 있다(미결정).
- **최대 박수**: 3박이다(`maxNights: 3`).
- **연박의 선점 효과**: 날짜 D가 열리는 순간 D부터 3박으로 예약하면 D+1과 D+2도 함께 잡힌다. 두 날짜의 창은 아직 열리지 않았는데도 그렇다. 공지는 "예약가능일에 접속시 일부 시설이 예약완료로 확인되는 경우가 종종 발생"한다고 적고 있다. 따라서 오픈 직후의 D+1, D+2는 이미 차 있을 수 있다. 감시 입장에서는 오픈 전 날짜에도 빈자리가 줄어들 수 있다는 뜻이다.
- **1인 1일 1객실**: 공지 [20260721173512015]에 있다. 이미 예약한 날짜로는 "온라인 예약하기에서 진입이 안됩니다". 감시 계정으로 본인 계정을 쓰면, 사용자가 예약을 마친 날짜의 조회가 막힐 수 있다(추정).
- **취소 후 2시간 재예약 불가**, 부분취소 불가다.
- 미결제 예약은 예약 당일 자정에 자동 취소된다. 공지에는 "예약진행 당일 결제를 안 하시거나 예약취소를 원하시는 분들이 있으면 바로 취소 처리"한다고 적혀 있다. 그래서 **자정 직후와 취소 직후에 빈자리가 풀린다**. 감시가 노릴 만한 시점이다.
- 성수기는 2026-07-15 ~ 2026-08-20이다. 주말 요금은 금요일, 토요일, 공휴일 전날에 적용한다.

## 5. 딥링크

- `fGotoNext()`는 제출 직전에 `q_trrsrtCd`, `trrsrtCode`, `q_year`, `q_month`를 **빈 값으로 덮어쓴다**. 그래서 URL이나 폼 값으로 시설이나 연월을 미리 골라 둔 채 들어갈 수 없다.
- 예약 화면으로 들어가는 URL은 `BD_reservation.do` 하나뿐이고, 들어갈 때마다 대기열을 거친다(키가 2시간 안이면 확인만 한다).
- **알림 딥링크로는 `https://www.campingkorea.or.kr/user/reservation/BD_reservation.do`를 권한다.** 알림 본문에는 시설, 구역, 자리, 날짜를 글로 적는다.
- 대기열 뒤 화면에 날짜나 구역을 골라 둔 채 여는 GET URL이 따로 있는지는 미검증이다.

## 6. 차단·구조 변경 신호

- 이번 조사에서는 차단을 한 번도 보지 못했다. 아래는 JS와 마크업에서 읽은 단서다.
- NetFunnel 쪽 신호
  - 결과 코드 301(Block)이면 `alert('Service Block!!')` 뒤에 진입이 막힌다. `TS_BLOCK_URL`은 비어 있다.
  - 302(IP Block)이면 가상 대기창이 10초씩 최대 200회 반복된다.
  - 키를 받지 못하면 페이지가 8초 뒤에 새로 고친다.
  - 어댑터가 대기열에 참여한다면, 301·302를 받는 즉시 `blocked`로 보고 멈추는 것이 맞다.
- `ND_checkNfKeyAvail.do`의 `message`에 `NOT Available`이 있으면 키가 만료된 것이다. 이것은 차단이 아니다.
- 예약처 공통 404는 HTTP 404에 `div.mError1`("요청하신 페이지를 찾을 수 없습니다")이다. 경로가 바뀐 것을 감지하는 데 쓸 수 있다.
- 점검
  - 공지 [20241113132431455]에 "홈페이지 시스템 점검으로 인하여 망상오토캠핑리조트 예약이 일시적으로 중단됩니다"라는 사례가 있다.
  - 점검 화면의 마크업은 미검증이다. 루트의 주석 `indexWait.do`가 대기 또는 점검 페이지일 수 있다(추정).
- 구조 변경 단서
  - `BD_reservation.do`에서 `#dataForm`의 `netfunnel_key` 필드, `ND_setNfKey.do` 호출, `NetFunnel_Action({action_id:"reserve"}` 문자열 가운데 하나라도 사라지면 흐름이 바뀐 것이다. 이때는 `unrecognized`로 본다.
  - `netfunnel.js`의 버전 문자열(`Version 2.2.25_hotfix`)과 `TS_HOST`도 함께 보면 좋다.

## 7. 미검증 항목과 다음 단계

**미검증**

- 대기열 뒤에서 빈자리를 묻는 요청 전부. URL, 메서드, 파라미터, 응답 마크업, 요청마다 키를 검사하는지를 모른다.
- 빈자리 보기에 로그인이 필요한지.
- 월 달력으로 선필터를 할 수 있는지.
- `fcltyCode`와 자리 번호가 예약 화면에서 어떻게 나오는지.
- 로그인할 때 NICE 재인증이 언제 뜨는지.

**다음 단계 제안.** 위 항목은 한 가지 관찰로 풀린다. 사용자가 자기 브라우저로 정상 경로를 한 번 따라가면서 개발자 도구 Network 탭의 XHR과 문서 요청을 기록하면 된다. 로그아웃 상태로 한 번, 로그인 상태로 한 번 한다. 대기열 참여도 사람이 브라우저에서 한다. 에이전트가 대기열에 참여하는 것은 이번 조사 범위 밖이다. #25와 #26은 모두 이 기록에 달려 있다. 별도 티켓으로 만드는 것을 권한다.

## 8. 대기열 뒤 기록 (2026-09-29 14:27~14:29 KST)

[동해시 대기열 뒤 요청 기록](https://github.com/ppzxc/overlord/issues/27)으로 한 관찰이다. 사용자 요청에 따라 에이전트가 헤드리스 Chromium(Playwright)으로 실제 페이지 JS를 돌렸다. 체크리스트의 "본인 브라우저"와 다르다. 조건은 다음과 같았다.

- UA: `overlord-availability-poller/0.1 (research)`
- 로그아웃 상태, 사용자 IP
- 문서·XHR 요청 약 13회, 사람이 클릭하는 간격(4초 이상)

captcha 입력과 "다음" 버튼은 건드리지 않았다. 대기열 우회 경로도 쓰지 않았다. 차단 신호는 없었다. 요청 목록은 `raw/donghae/requests-queue.txt`에 있다.

**대기열.** `ts.wseq` opcode 5101 한 번에 `5002:200:key=…&nwait=0`이 돌아왔다(대기 0명). 이어서 페이지가 두 요청을 보냈다.

1. `ND_setNfKey.do` POST(본문은 키)
2. `BD_reservation.do` POST(`q_complete=Y&netfunnel_key=<키>`, 나머지는 빈 값)

기록 동안 setComplete(5004)는 관찰되지 않았다. 페이지 코드상으로는 5분 타이머나 페이지를 벗어날 때 부른다.

**로그인 없이 예약 1단계(날짜 선택)가 열린다.** 관광지 탭(망상 1000, 망상2 2000, 무릉 3000, 추암 4000)과 월 달력이 보인다. 날짜 칸은 셋 중 하나다.

- `예약현황보기` 링크(`getFcltyCntAll('<일>')`)
- `예약마감`(`li.end`)
- `예약종료`(지난 날짜)

D+30 뒤의 날짜 칸은 비어 있다. 이 화면을 보면 월 달력을 선필터로 쓸 수 있다.

**구역별 남은 수 조회는 captcha 없이 된다.** `예약현황보기`는 아래 요청을 보낸다.

```
POST /user/reservation/ND_selectFcltyCalendarDetail.do
trrsrtCode=1000&q_year=2026&q_month=10&qDay=1&passResv1=&passNfTime=<대기 ms>&netfunnel_key=<키>
```

응답은 JSON이다.

```json
{"ipAdres":null,"paramMap":{},"result":true,"value":"전통한옥:16|^|캐빈하우스:예약완료|^|든바다:예약완료|^|난바다:7|^|허허바다:예약완료|^|자동차캠핑장:20|^|캐라반:4|^|글램핑(4인):1|^|글램핑(2인):예약완료","message":null}
```

- `value`는 `표시이름:값`을 `|^|`로 이은 문자열이다.
- 값은 남은 수(숫자), `예약완료`, `예약불가`, `준비중` 가운데 하나다.
- 구역은 **코드가 아니라 표시 이름**으로 온다. 망상은 9개다: 전통한옥, 캐빈하우스, 든바다, 난바다, 허허바다, 자동차캠핑장, 캐라반, 글램핑(4인), 글램핑(2인).
- 한 번 부르면 **하루 하룻밤** 치를 준다.
- 9/30에는 자동차캠핑장이 31이었고, 10/1에는 20이었다.

이 요청에 대해 확인한 사항은 다음과 같다.

- `passNfTime`은 페이지가 대기열에서 **실제로 기다린 시간(ms)**이다(`dhscamp_pass_netfunnelt`). 이번에는 99였다.
- `passResv1`은 비어 있었다.
- 서버는 이 요청마다 pass 키를 검사한다. 실패하면 `message`에 `NOPASS:` 접두가 붙는다. 그러면 페이지는 세션 저장값을 지우고 `history.go(-2)`로 돌아간다.
- `result:false`이면 `message`를 alert로 띄운다.

**클라이언트가 남은 수를 보정한다.** 페이지 JS의 `temporaryReducedCounts = { 'A-zone 자동차캠핑장' : 20 }`에 적힌 이름과 일치하는 항목은 남은 수에서 그만큼 뺀다. 이유는 "임시 사용 중단 호실"이다. 이번 응답의 이름("자동차캠핑장")과는 일치하지 않았다. 이 상수는 페이지를 고치면 바뀐다.

**월 이동**은 `BD_reservationOrigin.do` POST다. 본문은 `trrsrtCode=1000&q_year=2026&q_month=10&netfunnel_key=<키>&…`이고, 새 달력 페이지가 통째로 온다(`raw/donghae/BD_reservationOrigin.do_2026-10.html`). 다음 달이 `mxResPosMth`(202610)를 넘으면 페이지가 막는다.

**박수**는 `stayngPd` 1001~1003(1~3박)이다. "다음"을 누르기 전까지는 클라이언트에서만 체크아웃 날짜를 계산한다.

**2단계(자리 선택)는 captcha 뒤에 있다.** "다음"을 누르면 순서가 이렇다.

1. `무단예약방지문구` 이미지 captcha(`ND_ncaptcha.do`)의 답을 `ND_chkAnswer.do`로 검사한다.
2. 통과하면 `BD_reservationReq.do`로 POST한다.

페이지에는 "기존 선점하신 시설"을 이어서 할지, `ND_deletePreOcpcInfo.do`로 해제할지 묻는 분기가 있다. 그래서 2단계 흐름은 **선점(임시 점유)**을 만드는 것으로 보인다(추정, 요청은 보내지 않았다). 개별 자리 번호는 이 captcha 뒤에서만 보인다.

**그 밖의 사항**

- 페이지 코드에는 `sessionStorage.dhscamp_pass_nonetfunnel`이 `Y`면 대기열을 건너뛰는 분기가 있다. 우회 경로이므로 쓰지 않는다.
- 로그인하지 않아도 1단계와 구역별 남은 수 조회에 막힘이 없었다. 로그인 상태 기록은 하지 않았다.

**7장 미검증 항목의 상태**

- 대기열 뒤 조회 요청: 위와 같이 확인했다.
- 로그인 필요 여부: 구역별 남은 수에는 필요 없다.
- 월 달력 선필터: 가능하다.
- `fcltyCode`와 자리 번호: captcha 뒤에 있어 관찰할 수 없다. 조회 응답은 구역 표시 이름 단위다.
- NICE 재인증: 로그인하지 않았으므로 해당이 없다.

## 출처

- `raw/donghae/root.html`: `GET /` (JS 리다이렉트)
- `raw/donghae/index.do.html`: NetFunnel `index`
- `raw/donghae/BD_reservation.do.html`: NetFunnel `reserve`, 키 등록 흐름, 숨은 폼
- `raw/donghae/netfunnel.excerpt.js`: NetFunnel 설정 발췌(헤더, EditZone, 상수만 남김. 원본은 92,328바이트), 결과 코드, `MP_*`
- `raw/donghae/robots.txt.404.html`: robots.txt 404, 공통 404 마크업
- `raw/donghae/BD_loginForm.do.html`: 로그인 폼, `ND_loginAction.do`, NICE 재인증 분기
- `raw/donghae/fclty_1000_1600_autocamping.html`, `fclty_1000_1700_caravan.html`, `fclty_1000_1100_1101_hanok.html`: 구역 정보
- `raw/donghae/useGuidance01.jsp.html`: 예약안내 (D−30, 오픈 시각, 3박4일, 회원가입 필요)
- `raw/donghae/notice_20210217101522607_rules.html`: 11시 오픈, 연박 선점 효과
- `raw/donghae/notice_20260721173512015_one_room_per_day.html`: 1인 1일 1객실
- 원본을 저장하지 않고 본문만 인용한 공지: 20241113132431455(점검 중단), 20251016190925018(당일 자정 결제)
- 원본을 저장하지 않고 본문만 인용한 페이지: 회원가입 약관(`BD_NiceAuthentication.do` 본인인증), 1200·1800 상세
- `raw/donghae/requests.log`: 1~7장 조사 때 보낸 요청 목록. `.gitignore`의 `*.log`에 걸려 커밋되지 않았고, 워크트리를 지울 때 함께 사라졌다.
- `raw/donghae/requests-queue.txt`: 8장 기록 때 보낸 요청 목록
- `raw/donghae/queue_step1_enter.requests.json`, `queue_step2_calendar.requests.json`: 8장 기록의 문서·XHR 요청과 응답 본문(헤더·쿠키 제외, 값 가림)
- `raw/donghae/BD_reservationOrigin.do_2026-10.html`: 2026-10 달력 화면
