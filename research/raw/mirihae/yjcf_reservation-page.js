/* ============================================
   reservation-page.js
   reservation.jsp 에서 분리된 예약 페이지 JS
   ============================================ */

/* 상품선택여부 체크 */
var selectItemCheckFlag = true;

/* ㅊ */
var eventNotices = [];

$(document).ready(function(){
	/* 로딩 레이어 숨기기 */
	$("#reloadFlag").val("1");
	$(".loading").remove();

	/* 메뉴 active */
	$(".menu-n .reservation").addClass("active");

	/* 행사안내 로드 */
	if (typeof groupCode !== 'undefined' && groupCode) {
		$.get("/camping/api/eventNoticeList.do", { groupCode: groupCode }, function(data) {
			eventNotices = data || [];
		});
	}
});

var submitBtnFlag = true;

/* 날짜 선택 */
var checkType = "";
var checkDate = "";
var startDate = "";
var endDate = "";
var selectDateFlag = true;
function fn_select(date){

	$("#check").remove();

	// 긴급예약제한 체크
	var _blocked = false;
	var pageId = $("#pageId").val();
	var groupCode = $("#groupCode").val();
	$.ajax({
		url: emergencyCheckUrl,
		type: "POST",
		data: { pageId: pageId, groupCode: groupCode },
		dataType: "json",
		async: false,
		success: function(res){
			if(res.blocked){
				_blocked = true;
				startDate = "";
				endDate = "";
				checkDate = "";
				$("#selectStartDate").val("");
				$("#selectEndDate").val("");
				$(".calendar .td").removeClass("active pignose-calendar-unit-first-active pignose-calendar-unit-second-active pignose-calendar-unit-active pignose-calendar-unit-range");
				$(".calendar-in .table").removeClass("start");
				$(".selectDateResult").remove();
				$("#map-select .head h1").text("예약날짜를 선택해주세요.");
				$(".map").addClass("coveron");
				selectDateFlag = true;
				$("#emergencyBlockModal").remove();
				$.post(emergencyPopupUrl, { pageId: pageId, groupCode: groupCode }, function(popupHtml) {
					$("body").append(popupHtml);
				});
			}
		}
	});
	if(_blocked) return;

	console.log("날짜선택 selectDateFlag :: "+ selectDateFlag);

	if(selectDateFlag){
		selectDateFlag = false;

		if(startDate == "" || (startDate != "" && endDate != "")){
			if(!$("#"+date).hasClass("click")){
				if($("#"+date).hasClass("preOpenPeriod")){
					fn_cert_popup();
				}else{
					alert("예약가능한 날짜를 선택해주세요");
				}
				selectDateFlag = true;
				return;
			}
		}

		checkDate = date;

		if(startDate == ""){

			// 입실일 클릭
			if(!$("#"+date).hasClass("click")){
				if($("#"+date).hasClass("preOpenPeriod")){
					fn_cert_popup();
				}else{
					alert("예약가능한 날짜를 선택해주세요");
				}
				selectDateFlag = true;
				return;
			}

			$("#selectStartDate").val(checkDate);
			$("#"+checkDate).addClass("pignose-calendar-unit-first-active");
			$("#"+checkDate).addClass("pignose-calendar-unit-active");
			$(".calendar-in .table").addClass("start");

			$.ajax({
			    url: "/camping/tokenCheck.do",
			    cache: false,
			    async: false,
			    type: "post",
			    data: $('form[name=searchForm]').serialize(),
			    dataType:'json',
			    success: function(data){

			    	if(data.resultCode != "200"){
			    		if(confirm("선택하신 자리가 초기화됩니다. 계속 진행하시겠습니까?")){

			    			$("#map-select .head h1").text("예약날짜를 선택해주세요.");
							$(".map").addClass("coveron");

			    			$.ajax({
							    url: "/camping/initSelectReservation.do",
							    cache: false,
							    async: false,
							    type: "post",
							    data: $('form[name=searchForm]').serialize(),
							    dataType:'json',
							    success: function(data){
							    	startDate = checkDate;
							    	fn_end_date_init();

							    	$.post("/camping/selectItemList.do", $("#searchForm").serialize(), function(data) {
										$("#selectTicketInfo").html(data);
									})
							    }
							});

			    		}else{
			    			// 날짜 선택 취소
			    			$("#selectStartDate").val("");
			    			$("#"+checkDate).removeClass("pignose-calendar-unit-first-active");
			    			$("#"+checkDate).removeClass("pignose-calendar-unit-active");
			    			$(".calendar-in .table").removeClass("start");
			    		}
			    	}else{
			    		startDate = checkDate;
			    	}
			    	selectDateFlag = true;
			    }
			});


		}else {

			if(endDate == ""){
				// 퇴실일 선택 시
				fn_endDateCheck(date);
			}else{

				$(".calendar .td").removeClass("pignose-calendar-unit-first-active");
				$(".calendar .td").removeClass("pignose-calendar-unit-second-active");
				$(".calendar .td").removeClass("pignose-calendar-unit-range");
				$(".calendar .td").removeClass("pignose-calendar-unit-active");

				// 날짜 변경할때 (입실일 다시 클릭)
				$.ajax({
				    url: "/camping/tokenCheck.do",
				    cache: false,
				    async: false,
				    type: "post",
				    data: $('form[name=searchForm]').serialize(),
				    dataType:'json',
				    success: function(data){
				    	console.log("다른날짜 선택 " +data.resultCode);
				    	if(data.resultCode != "200"){

				    		// 이미 선택된 자리가 있을 경우
				    		if(confirm("선택하신 자리가 초기화됩니다. 계속 진행하시겠습니까?")){

				    			$("#map-select .head h1").text("예약날짜를 선택해주세요.");
								$(".map").addClass("coveron");

				    			$.ajax({
								    url: "/camping/initSelectReservation.do",
								    cache: false,
								    async: false,
								    type: "post",
								    data: $('form[name=searchForm]').serialize(),
								    dataType:'json',
								    success: function(data){
								    	startDate = checkDate;
								    	fn_end_date_init();
								    }
								});

				    		}

				    	}else{
				    		startDate = checkDate;
				    		$("#map-select .head h1").text("예약날짜를 선택해주세요.");
					    	$(".map").addClass("coveron");
					    	fn_end_date_init();
				    	}
				    	selectDateFlag = true;
				    }
				});
			}
		}
		/* 기간 선택 END */
	}else{
		fn_alert_layer_open("잠시만 기다려주세요. ");
	}
}

function fn_end_date_init(){
	// 기존 선택일자 취소
	$("#selectEndDate").val("");
	endDate = "";
	$(".calendar .td").removeClass("pignose-calendar-unit-range");
	$(".calendar .td").removeClass("pignose-calendar-unit-second-active");
	$(".calendar .td").removeClass("pignose-calendar-unit-active");
	$(".selectDateResult").remove();
	// 시작일 세팅
	$("#"+startDate).addClass("pignose-calendar-unit-first-active");
	$("#"+startDate).addClass("pignose-calendar-unit-active");


	$("#selectStartDate").val(startDate);
	$(".calendar-in .table").addClass("start");

	// 지도 초기화
	$(".pin-area .pin.active").removeClass("active");
	$(".pin-area .pin.disabled").removeClass("disabled");
	$(".form").empty();
	$("#form-wrap").empty();
}

function fn_endDateCheck(date){ //date === 퇴실날짜
	if($("#selectStartDate").val() == date){
		alert("퇴실일이 입실일과 같습니다. 다른 날짜를 선택해주세요");
		selectDateFlag = true;
		return;
	}
	var startIndex = $("#"+startDate).data("index");
	var endIndex = $("#"+date).data("index");

	$("#selectEndDate").val(date);
	$.ajax({
	    url: "/camping/nightCheck.do",
	    type: "post",
	    data: $('form[name=searchForm]').serialize(),
	    dataType:'json',
	    success: function(data){
	    	console.log("data"+data);
	    	if(data.resultCode){
	    		console.log("예약가능")
	    		console.log(" resultCode :: " + data.resultCode);

	    		if(startIndex > endIndex){
	    			endDate = startDate;
	    			startDate = date;

	    			$(".calendar .td").removeClass("range");
	    			$(".calendar .td").removeClass("active");

	    			$("#"+startDate).addClass("active");
	    			var start = $("#"+startDate).data("index");
	    			var end = $("#"+endDate).data("index");
	    			for(var i = (start+1); i < end; i ++){
	    				$(".td"+i).addClass("pignose-calendar-unit-range");
	    			}
	    			$("#"+endDate).addClass("pignose-calendar-unit-second-active");

	    		}else{
	    			 for(var i = (startIndex+1); i < endIndex; i ++){
	    				$(".td"+i).addClass("pignose-calendar-unit-range");
	    			}
	    			$("#"+date).addClass("pignose-calendar-unit-second-active");
	    			endDate = date;
	    		}
	    		$("#"+startDate).addClass("pignose-calendar-unit-first-active");
	    		$("#"+startDate).addClass("pignose-calendar-unit-active");
	    		$("#"+startDate).removeClass("active");
	    		$("#selectStartDate").val(startDate);
	    		$("#selectEndDate").val(endDate);

	    		$(".calendar-in .table").removeClass("start");
	    		$(".calendar-in .table").addClass("end");

	    		 var arrayDate = getDatesStartToLast(startDate, endDate);
	    		$.each(arrayDate, function(index, item){
	    			if(index > 0){
	    				$("#"+item).addClass("pignose-calendar-unit-range");
	    			}
	    		})
	    		 $("#"+endDate).addClass("pignose-calendar-unit-second-active");
	    		$("#"+endDate).addClass("pignose-calendar-unit-active");
	    		console.log("enddate")

	    		$("#reloadFlag").val("0");
	    		$("#loading").show();

	    		fn_dateItem();
	    	}else{
	    		console.log("5박이상 예약불가")
	    		console.log(" resultCode :: " + data.resultCode)
	    		alert("최대예약일수는 4박5일입니다.");
	    		$("#selectEndDate").val("");
	    		selectDateFlag = true;
	    	    return;
	    	}
	    },
	    error: function(xhr, status, error) {
	        console.error("Error occurred during AJAX request:", error);
	    }
	});


}



var pinLoading = true;
var dataItemRoad = true;
function fn_dateItem(){

	$.post("/camping/selectItemList.do", $("#searchForm").serialize(), function(data) {
		$("#selectTicketInfo").html(data);
	})
	console.log("fn_dateItem dataItemRoad :: " + dataItemRoad);

	if(dataItemRoad){

		dataItemRoad = false;
		$("#selectDateResult").remove();

		pinLoading = true;
		fn_pin_load();

		var sLabel = fn_weekLabel($("#selectStartDate").val());
		var eLabel = fn_weekLabel($("#selectEndDate").val());
		$("#map-select .head .added-date").text($("#selectStartDate").val() +"("+sLabel+") 입실 ~ "+$("#selectEndDate").val()+"("+eLabel+") 퇴실 자리 선택");
		$("#map-select .head .added-date").addClass("point");

		$('.row .map-area').focus();
		fn_scroll();

		dataItemRoad = true;
		selectDateFlag = true;

		// 2-3 지도 하단 form 세팅
		$.post("/camping/selectItemForm.do", $("#searchForm").serialize(), function(data) {
			$("#map-select .form").remove();
			$("#map-select .row").append(data);
		}).done(function() {
			//  2-4 하단 예약 form 세팅
			$.post("/camping/reservationForm.do", $("#searchForm").serialize(), function(data) {
				$("#form-wrap").empty();
				$("#form-wrap").append(data);
			}).done(function() {

			})
		})

	}else{
		fn_alert_layer_open("잠시만 기다려주세요 !!!");
	}
}

function fn_pin_load(){
	if(pinLoading){
		pinLoading = false;

		$(".pin-area").removeClass("pinSelect");
		$(".pin-area .pin").removeClass("active");
		$(".pin-area .pin").removeClass("cursor");
		$(".pin-area .pin").addClass("disabled");

		$.ajax({
		    url: "/camping/selectAjaxDatePinInfo.do",
		    cache: false,
		    async: false,
		    type: "post",
		    data: $('form[name=searchForm]').serialize(),
		    dataType:'json',
		    success: function(data){
		    	console.log("data =", data);
		    	var pinCategoryList = data.pinCategoryList;
                var rentalPackHtml = "";
                var rentalCount = 0
                var remainingCount = 0;
		    	$.each(pinCategoryList, function (index, item) {
		    		var pinHtml = "";
			    	$.each(item.pinList, function (index, pin) {
                        // 렌탈 상품이면 pack에 담기
                        if (pin.categoryType === 'rental') {
                            rentalCount++;
                            console.log("rentalCount = " + rentalCount);
                            if (pin.useAt !== 'N') {
                                remainingCount++;
                            }
                            console.log("remainingcount = "+ remainingCount);
                            rentalPackHtml += "<li ";
                            rentalPackHtml += " class=\"pin toggle only "
                                            + pin.itemId + " "
                                            + (pin.useAt === 'N' ? "disable" : "") + "\" ";
                            rentalPackHtml += " data-category=\"" + pin.categoryNm + "\" ";
                            rentalPackHtml += " data-name=\"" + pin.itemNm + "\" ";
                            if (pin.useAt !== 'N') {
                                rentalPackHtml += " onclick=\"fn_select_pin('" + pin.itemId + "')\" ";
                            }
                            rentalPackHtml += " >";
                            rentalPackHtml += " <span class=\"material-symbols-sharp\">mode_heat_cool</span>";
                            rentalPackHtml += "</li>";
                        }

                        if(pin.categoryType !== 'rental'){
                            pinHtml += "<div data-name=\""+pin.itemNm+"\" data-category=\""+pin.categoryNm+"\"	";
                            pinHtml += " data-categoryusable=\"true\"	";
                            pinHtml += " id=\"pin-"+pin.itemClassId+"\"";
                            pinHtml += " class=\"pin "+pin.categoryId+" "+pin.itemId+" "+pin.color+" ";
                            if(pin.useAt == "N"){
                                pinHtml += " disabled ";
                                pinHtml += "\" title=\"이미 예약된 자리입니다!(선택불가) "+pin.itemNm +"\"";
                                pinHtml += " onclick=\"alert('이미 예약된 자리입니다');\"";
                            }else{
                                pinHtml += " cursor ";
                                pinHtml += "\" title=\""+pin.itemNm +"\"";
                                pinHtml += " onclick=\"fn_select_pin('"+pin.itemId+"');\"";
                                pinHtml += "onkeydown=\"if(event.keyCode == 13){fn_select_pin('"+pin.itemId+"');}\"";
                            }
                            pinHtml += " tabindex=\"0\" >";
                            pinHtml += "<div class=\"marker\"><p>"+pin.itemNo+"</p></div>";
                            pinHtml += "<div class=\"deco\"></div>";
                            if(pin.rampYn === 'Y'){
                                pinHtml += "<div class=\"feat icon icon-ramp\"><span class=\"material-symbols-sharp fill\">elevation</span></div>";
                            }
                            if(pin.petYn === 'Y'){
                                pinHtml += "<div class=\"feat icon icon-pet\"><img src=\"/camping/images/icon/pin-pet.svg\" alt=\"반려동물\"></div>";
                            }
                            pinHtml += "</div>";
                        }

			    	});
			    	$("#pinCategory"+(index+1)).html(pinHtml);
		    	})
		    	$(".map-picker .map-area").after(
                    '<div class="options">'
                    + '<div class="title">'
                    + '<p>동계팩 대여를 원하시는 분은 선택 해주세요.</p>'
                    + '<p>선착순 '+ rentalCount +'명 지급. 남은 수량 <strong class="impo">'+ remainingCount +'</strong></p>'
                    + '</div>'
                    + '<ul class="pack">'
                    + rentalPackHtml
                    + '</ul>'
                    + '</div>'
                )
		    	$(".pin-area").addClass("pinSelect");

		    	if(!data.selectDateCheck){
		    		alert("우선예약은 하루에 한자리만 예약 가능합니다. \n선택하신 날짜에 이미 예약하신 내역이 존재합니다. ");
		    	}else if(!data.preOpenCheck){
		    		alert("우선예약은 하루에 "+data.preOpenCnt+"번만 가능합니다. \n이미 예약하신 내역이 존재합니다. ");
		    	}

		    	$('.pin-area .pin').mouseenter( function () {
	    	    	if( !$( this ).hasClass('disabled')){
						$(this).addClass('over');
	    	    	}
	    		});
				$('.pin-area .pin').mouseleave( function () {
	    	    	$(this).removeClass('over');
	    		});

		    	$("#reloadFlag").val("1");
				$("#loading").hide();

				$("#selectDateResult").remove();
				var html ="<div class=\"district selectDateResult\" id=\"selectDateResult\">";
				$.each(data.categoryList, function (index, item) {
					if(item.use_at == "Y" && item.usage_type != "ticket"){
						html+= "<dl class=\"schedule "+item.color+" \" data-id='"+item.category_id+"'>";
						html += "<dt><span></span></dt>";
						html += "<dd>"+item.category_nm+"</dd>";
						html += "</dl>";
					}
				})
				html += "</div>";
				$("#"+$("#selectStartDate").val()+ " .element").append(html);

				$('#selectDateResult .schedule').each(function (index, item) {
				     var categoryId = $(item).attr("data-id");
				     var categoryCnt = $(".pin-area.pinSelect .pin.cursor."+categoryId).length;
				     if(categoryCnt <= 0){
				    	 categoryCnt = 0;
				     }
				     $(item).attr("style","cursor:pointer;filter: initial;");
				     $(item).find("dt span").text(categoryCnt);
				});
				pinLoading = true;
		    }
		})
	}
}


function fn_weekLabel(date){
    var week = new Array('일', '월', '화', '수', '목', '금', '토');
    var today = new Date(date).getDay();
    var todayLabel = week[today];
    return todayLabel;
}

function fn_scroll(){
	$('html, body').animate({
        scrollTop: $('#map-select').offset().top - 40
	}, 500, function() {

 	});
}

function getDatesStartToLast(startDate, lastDate) {
	var regex = RegExp(/^\d{4}-(0[1-9]|1[012])-(0[1-9]|[12][0-9]|3[01])$/);
	if(!(regex.test(startDate) && regex.test(lastDate))) return "Not Date Format";
	var result = [];
	var curDate = new Date(startDate);
	while(curDate < new Date(lastDate)) {
		result.push(curDate.toISOString().split("T")[0]);
		curDate.setDate(curDate.getDate() + 1);
	}
	return result;
}



/* 상품 선택 */
var pinFlag = true;
var pinUseFlag = true;
var colorNumber = "";
function fn_select_pin(id){
		console.log("선택한 아이템 item_id = ", id);
	if($("#selectEndDate").val() == ""){
		alert("퇴실일을 선택해주세요");
		return;
	}

	$("body").addClass("paying");
	console.log("@function fn_select_pin() id " + id);
	console.log("pinFlag :: " + pinFlag);
	console.log("pinUseFlag :: " + pinUseFlag);
	console.log("submitBtnFlag :: " + submitBtnFlag);

	if($(".pin."+id).hasClass("active")){
		return;
	}

	if($(".selectPinList").length >= 100){
		alert('더이상선택할 수 없습니다')
		return;
	}
	if(!submitBtnFlag){
		return;
	}
	submitBtnFlag = false; /* 아이템 선택하면 추가되기전에 결제버튼 막기 */
	selectDateFlag = false; /* 아이템 선택하면 날짜변경 막기 */

	if($(".pin."+id).hasClass("disabled")){
		selectDateFlag = true;
		submitBtnFlag = true;
		return
	}
	if(!$(".pin-area").hasClass("pinSelect")){
		alert("날짜를 선택해주세요");
		selectDateFlag = true;
		submitBtnFlag = true;
		return
	}

	if(pinFlag){
		pinFlag = false;

		if($(".select-pin."+id).length > 0){
			pinFlag = true;
			selectDateFlag = true;
			submitBtnFlag = true;
			return;
		}

		if($(".calendar .table").hasClass("period") && $("#selectEndDate").val() == ""){
			alert("퇴실일을 선택해주세요");
			pinFlag = true;
			selectDateFlag = true;
			submitBtnFlag = true;
			return;
		}

		/* 상품선택 (selectReservationCheck) */
		$("#check").remove();
		$("#selectItemId").val(id);
		console.log("#selectItemId = ", $("#selectItemId").val());
		$("#checkType").val("selectPin");
		$.post("/camping/selectReservationCheck.do", $("#searchForm").serialize(), function(data) {
			$("body").append(data);
			selectDateFlag = true;
		})
	}
}

var selectItemPetYn = "N";
var selectItemDeckYn = "N";
function fn_next(flag){
	if(flag){
		var id = $("#selectItemId").val();
        console.log("id = ", id);
		var category = $(".pin."+id).data("category");
		console.log("category = ", category);
		var item = $(".pin."+id).data("name");
        console.log("item nm = ", item);
		if(!$(".pin."+id).hasClass('active')){
			$("#selectItemId").val(id);

			$.post("/camping/selectTicketInfo.do", $("#searchForm").serialize(), function(data) {
				$("#selectTicketInfo").html(data);
			}).done(function() {
				if(pinUseFlag){
					var selectStartDate = $("#selectStartDate").val();
					var selectEndDate = $("#selectEndDate").val();
					var formattedStartDate = selectStartDate.substring(0, 7);
					var formattedEndDate = selectEndDate.substring(0, 7);
					console.log("selectItemPetYn="+selectItemPetYn);

                    var confirmMsg = "";
                    for (var i = 0; i < eventNotices.length; i++) {
                        var n = eventNotices[i];
                        var bgColor = n.notice_bg_color || '#fff3cd';
                        var titleColor = n.notice_title_color || '#ff0000';
                        var titleText = (n.schedule_nm || '').replace(/\n/g, '<br>');
                        var contentText = (n.notice_content || '').replace(/\n/g, '<br>');
                        confirmMsg +=
                            "<div style='background:" + bgColor + ";border:2px solid #ff6600;border-radius:8px;padding:12px 15px;margin-bottom:12px;text-align:center;'>" +
                            "<span style='font-size:18px;font-weight:bold;color:#d63384;'>&#128197; " + n.event_nm + "</span><br>" +
                            "<span style='font-size:20px;font-weight:bold;color:" + titleColor + ";'>" + titleText + "</span><br>" +
                            "<span style='font-size:14px;font-weight:bold;color:#333;'>" + contentText + "</span>" +
                            "</div>";
                    }
                    confirmMsg +=
                        "[" + category + " - " + item + "]을 선택하였습니다<br>" +
                        "선택된 자리는 <strong>20분 이내</strong>에 예약이 완료되지 않으면 다른 고객이 예약하실 수 있습니다.";
                    if (selectItemPetYn === 'Y') {
                        confirmMsg +=
                            "<br><br><strong>[반려견 사이트 이용 안내]</strong><br>" +
                            "선택하신 곳은 반려견 울타리가 설치된 사이트입니다.<br>" +
                            "애견 동반 시 예약을 권장드립니다.";
                    }
                    if (selectItemDeckYn === 'Y') {
                        confirmMsg +=
                            "<br><br><strong>[데크 사이트 이용 안내]</strong><br>" +
                            "본 사이트는 데크가 설치된 캠핑사이트입니다.<br>" +
                            "데크 위 텐트 설치 시에는 데크 전용 팩(나사형 팩 등)을 사용해 주시기 바라며, " +
                            "데크 상단에서는 화로대 사용 및 불 사용을 금지합니다.<br>" +
                            "<strong style='color:#d6336c;'>이용 중 개인 부주의로 인한 데크 파손 발생 시, 복구 비용이 청구될 수 있음을 안내드립니다.</strong>";
                    }
                    //다시복구
                    selectItemPetYn = 'N'
                    selectItemDeckYn = 'N'
                    customConfirm(confirmMsg, function (ok) {
                        if (ok) {
                            $("#selectTicketInfo .empty").hide();
                            $(".pin." + id).addClass('active');
                            submitBtnFlag = true;
                        } else {
                            fn_cancel_select(id);
                        }
                    });

                }else{
					submitBtnFlag = true;
				}
				pinUseFlag = true;
				pinFlag = true;
			})
		}else{
			fn_cancel_select(id);
			pinFlag = true;
			submitBtnFlag = true;
		}
	}else{
		pinFlag = true;
		submitBtnFlag = true;
	}
}
/* 상품 선택 END */

function customConfirm(htmlMsg, callback) {
    $("#customConfirmMessage").html(htmlMsg);
    $("#customConfirmLayer").show();
    $("body").css("overflow", "hidden");

    $("#customConfirmOk").off("click").on("click", function () {
        closeConfirm();
        callback(true);
    });

    $("#customConfirmCancel").off("click").on("click", function () {
        closeConfirm();
        callback(false);
    });
}

function closeConfirm() {
    $("#customConfirmLayer").hide();
    $("body").css("overflow", "");
}
/* 달력선택 */
var mflag = true;
function fn_select_month(date){
	console.log("@function fn_select_month START !! @param:: " + date);
	console.log("@mflage :: " + mflag);

	// 긴급예약제한 체크
	var pageId = $("#pageId").val();
	var groupCode = $("#groupCode").val();
	$.ajax({
		url: emergencyCheckUrl,
		type: "POST",
		data: { pageId: pageId, groupCode: groupCode },
		dataType: "json",
		success: function(res){
			if(res.blocked){
				$("#emergencyBlockModal").remove();
				$.post(emergencyPopupUrl, { pageId: pageId, groupCode: groupCode }, function(popupHtml) {
					$("body").append(popupHtml);
				});
				return;
			}
			fn_select_month_exec(date);
		},
		error: function(){
			fn_select_month_exec(date);
		}
	});
}

function fn_select_month_exec(date){

	$("#reloadFlag").val("0");
	$("#loading").show();

	if(mflag){
		mflag = false;
		$("#selectMonth").val(date);
		$.post("/camping/calendar.do", $("#searchForm").serialize(), function(data) {
			$(".calendar").empty();
			$(".calendar").append(data);

			$("#reloadFlag").val("1");
			$("#loading").hide();
			fn_alert_layer_close();

			var startDate = $("#selectStartDate").val();
			if($("#"+startDate).length > 0){
				$("#"+startDate).addClass("active");
				$("#"+startDate).addClass("pignose-calendar-unit-first-active");
				$("#"+startDate).addClass("pignose-calendar-unit-active");
			}
		}).done(function() {
			console.log("@function fn_select_month END !!");
			mflag = true;
		}).fail(function(data, textStatus, errorThrown){
			console.log("@function fn_select_month FAIL !!!!!");
			fn_select_month_exec(date);
	    });
	}else{
		fn_alert_layer_open("잠시만 기다려주세요");
	}
}
/* 달력  END */

function fn_alert_layer_open(text){
	$("#loadingAlertText").text(text);
	$("#loadingAlert").css("display","flex");
	setTimeout(function() {
		fn_alert_layer_close();
	}, 3000);
}

function fn_alert_layer_close(){
	$("#loadingAlert").hide();
	$("#loadingAlertText").text("");
}

function fn_pay(){

	if(!$("#agreePolicy").is(":checked")){
		alert("이용자 준수사항을 확인하셨습니까? 이용자 준수사항을 확인후 체크박스를 체크해주세요");
		return;
	}

	if(confirm("결제하시겠습니까?")){
		document.searchForm.action = "/camping/paymentForm.do";
		document.searchForm.submit();
	}
}

function fn_notSelect(){
	alert('예약하실 날짜와 자리를 선택해주세요.')
}
// 상품 개수 변경
function fn_cnt_change(itemId, ticketId){
	var cnt = $("select[name="+itemId+"_"+ticketId+"] option:selected").val();
	$("#cnt").val(cnt);
	if(cnt > 0){
		$("select[name="+itemId+"_"+ticketId+"]").removeClass("red");
	}
	$("#selectItemId").val(itemId);
	$("#selectTicketId").val(ticketId);
	$.ajax({
	    url: "/camping/updateSelctItemticketCntChange.do",
	    cache: false,
	    async: false,
	    type: "post",
	    data: $('form[name=searchForm]').serialize(),
	    dataType:'json',
	    success: function(data){
	    	$.post("/camping/selectItemList.do", $("#searchForm").serialize(), function(data) {
				$("#selectTicketInfo").html(data);
			})
	    }
	}).always(function(){
	})
}

 function priceUpdate(){
	$.ajax({
	    url: "/camping/deSelectTicket.do",
	    cache: false,
	    async: false,
	    type: "post",
	    data: $('form[name=searchForm]').serialize(),
	    dataType:'json',
	    success: function(data){
			console.log("data: "+data)
	    	console.log(data.resultFlag);
	    	$(".pin."+id).removeClass('active');
	    	if(data.resultFlag){
		    	$.post("/camping/selectItemList.do", $("#searchForm").serialize(), function(data) {
					$("#selectTicketInfo").html(data);
				})
	    	}else{
	    		alert(data.message);
	    		location.reload(true);
	    	}
	    },
	    complete : function () {
	    	cancelFlag = true;
	    	submitBtnFlag = true;
	    }
	}).always(function(){
		cancelFlag = true;
		submitBtnFlag = true;
	})

 }

 $(document).ready(function(){
 	var popupTime = new Date();
	var y = new Date().getFullYear();
	var m = new Date().getMonth() + 1;
	var d = new Date().getDate();
	var popupTime = y + ""+ (m<10?'0'+m:m) +""+ (d<10?'0'+d:d);
	console.log(popupTime);

	for(i=1; i<3; i++){
		var cookieName = "popup" + i + "_notToday";
		if(getCookie(cookieName)){
			$("#popup"+i).css('display', 'none');
		} else{
			$("#popup"+i).css('display', 'block');
		}
	}
 });

 function close_popup(id) {
	var targetNotTodayBox = id + "_notToday";
	console.log(targetNotTodayBox);
	if ($("#" + targetNotTodayBox).prop("checked")) {
		setCookie(targetNotTodayBox, 'Y', 1);
		console.log("setted cookie");
	}
	$("#" + id).fadeOut();
}


//쿠키 세팅
function setCookie(xname, xvalue, expiredays) {
	var todayDate = new Date();
	todayDate.setDate(todayDate.getDate() + expiredays);
	document.cookie = xname + "=" + escape(xvalue) + "; path=/; expires=" + todayDate.toGMTString() + ";";
	console.log(document.cookie);
}

//쿠키 존재 여부 확인
function getCookie(cookieName) {
   var nameOfCookie = cookieName + "=";
   var x = 0;
   while (x <= document.cookie.length ) {
       var y = (x+nameOfCookie.length);
       if(document.cookie.substring(x, y) == nameOfCookie) {
           if((endOfCookie = document.cookie.indexOf( ";", y )) == -1)
               endOfCookie = document.cookie.length;
           return unescape(document.cookie.substring(y, endOfCookie));
       }
       x = document.cookie.indexOf( " ", x ) + 1;
       if (x == 0)  break;
   }
   return "";
}

/* 인증팝업 */
var pflag = true;
function fn_cert_popup(){
	if(pflag){
		$("#certPopup").remove();
		pflag = false;
		$.post("/cert/" + groupCode + "/approvalCheckPopoup.do", $("#searchForm").serialize(), function(data) {
			$("body").prepend(data);
			$("body").addClass("modal-on");
		}).done(function() {
		})
	}
}

function fn_cert_popup_close(){
	$("body").removeClass("modal-on");
	$(".modal.certification").remove();
	pflag = true;
}
/* 인증팝업  END */


/* === Swiper 초기화 (DOM 로드 후) === */
$(function() {
    // slider random init
    function return_index(div_elmt) {
      var r_index = Math.floor(Math.random() * $('li.' + div_elmt + ' .swiper-slide:not(.swiper-slide-duplicate)').length);
      return parseInt(r_index);
    }

    var imagesSwiper = new Swiper('.images', {
      autoplay: {
        delay: 3500,
        disableOnInteraction: false,
        paginationClickable: true,
        loop: true,
        initialSlide: return_index('images'),
      },
      pagination: {
        el: '.swiper-pagination',
        type: 'progressbar',
      },
    });
    var inNotice = new Swiper('.notice-area', {
      autoHeight: true,
      autoplay: {
        delay: 4500,
        disableOnInteraction: true,
        loop: true,
      },
      navigation: {
        nextEl: '.swiper-next',
        prevEl: '.swiper-prev',
      },
      pagination: {
        el: '.swiper-pagination',
        type: 'fraction',
      },
    });
    $('.swiper-container').hover(
      function () {
        this.swiper.autoplay.stop();
      },
      function () {
        this.swiper.autoplay.start();
      }
    );
    // 시설 슬라이더
    var thumbSwiper = new Swiper('.thumb-swiper', {
      autoHeight: true,
      responsive: true,
      autoplay: {
        delay: 4000,
        disableOnInteraction: true,
        loop: true,
      },
      pagination: {
        el: '.swiper-pagination',
        type: 'progressbar',
      },
      observer: true,
      observeParents: true,
      navigation: {
        nextEl: '.swiper-button-next',
        prevEl: '.swiper-button-prev',
      },
      autoHeight: true,
    });
    $('.thumb-swiper .swiper-slide').click(function (e) {
      e.preventDefault();
      var $swiper = $(this).parent().parent().parent();
      // zoom 시 원본 이미지로 교체
      $swiper.find('.swiper-slide').each(function () {
        var originalUrl = $(this).data('original');
        if (originalUrl) {
          $(this).find('.img').css('background-image', 'url(' + originalUrl + ')');
        }
      });
      $('body').addClass('dimed');
      $('body').addClass('zoomed');
      $swiper.addClass('zoom');
    });
    $('.with-swiper .close').click(function (e) {
      var $swiper = $(this).closest('.with-swiper');
      $('body').removeClass('dimed');
      $('body').removeClass('zoomed');
      $swiper.removeClass('zoom');
      // 닫을 때 다시 썸네일로 복원
      $swiper.find('.swiper-slide').each(function () {
        var originalUrl = $(this).data('original');
        if (originalUrl) {
          $(this).find('.img').css('background-image', 'url(' + originalUrl.replace('getImage.do', 'getThumbImage.do') + ')');
        }
      });
    });
});
