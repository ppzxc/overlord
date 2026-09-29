# 고래불 예약처 어댑터 세부 동작 (2026-09-29)

1차 정찰(`goraebul-recon.md`)의 후속 조사다. 2026-09-29 09:07~09:15 KST 사이에 `stay.yd.go.kr/pages/` 아래로 읽기 전용 GET 약 20회를 보냈다. 요청 사이 간격은 3~4초였다. `/bbs/`는 호출하지 않았고 폼도 제출하지 않았다. NetFunnel을 거치는 링크(월 이동 화살표)는 따라가지 않고 URL만 직접 GET했다.

이번에 받은 원본은 `raw/2026-09-29/`에 있다.

## User-Agent 기록

| 관찰 | UA | 결과 |
|---|---|---|
| `raw/*.htm` (1차 정찰, 2026-09-28) | **알 수 없음** (기록 없음) | 정상 페이지 |
| `raw/2026-09-29/sep.htm`, `oct.htm`, `s1.htm`, `z_*.htm` | `Mozilla/5.0 (research; read-only)` | 정상 페이지 |
| `raw/2026-09-29/honest.htm`, `honestcal.htm`, `honests1.htm` | `overlord-availability-poller/0.1 (research)` | 정상 페이지 (차단 페이지 아님) |

- 앞의 UA는 `Mozilla/5.0`으로 시작하므로 브라우저처럼 보일 수 있다. 코디네이터 지시가 오기 전에 쓴 것이다. 이후로는 도구 이름을 밝히는 UA만 썼다.
- 도구 이름 UA로 캘린더, step01, `zoneAreaAjax.htm`을 한 번씩 요청했다. 셋 다 정상 크기(26730 / 24506 / 1551 바이트)로 왔고 차단 페이지(~915 바이트, "영덕군 전산팀 문의")는 아니었다. 다른 조사에서 차단된 것은 curl 기본 UA(`curl/x.y`)인 것으로 보인다(미검증).
- 어댑터는 `overlord-availability-poller/<ver>` 형식의 UA를 쓰고, 이메일 같은 개인정보는 헤더에 넣지 않는다.

## 1. 월 캘린더

```
GET https://stay.yd.go.kr/pages/sub.htm?nav_code=gor1501675800&view_cate=2026&view_cate2=9&code=
```

- `view_cate`=연도, `view_cate2`=월(앞에 0을 붙이지 않음). 쿠키나 선행 요청 없이 200이 온다. 응답마다 새 `PHPSESSID` 쿠키가 발급되지만 조회에 쓰이지 않는다.
- 달력 표는 `<table class="t_calendar">`이고, 날짜 칸은 `<td …><span class='day'>D</span><ul class='list'>…</ul></td>` 형태다.

날짜 칸은 세 종류다.

1. **열린 날짜** (`<td >`, class 없음). 구역마다 `<li>`가 하나씩 있다.
   - 빈자리 있음:
     ```html
     <li><i class='fa fa-check-circle point_blue'></i><a href='/pages/sub.htm?nav_code=gor1501675800&mode=step01&type=CAA&today=2026-09-29&col=2' title='2026-09-29 카라반 4인실 예약가능' class='point_blue'>카라반 4인실</a><em>(2)</em></li>
     ```
     `<em>(N)</em>`이 남은 자리 수다. `type`=구역 코드, `today`=입실일이다.
   - 매진: `<li><i class='fa fa-times-circle point_gray'></i>펜션형 8인실(마감)</li>` (링크 없음)
2. **아직 안 열린 날짜** (`<td class='not'>`):
   ```html
   <td class='not'><span class='day'>29</span><ul class='list'><div class='txt'><i class='fa fa-times fa-4x'></i><a href="javascript:alert('선택하신 일자는 2026-09-29일 오전 10시부터 예약가능합니다.');" class='btn_d btn_small'>Click<br>예약안내</a></div></ul></div></td>
   ```
   alert 문구 안에 열리는 날짜가 들어 있다.
3. **지난 날짜** (`<td class='not'>`): `<div class='txt'><i class='fa fa-times fa-4x'></i>예약마감</div>`

### 30일 롤링 경계

- 10월 캘린더(09:08 KST 조회)를 보면 29일은 "2026-09-29 10시부터", 30일은 "09-30", 31일은 "10-01"로 안내된다. **입실일 D는 D−30일 10:00에 열린다.**
- 경계 날짜는 두 가지로 알아볼 수 있다. `class='not'` 칸 안에 "예약안내" alert가 있거나, `zoneAreaAjax`가 모든 자리를 `ban`으로 준다. 10:00 전에 `res_Day=2026-10-29`를 요청했더니 38자리가 전부 `ban`이었다.
- 10시 정각에 표시가 바뀌는 것은 직접 보지 못했다(미검증).
- 9월 캘린더에서 열린 날은 29, 30일뿐이었다. 10월 1~28일은 모든 구역이 `(마감)`이었다. 연휴 기간이라 실제로 매진된 것으로 보인다. 9-30 입실 2박(`site_date=2`) 조회에서 DKA 38자리가 전부 `ban`이었던 것과도 맞는다.

### 캘린더 숫자와 자리 배치의 일치

9-29, 9-30에 캘린더의 `(N)`과 `zoneAreaAjax.htm?site_date=1`에서 빈 자리(`class="num "`) 개수를 비교했다. CAA 2/2, CAA(9-30) 3/3, DKA 34/34, DKB 51/51, PEC 1/1로 모두 같았다. 캘린더의 N은 **1박 기준 빈자리 수**다.

## 2. step01 (딥링크)

```
GET https://stay.yd.go.kr/pages/sub.htm?nav_code=gor1501675800&mode=step01&type=CAA&today=2026-09-29&col=2
```

- `col`은 요일 열 번호로 보인다(0=일). 9-29(화)는 2, 9-30(수)는 3이다. 캘린더 링크에 있는 값을 그대로 쓰면 된다. 다른 값으로 바꿔 보지는 않았다(미검증).
- 캘린더의 step01 링크에는 NetFunnel `onclick`이 **붙어 있지 않다**. NetFunnel(`NetFunnel_Action({action_id:'goraebul_res'}, …)`)은 월 이동 화살표와 F5/Ctrl+R 핸들러에만 있다.
- **사용자 알림에 넣을 딥링크로는 이 step01 URL이 가장 좋다.** 날짜와 구역이 미리 선택된 상태로 열리고, 거기서 자리를 고르고 "다음단계"를 누르면 된다. 브라우저에서 바로 열었을 때 막히는지는 확인하지 않았다(미검증).
- 페이지 안에는 1박/2박을 고르는 `<select name="res_For">`(옵션 1, 2)가 있다. 선택을 바꾸면 `Calculate()`가 `../bbs/res_step01_rdata.php`로 POST를 보내 토큰 `r_data`를 갱신하고, `zone_area_view(res_For)`를 부른다. **어댑터는 이 POST를 흉내 내지 않는다.** 자리 배치는 아래 XHR만으로 조회할 수 있다.
- 폼 `res_form01`에는 `res_pkey`, `r_data` 같은 서버 토큰이 있다. 예약 진행에만 쓰이고 조회에는 필요 없다.

## 3. 자리 배치 XHR

step01의 JS 원문:

```js
function zone_area_view(date) {
	jQuery.ajax({
	    url : "./zoneAreaAjax.htm?res_Day=2026-09-29&room_Code=CAA&site_date="+date,
	    success: function(html) { $("#zone_area").html(html); … }
	});
}
$(document).ready(function(){ … zone_area_view(1,''); … });
```

```
GET https://stay.yd.go.kr/pages/zoneAreaAjax.htm?res_Day=YYYY-MM-DD&room_Code=DKA&site_date=N
```

- 쿠키, CSRF, `X-Requested-With` 헤더 없이 200이 온다. 응답은 HTML 조각이다.

### `site_date` = 박수 (확인됨)

- step01은 `res_For` select 값(1=1박2일, 2=2박3일)을 그대로 `site_date`로 넘긴다.
- 실측 결과도 박수 해석과 맞는다.
  - DKA 9-29 `site_date=1`: 빈자리 34개, `ban` 4개(1, 3, 18, 20)
  - DKA 9-30 `site_date=1`: `ban` 4개(1, 3, 20, 21)
  - DKA 9-29 `site_date=2`: 빈자리 33개, `ban` 5개. 9-29 1박 결과에서 **dka_21이 빠졌다.** 9-30에 dka_21이 막혀 있기 때문이다. 즉 `site_date=2`는 입실일부터 N박 **연속으로 모두 비어 있는** 자리만 빈자리로 준다.
  - DKA 9-29 `site_date=3`: 38자리 전부 `ban` (최대 2박 초과)
  - 9-30 `site_date=2`는 CAA, DKA 모두 전부 `ban`이었다. 10-01이 매진이기 때문이다.
- 그래서 감시 조건이 "입실일 D, N박"이면 `res_Day=D&site_date=N` 한 번으로 판정할 수 있다.

### 마크업

```html
<div id="zone_caa" class="select_room">
  <a href="#" onclick="alert('이미 예약된 시설입니다.');return false;" id="caa_1" class="num ban"><span>X</span></a>
  …
  <a href="#" onclick="zone_area_select('5','caa_11','카라반 11호');return false;" id="caa_11" class="num "><span>11</span></a>
</div>
<script> function zone_area_select(site,siteId,siteName) { … $("#r_pro_idx").val(site); … } </script>
```

- 컨테이너는 `div#zone_<구역코드 소문자>.select_room`이다.
- 자리 하나가 `a.num` 하나다.
  - `id`=`<구역코드 소문자>_<자리번호>`
  - `class`: `"num "`이면 빈자리, `"num ban"`이면 예약불가
  - 빈자리일 때만 `onclick`이 `zone_area_select('<내부 idx>','<id>','<자리 이름>')` 형태다. 내부 idx(`r_pro_idx`)는 예: DKA 2번=31, CAA 11번=5.
  - 예약불가 자리의 `<span>`에는 `X`가 들어 있어서 자리 번호가 보이지 않는다. 번호는 `id`에서 읽는다.
- 폐쇄된 자리는 목록에 아예 나오지 않는다. 예를 들어 CAA는 1, 2, 6, 7, 11, 12, 20, 21, 22번 9자리만 나온다.

### "예약진행중(임시점유)", "취소대기" 표시

- step01의 범례에 `<span class="wait"></span> 취소대기`, `<span class="ing"></span> 예약진행중(임시점유)`, `<span class=""></span> 예약가능`, `<span class="ban"></span> 예약불가`가 있다.
- `booking.css`에도 `.select_room .num.ing`(녹색), `.select_room .num.wait`(회색) 규칙이 있다. 따라서 임시점유 자리는 `class="num ing"`, 취소대기 자리는 `class="num wait"`로 올 것으로 **추정한다.**
- 하지만 이번에 받은 응답 약 470자리 중에 `ing`나 `wait`는 **한 번도 없었다**(미검증). onclick 분포는 `alert('이미 예약된 시설입니다.')` 310개, `zone_area_select` 160개였다.
- 안내 문구는 "번호가 보이지 않거나 선택이 되지 않는 시설은 이미 예약이 진행중이거나 완료된 시설입니다"이다. 임시점유 자리가 그냥 `ban`으로 나올 가능성도 있다(미검증).
- **파싱 규칙**: `class`에 `ban`, `ing`, `wait` 중 하나라도 있거나 `zone_area_select` onclick이 없으면 빈자리가 아니다. 모르는 클래스가 오면 빈자리가 아닌 것으로 보고 경고 로그를 남긴다.

## 4. 캐시 헤더

- 캘린더와 XHR 모두 `Expires: Thu, 19 Nov 1981 08:52:00 GMT`, `Cache-Control: max-age=36000, public, must-revalidate`, `Pragma: no-cache`를 준다. PHP 세션 기본값에 설정이 덧붙은 것으로 보인다.
- `Age`, `Via`, `X-Cache`, `ETag`, `Last-Modified`는 없다. 앞단에 공유 캐시가 있다는 흔적은 없다.
- 같은 URL을 몇 분 간격으로 다시 받았을 때 예약 변동이 반영되는지는 보지 못했다(미검증). 어댑터는 로컬 HTTP 캐시를 끄거나, `Cache-Control: no-cache` 요청 헤더를 붙이는 편이 안전하다.

## 5. 감시 조건 하나를 평가하는 요청 순서

감시 조건 = (고래불, 구역 코드 R, 입실일 D, N박[1|2], 원하는 자리 목록 또는 "아무 자리")

1. D가 오늘부터 30일 안에 없으면 확인하지 않는다. D−30일 10:00 전이면 결과를 "아직 안 열림"으로 둔다. (선택) 캘린더의 `class='not'` alert로 한 번 더 확인할 수 있다.
2. (선택, 여러 감시 조건을 묶을 때) 캘린더를 월당 한 번 GET해서 D 칸의 구역 R에 `(마감)`이 붙어 있는지 본다. `(마감)`이면 N=1 기준으로 빈자리가 0이다. N=2이면 D+1도 봐야 하므로 빠르게 걸러 내는 용도로만 쓴다.
3. `GET /pages/zoneAreaAjax.htm?res_Day=D&room_Code=R&site_date=N`
4. `div.select_room a.num`마다 빈자리인지 판정한다. `class` 토큰이 `num` 하나뿐이고 onclick에 `zone_area_select(`가 있어야 빈자리다. 자리 번호는 `id`의 `_` 뒤, 자리 이름은 onclick의 세 번째 인자에서 읽는다.
5. 원하는 자리와 겹치는 빈자리가 있으면 알린다. 딥링크는 `https://stay.yd.go.kr/pages/sub.htm?nav_code=gor1501675800&mode=step01&type=R&today=D&col=<D의 요일 0~6>`이다. 사용자는 이 페이지에서 N박을 직접 골라야 한다. 기본값은 1박이다.

감시 조건 하나에 1회 GET이면 된다(캘린더 선필터를 쓰면 +월당 1회). 세션, 토큰, NetFunnel은 필요 없다.

## 구역 코드 (1차 정찰 + 이번 확인)

CAA 카라반 4인실, CAB 카라반 6인실, DKA/DKB/DKC 숲속야영장 A/B/C(자리 이름은 "텐트사이트 A02호" 형식), AUA 캠핑카존, PEA/PEB/PEC 펜션형. 캘린더에는 "펜션형 8인실", "펜션형 10인실" 두 개만 나온다. 이번 링크에서는 PEC가 10인실이었다. 코드와 인원의 대응은 일부만 확인했다(미검증).

## 미검증 요약

- 임시점유, 취소대기 자리의 실제 클래스(`ing`/`wait`인지 `ban`인지)
- 10:00 정각에 새 날짜가 열리는 전환
- 캐시 헤더가 데이터 신선도에 영향을 주는지
- `col` 값이 틀렸을 때 step01의 동작, 딥링크를 브라우저에서 바로 열었을 때의 동작
- 1차 정찰 원본(`raw/*.htm`)을 받을 때 쓴 UA
