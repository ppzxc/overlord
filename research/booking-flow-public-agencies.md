# 공공 대형 예약처(숲나들e, 국립공원)의 예약 단계 구조 (2026-10-26)

[#161](https://github.com/ppzxc/overlord/issues/161)을 풀려고 조사했다. 지도는 [#160](https://github.com/ppzxc/overlord/issues/160)이다. 질문은 "`foresttrip`과 `knps`에서 자리를 잡는 단계가 어떻게 생겼고, 결제 전에 멈출 수 있으며, 자동화할 수 있는가"이다. 공개 GET만 보냈고(호스트마다 4초 이상 간격), 로그인·예약·결제·POST는 보내지 않았다. 이미 알려진 사실([`forest-login-probe.md`](forest-login-probe.md), [`provider-residual-verification.md`](provider-residual-verification.md), [`forest-login-conditions.md`](forest-login-conditions.md), `research/raw/knps/`)은 다시 조사하지 않고 인용만 한다.

## 핵심 결론

- **두 예약처 모두 "예약 신청 → 결제 만기 안에 결제 → 확정" 순서이고, 결제 전에 자리를 쥔 상태가 있다.** 사람이 나중에 결제할 수 있다. 숲나들e는 약관에 만기가 적혀 있다(예약일 다음 날 23:00까지, 사용일 7일 이내 예약이면 예약 시각부터 3시간). 국립공원은 만기 일시를 예약 응답이 주며 공개 자료에 길이가 없다(확인 불가).
- **국립공원의 예약 요청에는 캡차(자동예약 방지숫자)가 들어 있다.** `registerCampReservation.do` 본문에 `captcha` 필드가 있고, 화면 JS는 `/reserCaptcha.do` 이미지를 보여 주고 값이 빈 채로는 전송하지 않는다. 캡차는 예약 단계에만 있고 조회와 로그인 폼 JS에는 없다. 서버가 값을 얼마나 엄격히 검증하는지는 확인 불가(요청을 보내지 않았다). 숲나들e도 예약 확정 단계에 `captchaImg.do`가 있다(선행 조사 [`forest-login-probe.md`](forest-login-probe.md), 로그인한 화면의 JS 읽기). 예약 신청 단계 자체의 URL과 메서드는 로그인 뒤 화면에만 있어 확인 불가.
- **약관상 자동 예약이 조회보다 훨씬 직접적으로 걸린다(숲나들e).** 국립자연휴양림 이용약관 제10조 1항은 "본인이 직접" 예약 신청하도록 하고, 제18조 1항 4호는 "별도 프로그램 등을 이용한 비정상적인 방법으로 자연휴양림 예약을 한 경우"를 예약 취소, 퇴실, 회원권한 상실 또는 3년 이내 이용정지 사유로 둔다. 조회는 해석이 갈렸지만(ADR 0004) 예약 자동화는 이 조항의 문언에 해당한다고 읽는 편이 자연스럽다. 국립공원은 약관 본문을 공개 경로에서 찾지 못해 자동 예약 금지 문구는 확인 불가이고, 화면이 "자동예약 방지숫자"를 둔 것이 운영자의 의사 표시다.
- **미결제 불이익은 예약처마다 다르다.** 숲나들e 약관은 결제유예기간 안에 결제하지 않으면 "예약신청은 취소된다"고만 적고 제재 문구가 없다. 국립공원은 "미 결제시 자동 취소"이고, 부도자 제한(1회 1개월, 2회 이상 3개월)은 사용 예정일 당일 12시 이후 취소나 미사용에 걸린다. 결제 전 만기 자동 취소가 부도로 세어지는지는 확인 불가.
- **결제 경로와 예약 경로의 접근 금지 목록은 아래 5절에 있다.** 숲나들e의 예약 신청 경로 이름은 공개 자료로는 얻지 못했다(확인 불가).

## 1. 예약 단계 순서

### 국립공원공단 (`reservation.knps.or.kr`, 야영장)

출처는 화면 JS `campsite.js`와 화면 HTML(둘 다 `research/raw/knps/`에 있는 기록을 다시 읽었다. 직접), 이용안내 화면이다.

1. **조회**: 야영장을 고르면 NetFunnel `reservation2` 뒤에 `POST /reservation/campsiteList.do`로 달력이 온다(기존 조사).
2. **칸 선택**: 달력 칸의 `data-reser_tp`가 `R`이면 "예약하기", `W`면 "대기예약하기"이다. 칸 클래스 `_N`(예약가능)이 `R`, `_W`(대기가능)가 `W`에 해당한다(`raw/knps/campsiteList.do_B252001.html.gz`의 칸 속성, 직접). 1박 또는 다음 날 칸도 `R`이면 2박 3일을 고를 수 있다.
3. **로그인 확인**: `reservation_before_auth()`가 `/reservation/auth.do`를 부른다(`callAjax`의 기본 메서드가 POST, `common.js` 직접). 401이면 로그인 팝업(`/mmb/mmbLoginPopup.do`, 로그인은 `POST /mmb/mmbLoginProc.do`의 `mmbId`·`passWd`)을 띄운다. 비회원 로그인은 본인인증(휴대폰 `checkplus`, 아이핀, 공동인증서 경로)을 거친다(`common.js`의 `nonMemberLoginProc`와 화면 form, 직접).
4. **캡차와 동의**: 로그인 확인 뒤 "자동방지 입력문자" 팝업이 열려 `/reserCaptcha.do?dummy=<ms>` 이미지를 보여 준다. 입력칸이 비면 "자동예약방지글을 입력해주세요."로 막는다. 무공해영지는 주의사항 체크, 장애인·유공자 감면 자격이 있는 영지는 자격구분과 민감정보 동의가 더 필요하다(직접).
5. **예약 요청**: `POST /reservation/registerCampReservation.do`. 본문 필드는 `prdId`, `deptId`, `useBgnDtm`, `useEndDtm`, `reserTp`, `checkPerVal`, `price`, `nextPrice`, `captcha`, `optAmtTotal`, `selectedOptions`, `isGreenpoint` 등이다(JS 읽기, 직접). 이 호출을 감싸는 NetFunnel 호출은 JS에 없다.
6. **임시 점유**: 응답 `resultCd == "S"`이면 화면이 "예약이 완료되었습니다. 결제 만기일시는 …까지입니다. 미 결제시 자동 취소되니 유의 하시기 바랍니다."와 "결제하기" 버튼을 보여 주고, 버튼은 `/mypage/selectReservationPayment.do?rsvtId=<id>&prdDvcd=C`로 간다. `reser_tp == 'W'`이면 "대기신청이 완료되었습니다"만 나오고 결제 버튼이 없다(직접). 화면 문구는 "마이페이지 → 나의예약목록에서 결제까지 완료하셔야 예약이 확정됩니다"이다.
7. **결제**: `selectReservationPayment.do` 화면에서 카드, 실시간 계좌이체, 무통장(가상계좌) 중에서 한다(예약·환불정책 화면, 직접).
8. **확정**: 결제 완료 시. 결제 만기 안에 못 하면 자동 취소된다.

**결제 만기 길이는 확인 불가다.** 예약 응답의 `sttlmMtDtm2`가 주는 값이고 공개 화면과 JS에는 숫자가 없다. 추첨 당첨 건은 발표일부터 3일간 결제라고 적혀 있지만(예약·환불정책 화면) 선착순 예약의 만기와 같다는 근거는 없다.

**대기예약(W)의 의미**: 야영장 대기는 원 예약자가 아직 결제하지 않아 예약 상태인 자리에만 신청할 수 있고, 원 예약자가 결제하면 대기가 자동 취소된다. 대기자는 원 예약자가 취소하거나 만기를 넘기면 예약자로 전환되고 안내 문자가 가지만 문자는 부가서비스라 못 받아도 보상하지 않는다. 사용 예정일 2일 전 밤 12시에 대기자는 일괄 취소된다(예약·환불정책 화면, 직접). 곧 `_N`(바로 예약 가능)이 뜬 칸과 `_W`(대기가능) 칸은 다른 경로다. 미결제 자동 취소로 풀린 자리는 다시 `_N`이 되어 선착순으로 잡히는 것으로 읽히지만, 풀린 순간에 대기자 전환이 먼저 일어나는지는 확인 불가.

### 숲나들e (`www.foresttrip.go.kr`, 휴양림·야영장)

출처는 산림휴양통합플랫폼 이용약관(제9조), 국립자연휴양림 이용약관(제10조~제12조), FAQ, 휴양림별 예약정책안내, 추첨 이용안내(모두 공개 GET, 직접)와 선행 조사다.

1. **로그인**: 약관 제9조 1항이 순서를 "회원 로그인, 예약 신청, 예약금 결제방법 선택 후 결제"로 정한다. 로그인 절차는 [`forest-login-probe.md`](forest-login-probe.md)가 기록했다(`crawlingCheck.do`, `POST /com/login`).
2. **조회**: 월별 현황과 시설 검색(선행 조사). 대기열은 화면과 상품 목록에 걸린다(`action3`, `action8`).
3. **예약 신청**: 어느 URL과 메서드인지는 로그인 뒤 화면의 인라인 JS에만 있어 **확인 불가**다. 공개 정적 JS(`/js/netfunnel.js`, `/js/parameter.js`, `/js/validation.js`, `/portal/js/common.js`, `commonPot.js`, `menu.js`)에는 예약 신청 경로가 없었다. 선행 조사가 로그인한 월별 현황 화면에서 `captchaImg.do` 호출을 봤고 예약 확정 단계에서 쓰인다고 적었다.
4. **임시 점유**: 약관이 "예약성립은 예약신청 후 결제유예기간 내에 결제를 완료하여야 하며 그렇지 않을 경우 예약신청은 취소된다"고 정한다(통합약관 제9조 2항, 국립 약관 제10조 2항). 유예기간은 통합약관에 **예약일의 다음 날 23:00까지, 예약일이 사용일로부터 7일 이내이면 예약 시각으로부터 3시간**이다. 국립 약관 제11조 2항은 결제 기한을 산림청고시 「국립자연휴양림 이용료 기준」에 맡긴다. 이 고시 원문은 읽지 못했다(확인 불가). 두 문서의 값이 같은지, 휴양림마다(공립·사립) 다른지도 확인 불가.
5. **결제**: 신용카드, 가상계좌, 실시간 계좌이체(국립 약관 제11조 1항, 현장 예약은 현금 가능).
6. **확정**: 결제 완료 시 성립. 날짜 변경은 불가하고 취소 후 재예약이다(FAQ).

**숲나들e의 대기(대기신청)**: 먼저 예약한 사람이 취소할 때만 차순위 대기자가 예약할 수 있고, 별도 연락이 없을 수 있으며, 알림톡·문자는 부가서비스다. 대기에서 예약으로 바뀌면 "마이페이지 → 예약신청내역 → 결제대기내역"에서 "대기예약확정"을 눌러 결제한다(FAQ, 직접). 휴양림별 예약정책안내 표에도 "대기" 열이 있다.

**개시 시각(국립 휴양림)**: 비수기 주중은 사용일 6주 전 수요일 09:00, 주말은 월 추첨(신청 매월 4일 09:00~9일 18:00, 발표 10일 16:00)이고 미당첨·미결제분은 매월 15일 09:00에 6주 정책으로 선착순 전환된다(FAQ, 추첨 이용안내). 시설별 개시 시각은 응답에서 읽는다는 것이 [`forest-login-probe-2.md`](forest-login-probe-2.md)의 결론이다. 이 문서는 오픈 시각 선점형을 다루지 않는다.

## 2. 단계별 장벽

| 단계 | 국립공원공단 | 숲나들e |
|---|---|---|
| 로그인 | 아이디·비밀번호(`mmbLoginProc.do`). 로그인 폼 JS에 캡차 없음. 비회원은 본인인증(휴대폰, 아이핀, 공동인증서) | `crawlingCheck.do` 봇 판별(2026-10-20 스파이크에서 통과), 캡차 없음, 가입은 실명 본인인증으로 읽힘(선행 조사) |
| 조회 | NetFunnel `landingCamp`·`reservation2`(평일 오후 즉시 통과, 기존 조사) | NetFunnel(`action3`·`action8` 등), 로그인 필요(기존 조사) |
| 자리 선택 | 없음(칸 클릭, 화면 JS) | 확인 불가 |
| 예약 신청 | **캡차(자동예약 방지숫자)**, 무공해영지·감면 자격이 있는 영지는 동의·자격 입력. 이 요청을 감싸는 NetFunnel은 JS에 없음 | `captchaImg.do`(선행 조사). 신청 단계의 대기열·봇 탐지는 확인 불가 |
| 결제 | 별도 화면, 결제수단 대화상자(자동화 대상 아님) | 같음 |

- 캡차는 두 예약처 모두 **예약 단계에 있고 조회에는 없다**. 자동 예약은 이 캡차를 사람이 풀지 않고는 지나갈 수 없다고 읽는 것이 기본값이다. 캡차를 우회하거나 푸는 일은 ADR 0002가 거절로 본 선("봇 탐지는 거절의 의사")과 같은 종류라 이 조사는 그 가능성을 따지지 않는다.
- 서버 쪽에서 캡차 값을 정말 검증하는지, 틀렸을 때 횟수 제한이 있는지, 같은 세션에서 반복해도 되는지는 요청을 보내야 알 수 있어 확인 불가다.
- 본인인증은 국립공원 비회원 경로에서만 보였다. 회원 로그인에는 JS상 본인인증이 없다.

## 3. 결제 전에 멈출 수 있는가

- **국립공원**: 가능하다. 예약 직후 상태는 "예약"이고 결제는 `selectReservationPayment.do`의 별도 단계다. 만기 안에 사람이 결제하면 된다. 단 만기 길이를 모르므로 "사람이 몇 시간 안에 결제하러 와야 하는가"는 확인 불가이고 실예약 없이는 공개 자료만으로 알 수 없다. 대기예약(`W`)은 점유가 아니라 순번이다.
- **숲나들e**: 가능하다. 약관상 신청과 결제가 분리되고 유예기간이 있다. 사용일 7일 이내 예약은 3시간뿐이라, 임박한 자리일수록 사람이 결제할 시간이 짧다.
- 두 곳 모두 점유가 만기에 풀리고 풀린 자리가 다시 빈자리로 나타난다. 이것이 취소표의 한 원천이다(추첨 이용안내가 "미결제건 선착순 개시"를 명시, 국립공원도 미결제 자동 취소 건을 선착순으로 돌린다고 적는다).

## 4. 예약·취소 관련 약관과 정책

### 숲나들e

- **자동 예약**: 국립자연휴양림 이용약관 제10조 1항은 이용하려는 사람이 "본인이 직접" 숲나들e 누리집으로 예약 신청하도록 한다. 제18조 1항 4호는 "별도 프로그램 등을 이용한 비정상적인 방법으로 자연휴양림 예약을 한 경우"를 예약 취소, 퇴실, 회원권한 상실 또는 3년 이내 이용정지 사유로 둔다. 같은 조 2항은 이 사유로 예약이 취소되어도 위약금은 제12조 2항(고시 기준)을 준용한다고 한다. 통합약관 제7조 2항 5호(약관이 금지하거나 반하는 행위)로 회원 자격 제한·정지·상실도 가능하다. 허용하는 문구는 어디에도 없다.
- **약관 변경**: 국립 약관 제5조 2항은 변경을 7일 전 공지하고, 회원에게 불리하면 30일 전 공지와 개별 통지를 요구한다. 통합약관 제3조 5항은 부당·불법 행위 조치를 위한 개정은 유예 없이 공지로 효력이 생긴다고 한다([`forest-login-conditions.md`](forest-login-conditions.md)). 두 약관의 기준이 달라 어느 쪽이 적용되는지 확인 불가.
- **한도**: 국립자연휴양림은 1인 월 최대 15건, 같은 휴양림은 최대 10건이다(FAQ). 국·공·사 정책이 다르다고 적혀 있다.
- **미결제**: 결제유예기간 안에 결제하지 않으면 예약신청이 취소된다. 노쇼·부도 같은 별도 제재 문구는 읽은 약관에 없다(확인한 범위 안에서).
- **위약금**: 국립 유명산 예시(시설 단위 페이지이고 모든 휴양림이 같은지는 확인 불가, 고시 원문 미확인).
  - 비수기: 사용 예정일 2일 전까지 전액 환불, 1일 전 10%(주중)·20%(주말) 공제, 당일 20%·30% 공제.
  - 성수기: 5일 전까지 전액 환불, 4일 전 10%·20%, 3일 전 30%·40%, 2일 전 50%·60%, 1일 전 80%·90%, 당일 100%.
  - 기상재해 등으로 접근이 불가하거나 휴양림 사정으로 못 쓰면 위약금이 없다.
- 예약 양도·매매·교환은 제재 대상이다(통합약관 제7조 2항 6호, 제15조 5호).

### 국립공원공단

- **자동 예약**: 이용약관 본문을 공개 경로에서 찾지 못했다(`/mmb/` 아래 가입 약관 경로는 404이고, 푸터는 저작권정책·개인정보처리방침만 연다). 그러므로 자동 예약을 금지하거나 허용하는 문구는 **확인 불가**다. FAQ(28건 중 첫 쪽 10건 안팎만 읽었고 쪽 이동이 되지 않았다)·공지·예약·환불정책 화면에도 자동화·매크로 문구는 없었다. 화면은 캡차를 "자동예약 방지숫자"로 부른다.
- **한도**: 예약·환불정책 표는 "최대 예약 건수 1개월 내 4건"을 적고 대피소(지리산 6건)·탐방로(우이령)는 예외, **야영장은 동일 날짜 중복 예약 불가**라고 적는다. 최대 이용기간은 야영장 2박 3일(표를 글로 풀면 열 대응이 모호해 이 값은 JS의 1박·2박 선택과 일치하는 것만 인용한다). 대기 신청은 1인당 월 3건이고 최대 예약 건수에 이르면 잔여 대기가 자동 취소된다.
- **취소와 위약금**(예약자 책임 사유): 사용 예정일 3일 전 또는 결제 당일 취소는 전액 환불, 2일 전 10% 공제, 1일 전 20% 공제, 당일(이용 당일 12시 전) 30% 공제에 부도자 제한, 미사용은 환불 없음에 부도자 제한. 환불은 영업일 기준 3~7일.
- **부도자 이용 제한**: 1회 1개월, 2회 이상 3개월. 벌칙 뒤 1년간 부도가 없으면 기록이 사라진다. 이용 당일 12시 전에 본인이 취소하면 부도가 면제되고 관리자 취소는 부도로 처리된다.
- **미결제**: 결제 만기를 넘기면 자동 취소(화면 문구). 부도 집계 여부는 확인 불가.

## 5. 접근 금지 목록 후보 (읽기만 했고 호출하지 않았다)

ADR 0002는 예약, 결제, 취소, 회원정보 경로를 예약처마다 접근 금지 목록에 넣도록 정했다. 자동 예약을 허용한다면 아래 가운데 **예약 신청 경로만** 예외 후보이고 결제 경로와 나머지는 계속 금지다. 메서드는 JS의 `ajaxCall` 기본값(POST)과 `form method`에서 읽었다.

### `knps` (`reservation.knps.or.kr`, 직접 JS·HTML 읽기)

| 경로 | 메서드 | 성격 |
|---|---|---|
| `/reservation/registerCampReservation.do` | POST | **예약 신청(임시 점유)**. 자동 예약이 허용될 때의 유일한 후보 |
| `/reservation/auth.do` | POST | 예약 직전 로그인 확인(401이면 로그인) |
| `/reserCaptcha.do?dummy=<ms>` | GET | 캡차 이미지 |
| `/reservation/campsite/selectOptionList.do` | POST | 예약 화면의 옵션 목록(예약 화면 보조 조회, 읽기 성격) |
| `/mypage/selectReservationPayment.do?rsvtId=…&prdDvcd=C` | GET | **결제 화면**. 계속 금지 |
| `/pay/iPinForPay.do`, `/pay/checkPlusForPay.do`, `/common/authGpkiForPay.do`, `/common/authGpki.do` | 폼 POST(화면 JS가 설정) | 본인인증·결제용 인증. 계속 금지 |
| `/mmb/mmbLoginProc.do` | POST | 로그인(`mmbId`, `passWd`, `loginType`) |
| `/mmb/mmbLoginPopup.do` | POST | 로그인 팝업 HTML |
| `/mmb/snsCheckPlus.do`, `/mmb/snsCheckError.do` | 폼 POST | 간편 로그인 본인인증 |
| `/mypage/dashBoard.do`, `/mypage/couponList.do`, `/favorites/selectFavoritesList.do`, `/talk/searchTalkTransmissionHistory.do` | GET | 회원 개인 화면 |
| `/srchrefund/searchRefund.do` | GET | 미환불금 조회(본인인증 경로) |

취소 경로는 이번에 읽은 정적 JS(`campsite.js`, `common.js`, `scripts.js`)에 없다. 마이페이지 화면의 JS에 있을 것으로 보이나 로그인 뒤 화면이라 **확인 불가**다.

### `foresttrip` (`www.foresttrip.go.kr`)

| 경로 | 메서드 | 성격 | 출처 |
|---|---|---|---|
| `/com/login`(폼), `/com/crawlingCheck.do`, `/com/logout`, `/com/alert.do`, `/pot/mc/pu/updatePssrdChngExpiredView.do` | POST/GET | 로그인, 봇 판별, 로그아웃, 로그인 뒤 안내, 비밀번호 변경(회원정보) | [`forest-login-probe.md`](forest-login-probe.md) |
| `captchaImg.do` | 확인 불가 | 예약 확정 단계의 캡차(전체 경로 미확인) | 같은 문서 |
| 예약 신청, 결제, 취소, 대기 신청, 대기예약확정 경로 | 확인 불가 | 로그인 뒤 화면의 인라인 JS에만 있다. 공개 정적 JS에는 없다 | 이번 조사 |
| `/rep/drlts/{wknd,hdmss,month,area}/drltsMain.do` | GET(화면). 신청 요청은 확인 불가 | 추첨 신청 화면. 공개 추첨 이용안내가 NetFunnel `action6` 뒤 이동으로 연결한다 | 추첨 이용안내, 직접 |
| `/rep/cndtl/cndtlRsrvtMain.do` | GET이 401 | 공개 메뉴에 걸려 있으나 로그인 요구. 용도는 확인 불가 | 직접(HTTP 401만 확인) |
| `/pot/is/gs/selectGnrlSrchView.do` | GET | robots가 막는 통합검색 | [`forest-login-conditions.md`](forest-login-conditions.md) |

숲나들e의 예약 신청 경로 이름은 로그인한 세션에서 읽은 화면 JS가 있어야 알 수 있다. 이 조사의 제약(로그인 금지)으로는 얻을 수 없다. 이는 후속 조사(사용자 본인 계정으로 화면 JS만 읽기)의 몫이다.

## 6. 확인 불가 목록

- 국립공원 선착순 예약의 결제 만기 길이. 숲나들e 국립 휴양림의 결제유예기간 고시 값(약관은 통합약관 값만 확인).
- 두 예약처의 캡차 서버 검증 강도, 오답 횟수 제한, 예약 요청 자체의 대기열·봇 탐지.
- 숲나들e의 예약 신청, 취소, 대기 신청 URL과 메서드.
- 국립공원 이용약관 본문과 자동화 관련 문구. 국립공원의 취소 경로.
- 결제 전 만기 자동 취소가 국립공원 부도로 세어지는지.
- 풀려난 자리를 대기자와 일반 예약자 가운데 누가 먼저 잡는지(두 예약처 모두).
- 제재 사례(자동 예약으로 정지된 사례). 이번에는 찾지 않았다. 선행 조사도 자동 조회 사례를 찾지 못했다.
- 숲나들e `/pot/rm/ri/selectUsNoteListView.do`(휴양림 이용안내)는 302로 나가 읽지 못했다.

## 7. 조사 방법

- 2026-10-26에 `reservation.knps.or.kr`, `www.knps.or.kr`, `www.foresttrip.go.kr`로 GET만 보냈다. UA는 `overlord-availability-poller/0.1 (research)`이고 호스트마다 요청 사이는 4초 이상이다. 403과 429는 받지 않았다. 확인한 비정상 응답은 `reservation.knps.or.kr`의 404 두 건(추측한 약관 경로), 숲나들e `cndtlRsrvtMain.do`의 401 한 건, `selectUsNoteListView.do`의 302 한 건이다.
- 국립공원: `contents/C/serviceGuideIntro.do`, `contents/rsvtRefundPolicy.do`, `contents/usagePolicy.do`, 공지·FAQ 목록, `assets/js/common.js`, `assets/js/scripts.js`, `www.knps.or.kr` 두 화면. `campsite.js`와 달력 HTML은 기존 기록(`research/raw/knps/`)을 다시 읽었다.
- 숲나들e: 이용약관, 국립 이용약관(`selectRsrvtTermsView.do`), 위약금정책(`selectFcltUseGdncView.do`), 휴양림별 예약정책안내, 추첨 이용안내, FAQ, 공지 목록, 정적 JS 6개. 마지막 두 약관·위약금 페이지는 웹 검색(`law.go.kr`, `forest.go.kr`, `foresttrip.go.kr`로 제한)에서 주소를 얻었다.
- 보내지 않은 것: 로그인, 예약, 결제, 취소, 모든 POST, 캡차 이미지 요청, NetFunnel 요청.
- 이 문서에는 세션 값, 토큰, CSRF 값, 쿠키, 응답 원문을 넣지 않았다. 내려받은 화면은 작업 폴더에서만 읽었고 저장소에 올리지 않았다.

## 출처 (모두 2026-10-26 조회, 공개 GET)

- `https://reservation.knps.or.kr/contents/rsvtRefundPolicy.do` (예약·환불정책)
- `https://reservation.knps.or.kr/contents/usagePolicy.do`, `/contents/C/serviceGuideIntro.do`, `/community/board/faq/boardList.do`, `/community/board/notice/boardList.do`
- `https://reservation.knps.or.kr/assets/js/common.js`, `/assets/js/scripts.js`, `/assets/js/reservation/campsite.js`(기존 기록)
- `https://reservation.knps.or.kr/reservation/searchSimpleCampReservation.do`(기존 기록)
- `https://www.foresttrip.go.kr/pot/cc/sc/selectSiteUsCndtnView.do?hmpgId=FRIP&menuId=006004001` (산림휴양통합플랫폼 이용약관)
- `https://www.foresttrip.go.kr/pot/rm/ug/selectRsrvtTermsView.do?hmpgId=0101&menuId=004004&ruleId=300` (국립자연휴양림 이용약관)
- `https://www.foresttrip.go.kr/pot/rm/ug/selectFcltUseGdncView.do?hmpgId=0101&menuId=004002002&ruleId=202` (유명산 위약금정책)
- `https://www.foresttrip.go.kr/pot/cc/fa/selectFaqBbrssListView.do?hmpgId=FRIP&menuId=004004&bbrssMsterId=BBRSSMSTER_00000002` (FAQ)
- `https://www.foresttrip.go.kr/pot/cc/bb/selectFripRsrvtPolcyView.do?hmpgId=FRIP&menuId=002001` (휴양림별 예약정책안내)
- `https://www.foresttrip.go.kr/rep/drlts/drltsUseGdnc.do?hmpgId=FRIP&menuId=001003004` (추첨 이용안내)
- `https://www.foresttrip.go.kr/main.do?hmpgId=FRIP`, `/js/netfunnel.js`, `/js/parameter.js`, `/js/validation.js`, `/portal/js/common.js`, `/portal/js/commonPot.js`, `/portal/js/menu.js`
