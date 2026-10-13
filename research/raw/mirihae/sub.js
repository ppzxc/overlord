$.datepicker.setDefaults({
  dateFormat: 'yymmdd',
  prevText: '이전 달',
  nextText: '다음 달',
  monthNames: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'],
  monthNamesShort: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'],
  dayNames: ['일', '월', '화', '수', '목', '금', '토'],
  dayNamesShort: ['일', '월', '화', '수', '목', '금', '토'],
  dayNamesMin: ['일', '월', '화', '수', '목', '금', '토'],
  showMonthAfterYear: true,
  yearSuffix: '년',
});
function size_check() {
  var width_size = window.outerWidth;
  if (width_size > 480) {
    var flOffset = $('.sub .detail').offset().top;
    $('.floating').css('top', flOffset);
    //PC
    //$('body').removeClass('paying');
  } else {
    //모바일
    /*$('.sub .detail .reserv-ui a.submit').on('click', function (e) {
      e.preventDefault();
    });
    //$('body').removeClass('paying');
    $('.sub .detail .reserv-ui a.submit').on('click', function () {
      $(this).text('결제하기');
      $('body').addClass('paying');
      $(this).addClass('pay').removeClass('submit');
    });
    $('.sub .detail .reserv-ui .choose .close').on('click', function () {
      $('.sub .detail .reserv-ui a.pay').text('예약하기');
      $('body').removeClass('paying');
    });
    $('.reserv-ui input, .reserv-ui select').on('click', function () {
      $(this).parent().parent().toggleClass('selecting');
    });*/
  } //
  if ($('.wrap').hasClass('full')) {
    var flOffset = $('.sub .detail').offset().top;
    $('.floating').css('top', flOffset);
  } else {
    if ($('.reserv-ui').length) {
      var flOffset = $('.reserv-ui').offset().top;
      $('.floating').css('top', flOffset);
    } else {
      var flOffset = $('.sub .detail').offset().top;
      $('.floating').css('top', flOffset);
    }
  }
}
function map_size() {
  var www = window.outerWidth;
  var ww = $('.map-district .ui-widget').width();
  var wscale = ww / 1024;
  var hh = $('.map-district .map-area .map img').height();
  if (ww <= 1024) {
    $('.map-district .map-area .map').css('transform', 'scale(1)');
    $('.map-district .map-area').css({
      height: 'auto',
    });
  } else {
    $('.map-district .map-area .map').css({
      transform: 'scale(' + wscale + ')',
    });
    $('.map-district .map-area').css({
      height: hh * wscale + 'px',
    });
  }
  // 본문 지도 사이즈
  if (www > 480) {
    var mapW = $('.sect .map-picker .map-area .map > img').outerWidth();
    var sectW = $('.sect .map-picker').width();
    var mapH = $('.sect .map-picker .map-area .map > img').height();
    var wratio = sectW / mapW;
    console.log(mapW, mapH, wratio);
    if (mapW <= 1024) {
      $('.sect .map-picker .map-area').css('height', mapH * wratio);
    } else {
      //
    }
  } else {
  }
}
$(window).resize(function () {
  size_check();
  map_size();
});
$(function () {
  map_size();
  size_check();
  // 예약 UI
  // $( '.reserv-ui .input input' ).blur();
  $('.reserv-ui').prepend('<div class="close"></div>');
  $('.reserv-ui .selector').on('click', function () {
    $(this).children().find('input').focus();
    $('.reserv-ui').addClass('active');
    $(this).addClass('selecting');
  });
  $('.reserv-ui input, .reserv-ui select').focus(function () {
    $(this).next().focus();
    // $( '.reserv-ui .input input' ).blur();
    if ($(this).next().hasClass('selection') === true) {
      $('.detail-contents').on('click', function (e) {
        e.preventDefault();
        $('.selecting').removeClass('selecting');
        $('.reserv-ui').removeClass('active');
      });
    } else {
      $('.reserv-ui').removeClass('active');
      $(this).parents('.input').siblings().removeClass('selecting');
    }
  });
  $('.reserv-ui select').focusout(function () {
    $('.reserv-ui').removeClass('active');
    $('.reserv-ui input, .reserv-ui select').parents('.input').removeClass('selecting');
  });
  $('.reserv-ui .total-payment, .selection a.ok').on('click', function (e) {
    e.stopPropagation();
    $('.reserv-ui input, .reserv-ui select').parents('.input, .selector').removeClass('selecting');
    $('.reserv-ui').removeClass('active');
  });
  $('.reserv-ui .close').on('click', function (e) {
    e.stopPropagation();
    $('body').toggleClass('paying');
  });

  //$('.pignose-calendar .pignose-calendar-unit').append('<div class="element"></div>');
  // 캘린더 구역 삽입
  //$('.calendar .district').clone().appendTo('.pignose-calendar .pignose-calendar-unit-date .element');
  //모바일 구역 선택
  $('.calendar .calendar-in + .district dl').on('click', function (event) {
    if ($(this).hasClass('able')) {
      $(this).toggleClass('active');
    } else {
    }
  });
});
//스크롤 반영
$(window).scroll(function (event) {
  didScroll = true;
  var scrollOffset = $('.contents ').offset();
  var uiOffset = $('.sub .detail-contents > *:first-child').offset().top;
  var uitop = uiOffset - 120;
  if ($(document).scrollTop() > scrollOffset.top) {
    $('body').addClass('scrolled');
    if ($(document).scrollTop() > uitop) {
      $('body').addClass('ui-fix');
      if ($('.notice-area').length) {
        inNotice.autoplay.start();
        inNotice.autoplay.stop();
      }
    } else {
      $('body').removeClass('ui-fix ');
      if ($('.notice-area').length) {
        inNotice.autoplay.start();
      }
    }
  } else {
    $('body').removeClass('scrolled ');
  }
});
