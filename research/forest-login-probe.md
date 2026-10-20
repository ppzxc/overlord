# 숲나들e 로그인 조회 스파이크: 봇 판별 통과, 잔여 응답 모양 (2026-10-20)

[#132](https://github.com/ppzxc/overlord/issues/132)를 풀려고 사용자의 본인 계정으로 한 번 로그인해 조회 흐름을 끝까지 따라가 봤다. [ADR 0004](https://github.com/ppzxc/overlord/pull/131)(미머지) 조건 안에서 실행했다. 예약, 결제, 취소, 회원정보 수정 경로는 부르지 않았다. 세션 값, 토큰, CSRF 값, 계정 정보, 응답 원문은 이 문서와 `research/raw/`에 넣지 않았다. 응답 원문은 작업 폴더에서만 쓰고 지웠다.

## 핵심 결론

- **`crawlingCheck.do`는 통과했다.** 로그인 화면이 열릴 때 부르는 이 호출을 페이지 JS와 같은 방식으로 한 번 보냈다. 플러그인이 없는 클라이언트라서 본문은 `param=noData`였고, 응답은 `true`였다. 플러그인 이름을 지어 넣거나 UA를 바꾸지 않았다. 로그인 뒤 조회 화면에서는 이 호출이 다시 나오지 않았다. ADR 0004 조건 1(막히면 멈춘다)은 이번에는 발동하지 않았다. 서버가 거짓을 내는 조건은 여전히 모른다.
- **로그인과 조회는 curl 수준의 클라이언트로 된다.** 캡차는 로그인에도 조회에도 없었다. 월별 현황 화면에는 `captchaImg.do` 호출이 있지만 예약 확정 단계에서 쓰이고, 조회 요청에는 캡차 값이 들어가지 않는다.
- **잔여는 상품 하나(`goodsId`)와 날짜 하나마다 상태 코드로 온다.** 남은 수는 없다. 상품이 곧 객실 하나 또는 야영 자리 하나다. 상태에 추첨(`DRLTS`)과 우선예약(`PRIOR`) 표시가 있다.
- **유형은 구역 후보이고 상품은 자리 후보다.** 상품 응답이 `goodsClsscCd`(예: `02002`)와 `goodsClsscNm`(야영데크)을 함께 준다. 이 필드는 로그인 응답에서만 보인다.
- **세션과 잔여 호출량은 아직 모른다.** 아래 "모르는 것" 참고.

## 로그인

1. `GET /com/login.do?targetUrl=/main.do?hmpgId=FRIP`로 로그인 화면과 `JSESSIONID` 쿠키, 화면 안의 `_csrf` 값(36자 UUID)을 받는다.
2. 화면이 열릴 때 `POST /com/crawlingCheck.do?_csrf=<값>`에 `param=noData`를 보낸다. 응답 `true`.
3. `POST /com/login`(폼, `application/x-www-form-urlencoded`)에 `_csrf`, `loginId`, `loginPwd`, 빈 값의 `socialToken`·`passCI`·`simpleCI`, `targetUrl=/main.do?hmpgId=FRIP`을 보낸다. `saveId`는 보내지 않았다.
4. 성공하면 `302`로 `/com/alert.do`로 보낸다(아래). 실패하면 `403`과 화면 안의 `loginErrorCode`(비밀번호 불일치는 `-6`, "입력하신 아이디 또는 비밀번호가 회원정보와 일치하지 않습니다")가 온다.
5. 이 계정은 "3개월 이상 비밀번호를 변경하지 않으셨습니다"라는 안내 때문에 `/com/alert.do`가 비밀번호 변경 화면(`/pot/mc/pu/updatePssrdChngExpiredView.do`)으로 보낸다. 이 경로는 회원정보 수정이라 따라가지 않았다. 따라가지 않아도 같은 세션으로 월별 현황과 조회 AJAX가 열렸다.
6. 로그아웃은 `POST /com/logout`(`_csrf`)이고 `302`로 `/main.do`다. 로그아웃 뒤 월별 현황은 다시 `401`과 `loginErrorCode = "-5"`였다.

쿠키는 `JSESSIONID`(만료 없는 세션 쿠키, `Secure`, `HttpOnly`)와 `WMONID`(1년 가까운 만료)다.

## 조회 흐름

월별 현황 화면(`GET /rep/or/sssn/monthRsrvtStatus.do?hmpgId=FRIP&menuId=001004`)은 로그인한 세션에서 `200`이다. 화면의 JS가 `$.ajaxSetup`으로 모든 AJAX에 `Content-Type: application/json; charset=UTF-8`과 `X-CSRF-TOKEN: <_csrf 값>`을 단다. JSON 본문을 이 `Content-Type` 없이 보내면 `415`다. 화면 이동과 데이터 호출에 NetFunnel(`nf.foresttrip.go.kr`, `sid=service_1`)이 걸리고, 이번 시간대(화요일 오후)에는 5101이 모두 첫 응답에서 `nwait=0`, `ttl=0`이었다.

| 단계 | 요청 | 대기열 | 얻는 것 |
|---|---|---|---|
| 화면 | `GET monthRsrvtStatus.do` | `aid=action3` 키를 `NetFunnel_ID` 쿠키로 | 화면(약 258KB), `_csrf`, 월 선택(오늘부터 3개월) |
| 유형 | `POST /rep/or/selectSthngListForMonthRsrvt.do` `{insttId}` | 없음 | `sthngList[]`(`upperGoodsClsscCd` `01` 숙소, `02` 야영)와 `rsrvtPolcy`(`rsrvtCycleTpeCd` `WEEK`/월별, `weekLastDay`, `monthLastDay`, 예약 개시 시각 `rsrvtBgnTm`) |
| 상품 | `POST /rep/or/sssn/selectRsrvtGoodsListForMonthRsrvt.do` `{insttId, upperGoodsClsscCd, inqurSctin, srchDate, lastDay, netfunnelKey}` | `aid=action8` 키를 본문 `netfunnelKey`와 `NetFunnel_ID` 쿠키로 | 상품 목록 `rsrvtGoodsList[]`, 날짜 머리 `rsrvtPssblDtList[]`, 휴무일 `hldtInfoList[]`, 환불 규정 |
| 잔여 | `POST /rep/or/selectRsrvtAvailInfoListForMonthRsrvt.do` `{insttId, upperGoodsClsscCd, goodsIdList, srchDate, lastDay, inqurSctin}` | 없음 | 상품×날짜 상태 행 |

- `inqurSctin`은 `01`(월별 보기)을 썼다. `02`는 "예약가능일자 검색"이고 `WEEK` 주기 시설에만 보인다(화면 JS 읽기, 호출하지 않았다).
- `srchDate`는 월 선택 값(`YYYYMM`)이고 `lastDay`는 `selectSthngListForMonthRsrvt.do`의 `weekLastDay`와 `monthLastDay` 중 큰 값이다(이번에는 `20261124`, 오늘 `20261020`부터 약 35일).
- 페이지는 상품을 5개씩 묶어 잔여 호출을 반복한다(`splitCnt = 5`). 한 번에 더 많이 보내는 것은 시험하지 않았다.
- 대기열은 데이터 호출 뒤 `5004`(`setComplete`, `aid=action8`)로 닫았다. `200`이었다.

## 응답의 모양

시험 시설은 유명산(`0101`)이다.

- 상품 목록은 야영(`02`) 50개, 숙소(`01`) 54개였다. 상품 하나는 `goodsId`, `goodsNm`(야영은 `야영데크(101)`, 숙소는 `고라니`, `꾀꼬리` 같은 방 이름), `goodsClsscCd`·`goodsClsscNm`(`02002` 야영데크, 숙소는 `01002` 휴양관 30·`01001` 숲속의집 15·`01003` 연립동 9), `mnmmAccptCnt`·`mxmmAccptCnt`(기준·최대 인원), `insttArea`(면적)를 가진다. 이 `goodsClsscCd`가 [구조 조사](forest-facility-structure.md)의 시설 홈 드롭다운 코드와 같은 값이다.
- 잔여 행은 상품 하나의 하루다. 5개 상품에 날짜 34일(이번 달 1일부터 `lastDay` 이전까지)로 170행이 한 번에 왔다. 행마다 `useDt`, `rsrvtAvail`, `rsrvtCnt`, `wtngCnt`, `goodsMxmmWtngCnt`, `wtngPssblYn`, `mxmmStngDayCnt`(최대 연박, 이번에는 3), `dywk`가 있다.
- **상태 해석**(화면 JS `dispGoodsTr`, 직접 읽음):

  | `rsrvtAvail` | 조건 | 화면 표시 | 뜻 |
  |---|---|---|---|
  | `Y` | `rsrvtCnt == 0` | 예 | 예약 가능 |
  | `Y` | `rsrvtCnt > 0`, `wtngPssblYn == 'Y'`이고 `wtngCnt < goodsMxmmWtngCnt` | 대N | 마감, 대기 가능 |
  | `Y` | 그 밖의 `rsrvtCnt > 0` | 완 | 마감 |
  | `PRIOR` | | 우 | 우선예약 |
  | `DRLTS`, `WEEKEND_DRLTS` | | 추 | 추첨 |
  | `REPAIR` | | 공 | 공사·수리 |
  | `PRNSL_DAY` | | 휴 | 정기휴무 |
  | `BEFORE_DATE`, `OVER_DATE` | | (빈칸) | 지난 날짜·기간 밖 |

  이번 응답에서 본 값은 `Y`, `PRNSL_DAY`, `REPAIR`, `BEFORE_DATE`다. 야영데크 101은 평일 `Y`에 `rsrvtCnt 0`, 주말 `Y`에 `rsrvtCnt 1`이었다(주말 마감으로 읽힌다). `PRIOR`, `DRLTS`, 대기 가능 행은 이번 표본에 없어 JS 해석만 있다.
- 남은 수는 없다. 칸마다 예약 가능 여부만 있어 **잔여 수를 모르는 예약처**와 달리 자리 단위(상품 하나)로 안다. 자리 번호는 상품 이름에 들어 있다(`야영데크(101)`).

## 모르는 것

- **세션 수명.** `JSESSIONID`는 만료 없는 세션 쿠키이고 서버 쪽 유휴 시간은 모른다. 몇 분 뒤 재조회를 하지 않고 로그아웃했다.
- **호출량.** 상품 5개마다 잔여 호출 한 번이다. 유명산은 야영 50개(10번)와 숙소 54개(11번)이고, 한 달 단위다. 시설 187곳에 3개월을 도는 비용은 계산하지 않았다. 한 호출에 상품을 더 넣거나 `inqurSctin=02`, "예약 가능 시설 검색"(`fcfsRsrvtPssblGoodsDetls.do`) 같은 요약 경로가 있는지는 확인하지 않았다.
- **`crawlingCheck.do`가 거짓을 내는 조건.** 이번에는 `true`였다.
- **시설별 차이.** 한 시설(유명산)만 읽었다. 월별 주기 시설(`rsrvtCycleTpeCd` 월별), 추첨 표시가 나오는 시기, 사립·공립 시설은 보지 못했다.
- **`.env`의 비밀번호에 `$`가 있었다.** 첫 로그인 시도는 셸이 `$`를 풀어 값이 바뀐 채 나가 `-6`으로 실패했다(비밀번호 오류 횟수 1회 소비). 값을 셸 해석 없이 읽자 성공했다. 구현은 설정 값에 변수 확장이 일어나지 않게 읽어야 한다.

## 약관에서 새로 본 것

월별 현황 응답에 국립자연휴양림 이용약관 본문이 실려 온다(`usRgltnVO`). 제18조 1항 4호는 "별도 프로그램 등을 이용한 비정상적인 방법으로 자연휴양림 예약을 한 경우" 예약 취소, 퇴실, 회원권한 상실 또는 3년 이내 이용정지를 둔다. 우리가 하는 일은 조회이고 예약이 아니지만, ADR 0004의 위험 설명에 이 조항이 빠져 있었다. [로그인 조건 조사](forest-login-conditions.md)가 읽은 이용약관과는 다른 문서(국립 시설 약관)이다.

## 조사 방법

- 2026-10-20에 `www.foresttrip.go.kr`와 `nf.foresttrip.go.kr`로 요청을 보냈다. UA는 `overlord-availability-poller/0.1 (research)`이고 요청 사이는 4초 이상이다. 403과 429는 한 번도 받지 않았다(로그인 비밀번호 불일치의 `403`은 이 항목에 해당하지 않는다).
- 로그인 `POST` 2건(첫 건 실패, 둘째 건 성공), `crawlingCheck.do` 2건, 화면 `GET` 3건, 조회 `POST` 6건(유형 1, 상품 2, 잔여 2, 첫 시도 415 1), NetFunnel 5101 3건과 5004 1건, 로그아웃 1건이다.
- 유명산 한 곳, 상품 5개씩 두 묶음만 읽었다.
