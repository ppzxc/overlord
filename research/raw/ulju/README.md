# 울주군립야영장(`camping.ulju.ulsan.kr`) 작천정별빛야영장(`jakcheon-byeolbit`) 기록 (#73)

2026-10-12 18:37~18:49 KST(평일 저녁), ADR 0002 원칙으로 한 번 기록했다. UA `overlord-availability-poller/0.1 (ADR0002 one-time recording)`, `camping.ulju.ulsan.kr` 요청 사이 5~8초(요청마다 `sleep 5~8`).
로그인·captcha·봇 탐지 호출 없음. 접근 금지 경로(`booking_step1`, 추첨 신청, 로그인, 마이페이지) 요청 없음. `robots.txt`는 `Yeti`(네이버)에만 `Allow: /`이고 `*` 규칙이 없다(금지 없음).
요청은 모두 `curl`이다. 쿠키 단지, `Set-Cookie`의 `JSESSIONID` 값은 저장하지 않았거나 `<masked>`다(`headers.txt`). 다른 파일에는 가릴 값이 없다(`jsessionid|csrf|token|password` 검색으로 확인).

## 보낸 요청 전부(33건)

| # | 요청 | 저장 |
|---|---|---|
| 1 | GET `/robots.txt` | `robots.txt` |
| 2 | GET `/ujcamping/campsite/booking` (쿠키 단지 저장) | `booking.html` |
| 3 | GET `/ujcamping/resources/js/mscommon.js` | `mscommon.js` |
| 4 | GET `/ujcamping/resources/js/netfunnel.js` | 저장하지 않음(87KB 압축 스크립트). `TS_HOST = 'net.uljusiseol.or.kr'`만 확인하고 지웠다 |
| 5 | POST `get_cal_month_data` `{sql_state:"GetData", year_val:2026, month_val:9}` | `get_cal_month_data_2026-10.json` |
| 6 | POST `get_cal_day_data_list` C0000001 2026-10-16 (쿠키·Referer·Origin·`X-Requested-With`을 실은 첫 요청) | `get_cal_day_data_list_C0000001_2026-10-16.json` (fixture 원문) |
| 7 | 같은 요청, 헤더 세 개만, 쿠키 없음, 예약 화면 GET 없이 | 6과 `cmp` 바이트 같음, 지움 |
| 8 | 같은 요청, `X-CSRF-TOKEN` 헤더 없이 | 6과 `cmp` 같음, 지움 |
| 9 | 같은 요청, `X-CSRF-TOKEN: undefined` | 6과 `cmp` 같음, 지움 |
| 10 | 같은 요청, `use_only: "Y"` | 6과 `cmp` 같음(88행, N 행도 온다), 지움 |
| 11 | 같은 요청, 빈 값 `X-CSRF-TOKEN`(curl `-H 'X-CSRF-TOKEN;'`) | 6과 `cmp` 같음, 지움 |
| 12 | POST day 2026-10-12(18:40, 17시 뒤 당일) | `..._2026-10-12.today_after17.json` |
| 13 | POST day 2026-10-11(과거) | `..._2026-10-11.past.json` |
| 14 | POST day 2026-10-13, 10-17, 10-24, 11-06, 11-07, 11-13, 11-27 (날짜 창·`Y` 분포) | 10-13, 11-06, 11-27만 남김. 10-17, 10-24, 11-07, 11-13은 지움(분포는 아래) |
| 15 | POST day 2026-12-25, 2027-01-15, 2027-06-04 | `..._2026-12-25.json`, `..._2027-01-15.json`, `..._2027-06-04.json` |
| 16 | POST day C0000002, C0000003, C0000005 (2026-10-16) | `get_cal_day_data_list_C000000{2,3,5}_2026-10-16.json` (다른 시설 구역 확인용) |
| 17 | GET `/ujcamping/guide/guide1_1`(운영조례), `guide1_3`(이용자규칙) | `guide1_1.html`. `guide1_3.html`은 쓸 내용이 없어 지웠다 |
| 18 | GET `/ujcamping/community/community03`(자주하는 질문), `community01`(공지 목록), `community01?prc=view&n=81`·`n=86`(11월 추첨 일정·일반 추첨결과) | `community03.html`, `community01.html`, `community01_view_n81.html`, `community01_view_n86.html` |

6~11, 12·13, 14, 15, 16의 `POST`는 모두 본문 JSON `{sql_state:"GetData", select_date, classes, facility:"", use_only:"N"}`(10번만 `"Y"`), 헤더 `Content-Type: application/json`, `X-HTTP-Method-Override: POST`다.

**기록 중 정정**: 앞쪽 요청(6~10 가운데 헤더 값이 빈 것)에서 `curl -H 'X-CSRF-TOKEN: '`은 값이 비면 헤더를 아예 보내지 않는다(로컬 서버로 확인). 그래서 6의 `X-CSRF-TOKEN`은 실제로는 없었고, 7·8도 같은 요청이었다. 빈 값 헤더가 가는 요청은 11이다. 응답은 모두 같았다(서버가 이 헤더를 보지 않는다).
페이지의 jQuery는 `#csrf_token` 요소가 없어 `$("#csrf_token").val()`이 `undefined`라 브라우저가 문자열 `undefined`를 보낼 가능성이 크다(9). 어댑터는 스펙대로 빈 값을 보낸다.

## 확인한 사실

- **쿠키 세션 불필요.** 쿠키·Referer·Origin 없이 헤더 세 개만 보낸 요청의 응답이 쿠키를 실은 요청과 바이트까지 같았다(7). 서버는 `JSESSIONID`(Path=/ujcamping)를 주지만 쓰지 않는다.
- **`get_cal_month_data` 선행 불필요.** 예약 화면 GET도 month 호출도 없는 첫 요청(7)이 정상 응답을 받았다. month 응답(5)은 날짜 틀(`DAY`, `D`, `TDATE`, `SDATE`, `BDATE`, `WEEK`)과 공휴일(`DTYPE`, `DSTR`)뿐이다.
- **`use_only`**: 페이지는 "예약가능 사이트만 보기" 체크박스(기본 해제)로 `"Y"`/`"N"`을 보내고, `"Y"`일 때 N 행을 그리지 않는다. 서버는 값을 가리지 않는다(10). 어댑터는 기본 `"N"`을 보낸다.
- **응답**: `{"result":"ok","list":[88행]}`. 행 키는 `CAMP_ID`, `NAME`, `OWNER_ID`, `ITEM_KIND`, `FACILITY_ID`, `SORT_ORDER`, `FACILITY_NAME`, `TITLE`, `SDATE`, `EDATE`, `ISRESERVABLE`이고 `IS_RESERVED_YN`(예약됨 74행), `EXP_PERIOD_YN`(3행, 뜻 모름)이 일부 행에만 붙는다. `SDATE`=선택한 밤, `EDATE`=다음 날이라 요청 하나가 밤 하나다.
  2026-10-16 분포: `Y` 11(야영데크(4*4) 7, 야영데크(6*4) 4), `N` 77. 구역: `F0000001` 오토캠핑장 20, `F0000016` 야영데크(6*4) 18, `F0000004` 야영데크(4*4) 15, `F0000017` 야영데크(8*5) 15, `F0000005` 캐빈하우스 10, `F0000003` 야영데크(8*4) 8, `F0000002` 야영데크(8*8) 2(스펙이 적은 #56 조사와 같다).
  `ISRESERVABLE`이 `Y`인 행에는 `IS_RESERVED_YN`·`EXP_PERIOD_YN`이 없었고, 둘 가운데 어느 쪽이 붙은 행도 `N`이었다. 10-24, 11-13에는 둘 다 없는 `N` 행이 한 자리씩 있었다(결제 대기 같은 보류로 짐작, 추정).
- **`booking_ended`**(HTTP 200, `msg`만 있고 `list` 없음)는 세 가지다: 17시 이후 당일(12), 과거(13), 현재 달과 다음 달 밖(15, 12/25·2027-01-15·2027-06-04: "예약은 현재 달과 다음 달까지만 조회 가능합니다."). `no_list`는 응답으로 보지 못했다(페이지 JS에만 있다).
- **날짜 창**: 10/12 기준 10월·11월은 `ok`(10-13 `Y` 50, 10-16 `Y` 11, 11-06 `Y` 33, 11-27 `Y` 50), 12월 이후는 `booking_ended`다.
- **오픈 규칙**: 공지 "2026년 11월 추첨 일정 안내"(신불산 3곳, 2026-09-24, `community01_view_n81.html`)의 순서: 울주군민 우선 추첨 접수 1~3일 → 추첨 4일 → 결제 5일 13:00까지 → 일반 추첨 접수 6~8일 → 추첨 9일 → 결제 10일 13:00까지 → **미당첨·취소분 선착순 11일 10:00부터**. 일반 추첨결과 공지(`n86`)도 "즉시결제 11일(일) 10:00부터"라 한다. 10월분도 같은 순서다(대운산 10월 군민추첨결과 공지 `n=77`, 2026-09-04: 결제 9/5 13:00까지, 일반 추첨 접수 9/6 09:00~8일 18:00. 이 공지는 요청했지만 저장하지 않았고, 이 GET이 표 18번 밖의 33번째 요청이다).
  예약 화면 안내: "추첨이 완료되고 남은 사이트에 한 해 선착순", "일2회(오전 10시, 오후 2시) 취소분 반영". FAQ(`community03.html`)도 "취소분 반영 오전 10시, 오후 2시".
  운영조례 제4조(`guide1_1.html`)의 "30일 전부터"는 서버가 실제 여는 창(현재 달과 다음 달)과 달라 쓰지 않는다. 당일 입실은 17:00 마감이다.
- **최대 박수**: FAQ "연박은 어떻게 신청하나요?" — "연박은 추첨 시 금, 토요일 및 지정 사이트에 한하여 신청 가능합니다. 추첨 이외의 연박은 즉시결제로 1박씩 예약하면 됩니다." 11월 추첨 공지: "연박은 지정된 사이트에 한하여 최대 2박 3일 신청 가능(매월 말일은 1박 2일만 가능)". 조회 요청에 박수 값이 없다. 즉시결제는 한 번에 1박이다.
- **추첨 날짜의 모양은 못 봤다.** 이번 기록은 11월 추첨이 끝난 뒤(10/11)이고 12월은 서버 창 밖(`booking_ended`)이라 추첨 기간 중인 날짜를 관찰할 수 없었다. 다음 관찰 기회는 11/1~11/10(12월분 추첨 기간)이다.
- **대기열·봇 탐지·captcha 없음.** `booking.html`에 `netfunnel.js`가 실리지만 `NetFunnel_Action` 호출 세 곳(`siseol`, `siseol`, `lec`)이 모두 주석 처리돼 있다. `booking.html`, `mscommon.js`에 `crawlingCheck`·`dynapath`·`botmanager`·captcha가 없고 조회 응답에도 오지 않았다. 예약 단계(`booking_step1` 뒤)는 열지 않았다.
- **접근 금지 경로**(화면 링크, 인라인 스크립트, `mscommon.js`): `/ujcamping/campsite/booking_step1`(`goReserve`가 가는 곳), `/ujcamping/campsite/ulju_resident_apply`, `/ujcamping/campsite/general_apply`(추첨 신청, 열지 않음), `/ujcamping/campsite/winnerList`(주석 처리된 링크),
  `/ujcamping/memberIntro/`(로그인), `/ujcamping/mypage/`(예약확인, 군민인증 `/mypage/authulju`), `/ujcamping/camp_exp/camp_exp_booking`(숲공작 체험 예약). 회원가입·ID 찾기는 다른 호스트(`crs.uljusiseol.or.kr`)다.
- **다른 시설(2026-10-16)**: 등억알프스 `C0000002` 68행(`F0000001` 오토캠핑장 48, `F0000006` 카라반(일반) 10, `F0000007` 카라반(테마) 10; `Y` 15), 작천정달빛 `C0000003` 47행(`F0000001` 오토캠핑장 35, `F0000018` 야영데크(8.5*6.5) 12; `Y` 9),
  대운산하늘숲 `C0000005` 20행(`F0000015` 7.3m × 7m 10, `F0000008` 7.2m × 7m 4, `F0000009`~`F0000014` 한 자리씩; `Y` 0). `FACILITY_ID`는 시설 사이에 공유된다(`F0000001`).
  예약 화면의 시설타입 선택(`#facility`)은 시설과 무관하게 18개를 모두 싣는다.
- 응답 크기·시간: 작천정별빛 88행 25KB, 1~2초. `booking_ended` 100바이트대.

테스트용 fixture는 `test/fixtures/ulju-get_cal_day_data_list-C0000001-20261016.json`으로 10-16 원문을 복사했다. `booking_ended` 응답은 테스트가 같은 모양(`msg`만 있고 `list` 없음)으로 만든다.
