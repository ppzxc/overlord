/**
 * 폼 전송을 Ajax를 통해서 처리
 * @param {Object} f
 * @param {function} callbackFunction
 */
function submitByAjax(f, callbackFunction) {
    var formTarget = f.target;
    var uri = f.action;

    $.ajax({
        url: uri,
        type: f.method,
        dataType: "json",
        data: $(f).serialize(),
        cache: false,
        async: false,
        beforeSend: function (xhr) {
			//console.log($(f));
            xhr.setRequestHeader("Accept", "application/json");
        },
        success: function (result) {
        	console.log(result);
            postAjaxAction(result, formTarget, callbackFunction);
        },
        error: function (request, status, error) {
        	console.log(request);
            alert("서버와의 통신 중 장애가 발생하였습니다.\n" + request.responseText);
        },
        complete: function(){}
    });
}

/**
 * Ajax 통신 이후 처리
 * @param {json} result
 * @param {string} target
 * @param {string} title
 * @param {string} classes
 * @param {function} callbackFunction
 */
function postAjaxAction(result, target, callbackFunction) {
    if (result.code === "failure") {
        //alert(result.msg);
        var msg = result.msg;
        if(msg == "noIngData"){
        	msg = "예약정보입력 대기 시간이 초과되었습니다. 처음부터 다시 진행하시기 바랍니다.";
        }else if(msg == "dupRev"){
        	msg = "예약일 기준, 중복 예약은 금지됩니다. 자세한 내용은 공지사항을 참조하세요.";
        }else if(msg == "unknownTargetId"){
        	msg = "예약대상이 유효하지 않습니다.";
		}else if(msg == "unknownTargetId2"){
        	msg = "예약대상이 유효하지 않습니다. 처음부터 다시 진행하시기 바랍니다.";
		}else if(msg == "dupRev2"){
        	msg = "예약일 기준, 중복 예약은 금지됩니다. 자세한 내용은 공지사항을 참조하세요.2";
		}else if(msg == "notExclusive"){
        	msg = "선택할 수 없는 사이트 정보입니다. 처음부터 다시 진행하시기 바랍니다.";
		}else if(msg == "dupRevToday"){ // 20220628 추가 - 당일 중복
        	msg = "예약일 기준, 중복 예약은 금지됩니다. 자세한 내용은 공지사항을 참조하세요.";
		}else if(msg == "dupRevDraw"){ // 20220628 추가 - 월 추첨 2회 신청 초과
        	msg = "예약일 기준, 중복 예약은 금지됩니다. 자세한 내용은 공지사항을 참조하세요.";
		}else if(msg == "dupRevMonth"){ // 20220628 추가 - 월 4회 신청 초과
        	msg = "월별 신청 가능 횟수를 모두 신청하였습니다.";
        }
        
        alert(msg);
        
        if (result.callJs == undefined) {        	
        }else{
        	eval(result.callJs);
        }
    } else if (result.code === "success") {
        if (target) {
            target = target.replace("#", "");
            insertContent($("#" + target), result.resultMap.content);
        }
        if (typeof callbackFunction === "function") {
            callbackFunction(result);
        }
    }
}

/**
 * 내용을 요소 안에 삽입
 * @param {Object} obj
 * @param {string} content
 */
function insertContent(obj, content) {
	obj.html(content);
}

