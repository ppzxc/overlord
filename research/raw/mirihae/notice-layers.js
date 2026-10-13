/* ============================================================
 * 공통 레이어 팝업(notice-layers) 제어 스크립트
 * ------------------------------------------------------------
 * - 모든 사이트가 공유하는 공지/이벤트 레이어 팝업 동작.
 * - 전체 팝업 단위로만 닫는다 (개별 팝업 하나만 닫기는 없음).
 * - "오늘 하루" = 1일, "일주일" = 7일 동안 쿠키로 노출을 차단한다.
 * - 마크업 기본값은 숨김(.on 없음). 차단 쿠키가 없을 때만 이 스크립트가
 *   .on 을 붙여 노출한다 → 닫아둔 사용자에게 깜빡임(FOUC)이 없다.
 * - 마크업: /views/common/include/layerPopup.jsp 의 .notice-layers
 * - 중복 로드돼도 핸들러는 1회만 건다.
 * - jQuery 의존: 페이지에 jquery.min.js 가 먼저 로드돼 있어야 한다.
 * ============================================================ */
(function () {
  // [중복 초기화 방지] 이 스크립트가 한 페이지에 두 번 로드돼도 핸들러는 1번만 건다.
  if (window.__noticeLayersInit) return;
  window.__noticeLayersInit = true;

  // [쿠키 쓰기] key 쿠키를 days 일 뒤 만료로 'Y' 저장한다. ("이 기간 동안 보지 않기"를 기록)
  function blockFor(key, days) {
    var expires = new Date();
    expires.setDate(expires.getDate() + days); // 오늘 + days 일
    document.cookie = key + '=Y; path=/; expires=' + expires.toGMTString();
  }

  // [쿠키 읽기] key 쿠키가 'Y' 로 살아있는지(차단 상태인지) 확인한다.
  function isBlocked(key) {
    return new RegExp('(?:^|; )' + key + '=Y(?:;|$)').test(document.cookie);
  }

  // DOM 준비 후 실행
  $(function () {
    // [강제 노출] 주소에 ?notice=on 이 있으면 차단 쿠키를 무시하고 무조건 띄운다. (운영/테스트용)
    var forceShow = new URLSearchParams(window.location.search).get('notice') === 'on';

    // 페이지에 있는 모든 팝업 컨테이너를 각각 처리
    $('.notice-layers').each(function () {
      var $popup = $(this);
      // [쿠키 이름 접두어] 컨테이너에 id 가 있으면 그걸, 없으면 'noticeLayers' 를 사용.
      // layerPopup.jsp 는 PopupController 가 만든 <groupCode>_<pageId>_notice 를 id 로 찍는다.
      // → 실제 쿠키명: gsmc_B85357623_notice_notTodayAll / gsmc_B85357623_notice_notWeekAll
      //   (id 가 사이트·예약페이지별로 다르므로 팝업 차단이 서로 간섭하지 않는다)
      var id = $popup.attr('id') || 'noticeLayers';

      // [닫기 동작] 슬라이드업 + on 클래스 제거(.on 제거 시 CSS body 스크롤 잠금도 해제됨)
      function close() {
        $popup.slideUp('fast').removeClass('on');
      }

      // [노출 여부 판단] "오늘 하루" 또는 "일주일" 차단 쿠키가 있으면 표시하지 않고 종료.
      //                  단, ?notice=on 이면 무시하고 띄운다.
      if (!forceShow && (isBlocked(id + '_notTodayAll') || isBlocked(id + '_notWeekAll'))) {
        $popup.removeClass('on').hide();
        return; // 이 컨테이너는 핸들러도 걸 필요 없이 종료
      }

      // [노출] 차단 쿠키가 없으면 이때 .on 을 붙여 노출한다.
      //        (마크업 기본값은 숨김이므로 여기서 붙여야 화면에 보인다)
      $popup.addClass('on').show();

      // [버튼1] 전부 닫기 : 쿠키 없이 이번만 닫음 (다음 접속 시 다시 뜸)
      $popup.on('click', '.closes .close', function (e) {
        e.preventDefault();
        close();
      });

      // [버튼2] 오늘 하루 보지 않기 : 1일짜리 쿠키 저장 후 닫음
      $popup.on('click', '.closes .close-today', function (e) {
        e.preventDefault();
        blockFor(id + '_notTodayAll', 1);
        close();
      });

      // [버튼3] 일주일 동안 보지 않기 : 7일짜리 쿠키 저장 후 닫음
      $popup.on('click', '.closes .close-week', function (e) {
        e.preventDefault();
        blockFor(id + '_notWeekAll', 7);
        close();
      });
    });
  });
})();
