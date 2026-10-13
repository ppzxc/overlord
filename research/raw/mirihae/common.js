$(function () {
  //모바일메뉴
  $('.gnb .coll').on('click', function (e) {
    e.preventDefault();
    $('.gnb').toggleClass('active');
    $('.floating').toggleClass('active');
  });
  //좋아요 토글
  $('.like').on('click', function (e) {
    e.preventDefault();
    var count = $(this).text();
    if ($(this).hasClass('liked')) {
      $(this).removeClass('liked');
      count--;
      $(this).text(count);
    } else {
      $(this).addClass('liked');
      count++;
      $(this).text(count);
    }
  });
  //토글
  $('.toggle').on('click', function (e) {
    e.preventDefault();
    if ($(this).hasClass('on')) {
      $(this).removeClass('on');
    } else {
      $(this).addClass('on');
    }
  });
  //토글 only
  $('.toggle.only').on('click', function (e) {
    e.preventDefault();
    $('.toggle.only').removeClass('on');
    $(this).toggleClass('on');
  });
 /* //아이템 셀렉트
  $('.select-item > li').on('click', function () {
    $(this).addClass('on').siblings().removeClass('on');
  });*/
  //셀렉트박스
  $('.selectbox').each(function () {
    var max_cnt = 6;
    $(this).find('span.max-cnt').text(max_cnt);
  });
  $('.selectbox .selector').on('click', function (e) {
    e.preventDefault();
    var index = $(this).next().children().index();
    $(this).toggleClass('on');
    $(this).next().slideToggle('fast');
    $('.reserv-ui').removeClass('active');
  });
  $('.selectbox .btns a').on('click', function (e) {
    $(this).parents('ul').slideUp('fast');
    $(this).parents('.selectbox').find('.selector').removeClass('on');
    $('.reserv-ui').removeClass('active');
  });
  $('.selectbox > ul > li').on('click', function (e) {
    $('.reserv-ui').removeClass('active');
    var name = $(this).text();
    var max_cnt = 6;
    console.log(name);
    // 다중선택
    if ($(this).parent().parent().hasClass('multi') === true) {
      var index = $(this).index();
      if ($(this).hasClass('on') === true) {
        $(this).removeClass('on');
        $(this)
          .parent()
          .prev()
          .children('.value')
          .children('span.name' + index)
          .remove();
        if ($('.value').children().length == 0) {
          $(this).parent().prev().removeClass('valued');
        } else {
        }
      } else {
        // 선택값
        if ($(this).parent().prev().children('.value').children().length >= max_cnt) {
          alert('최대' + max_cnt + '개를 모두 선택하셨습니다. 기존 날짜를 삭제 후 선택하세요');
        } else if ($(this).parent().prev().children('.value').children().length < max_cnt) {
          $(this).addClass('on name' + index);
          $(this)
            .parent()
            .prev()
            .addClass('valued')
            .children('.value')
            .append("<span class='name" + index + "' style='order:" + index + "'>" + name + '</span>');
        }
      }
    } else {
      // 단일선택
      $(this).parent().prev().text(name).removeClass('on');
      $(this).addClass('on').siblings().removeClass('on');
      $(this).parent().slideUp('fast');
    }
  });
  // 갯수
  $('.quantity .minus').on('click', function (e) {
    e.preventDefault();
    var stat = $(this).next('input').val();
    var num = parseInt(stat, 10);
    num--;
    // console.log( num );
    if (num <= 0) {
      num = 0;
      $(this).addClass('disable');
    } else {
      $(this).removeClass('disable');
    }
    $(this).next('input').val(num);
  });
  $('.quantity .plus').on('click', function (e) {
    e.preventDefault();
    var stat = $(this).prev('input').val();
    var num = parseInt(stat, 10);
    num++;
    // console.log( stat )
    $(this).prev().prev().removeClass('disable');
    if (num > 10) {
      num = 10;
      $(this).addClass('disable');
    } else {
      $(this).removeClass('disable');
    }
    if (num > 0) {
      $(this)
        .parent()
        .parent()
        .each(function (index, item) {
          var select_name = $(this).find('.select-name').text();
          var add_price = $(this).find('.add').text();
          $(this)
            .parent()
            .prev('input')
            .val(select_name + ' ' + num + '명');
        });
    } else {
    }
    $(this).prev('input').val(num);
  });
  //
  $('.tabs a').on('click', function () {
    var aleft = $(this).offset().left;
    $(this)
      .parent()
      .animate(
        {
          scrollLeft: aleft - 24,
        },
        300
      );
    $(this).addClass('active').siblings().removeClass('active');
  });
  //탭여부 파악
  if ($('.article .tabs').length) {
    $('.wrap').addClass('has-tab');
  }
  $('a[href="#"]').on('click', function (e) {
    e.preventDefault();
  });
  // 데이트피커 jquery-ui
  $('.datepicker').datepicker({
    minDate: 0,
    dateFormat: 'yy년 mm월 dd일',
  });

  // 아코디언 컴포넌트
  $('.accordion li.active .pull').css('display', 'block');
  $('.accordion li h2 a').on('click', function (e) {
    e.preventDefault();
    if ($(this).parent().parent().parent().hasClass('only')) {
      if ($(this).parent().parent().hasClass('active')) {
        $(this).parent().parent().removeClass('active');
        $(this).parent().next('.pull').slideUp('fast');
      } else {
        $(this).parent().parent().addClass('active').siblings().removeClass('active');
        $(this).parent().next('.pull').slideDown('fast');
        $(this).parent().parent().siblings().children('.pull').slideUp('fast');
      }
    } else {
      $(this).parent().parent().toggleClass('active');
      $(this).parent().next('.pull').slideToggle('fast');
    }
  });
  //input file
  var fileTarget = $('.filebox .upload-hidden');
  fileTarget.on('change', function () {
    if (window.FileReader) {
      // modern browser
      var filename = $(this)[0].files[0].name;
    } else {
      var filename = $(this).val().split('/').pop().split('\\').pop(); // 파일명만 추출
    }
    $(this).siblings('.upload-name').val(filename);
  });
});
//스크롤
$(window).scroll(function (event) {
  didScroll = true;
  var scrollOffset = $('.contents').offset();
  var scrollTop = $(window).scrollTop();
  if ($(document).scrollTop() > scrollOffset.top) {
    $('body').addClass('scrolled');
  } else {
    $('body').removeClass('scrolled ');
  }
});

//구역 이름 구하기
$('.map .pin').each(function (index, item) {
  var sect01 = $('.sect .map-picker .option.color-var .legend p:first-child').text();
  var sect02 = $('.sect .map-picker .option.color-var .legend p:nth-child(2)').text();
  var sect03 = $('.sect .map-picker .option.color-var .legend p:nth-child(3)').text();
  var sect04 = $('.sect .map-picker .option.color-var .legend p:nth-child(4)').text();
  var sect05 = $('.sect .map-picker .option.color-var .legend p:nth-child(5)').text();
  var sect06 = $('.sect .map-picker .option.color-var .legend p:nth-child(6)').text();
  var sect07 = $('.sect .map-picker .option.color-var .legend p:nth-child(7)').text();
  $('.map .pin.sect01').attr('sect-name', sect01);
  $('.map .pin.sect02').attr('sect-name', sect02);
  $('.map .pin.sect03').attr('sect-name', sect03);
  $('.map .pin.sect04').attr('sect-name', sect04);
  $('.map .pin.sect05').attr('sect-name', sect05);
  $('.map .pin.sect06').attr('sect-name', sect06);
  $('.map .pin.sect07').attr('sect-name', sect07);
  // 23.06.26 구역이름이 문자일 경우 추가
  // 구역이름 문자일 경우 부모에 string 추가
  if ($(this).parent().hasClass('string')) {
    var sect_name = $(this).attr('id');
    var sect_n = sect_name.substring(4, 6);
    var sect_el = sect_name.substring(8);
    console.log(sect_n, sect_el);
    $(this)
      .addClass('sect' + sect_n)
      .attr('data-sect', 'sect' + sect_n);
    $(this).append('<div class="marker"><p>' + sect_el + '</p></div><div class="deco"></div>');
  } else {
    // 구역 이름 숫자일 경우
    var sect_name = $(this).attr('id');
    var sect_n = sect_name.substring(4, 6);
    var sect_el = parseInt(sect_name.substring(7));
    $(this)
      .addClass('sect' + sect_n)
      .attr('data-sect', 'sect' + sect_n)
      .attr('pin-num', sect_el)
      .attr('idx', sect_n + '-' + sect_el);
    $(this).append('<div class="marker"><p>' + sect_el + '</p></div><div class="deco"></div>');
  }
});
$('.map .pin').on('click', function (e) {
  if ($(this).hasClass('disabled')) {
    //
  } else {
    if ($(this).parents('.map').hasClass('only')) {
      $(this).addClass('active').siblings().removeClass('active');
      $('.wrap').addClass('multi');
    } else {
      $(this).toggleClass('active');
      $('.wrap').removeClass('multi');
    }
  }
});
$('.map .pin').mouseenter(function () {
  if ($(this).hasClass('disabled')) {
    //
  } else {
    $(this).addClass('over');
  }
});
$('.map .pin').mouseleave(function () {
  $(this).removeClass('over');
});
