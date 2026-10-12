function BookingModel() {
	var self = this;

	ko.utils.extend(self, new ShopModel());
	ko.utils.extend(self, new PasswordManagerModel());

	self.currentMonth = ko.observable('');
	self.selectedBookDays = ko.observable({
		days : 1,
		daysLabel : "1박 2일"
	});
	self.bookDates = ko.observableArray([]);
	self.bookStartDate = ko.observable({});
	self.bookProductGroups = ko.observableArray([]);
	self.currentProductGroupCode = ko.observable('');
	self.captcha = ko.observable(''); // Jcaptcha추가
	self.captchaImageUrl = ko.observable('');
	self.productGroupCode = ko.observable({});
	self.bookDays = ko.observableArray();
	self.products = ko.observableArray();
	self.bookDateExtra = false;
	self.selectedProducts = ko.observableArray([]);
	self.contentTabId = ko.observable('P'); // P: product map, S: sale info, G
	
	//popupList add by woo
	self.popupList = ko.observableArray([]);
	if(popupList!=undefined && popupList!=null && popupList.length > 0){
		self.popupList(popupList);
	}
	
	self.productGroupScroll = null;
	
	self.firstLoaded = false;  //처음 로드 했는지 체크하는 변수
	
	// user guide
	self.monthCalendar = ko.computed(function() {
		if (self.currentMonth().length == 0)
			return;
		
		var calendar = [];
		var dateMonth = getDateByMonthString(self.currentMonth());
		var bookDates = self.bookDates();
		var bookStartDate = self.bookStartDate();
		var bookDays = self.selectedBookDays();
		var year = dateMonth.getFullYear();
		var month = dateMonth.getMonth();
		var days = getDaysOfMonth(dateMonth);
		var firstDay = getFirstDay(dateMonth);
		var isBuildAllDays = false;
		var idx = 0;

		var startDate = bookStartDate.date;

		for ( var j = 0; j < 6 && isBuildAllDays == false; j++) {
			var cols = ko.observableArray();
			for ( var i = 0; i < 7; i++, idx++) {
				var sDate = new Date(year, month, 1 - firstDay + idx);
				var sameMonth = (sDate.getMonth() - month) == 0;
				var dateLabel = '&bnsp;';
				if (sameMonth) {
					dateLabel = sDate.getDate();
				}

				var isBookDay = false;
				var isAdvance = false;
				if (bookDates && bookDates.length > 0) {
					var dateStr = getDateString(sDate);
					for ( var k in bookDates) {
						var playDateStr = bookDates[k].play_date;
						if (playDateStr == dateStr) {
							isBookDay = true;
							if(bookDates[k].advance_yn == '1') {
								isAdvance = true;
							}	 
							break;
						}
						
					}
				}

				var isSelected = false;
				if (startDate) {
					var endDate = DayAdd(startDate, bookDays.days - 1);
					if (sDate >= startDate && sDate <= endDate) {
						isSelected = true;
					}
				}
				
				var day = ko.observable({
					date : sDate,
					sameMonth : sameMonth,
					dateLabel : dateLabel,
					selected : isSelected,
					bookDay : isBookDay,
					advance : isAdvance
				});
			
				cols.push(day);
				if (sameMonth && days == sDate.getDate()) {
					isBuildAllDays = true;

				}
			}
			calendar.push(cols);
		}
		return calendar;
	}, this);

	self.currentMonthLabel = ko.computed(function() {
		var dateMonthStr = self.currentMonth();
		if (dateMonthStr) {
			return dateMonthStr.substr(0, 4) + '.' + dateMonthStr.substr(4, 2);
		}
		return '';
	}, this);

	self.clickBookDate = function(calendarDay) {
		//칠곡 제한 
		//if(self.shopInfo().shop_code == '504830064001') {
		//	if(self.selectedBookDays().days >= 3 && (getDateString(calendarDay.date).substring(4) >= '0701' && getDateString(calendarDay.date).substring(4) <= '0831')) {
		//		alert('해당 날짜에는 ' + self.selectedBookDays().daysLabel + ' 선택이 불가능 합니다.');
		//		return;
		//	}	
		//}
		
		if (!validateSchedule(self.bookDates(), calendarDay, self.selectedBookDays())) {
			return;
		}
	
		self.bookStartDate(calendarDay);
		self.selectedProducts.removeAll();
		
		$(".select_day").children('a').attr('title', '선택됨');
	};

	self.applyStayDays = function(maxDay) {
		self.bookDays.removeAll();
		for ( var i = 0; i < maxDay; i++) {
			var days = i + 1;
			var label = days + '박 ' + (days + 1) + '일';
			self.bookDays.push({
				days : days,
				daysLabel : label
			});
		}
		
		if(!self.firstLoaded) {
			if(self.shopInfo().two_stay_days > 0) {
				//alert('2박3일 우선 예약 시설입니다. 기본 설정된 숙박일수를 확인하신 후 예약신청 바랍니다.');
				if(self.bookDays().length >= 2) {
					var days = self.bookDays()[1];
					self.clickBookDay(days);
				}
			}
			
			self.firstLoaded = true;
		}
	};

	self.clickBookDay = function(bookDays) {
		//칠곡 제한
		//if(self.shopInfo().shop_code == '504830064001') {
		//	if(bookDays.days >= 3 && (getDateString(self.bookStartDate().date).substring(4) >= '0701' && getDateString(self.bookStartDate().date).substring(4) <= '0831')) {
		//		alert('해당 날짜에는 ' + bookDays.daysLabel + ' 선택이 불가능 합니다.');
		//		return;
		//	}	
		//}
	
		if (self.bookStartDate().date) {
			if (!validateSchedule(self.bookDates(), self.bookStartDate(), bookDays)) {
				return;
			}
		}

		self.selectedProducts.removeAll();	//add 2014.09.12
		self.selectedBookDays(bookDays);
		$('.myValue').parent().removeClass('open');
	};
	
	self.initScrollTabS = false;
	self.initScrollTabG = false;
	
	ko.computed(function() {
		
		var contentTabId = self.contentTabId();
		
		if( self['initScrollTab'+contentTabId] == true )
			return;
		
		self['initScrollTab'+contentTabId] = true;
		
		setTimeout(function(){
			$(".c_scroll"+contentTabId).mCustomScrollbar({
				set_width:660,
				set_height:560,
				scrollInertia:150,
				theme:"dark"
			});
		}, 500);
		
	}, this);

	ko.computed(function() {
		var shopInfo = self.shopInfo();
		
		if(shopInfo.drone_url != undefined && shopInfo.drone_url != '') {
			$("#droneImg").show();
		}
		
		//우선예약 데이터 세팅 
		if(self.shopInfo().advance_ddays && self.shopInfo().advance_ddays <= 7) {
			
		}
		
		if (shopInfo.play_month) {
			self.currentMonth(shopInfo.play_month);
		}
		if (shopInfo.book_days) {
			self.applyStayDays(shopInfo.book_days);
		}
		
	}, this);

	ko.computed(function() {
		if (self.currentMonth().length == 0)
			return;

		self.bookDateExtra = false;

		$.post('/Web/Book/GetBookPlayDate.json', {
			play_month : self.currentMonth()
		}, self.loadedBookPlayDate);
	}, this);

	self.loadedBookPlayDate = function(result) {
		if (result.error1) {
	      alert(result.error1.message);
	      if(result.redirect) {
	        location.href = result.returnUrl;
	      }
	      return;
	    }
    
		if (result.error) {
			alert(result.error.message);
			return;
		}

		if (self.bookDateExtra == false) {
			self.bookDates(result.data.bookPlayDateList);
		} else {
			self.bookDates(self.bookDates().concat(result.data.bookPlayDateList));
			self.bookDateExtra = false;
			return;
		}

		self.bookDateExtra = true;
		var date = getNextDate(getDateByMonthString(self.currentMonth()));
		$.post('/Web/Book/GetBookPlayDate.json', {
			play_month : getYearMonth(date)
		}, self.loadedBookPlayDate);
	};

	self.goPrevMonth = function() {
		var date = getPrevDate(getDateByMonthString(self.currentMonth()));
		self.clearSelectedInfo();
		self.currentMonth(getYearMonth(date));
	};

	self.goNextMonth = function() {
		var date = getNextDate(getDateByMonthString(self.currentMonth()));
		self.clearSelectedInfo();
		self.currentMonth(getYearMonth(date));
	};
	
	self.clearSelectedInfo = function() {
		self.products.removeAll();
		self.bookStartDate({});
		self.currentProductGroupCode('');
	};

	ko.computed(function() {
		if (self.currentMonth().length == 0)
			return;

		var bookStartDate = self.bookStartDate();
		var selectedBookDays = self.selectedBookDays();
		
		if (bookStartDate.date == undefined) {
			if (self.currentMonth().length == 0)
				return;

			var startDate = self.currentMonth() + '01';
			var endDate = self.currentMonth() + '31';

			params = {
				start_date : startDate,
				end_date : endDate
			};
			
		}else{
			var date = bookStartDate.date;
			var selectedDate = getDateString(date);
			
			params = {
				start_date : selectedDate,
				end_date : selectedDate
			};
		}
		
		$.post('/Web/Book/GetBookProductGroup.json', params, self.loadedBookProductGroups);
	}, this);

	self.loadedBookProductGroups = function(result) {
		
		if (result.error1) {
	      alert(result.error1.message);
	      if(result.redirect) {
	        location.href = result.returnUrl;
	      }
	      return;
	    }
		
		if (result.error) {
			alert(result.error.message);
			if(result.error.code == '0009') {
				location.href = "main?shopEncode=" + self.shopEncode;
			}
			return;
		}
		self.bookProductGroups(result.data.bookProductGroupList);
		
		if (self.bookProductGroups().length > 0 && self.currentProductGroupCode().length == 0) {
			self.currentProductGroupCode(self.bookProductGroups()[0].product_group_code);
		}
		
		if(self.productGroupScroll != null) {
			self.productGroupScroll.mCustomScrollbar("update");
		}else{
			self.productGroupScroll = $(".c_scroll1").mCustomScrollbar({
				set_width:220,
				scrollInertia:60,
				theme:"dark",
				autoHideScrollbar: true
			})
		}
		
	};

	ko.computed(function() {
		var bookStartDate = self.bookStartDate();
		if (bookStartDate.bookDay == false) {
			return;
		}

		var productGroupCode = self.currentProductGroupCode();
		
		if (bookStartDate && bookStartDate.bookDay && productGroupCode && productGroupCode.length > 0) {
			var days = self.selectedBookDays().days;
			var date = bookStartDate.date;
			var startDate = getDateString(date);
			var endDate = getDateString(DayAdd(date, days - 1));
			var twoStayDays = self.shopInfo().two_stay_days;
			var params = {
				product_group_code : productGroupCode,
				start_date : startDate,
				end_date : endDate,
				book_days : days,
				two_stay_days : twoStayDays
			};
			$.post('/Web/Book/GetBookProduct010001.json', params, self.loadedBookProducts);
		}

	}, this);

	self.productGroupName = ko.computed(function() {
		self.selectedProducts.removeAll();
		var list = self.bookProductGroups();
		var productGroupCode = self.currentProductGroupCode();
		for ( var i = 0; i < list.length; i++) {
			if (list[i].product_group_code == productGroupCode) {
				return list[i].product_group_name;
			}
		}
		return '';
	}, this);
	
	self.productGroupImageUrl = ko.computed(function() {
		var list = self.bookProductGroups();
		var productGroupCode = self.currentProductGroupCode();
		for ( var i = 0; i < list.length; i++) {
			if (list[i].product_group_code == productGroupCode) {
				//return staticServer + list[i].product_map_file_path + list[i].product_map_file_name;
				return 'https://s3.ap-northeast-2.amazonaws.com/xticket.kr-static/static' + list[i].product_map_file_path + list[i].product_map_file_name;
			}
		}
		return null;
	}, this);

	self.loadedBookProducts = function(result) {
		self.products.removeAll();

		if (result.error1) {
			alert(result.error1.message);
			if(result.redirect) {
				location.href = result.returnUrl;
			}
			return;
		}
		
		if (result.error) {
			alert(result.error.message);
			if(result.redirect) {
				location.href = result.returnUrl + self.shopEncode;
			}
			return;
		}

		self.products(result.data.bookProductList);
	};

	self.onProductOver = function(data, event, element) {

		var detailBox = $('#product_detail_box');
		$('#product_detail_text').html(getProductDetailText(data));
		detailBox.css('visibility', 'visible');
		var position = $(element).offset();
		detailBox.css("left", position.left - (detailBox.width() + 20));
		detailBox.css("top", position.top);
	};

	self.onProductOut = function(data, event) {
		$('#product_detail_box').css('visibility', 'hidden');
	};

	self.clickProduct = function(data) {
		//console.log(data);
		
		if (data.status_code == "4" && data.select_yn == "1") {
			return alert('예약 대기중인 사이트 입니다.');
		}
		
		if (data.status_code != "0" || data.select_yn != "1") {
			return;
		}

		if (self.findSelectedProduct(data.product_code) != null) {
			self.selectedProducts.remove(data);
		} else {
			var count = self.selectedProducts().length;
			var limitCount = 0;
			if(self.bookStartDate().advance) {
				limitCount = self.shopInfo().advance_day_limit_count;
			}else{
				limitCount = self.shopInfo().book_day_limit_count;
			}
			if(count >= limitCount) {
				return alert('예약 제한 수량을 초과하였습니다.');
			}
				
			self.selectedProducts.push(data);
		}
	};

	self.findSelectedProduct = function(code) {
		var list = self.selectedProducts();
		for ( var i = 0; i < list.length; i++) {
			if (list[i].product_code == code) {
				return list[i];
			}
		}
		return null;
	};

	self.getProductSelectInfo = ko.computed(function() {
		var text = '';
		var bookStartDate = self.bookStartDate();
		if (!bookStartDate.date) {
			return '';
		}

		var days = self.selectedBookDays().days;
		var startDate = bookStartDate.date;
		var endDate = DayAdd(startDate, days);

		text += getDateStringLocale(startDate) + ' ~ ' + getDateStringLocale(endDate);
		
		text += '(' + days +'박' + (days+1) + '일)';

		var productText = '';
		var total = 0;
		var list = self.selectedProducts();
		for ( var i = 0; i < list.length; i++) {
			if (productText.length > 0) {
				productText += ', ';
			}
			productText += list[i].product_name;
			total += parseInt(list[i].sale_product_fee);
		}

		if (productText.length > 0) {
			text += ' / ' + productText + ' / ' + moneyString(total) + '원';
		}
		
		//연박이면 할인 체크
		if(days > 1) {
			var groupList = self.bookProductGroups();
			var stayDiscountAmount = 0;
			for ( var i = 0; i < groupList.length; i++) {
				if (groupList[i].product_group_code == self.currentProductGroupCode()) {
					if(groupList[i].stay_discount_yn == '1' && total > 0) {
						stayDiscountAmount = ((days - 1) * groupList[i].stay_discount_value) * list.length;
						text += ' (연박할인 후 ' + moneyString(total - stayDiscountAmount) + '원)';
					}
				}
			}
		}

		return text;
	}, this);

	self.clickReservation = function() {
		//console.log('click');
		
		if(self.blacklistYn()  == '1') {
			alert(languageModel.getMsg('000038') + self.blacklistStartDate() + ' ~ ' + self.blacklistEndDate() + languageModel.getMsg('000039'));
			return;
		}
		
		var bookStartDate = self.bookStartDate();
		if (!bookStartDate.date) {
			return alert('날짜를 선택해 주세요.');
		}

		if (self.selectedProducts().length == 0) {
			return alert('상품(사이트)를 선택해 주세요.');
		}

		var productGroupCode = self.currentProductGroupCode();
		if (!productGroupCode || productGroupCode.length == 0) {
			return alert('시설을 선택해 주세요.');
		}

		var memberId = self.memberId();
		if (!memberId || memberId.length == 0) {
			return alert('먼저 로그인을 해주세요.');
		}
	
		if(self.bookStartDate().advance){
			showAdvanceInfoLayer();
		}else{
			self.refreshCaptchaImage();
			self.captcha('');
			showReservationLayer();
		}
	};

	self.refreshCaptchaImage = function() {
		self.captchaImageUrl('/Web/jcaptcha?r=' + Math.random());
	};

	self.clickReservationConfirm = function() {
		var captchaText = self.captcha();
		if (captchaText.length == 0) {
			return alert('이미지에 보이는 글자를 입력해 주세요.');
		}

		self.sendReservationInfo();
	};

	self.sendReservationInfo = function() {
		var bookStartDate = self.bookStartDate();
		if (!bookStartDate.date) {
			return alert('날짜를 선택해 주세요.');
		}

		if (self.selectedProducts().length == 0) {
			return alert('상품(사이트)를 선택해 주세요.');
		}

		var productGroupCode = self.currentProductGroupCode();

		if (!productGroupCode || productGroupCode.length == 0) {
			return alert('시설을 선택해 주세요.');
		}

		var captchaText = self.captcha();

		if (!captchaText || captchaText.length == 0) {
			return alert('자동입력방지 문자를 입력해 주세요.');
		}

		var days = self.selectedBookDays().days;
		var date = bookStartDate.date;
		var play_date = '';

		for ( var i = 0; i < days; i++) {
			if (play_date.length > 0) {
				play_date += ',';
			}
			play_date += getDateString(DayAdd(date, i));
		}

		var product_code = '';
		var list = self.selectedProducts();
		for ( var i = 0; i < list.length; i++) {
			if (product_code.length > 0) {
				product_code += ',';
			}
			product_code += list[i].product_code;
		}

		var params = {
			product_group_code : productGroupCode,
			play_date : play_date,
			product_code : product_code,
			captcha : captchaText
		};
		
		$.post('/Web/Book/Book010001.json', params, self.sendedReservationInfo);
	};

	self.sendedReservationInfo = function(result) {
		
		if (result.error1) {
	      alert(result.error1.message);
	      if(result.redirect) {
	        location.href = result.returnUrl;
	      }
	      return;
	    }
		
		if (result.error) {
			alert(result.error.message);
			if (result.error.code == '0001') { // 보안문자 틀림
				self.refreshCaptchaImage();
				self.captcha('');
			}else if (result.error.code == '0006') { // 주소정보가 없으면 
				location.href = "/web/profile?shopEncode=" + self.shopEncode;
			}else{
				hideReservationLayer();
			}
			
			if(result.redirect) {
				location.href = result.returnUrl + self.shopEncode;
			}
			return;
		}

		if (result.data.success) {
			if(result.data.payment_limit_minute!=""){
				alert('[예약이 완료되었습니다. ' + result.data.payment_limit_minute + '까지 결제하시지 않으면 자동 취소됩니다.]');
			}else{
				alert('[예약이 완료되었습니다.]');
			}
			location.href = 'books?shopEncode=' + self.shopEncode;
		} else {
			return alert('예매를 실패하였습니다.');
		}
	};
}

var model = new BookingModel();

$(function() {
	showNoticeLayer();
});

function validateSchedule(bookDates, bookStateDate, bookDays) {
	var date = bookStateDate.date;
	var days = bookDays.days;
	var advance = bookStateDate.advance ? '1' : '0';
	
	var count = 0;
		
	if (bookDates && bookDates.length > 0) {
		var dateStr = getDateString(date);
		for ( var k in bookDates) {
			var playDateStr = bookDates[k].play_date;
			var advanceStr = bookDates[k].advance_yn;
			
			if (playDateStr == dateStr && advance == advanceStr) {
				count++;
				if (days == count) {
					return true;
				}
				dateStr = getDateString(DayAdd(date, count));
			} else if (count > 0) {
				break;
			}
		}
	}

	alert("선택하신 날짜와 숙박일로 가능한 예약시설이 없습니다.\n숙박일을 다시 선택하시기 바랍니다.");
	return false;
}

function getCalendarDayClass(day) {
	var classStr = '';
	if (day.bookDay)
		classStr = 'available';
	if (day.advance)
		classStr = 'advance';
	if (day.selected)
		classStr = 'select_day';

	if (day.date.getDay() == 0) {
		if (classStr.length > 0) {
			classStr += ' ';
		}
		classStr += 'left';
	}
	if (day.date.getDay() == 6) {
		if (classStr.length > 0) {
			classStr += ' ';
		}
		classStr += 'right';
	}

	return classStr;
}

function getBookDaysClass(list) {
	if (list && list.length > 14) {
		return 'aList aList_scroll';
	}
	return 'aList';
}

function getProductClass(data) {
	if (data.status_code == "0") {
		if (data.select_yn == "1") {
			var selecteds = model.selectedProducts();
			for ( var i = 0; i < selecteds.length; i++) {
				if (selecteds[i].product_code == data.product_code) {
					return 'product_box selected';
				}
			}
			return 'product_box normal';
		} else {
			return 'product_box saled';
		}
	} else {
		return 'product_box disabled';
	}
}

function getProductImageUrl(data) {
	if (data.status_code != "2") {
		if (data.status_code == "4" && data.select_yn == "1") {
			return '/resources/images/icon/product_map_wait' + data.width + 'x' + data.height + '.png';
		}else{
			if ( data.status_code == "0" && data.select_yn == "1") {
				var selecteds = model.selectedProducts();
				for ( var i = 0; i < selecteds.length; i++) {
					if (selecteds[i].product_code == data.product_code) {
						return '/resources/images/icon/product_map_selected' + data.width + 'x' + data.height + '.png';
					}
				}
				return '/resources/images/icon/product_map_house' + data.width + 'x' + data.height + '.png';
			} else {
				return '/resources/images/icon/product_map_sold' + data.width + 'x' + data.height + '.png';
			}
		}
	} else {
		return '/resources/images/icon/product_map_disable' + data.width + 'x' + data.height + '.png';
	}
}

function getProductAlt(data) {
	if (data.status_code != "2") {
		if ( data.status_code == "0" && data.select_yn == "1") {
			var selecteds = model.selectedProducts();
			for ( var i = 0; i < selecteds.length; i++) {
				if (selecteds[i].product_code == data.product_code) {
					return data.product_name;
				}
			}
			return data.product_name + ' 선택가능';
		} else {
			return data.product_name + ' 예약완료';
		}
	} else {
		return data.product_name + ' 수리중';
	}
}

function getProductDetailText(data) {
	var text = getBoldString(data.product_name) + '<br/>';
	
	if(data.status_code == "0" && data.select_yn == "1") {
		text += '판매가: ' + moneyString(data.sale_product_fee) + '<br/>';
	}else{
		text += '판매가: 0' + '<br/>';
	}
	/*
	text += '일반: ';
	if (data.discount_yn == '0' && data.premium_yn == '0') {
		text += getBoldString(moneyString(data.product_fee));
	} else {
		text += moneyString(data.product_fee);
	}
	text += '<br/>';
	text += '성수기: ';
	if (data.premium_yn == '1') {
		text += getBoldString(moneyString(data.product_premium_fee));
	} else {
		text += moneyString(data.product_premium_fee);
	}
	text += '<br/>';
	text += '비수기: ';
	if (data.discount_yn == '1') {
		text += getBoldString(moneyString(data.product_discount_fee));
	} else {
		text += moneyString(data.product_discount_fee);
	}
	*/
	return text;
}

function showReservationLayer() {
	var layerWidht = $(".chk_layer.captcha .layer").width();
	var layerHeight = $(".chk_layer.captcha .layer").height();
	
	var winHeight = $(window).height();
	var winWidth = $(window).width();
	var layerTop = (winHeight / 2) - (layerHeight / 2);
	var layerLeft = (winWidth / 2) - (layerWidht / 2);
	$(".chk_layer.captcha .layer").css({
		"top" : layerTop + "px",
		"left" : layerLeft + "px"
	});
	$(".chk_layer.captcha .bg").css("height", $(document).height() + "px").fadeTo("fast", 0.8);
	$(".chk_layer.captcha").fadeTo("fast", 1.0);
}

function hideReservationLayer() {
	$(".chk_layer").fadeOut("fast", 0);
}

function showNoticeLayer() {
	var noticePopups = $(".chk_layer.notice");
	var noticePopupId;
	for(var i=0; i<noticePopups.length; i++){
		noticePopupId = $(noticePopups[i]).attr('id');
		if($.cookie(noticePopupId) != undefined){
			$(noticePopups[i]).removeClass('notice');
		}
	}
	
	noticePopups = $(".chk_layer.notice");
	
	if(noticePopups.length > 0){
		var layerWidht = $(".chk_layer.notice .layer").width();
		var layerHeight = $(".chk_layer.notice .layer").height();
		var winHeight = $(window).height();
		var winWidth = $(window).width();
		var layerTop = (winHeight / 2) - (layerHeight / 2);
		var layerLeft = (winWidth / 2) - (layerWidht / 2);
		
		$(".chk_layer.notice .layer").css({
			"top" : layerTop + "px",
			"left" : layerLeft + "px"
		});
		$(".notice_bg").css("height", $(document).height() + "px").fadeTo("fast", 0.8);
		$(".chk_layer.notice").fadeTo("fast", 1.0);
		$(".chk_layer.notice .layer").attr("tabindex", 0).show().focus();		
		
		$(".c_scroll10").mCustomScrollbar({
			set_width:325,
			scrollInertia:150,
			theme:"dark",
			autoHideScrollbar: true
		});
	}
}

function hideNoticeLayer(el){
	var popupSequence = $(el).attr('data');
	
	if($('#notice_checkbox_' + popupSequence).is(":checked") == true){
		$.cookie('notice_layer_' + popupSequence, popupSequence, { expires: 1 }); //쿠키의 유효기간을 1일간으로 지정
	}
	
	if($('.chk_layer.notice:visible').length == 1){
		$(".notice_bg").fadeOut("fast", 0);
		$("#mainLogo").focus();
	}
	$('#notice_layer_' + popupSequence).fadeOut("fast", 0);
	
	var noticePopups = $(".chk_layer.notice .layer");
	//console.log(noticePopups[$('.chk_layer.notice:visible').length - 2]);
	$(noticePopups[$('.chk_layer.notice:visible').length - 2]).attr("tabindex", 0).show().focus();
	
}

function showChangePasswordLayer() {
	var layerWidht = $(".chk_layer1.password .layer").width();
	var layerHeight = $(".chk_layer1.password .layer").height();
	
	var winHeight = $(window).height();
	var winWidth = $(window).width();
	var layerTop = (winHeight / 2) - (layerHeight / 2);
	var layerLeft = (winWidth / 2) - (layerWidht / 2);
	$(".chk_layer1.password .layer").css({
		"top" : layerTop + "px",
		"left" : layerLeft + "px"
	});
	$(".chk_layer1.password .bg").css("height", $(document).height() + "px").fadeTo("fast", 0.8);
	$(".chk_layer1.password").fadeTo("fast", 1.0);
}

function hideChangePasswordLayer() {
	$(".chk_layer1").fadeOut("fast", 0);
}

function showAdvanceInfoLayer() {
	var layerWidht = $(".chk_layer2.advance .layer").width();
	var layerHeight = $(".chk_layer2.advance .layer").height();
	
	var winHeight = $(window).height();
	var winWidth = $(window).width();
	var layerTop = (winHeight / 2) - (layerHeight / 2);
	var layerLeft = (winWidth / 2) - (layerWidht / 2);
	$(".chk_layer2.advance .layer").css({
		"top" : layerTop + "px",
		"left" : layerLeft + "px"
	});
	$(".chk_layer2.advance .bg").css("height", $(document).height() + "px").fadeTo("fast", 0.8);
	$(".chk_layer2.advance").fadeTo("fast", 1.0);
}

function clickAdvance() {
	$(".chk_layer2").fadeOut("fast", 0);
	
	model.refreshCaptchaImage();
	model.captcha('');
	showReservationLayer();
}

function hideAdvanceInfoLayer() {
	$(".chk_layer2").fadeOut("fast", 0);
}


//2018.04.24 kenosis
function PasswordManagerModel() {
	var self = this;
	
	self.oldPasswd = ko.observable('');
	self.passwd = ko.observable('');
	self.passwd2 = ko.observable('');
	self.changePassword = ko.observable("Yes");
	
	self.valdateData = function() {
		
		if (self.oldPasswd().length == 0 ) {
			alert(languageModel.getMsg('000035'));
			return false;
		}
		
		var passwd = self.passwd();
		
		if(!chkPassword(passwd)) {
			alert(languageModel.getMsg('000040'));
			return false;
		}
		
		if (passwd.length < 10) {
			alert(languageModel.getMsg('000034'));
			return false;
		}
		
		if (passwd.indexOf(model.memberId().substring(1, 4)) > -1) {
			alert(languageModel.getMsg('000032'));
			return false;
		}
		
		var regexNo = /(\w)\1\1/;
   		if (!regexNo.test(passwd)) {
	        if (!stck(passwd, 4)) {
	            alert(languageModel.getMsg('000031')); 
	        	return false;
	        }
    	}
    	
    	if (self.passwd2() == 0) {
			alert(languageModel.getMsg('000036'));
			return false;
		}
		
    	if (passwd != self.passwd2()) {
			alert(languageModel.getMsg('000015'));
			return false;
		}
		
		if (passwd == self.oldPasswd()) {
			alert(languageModel.getMsg('000037'));
			return false;
		}
		
		return true;
	}
	
	self.clickChangePassword = function() {
		
		if (self.changePassword() == 'Yes') {
			if(self.valdateData()) {
				$.post('/Web/Member/ChangePassword.json', {
					old_password : self.oldPasswd(),
					member_password : self.passwd()
				}, self.resultChangePassword);
			}
		}else{
			$.post('/Web/Member/ChangePassword.json', {
				old_password : '',
				member_password : ''
			}, self.resultChangePassword);
		}
	};
	
	self.resultChangePassword = function(result) {
		if (result.error) {
			alert(result.error.message);
			return;
		}
		
		if (result.data.success) {
			hideChangePasswordLayer();
		} else {
			alert(languageModel.getMsg('000042'));
			return;
		}
	}
	
}

        
//Key Event Handler
function keyEventHandler() {
	var objTable = document.getElementById("calendarTable");
	 	
	var maxRows   = objTable.rows.length-1;
	//var iRowIdx = getRowIndex();
     var rowIndex = 0;
     var colIndex = 0;
     
    var focused = document.activeElement;
        
    for (var i = 0; i < objTable.rows.length; i++) {
    	for(var j = 0; j < 7; j++) {
    		if(focused.childNodes[0].nodeValue == objTable.rows[i].cells[j].childNodes[0].text) {
    			rowIndex = i;
    			colIndex = j;
    			break;
    		}
		}
    }
    
    if(event.keyCode == 37)	{		//왼쪽
    	if(colIndex == 0) {
    		if(rowIndex == 1) {
    			
    		}else{
    			rowIndex--;
    			colIndex = 6;
    		}
    	}else{
    		colIndex--;
    	}
    }else if(event.keyCode == 38) {		//위쪽 
    	if(rowIndex == 1) {
    	
    	}else{
    		rowIndex--;
    	}
    }else if(event.keyCode == 39) {		//오른쪽 
    	if(colIndex == 6) {
    		if(rowIndex == maxRows) {
    			
    		}else{
    			rowIndex++;
    			colIndex = 0;
    		}
    	}else{
    		colIndex++;
    	}
    }else if(event.keyCode == 40) {		//아래 
    	if(rowIndex == maxRows) {
    	
    	}else{
    		rowIndex++;
    	}
    } 
    
    var targetObject = objTable.rows[rowIndex].cells[colIndex].firstChild;
    
    if(targetObject.text != undefined) {
    	targetObject.focus();
    }
}

function dropdownFocusout() {
	$('.myValue').parent().removeClass('open');
}

function dropdownKeyEventHandler() {

	$('.myValue').parent().addClass('open');
	
	/*
	var rowIndex = 0;
	
	for(var i = 0; i < model.bookDays().length; i++) {
		
		if(model.bookDays()[i].days == model.selectedBookDays().days) {
			rowIndex = i;
			break;
		}
	}
	
	if(event.keyCode == 38) {		//위쪽 
		if(model.bookDays()[0].days != model.selectedBookDays().days) {
			rowIndex--;
		}
	}else if(event.keyCode == 40) {		//아래 
		if(model.bookDays()[model.bookDays().length - 1].days != model.selectedBookDays().days) {
			rowIndex++;
		}
	}
	
	var days = model.bookDays()[rowIndex];
	model.clickBookDay(days);
	*/
}


