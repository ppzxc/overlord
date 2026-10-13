// 상품 금액 조회
function fn_sum(){
	$.ajax({
	    url: "/camping/camping/totalTicketPrice.do",
	    cache: false,
	    async: false,
	    type: "post",
	    data: $('form[name=searchForm]').serialize(),
	    dataType:'json',
	    success: function(data){
	    	$(".realPriceStr").text(data.realPriceStr);
	    	$("#totalPriceStr").text(data.totalPriceStr);
	    	$("#discountPriceStr").text(data.discountPriceStr);
	    	$("#realPrice").val(data.realPrice);
			
			if(data.realPrice < 1){
				$("#payMethodTr").hide()
			}
	    }
	});
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
	    url: "/camping/camping/ticketCntChange.do",
	    cache: false,
	    async: false,
	    type: "post",
	    data: $('form[name=searchForm]').serialize(),
	    dataType:'json',
	    success: function(data){
	    	fn_discount_select();
	    }
	}).always(function(){ 
	})	
}

// 상품 선택 확인
function fn_item_ticket_check(){
	var itemCheck = 0;
	var ticketName = "";
	$(".select-pin").each(function(index, item) {
		var totalCnt = 0;
		var name = "";
		$(this).find(".ticket-info").each(function(index, item) {
			var cnt = $(this).find(".select select option:selected").val();
			if(cnt < 1){
				$(this).find(".select select").addClass("red");
				itemCheck ++;
			}
		});
	})
	if(itemCheck > 0){
		alert("상품 인원을 선택해주세요");
		return false;
	}else{
		return true;
	}
}


var cancelFlag = true;
function fn_cancel_select(id){
	console.log("cancelFlag : "+cancelFlag)
	if(cancelFlag){
		cancelFlag = false;
		$("#selectItemId").val(id);
		$.ajax({
		    url: "/camping/camping/deSelectTicket.do",
		    cache: false,
		    async: false,
		    type: "post",
		    data: $('form[name=searchForm]').serialize(),
		    dataType:'json',
		    success: function(data){
		    	console.log(data.resultFlag);
		    	if(data.resultFlag){
			    	$(".pin."+id).removeClass('active');
					$(".pin."+id).find("input[type=checkbox]").prop("checked", false);
					$("#selectTicketInfo").find("."+id).remove();
					var len = $("#selectTicketInfo").find(".select-pin").length;
					if(len < 1){
						$("#selectTicketInfo .empty").show();	
					}
			    	fn_discount_select();
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
}

