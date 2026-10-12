// 울산 중구 야영장 예약처(camping.junggu.ulsan.kr/camping/) 시설·구역 카탈로그. 정적 목록이며 어댑터 로직과 네트워크 코드는 두지 않는다.
// 시설 `ref`는 `{ cpId, menuNo }`다. `cpId`는 `ajaxGetMonthlyMap.do`·`ajaxGetSiteList.do`가, `menuNo`는 예약 화면 `pageCont.do?menuNo=`가 쓴다.
// 구역 = `csId`(이름 `csName`), 자리 = `ctId`(이름 `ctName`)이고 자리 id는 `ctName`이다.
// 출처: 입화산 제2오토는 2026-10-12 20:16~20:25 KST 기록(research/raw/junggu, #78)이다. 황방산(`1020300`)·태화연(`1030300`)은 아직 기록하지 않아 카탈로그에 넣지 않았다(#79).
// 입화산 자연휴양림(별뜨락, `2010400`)은 야영장이 아니라 휴양림 객실이라 넣지 않는다.
//
// 기록으로 확인한 것(#78, 입화산 제2오토 `iphwa_auto2`, `menuNo=1010300`):
// - 구역(csId) 5개: `CP_SPEC_000000000031` 입화산 제2오토A(대형) 11자리(오토(대형)505~521), `…32` A(중형) 8자리(오토(중형)501~518), `…33` A(소형) 5자리(오토(소형)522~527),
//   `…35` B(중형) 6자리(오토(중형)601~606), `…36` B(소형) 6자리(오토(소형)607~612). 예약 화면의 구역 선택 목록(`changeCp`)에서 읽었고 구역마다 `ajaxGetSiteList.do`로 자리를 받아 확인했다.
//   자리 이름이 `오토(대형)505`처럼 한글이 앞서서 자리 필터(`seats:` 토큰 `A02`)로 걸 수 없어 자리 목록은 두지 않는다. 정원은 모든 구역이 1~6인(`csMaxCapacity: 6`)이다.
// - 열린 자리: `ctState: "ACTIVE"`, `ctIsBookable: "Y"`, `ctIsIng: "N"`, `lotteryCount: 0`(2026-10-20, 구역 31·33·35·36 전 자리와 구역 32의 7자리). 화면 JS는 `ctIsBookable == "Y"`이고 `ctIsIng != "Y"`면 "예약하기",
//   `ctIsIng == "Y"`면 "예약진행"(다른 사람이 예약 진행 중, 추첨이 아니다)으로 그린다. 닫힌 값은 `RESERVED`(예약완료, 2026-10-17 구역 31 전부와 10-20 구역 32의 `오토(중형)504`)와
//   `CLOSED`(예약불가, 2026-10-14 구역 31 전부, 조사 때와 같다)이고 `DISABLED`는 화면이 아예 그리지 않는다. 아는 `ctState`는 이 넷이고 그 밖은 구조 변경이다.
//   `ctExclusive`는 화면 JS가 쓰지 않는다("중구민 우선 추첨 사이트" 배치도 표시로 보이며 일부 자리에 `Y`).
// - 선착순과 추첨: `currentAppVO.appProcess`가 `C0L0P1`이다. 화면 JS는 `L1`이 들어 있으면 추첨("현재 N 건 접수"), 아니면 선착순(`L0`)으로 다룬다. `L1` 값은 이 기록에서 보지 못했다.
//   추첨이면 열린 자리로 치지 않는다. `L0`도 `L1`도 없으면 구조 변경이다.
// - 중구민 전용일: `ajaxGetMonthlyMap.do`의 `isExclusive`가 참인 날이다(이 기록에는 없었다). 화면은 그런 날 중구민이 아니면 자리 조회를 하지 않는다. 우리도 보내지 않는다.
//   `ajaxGetSiteList.do`의 `isExclusive`는 화면 JS가 전용일이 아닌 날 빈 문자열(`""`)을 보내므로 그대로 빈 값을 보낸다.
// - 오픈 규칙: `currentAppVO`는 `appProcess: "C0L0P1"`, `appDateType: "ALWAYS"`, `appBgnDay: 1`(10:00)~`appEndDay: 7`(23:59), `ableDateType: "FIXED"`, `ableBgnDate: "2023-03-01"`, `ableEndDate: "2026-10-31"`이다.
//   `appBgnDay`·`appEndDay`가 무엇을 뜻하는지는 값만으로 알 수 없다. 월 지도(10/12~10/31만 `isAbleDate: true`)가 `ableEndDate`와 맞다(동절기 운영 종료일 가능성은 추정).
//   선착순 개시 시각은 미확인이다. 그래서 오픈 경쟁 시간 기본값은 두지 않고, 날짜가 열렸는지는 월 지도(`isAbleDate`)로 거른다.
// - 최대 박수: 서버 값은 못 봤다(`cpMaxStay: 0`, 숙박기간 목록은 로그인 뒤 `ajaxSelecteSite.do` 응답에 있다). 화면 JS 주석에 "2박 3일, 1박 2일"과 `rsStay` 1, 2가 있어 2박까지 있어 보이나 미확인이다. 이 조각은 1박으로 둔다.
// - `main`을 다시 지나는지: 예약 화면의 `fnRev`·`fnRev1`~`fnRev4`는 `NetFunnel_Action({action_id:"main"})` 뒤 해당 `pageCont.do?menuNo=…`로 간다(입화산 1010300, 황방산 1020300, 태화연 1030300, 별뜨락 2010400).
//   상단 메뉴의 `<a href>`는 `main`을 거치지 않고 바로 `pageCont.do`로 간다. 어댑터는 시설마다 `main`을 지난 뒤 그 시설의 `pageCont.do`를 연다(화면 버튼의 흐름).
// - 딥링크: `https://camping.junggu.ulsan.kr/camping/pageCont.do?menuNo=1010300`. 쿠키 없이 보낸 GET도 200이고 대기열을 지난 요청과 본문이 바이트까지 같다. 화면은 로드 때 `NetFunnel_Action`을 부르지 않는다(함수 안에서만 부른다).
//   서버와 JS로 확인했고 브라우저로는 확인하지 못했다.
// - 구역 전환: 화면은 구역을 바꿀 때 `/camping/iphwa_auto2/intro.do?menuNo=1010300&searchCsId=<csId>`로 이동한다. 어댑터는 그 화면을 거치지 않고 `ajaxGetSiteList.do`에 `csId`만 바꿔 보낸다(기록에서 구역 다섯 모두 이렇게 받았다).
// - 접근 금지 경로(화면 링크와 JS에서 확인): 자리 선택 `/camping/ajaxSelecteSite.do`(로그인 필요), 숙박기간 변경 `/camping/ajaxChangeStayGigan.do`(로그인 필요), 예약 제출 `/camping/iphwa_auto2/insert.do`(폼 action, 결제 시작),
//   `pageCont.do?menuNo=5…` 회원 메뉴: 로그인 `5010000`, 회원가입 `5020000`, 아이디/비밀번호 찾기 `5030000`, 마이페이지(예약확인·취소) `5040100`, 이용약관 `5070000`. 결제는 외부 호스트(토스페이먼츠)이고 이 화면에서 본 내부 결제 경로는 없다.
// - 봇 탐지·captcha: `index.jsp`, `pageCont.do`, `netfunnel.js`, `ajax.js`와 조회 응답에 `crawlingCheck`·`dynapath`·`botmanager`·captcha가 없다.
import type { FacilityInfo, ZoneInfo } from "../types.js";

const zone = (csId: string, name: string): ZoneInfo => ({ code: `CP_SPEC_0000000000${csId}`, name, type: "오토캠핑", capacity: 6 });

const iphwaAuto2Zones: ZoneInfo[] = [
  zone("31", "입화산 제2오토A(대형)"),
  zone("33", "입화산 제2오토A(소형)"),
  zone("32", "입화산 제2오토A(중형)"),
  zone("36", "입화산 제2오토B(소형)"),
  zone("35", "입화산 제2오토B(중형)"),
];

export const facilities: FacilityInfo[] = [
  { code: "iphwa-auto2", name: "입화산 제2오토야영장", ref: { cpId: "iphwa_auto2", menuNo: "1010300" }, zones: iphwaAuto2Zones, maxNights: 1 },
];
