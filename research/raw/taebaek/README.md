# 태백시시설관리공단 고원힐링캠핑장(`wloc=B01`) 달력 기록 (#116, Spec #115)

2026-10-14 13:2x ~ 13:4x KST(수요일), ADR 0003 조건으로 기록했다. UA `overlord-availability-poller/0.1 (+personal availability notifier)`. 요청 사이는 2~3초 이상 쉬었다. 예약처 `tfmc.huyang.co.kr:452` 하나다.
접근 금지 경로(`location=002_01`, `location=003`, 로그인·회원)는 부르지 않았다. 서버가 준 ASP 세션 쿠키(`ASPSESSIONID…`)는 값을 저장하지 않았고(헤더는 보관하지 않았다), 본문에는 세션 값이 없다. 마스킹이 필요한 값은 없었다.

- `robots.txt`: `*`·Googlebot `Disallow: /`, NaverBot·Yeti `Allow: /`.
- `reservation.asp_location002_B01_2026-10_man2_GET.html`: `GET /reservation.asp?location=002&wloc=B01`(쿠키 없이도 같은 달력). 기본 탭 자동차야영장(`man=2`), 10월. 10/1~14 예약종료, 10/15~31 예약가능.
- `reservation.asp_location002_B01_2026-11_man2_POST.html`: `POST /reservation.asp?location=002` `wh_year=2026&wh_month=11&man=2&wloc=B01`. 11/1~30 모두 예약가능. 다음달 버튼은 없다.
- `reservation.asp_location002_B01_2026-10_man1_POST.html`: 야영데크(`man=1`) 10월. 날짜 칸은 15~31 포함 대부분 예약종료이고 예약가능은 3칸이다.
- `reservation.asp_location002_B01_2026-10_man3_POST.html`: 카라반(`man=3`) 10월. 15·18~22·25~29 예약가능, 16·17·23·24·30·31 예약완료(`span.commit`).
- 그 밖의 요청(본문 저장 안 함): `GET /`(302, `/facility.asp?wloc=`), `/facility.asp?wloc=`·`/reservation.asp?wloc=B02`·`?location=002&wloc=B02`와 POST `wloc=B02`(모두 절골 `A01`이 왔다), `facility.asp?wloc=B01`(세션 쿠키 얻기).
- 탭은 달력 화면의 `.btn-box`(켜진 탭 `button.on`과 다른 탭 폼의 `man`)에서 읽었다: `man=1` 야영데크, `man=2` 자동차야영장, `man=3` 카라반. 날짜 칸은 `td > span.day`와 `span.possible`(예약가능)/`span.commit_end`(예약종료)/`span.commit`(예약완료)다.
