if (!window.console)
	console = {
		log : function() {
		}
	};

function ShopModel() {
	var self = this;

	self.tempForm = null;
	self.companyCode = getCompanyCode();
	self.shopEncode = getShopEncode();
	self.seShopEncode = getSeShopEncode();
	self.shopInfo = ko.observable({});
	self.memberId = ko.observable(getMemberId());
	self.savedLoginId = ko.observable($.cookie(self.companyCode + '_saveId'));
	self.isSavedLoginId = ko.observable(self.savedLoginId() && self.savedLoginId().length > 0);

	self.idCheckNo = ko.observable('');
	self.idCheckType = ko.observable('');
	self.idCheckName = ko.observable('');
	self.idCheckGender = ko.observable('');
	self.idCheckBirthday = ko.observable('');
	self.idCheckCode = ko.observable('');
	self.idCheckMessage = ko.observable('');
	
	self.blacklistYn = ko.observable('0');
	self.blacklistStartDate = ko.observable('');
	self.blacklistEndDate = ko.observable('');
		
	self.loadShopInfo = function() {
		$.post('/Web/Book/GetShopInformation.json', {
			shop_encode : self.shopEncode
		}, self.loadedShopInfo);
	};

	self.loadedShopInfo = function(result) {
		if (result.error) {
			alert(result.error.message);
			if(result.error.code == '0009') {
				location.href = "/web/main?shopEncode=" + self.seShopEncode;
			}
			return;
		}
		//console.log(result);
		
		if(result.data.member_identification_kind.indexOf("MOBILE") > -1){
			result.data.member_identification_mobile = 1;
		}else{
			result.data.member_identification_mobile = 0;
		}
		if(result.data.member_identification_kind.indexOf("IPIN") > -1){
			result.data.member_identification_ipin = 1;
		}else{
			result.data.member_identification_ipin = 0;
		}
		if(result.data.member_identification_kind.indexOf("EMAIL") > -1){
			result.data.member_identification_email = 1;
		}else{
			result.data.member_identification_email = 0;
		}
		if(result.data.member_identification_kind.indexOf("EASY") > -1){
			result.data.member_identification_easy = 1;
		}else{
			result.data.member_identification_easy = 0;
		}
		
		self.shopInfo(result.data);
		
		//init ajax
		$.ajaxPrefilter(function( options, originalOptions, jqXHR ) {
			if(originalOptions.data!=undefined && typeof(originalOptions.data) === 'string'){
                options.data = originalOptions.data + '&shopCode=' + self.shopInfo().shop_code
	        }else{
	                options.data = $.param($.extend({}, originalOptions.data, { shopCode: self.shopInfo().shop_code }));
	        }
		});

		$(document).ajaxError(function( event, jqxhr, settings, thrownError ) {
			if(jqxhr.status == 999){
				location.reload();
			}
		});
	};

	self.isLogined = ko.computed(function() {
		return self.memberId().length > 0;
	}, this);

	self.login = function() {
		var loginId = $.trim( $('#login_id').val() );
		var passwd = $.trim( $('#login_passwd').val() );

		if (loginId.length == 0) {
			return alert(languageModel.getMsg('000001'));
		}
		if (passwd.length == 0) {
			return alert(languageModel.getMsg('000002'));
		}

		$.post('/Web/Member/MemberLogin.json', {
			member_id : loginId,
			member_password : passwd
		}, self.resultLogin);
	};

	self.resultLogin = function(result) {
		$('#login_passwd').val('');
		
		if (result.error) {
			alert(result.error.message);
			
			if(result.redirect) {
				location.href = result.returnUrl + self.shopEncode;
			}
			return;
		}

		if (result.data.success) {
			if (self.isSavedLoginId()) {
				self.savedLoginId(result.data.member_id);
				$.cookie(self.companyCode + '_saveId', self.savedLoginId(), {
					expires : 365
				});

				//console.log('cookie:' + $.cookie(self.companyCode + '_saveId'));
			} else {
				self.savedLoginId(null);
				self.isSavedLoginId(false);
				$.cookie(self.companyCode + '_saveId', '', {
					expires : 365
				});
			}
			
			self.memberId(result.data.member_id);
			self.blacklistYn(result.data.blacklist_yn);
			self.blacklistStartDate(result.data.blacklist_start_date);
			self.blacklistEndDate(result.data.blacklist_end_date);
			
			if(result.data.password_change_yn == '1') {
				//모바일이면 
				if(typeof webType!='undefined' && webType!=null && webType == 'mobile'){
					changeMemberPassword();
				//pc 웹이면
				}else{
					showChangePasswordLayer();
				}
			}
			
			if(result.data.blacklist_yn == '1') {
				alert(languageModel.getMsg('000038') + result.data.blacklist_start_date + ' ~ ' + result.data.blacklist_end_date + languageModel.getMsg('000039'));
			}

		} else {
			//console.log(result);
			
			alert(languageModel.getMsg('000022'));
			$('#login_passwd').val('');
		}
		
		//mobile add by woo
		if(typeof webType!='undefined' && webType!=null && webType == 'mobile'){
			hideIdLayer('wrapLoginLayer');
		}
		
		//지역코드가 없으면...
		if(result.data.region_code == '') {
			//모바일이면 
			if(typeof webType!='undefined' && webType!=null && webType == 'mobile'){
				alert('주소정보를 업데이트 해야 합니다. 지금 주소정보 업데이트하지 않으면 예약신청이 접수되지 않습니다.');
				modifyMemberFn();
			//pc 웹이면
			}else{
				alert('주소정보를 업데이트 해야 합니다. 지금 주소정보 업데이트하지 않으면 예약신청이 접수되지 않습니다.');
				location.href = "/web/profile?shopEncode=" + self.shopEncode;
			}
		}
	};

	self.logout = function() {
		/*
		self.savedLoginId(null);
		$.cookie(self.companyCode + '_saveId', '', {
			expires : 365
		});
		*/
		$.post('/Web/Member/MemberLogout.json', self.resultLogout);
	};

	self.resultLogout = function() {
		self.memberId("");
		location.href = "/web/main?shopEncode=" + self.shopEncode;
		//location.reload();
	};
	
	self.main = function(shopEncode) {
		location.href = "/web/main?shopEncode=" + shopEncode;
	}
	
	self.findId = function(shopEncode) {
		location.href = "/web/findId?shopEncode=" + shopEncode;
	}
	
	self.join = function(shopEncode) {
		location.href = "/web/join?shopEncode=" + shopEncode;
	}
}

function getCompanyCode() {
	return companyCode;
}

function getShopEncode() {
	return shopEncode;
}

function getMemberId() {
	return memberId;
}

function getSeShopEncode() {
	return seShopEncode;
}

function stck(str, limit) {
    var o, d, p, n = 0, l = limit == null ? 4 : limit;
    for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (i > 0 && (p = o - c) > -2 && p < 2 && (n = p == d ? n + 1 : 0) > l - 3) return false;
        d = p, o = c;
    }
    return true;
}


function wrapWindowByMask() {
	//화면의 높이와 너비를 구한다.
    var maskHeight = $(document).height();  
//  var maskWidth = $(document).width();
    var maskWidth = window.document.body.clientWidth;
         
    var mask = "<div id='mask' style='position:absolute; z-index:9000; background-color:#000000; display:none; left:0; top:0;'></div>";
    var loadingImg = '';
         
    loadingImg += "<div id='loadingImg' style='position:absolute; left:50%; top:40%; display:none; z-index:10000;'>";
    loadingImg += " <img src='/resources/images//viewLoading.gif'/>"; 
    loadingImg += "</div>";   
     
    //화면에 레이어 추가 
    $('body')
    	.append(mask)
        .append(loadingImg)
           
    //마스크의 높이와 너비를 화면 것으로 만들어 전체 화면을 채운다.
    $('#mask').css({
    	'width' : maskWidth
        , 'height': maskHeight
        , 'opacity' : '0.3'
    });  
     
    //마스크 표시
    $('#mask').show();    
     
    //로딩중 이미지 표시
    $('#loadingImg').show();
}

function closeWindowByMask() {
    $('#mask, #loadingImg').hide();
    $('#mask, #loadingImg').remove();  
}

$(function() {
	ko.applyBindings(model);
	if(model.loadShopInfo!=undefined){
		model.loadShopInfo();
	}
});

var popWin = null;

function showIPinPopup(remark) {
	model.isMember2(false);
	popWin = window.open('/web/ipinRequest?shopEncode=' + model.shopEncode + '&remark=' + remark, 'popupIPIN2', 'width=450, height=550, top=100, left=100, fullscreen=no, menubar=no, status=no, toolbar=no, titlebar=yes, location=no, scrollbar=no');
}

function showCIPopup(remark) {
	model.isMember2(false);
	popWin = window.open('/web/ciRequest?shopEncode=' + model.shopEncode + '&remark=' + remark, 'popupCI', 'width=500, height=550, top=100, left=100, fullscreen=no, menubar=no, status=no, toolbar=no, titlebar=yes, location=no, scrollbar=no');
}

function sendIPinData(type, no, name, gender, birthday, code, message) {	
	model.idCheckNo(no);
	model.idCheckType('IPIN');
	model.idCheckName(name);
	model.idCheckGender(gender);
	model.idCheckBirthday(birthday);
	model.idCheckMessage(message);
	model.idCheckCode(code);
	
	model.resultIndentity();
}

function sendCiData(type, no, name, gender, birthday, code, message) {
	
	model.idCheckNo(no);
	model.idCheckType('CI');
	model.idCheckName(name);
	model.idCheckGender(gender);
	model.idCheckBirthday(birthday);
	model.idCheckMessage(message);
	model.idCheckCode(code);
	
	model.resultIndentity();
}

function closePopup() {
	
	setTimeout(function() {
		if (popWin != null)
			popWin.close();
	}, 100);
}

function getPaymethodString(method){
	if(method == "CARD"){
		return languageModel.getMsg('100023');
	}else if(method == "BANK"){
		return languageModel.getMsg('100024');
	}else if(method == "CELLPHONE"){
		return languageModel.getMsg('100025');
	}else if(method == "VBANK"){
		return languageModel.getMsg('100026');
	}else{
		return "";
	}
}

function chkPassword(str){
	//1. 영문, 숫자 혼합하여 6~20자리 이내
 	var reg_pwd = /^.*(?=.{10,20})(?=.*[0-9])(?=.*[a-zA-Z]).*$/;

 	if(!reg_pwd.test(str)){
  		return false;
 	}
	return true;
}

$(function() {
	console.log('ready data-src');
	$('[data-src]').each(function() {
		  //$(this).load( '/Web/asset?path='+ encodeURIComponent($(this).attr('data-src')));
		  $(this).load( $(this).attr('data-src') );
	});
});

//javascript map
Map = function(){
 this.map = new Object();
};   
Map.prototype = {   
    put : function(key, value){   
        this.map[key] = value;
    },   
    get : function(key){   
        return this.map[key];
    },
    containsKey : function(key){    
     return key in this.map;
    },
    containsValue : function(value){    
     for(var prop in this.map){
      if(this.map[prop] == value) return true;
     }
     return false;
    },
    isEmpty : function(key){    
     return (this.size() == 0);
    },
    clear : function(){   
     for(var prop in this.map){
      delete this.map[prop];
     }
    },
    remove : function(key){    
     delete this.map[key];
    },
    keys : function(){   
        var keys = new Array();   
        for(var prop in this.map){   
            keys.push(prop);
        }   
        return keys;
    },
    values : function(){   
     var values = new Array();   
        for(var prop in this.map){   
         values.push(this.map[prop]);
        }   
        return values;
    },
    size : function(){
      var count = 0;
      for (var prop in this.map) {
        count++;
      }
      return count;
    }
};

String.prototype.format = function() {
    var formatted = this;
    for( var arg in arguments ) {
        formatted = formatted.replace("{" + arg + "}", arguments[arg]);
    }
    return formatted;
};

function inputLengthCheck(eventInput){
	var inputText = $(eventInput).val();
	var inputMaxLength = $(eventInput).prop("maxlength");
	var j = 0;
	var count = 0;
	
	for(var i = 0;i < inputText.length;i++) { 
		val = escape(inputText.charAt(i)).length; 
		if(val == 6){
			j++;
		}

		j++;
		if(j <= inputMaxLength){
			count++;
		}
	}
	
	if(j > inputMaxLength){
		$(eventInput).val(inputText.substr(0, count));
	}
};

function droneUrl() {
	window.open(model.shopInfo().drone_url);
}

function checkSystemTime() {
	const now = new Date();

	if( now.getHours() == 5 && (now.getMinutes() >= 0 && now.getMinutes() <= 10)) {
		return true;
	}else{
		return false;
	}
	
} 

function isValidCarNumber(carNo) {
    if (!carNo) return false;

    // 공백 제거
    carNo = carNo.replace(/\s/g, '');

    // 일반 차량
    // 예: 123가4567, 12가3456
    const normalRegex =
        /^(?:[가-힣]{2})?\d{2,3}[가-힣]\d{4}$/;

    // 구형 번호판
    // 예: 12가345
    const oldRegex =
        /^(?:[가-힣]{2})?\d{2}[가-힣]\d{4}$/;

    // 외교 번호판
    // 예: 외교123-456
    const diplomaticRegex =
        /^외교\d{3}-\d{3}$/;

    // 군용 번호판
    // 예: 육-123456, 해-123456, 공-123456
    const militaryRegex =
        /^(육|해|공|국)\-\d{4,6}$/;

    return (
        normalRegex.test(carNo) ||
        oldRegex.test(carNo) ||
        diplomaticRegex.test(carNo) ||
        militaryRegex.test(carNo)
    );
}

