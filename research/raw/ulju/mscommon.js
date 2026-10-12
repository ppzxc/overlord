var _main;
var _c_main;
var item_list;
var _senddata;
var _getdata;
var _pop_callback;
var _debug=false;
var _Calendar_shape;
	$(function() {
		
		_c_main = window;
		_main = window.parent;
		_senddata = new Object;
		_getdata = new Object;
		_popup = _main.$('#myModal');	
	});	
	function init_sms() {
		_c_main = window;
		_main = window.parent;
		_senddata = new Object;
		_getdata = new Object;
		_popup = _main.$('#myModal');	
	}
	function getContextPath(){
	    var ctxPath=$("#web_contextPath").val();
	    return ctxPath;
	}

	//쿠키
	/* Cookie */
	var Cookie = {
		getCookie : function(cookie_key){
			var i, x, y, z, cookies = document.cookie.split(';');
			for(i=0; i<cookies.length; i++){
				z = cookies[i].indexOf('=');
				x = cookies[i].substr(0, z);
				y = cookies[i].substr(z+1);
				x = x.replace(/^\s+|\s+$/g,'');
				if(x === cookie_key){
					return unescape(y);
				}
			}
		},
		setCookie : function(cookie_key, value, exdays){
			var exdate = new Date();
			exdate.setDate(exdate.getDate() + exdays);
			var c_value = escape(value) + ((exdays == null)? "" : "; expires="+exdate.toUTCString());
			document.cookie = cookie_key + "=" + c_value;
		}
	};
	

	/*
	 * 자바스크립트에서 ContextPath 구하기 javascript
Information Technology 2011.08.26 16:16
function getContextPath(){
    var offset=location.href.indexOf(location.host)+location.host.length;
    var ctxPath=location.href.substring(offset,location.href.indexOf('/',offset+1));
    return ctxPath;
}

사용 예)

function home() {

   location.href = getContextPath()+'/index.do';

}
    */
	function show_popup(in_data,in_data_id)
	{
		var load_url=frameSrcteam+"?find="+in_data;
		g_callback_id=null;
		g_callback_id=in_data_id;
		$('iframe').attr("src",load_url);
		$('#myModal').modal({show:true});
	}
	function _callBackPopup(rData){
   		if(rData != null && rData != "" && rData !="undefined"){
   	        //console.log(rData);
   	        if(!ISNULL(g_callback_id))
   	        {
   	        	eval(g_callback_id+"(rData)");
   	        }
   		}
   		$('iframe').attr("src","");
   		$('#myModal').modal('toggle');
   	}
	/*로드*/
	function get(name) {
	    if (typeof (Storage) !== "undefined") {
	      return localStorage.getItem(name);
	    } else {
	      window.alert('최신 브라우저를 사용하세요!');
	    }
	  }
	/*저장*/
	function store(name, val) {
	    if (typeof (Storage) !== "undefined") {
	      localStorage.setItem(name, val);
	    } else {
	      window.alert('최신 브라우저를 사용하세요.!');
	    }
		  }
	function sms_replaceAll(str, searchStr, replaceStr) 
	{
		return str.split(searchStr).join(replaceStr);
	}	
	function showmessage(in_title,in_str,delay,type)
	{	
		showmsg(in_title,in_str,delay,type);
	}	
	function showmsg(in_title,in_str,_delay,_type)
	{
		if(ISNULL(_delay))
		{
			_delay=5000;
		}
		new PNotify({
	    	title: in_title,
	    	text: in_str,
	    	delay: _delay,
	    	type: _type,
	    	addclass: "stack-topleft",
	    	animate: {
		        animate: true,
		        in_class: 'bounceInRight',
		        out_class: 'bounceOutLeft'
		    }
		});
	}
	function pop_showmessage(in_title,in_str,delay,type)
	{
		new PNotify({
		    title: in_title,
		    text: in_str,
		    delay: _delay,
		    type: 'error',
		    addclass: "stack-topleft",
		    desktop: {
		        desktop: true
		    },	    
		    animate: {
		        animate: true,
		        in_class: 'bounceInRight',
		        out_class: 'bounceOutLeft'
		    }
		});
	}
	//오브젝트.. 검사.
	function ISNULL(obj){
		if(obj == undefined  || obj == null || obj == ""){
			return true;
		}else{
			return false;
		}
	}
	//배열복사..
	function copyArray(targetA,_originA)
	{	
		var originA=[];
		if(ISNULL(_originA))
		{
			/*
			$.each(_originA, function(index, item) {
				originA[index]=item[index];
			});
			*/
			return;
		}
		else
		{
			originA=_originA;
		}
		var indexa = targetA.length;
		if(ISNULL(indexa))
		{
			indexa = 0;
		}
		var targetSize = originA.length,
		sumSize = indexa + targetSize;
		var index =0;
		var t_index=indexa+index;
		for(index=0; index < targetSize ; index++) {
			t_index=indexa+index;
			targetA[t_index] = originA[index];
	    }
	}
	function numberTOpointTransform(in_obj,numPoint)
	{	
			in_obj.on('change',function(){
				var val = in_obj.val();		
			
			});   			
			in_obj.change(function(){
				
				in_obj.number( true, numPoint );
			});
			in_obj.number( true, numPoint );
	}
	function numberTOpointTransform_blur(in_obj,numPoint)
	{	
			in_obj.on('change',function(){
				var val = in_obj.val();		
			});
			in_obj.keyup(function() {
				in_obj.blur();
			});
			in_obj.change(function(){
				
				in_obj.number( true, numPoint );
			});
			in_obj.number( true, numPoint );
	}
	var move_href=null;
	
	function getInputDayLabel(in_data) {
		
		var week = new Array('일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일');
		
		var today = new Date(in_data).getDay();
		var todayLabel = week[today];
		
		return todayLabel;
	}
	/*인풋 콤마 넣기*/
	function numberWithCommas(x) {
		return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	}
	/*외부 rest통신 ajax 통신 할때 */
	function getOutPostData(inurl,indata,myfunction,in_async)  		
	{
		var async_value=true;
		if(in_async==false)
		{
			async_value=false;
		}
		$.ajax({
			type : 'post',
			url : getContextPath()+inurl,
			headers : {
				"Content-Type" : "application/json",
				"X-HTTP-Method-Override" : "POST",
				'X-CSRF-TOKEN': $("#csrf_token").val()
			},
			dataType : 'text',
			data : indata,
			async: async_value,
			error:function(request,status,error)
			{
				ms_alert("알림",status+error);
			},				
			success : function(result) {									
				//console.log("result: " + result);
				var obj = jQuery.parseJSON( result );	
				if(myfunction!=null)
				{
					myfunction(obj);
				}
				
			}
		});
}
	function ms_alert(intitle,incontext)
	{
		alert(intitle+"\n"+incontext);
	}
		/*내부 ajax 통신 할때 */
		function getPostData(inurl,indata,myfunction,in_async)  		
		{
			var async_value=true;
			if(in_async==false)
			{
				async_value=false;
			}
			
		$.ajax({
			type : 'post',
			url : getContextPath()+inurl,
			headers : {
				"Content-Type" : "application/json",
				"X-HTTP-Method-Override" : "POST",
				'X-CSRF-TOKEN': $("#csrf_token").val()
			},
			dataType : 'text',
			data : indata,
			async: async_value,
			error:function(request,status,error)
			{
				ms_alert("알림",status+error);
			},				
			success : function(result) {									
				//console.log("result: " + result);
				var obj = jQuery.parseJSON( result );	
				if(myfunction!=null)
				{
					myfunction(obj);
				}
				
			}
		});
	}
		/*내부 ajax 파일 통신 할때 */
	function getPostFileData(inurl,indata,myfunction,in_async)  		
	{
			var async_value=true;
			if(in_async==false)
			{
				async_value=false;
			}
			
			$.ajax({
			type : 'post',
			url : getContextPath()+inurl,
			headers : {					
				'X-HTTP-Method-Override' : 'POST',
				'X-CSRF-TOKEN': $("#csrf_token").val()
			},
			dataType : 'text',
			enctype: 'multipart/form-data',
			data : indata,
            contentType: false,
            processData: false,				
			async: async_value,
			error:function(request,status,error)
			{
				ms_alert("알림",status+error);
			},				
			success : function(result) {									
				//console.log("result: " + result);
				var obj = jQuery.parseJSON( result );	
				if(myfunction!=null)
				{
					myfunction(obj);
				}
				
			}
		});
	}
		/*select 내부 데이타 ajax 통신 */
  		function getPostSelectdata(inurl,indata,myfunction,target,isALL,selectkey,select_title)
		{
			$.ajax({
				type : 'post',
				url : getContextPath()+inurl,
				headers : {
					"Content-Type" : "application/json",
					"X-HTTP-Method-Override" : "POST",
					'X-CSRF-TOKEN': $("#csrf_token").val()
				},
				dataType : 'text',
				data : indata,
				error:function(request,status,error)
				{
					ms_alert("알림",status+error);
				},				
				success : function(result) {									
					//console.log("result: " + result);
					var obj = jQuery.parseJSON( result );														
						myfunction(obj,target,isALL,selectkey,select_title);
					
				}
			});
		}
		/*select 내부 데이타 ajax 통신 */
  		//여기가 그거 구나 가져오는부분.
	function getPostSelectdata(inurl,indata,myfunction,target,isALL,selectkey,select_title,call_function)
	{
		$.ajax({
			type : 'post',
			url : getContextPath()+inurl,
			headers : {
				"Content-Type" : "application/json",
				"X-HTTP-Method-Override" : "POST",
				'X-CSRF-TOKEN': $("#csrf_token").val()
			},
			dataType : 'text',
			data : indata,
			async: false,
			error:function(request,status,error)
			{
				ms_alert("알림",status+error);
			},				
			success : function(result) {									
				//console.log("result: " + result);
				var obj = jQuery.parseJSON( result );														
					myfunction(obj,target,isALL,selectkey,select_title,call_function);
				
			}
		});
	}
		/*select및 목록값가져올때. 내부 데이타 ajax 통신 */
		function getPostSelectdata_commom_value(inurl,indata)
	{
		$.ajax({
			type : 'post',
			url : getContextPath()+inurl,
			headers : {
				"Content-Type" : "application/json",
				"X-HTTP-Method-Override" : "POST",
				'X-CSRF-TOKEN': $("#csrf_token").val()
			},
			dataType : 'text',
			data : indata,
			error:function(request,status,error)
			{
				ms_alert("알림",status+error);
			},				
			success : function(result) {									
				//console.log("result: " + result);
				var obj = jQuery.parseJSON( result );
				item_list=obj;
			}
		});
	}
		//오늘 일자 가져오기.. 
		function getTimeStamp() {
	    var d = new Date();
	    var s =
	        leadingZeros(d.getFullYear(), 4) + '-' +
	        leadingZeros(d.getMonth() + 1, 2) + '-' +
	        leadingZeros(d.getDate(), 2);
	    return s;
	}
		//오늘 일자 가져오기.. 
		function getTimeStamp_YYYY_MM() {
			var d = new Date();
			var s = leadingZeros(d.getFullYear(), 4) + '-' +
			        leadingZeros(d.getMonth() + 1, 2)
			return s;
		}
		function leadingZeros(n, digits) {
		    var zero = '';
		    n = n.toString();
		 
		    if (n.length < digits) {
		        for (i = 0; i < digits - n.length; i++)
		            zero += '0';
		    }
		    return zero + n;
		}
		
		//공통코드 불러오는 부분..
		function listcommon_code(target,key,selectkey,isall,select_title)
		{
			var url = '/com/getcommoncode';
			var data = JSON.stringify({		 
				  mt_parents_key : key
			});
			getPostSelectdata(url,data,callback_header,target,isall,selectkey,select_title);
		}
		//공통코드 불러오는 부분..
		function listcommon_code_asc(target,key,selectkey,isall,select_title)
		{
			var url = '/com/getcommoncode_asc';
			var data = JSON.stringify({		 
				  mt_parents_key : key
			});
			getPostSelectdata(url,data,callback_header,target,isall,selectkey,select_title);
		}
		var callback_header_call = function callback_listcommon_code(result,target,isall,selectkey,select_title,call_function)
		{
			if(isall)
			{
				if(select_title!=null)
				{
					$(target).append("<option value=''>"+select_title+"</option>");
				}
				else
				{
				 	$(target).append("<option value=''>전체</option>");
				}
			}
			for(var i=0;i<result.length;i++)
			{
				if(ISNULL(result[i].CODE))
				{
					result[i].CODE='';
				}
				if(selectkey != null)
				{
					if(result[i].CODE==selectkey)
					{
						$(target).append("<option value='"+result[i].CODE+"' selected>"+result[i].VALUE+"</option>");
					}		
					else
					{
						$(target).append("<option value='"+result[i].CODE+"'>"+result[i].VALUE+"</option>");
					}
				}
				else
				{
					 $(target).append("<option value='"+result[i].CODE+"'>"+result[i].VALUE+"</option>");
				}
			}
			call_function();
			//console.log("target:"+target);
		}  
		var callback_header = function callback_listcommon_code(result,target,isall,selectkey,select_title)
		{
			if(isall)
			{
				if(select_title!=null)
				{
					$(target).append("<option value=''>"+select_title+"</option>");
				}
				else
				{
				 	$(target).append("<option value=''>전체</option>");
				}
			}
			for(var i=0;i<result.length;i++)
			{
				if(ISNULL(result[i].CODE))
				{
					result[i].CODE='';
				}
				if(selectkey != null)
				{
					if(result[i].CODE==selectkey)
					{
						$(target).append("<option value='"+result[i].CODE+"' selected>"+result[i].VALUE+"</option>");
					}		
					else
					{
						$(target).append("<option value='"+result[i].CODE+"'>"+result[i].VALUE+"</option>");
					}
				}
				else
				{
					 $(target).append("<option value='"+result[i].CODE+"'>"+result[i].VALUE+"</option>");
				}
			}
			//console.log("target:"+target);
		}  
		//날짜 변경
		function get_format_date(in_data)
	   	{
			if(jQuery.type(in_data) === 'undefined')
			{
				return "";
			}
	   		if(in_data == "")
	   		{
	   			return "";	
	   		}
	   		
	   		var yyyy = in_data.substring( 0, 4);
	   		var mm = in_data.substring( 4, 6);
	   		var dd = in_data.substring( 6, 8);
	   		var return_text = yyyy+"-"+mm+"-"+dd;  
	   		return return_text;
	   	}
		
		function cloneJSON(obj) {
		    // basic type deep copy
		    if (obj === null || obj === undefined || typeof obj !== 'object')  {
		        return obj
		    }
		    // array deep copy
		    if (obj instanceof Array) {
		        var cloneA = [];
		        for (var i = 0; i < obj.length; ++i) {
		        	
		            cloneA[i] = cloneJSON(obj[i]);
		            //console.log(cloneA[i] );
		        }              
		        return cloneA;
		    }                  
		    // object deep copy
		    var cloneO = {};   
		    for (var i in obj) {
		        cloneO[i] = cloneJSON(obj[i]);
		    }                  
		    return cloneO;
		}
		//공통코드 불러오는 부분..
		function common_code_get(return_value,key,callback_myfunction)
		{
			var url = '/com/getcommoncode';
			var data = JSON.stringify({		 
				  mt_parents_key : key
			});
			common_code_getdata(url,data,return_value,callback_myfunction);
		}
		/*select및 목록값가져올때. 내부 데이타 ajax 통신 */
		
	function common_code_getdata(inurl,indata,return_value,callback_myfunction)
	{
		$.ajax({
			type : 'post',
			url : getContextPath()+inurl,
			headers : {
				"Content-Type" : "application/json",
				"X-HTTP-Method-Override" : "POST",
				'X-CSRF-TOKEN': $("#csrf_token").val()
			},
			async: false,
			dataType : 'text',
			data : indata,
			error:function(request,status,error)
			{
				ms_alert("알림",status+error);
			},				
			success : function(result) {
				var obj = jQuery.parseJSON( result );
				for (var i in obj) {	// for in 문을 사용하여 obj 객체 안의 프로퍼티를 하나씩 꺼냅니다.
					return_value[i] = obj[i];	// obj2 객체에 obj 객체가 가지고 있는 프로퍼티를 만들고
										// 프로퍼티 값도 원본 객체인 obj 객체와 같은 값으로 할당합니다.
				}
				if(callback_myfunction!=null)
				{
					callback_myfunction();
				}
				//console.log("587---result: " + result);
			}
		});
	}
		function input_listcommon_code(result,target,isall,selectkey,select_title)
		{
			//var m_code = result[i].code;
			//var m_value = result[i].value;
			if(isall)
			{
				if(select_title!=null)
				{
					$(target).append("<option value=''>"+select_title+"</option>");
				}
				else
				{
				 	$(target).append("<option value=''>전체</option>");
				}
			}
			for (var i in result)
			{
				if(ISNULL(result[i].CODE))
				{
					result[i].CODE='';
				}
				if(selectkey != null)
				{
					if(result[i].CODE==selectkey)
					{
						$(target).append("<option value='"+result[i].CODE+"' selected>"+result[i].VALUE+"</option>");
					}		
					else
					{
						$(target).append("<option value='"+result[i].CODE+"'>"+result[i].VALUE+"</option>");
					}
				}
				else
				{
					 $(target).append("<option value='"+result[i].VALUE+"'>"+result[i].VALUE+"</option>");
				}
			}
			//m_coderesult[i].code = m_code;
			//result[i].value = m_value;
		}  	
		function input_listcommon_code(result,target,isall,selectkey,select_title, title_key)
		{
			//var m_code = result[i].code;
			//var m_value = result[i].value;
			if(isall)
			{
				if(ISNULL(title_key))
				{
					title_key='';
				}
				if(select_title!=null)
				{
					$(target).append("<option value='"+title_key+"'>"+select_title+"</option>");
				}
				else
				{
				 	$(target).append("<option value=''>전체</option>");
				}
			}
			for (var i in result)
			{
				if(ISNULL(result[i].CODE))
				{
					result[i].CODE='';
				}
				if(selectkey != null)
				{
					if(result[i].CODE==selectkey)
					{
						$(target).append("<option value='"+result[i].CODE+"' selected>"+result[i].VALUE+"</option>");
					}		
					else
					{
						$(target).append("<option value='"+result[i].CODE+"'>"+result[i].VALUE+"</option>");
					}
				}
				else
				{
					 $(target).append("<option value='"+result[i].CODE+"'>"+result[i].VALUE+"</option>");
				}
			}
			//m_coderesult[i].code = m_code;
			//result[i].value = m_value;
		}  	
		function input_listcommon_code_find_name(result,target,isall,selectkey,select_title)
		{
			//var m_code = result[i].code;
			//var m_value = result[i].value;
			if(isall)
			{
				if(select_title!=null)
				{
					$(target).append("<option value=''>"+select_title+"</option>");
				}
				else
				{
				 	$(target).append("<option value=''>전체</option>");
				}
			}
			for (var i in result)
			{
				if(selectkey != null)
				{
					if(result[i].CODE==selectkey)
					{
						$(target).append("<option value='"+result[i].CODE+"' selected>"+result[i].VALUE+"</option>");
					}
				}
				else
				{
					 $(target).append("<option value='"+result[i].CODE+"'>"+result[i].VALUE+"</option>");
				}
			}			
		}  	
		$(document).ready(function(){
			if( $("#mt_pass").is())
			{
			    $("#mt_pass").keydown(function (key) {  		 
			        if(key.keyCode == 13){//키가 13이면 실행 (엔터는 13)
			        	actionLogin();
			        }
			    });
			}
		});
		$(document).keydown(function (e) {  			
	        if (e.keyCode === 8 && e.target.localName =='body') {
	            return false;
	        }
	    });
		function Come_get_my_code(callback_myfunction,return_value,key,in_sqlId,in_com_cap, re_code,re_value)
		{		
				var url = '/grid/commonGetUserCodeJsGrid';
				var data = JSON.stringify({		 
					  mt_parents_key : key
					 ,sqlId : in_sqlId
					 ,com_cap : in_com_cap
					 , code : re_code
				     , value : re_value
				});
				common_code_getdata(url,data,return_value,callback_myfunction);
		}
		//리턴 배열값에서 값찾기.
		function find_key_value(in_data, in_key)
		{
			var return_value="";
			$.each(in_data, function(key, data) { 
			  	if(data.code==in_key)
			  	{
			  		return_value = data.value;
			  		return return_value;
			  	}
			});
			return return_value;
		}
		function show_return_object_key_value(in_data)
		{
			var return_value="";
			$.each(in_data, function(key, data) { 
			  	console.log("key : "+key+" , data : "+data);
			});
			return return_value;
		}
  		//select 정보를 넘겨서 가져오기. 
  		function select_code_get_url(return_value,i_url,callback_myfunction)
  	   	{
  	   		var data = JSON.stringify({		 
  				sql_state : 'select'
  			});
  			common_code_getdata(i_url,data,return_value,callback_myfunction);
  	   	}
  		//sql문으로 코드값을 불러온다. 
  		function common_code_sql_id_get(return_value,sql_id,key,callback_myfunction)
  		{
  			var url = '/com/getcommoncode_sql_id';
  			var postData = new Object();
  		    postData["sqlId"] = sql_id;       
  		    postData["mt_parents_key"] = key;
  			var data = JSON.stringify(postData);
  			common_code_getdata(url,data,return_value,callback_myfunction);
  		}
  		
  		//공통코드 불러오는 부분..
  		function common_code_get_asc(return_value,key,callback_myfunction)
  		{
  			var url = '/com/getcommoncode_asc';
  			var data = JSON.stringify({		 
  				  mt_parents_key : key
  			});
  			common_code_getdata(url,data,return_value,callback_myfunction);
  		}
  		//단어찾기.
  		function containsWord(haystack, needle) {
  		    return (" " + haystack + " ").indexOf(" " + needle + " ") !== -1;
  		}
  		
  		
  		
  		String.prototype.htmlChars = function() { 

  	        var str = ((this.replace('"', '&amp;')).replace('"', '&quot;')).replace('\'', '&#39;'); 

  	        return (str.replace('<', '&lt;')).replace('>', '&gt;'); 

  	 } 

  	   

  	 //좌우 공백없애는 함수
  	 String.prototype.trim = function(){
  	         return this.replace(/(^s*)|(s*$)/g, "");
  	        // 사용방법 : form.msg.value.trim(); 
  	 } 
  	 //좌우 공백없애는 함수
  	 function trim(string) {
  	     var temp = "";     
  	     string = '' + string;
  	     splitstring = string.split(" ");
  	     for(i = 0; i < splitstring.length; i++)
  	         temp += splitstring[i]; 
  	     return temp; 
  	    // 사용방법 : trim(form.msg.value); 

  	 } 
  	 // 왼쪽 공백없애는 함수
  	 String.prototype.ltrim = function() { return this.replace(/^s*/g, ""); }
  	 // 오른쪽 공백없애는 함수 
  	 String.prototype.rtrim = function() { return this.replace(/s*$/g, ""); }  	    
  	 // 태그만 제거 
  	 String.prototype.stripTags = function() {
  	        var str = this;
  	        var pos1 = str.indexOf('<');
  	     if (pos1 == -1) return str;
  	     else { 
  	         var pos2 = str.indexOf('>', pos1);
  	         if (pos2 == -1) return str;
  	         return (str.substr(0, pos1) + str.substr(pos2+1)).stripTags();
  	     } 
  	 } 
  	 // 대소문자 구별하지 않고 단어 위치 찾기
  	 String.prototype.ipos = function(needle, offset) {
  	        var offset = (typeof offset == "number")?offset:0;
  	        return str.toLowerCase().indexOf(needle.toLowerCase(), offset);
  	 } 
  	 // 대소문자 구별하지 않고 뒤에서부터 단어위치 찾기
  	 String.prototype.ripos = function(needle, offset) {
  	        var offset = (typeof offset == "number")?offset:0;
  	        return str.toLowerCase().lastIndexOf(needle.toLowerCase(), offset);
  	 } 
  	 //특정문자열을 모두 찾아서 원하는 문자열로 모두 바꾸기
  	 String.prototype.replaceExp = function(from, to){
  	       return this.replace(new RegExp(from, "g"), to);
  	 }  
  	 String.prototype.replaceEval = function(from, to){
  	       return this.replace(eval("/" + from + "/g"), to);
  	 }  
  	 // 문자열을 배열로
  	 String.prototype.toArray = function() {
  	        var len = this.length; 
  	        var arr = new Array; 
  	        for (var i=0; i<len; i++) arr[i] = this.charAt(i);
  	        return arr; 
  	} 
  	function Hun_Min_Jeong_Eum(in_hangle)
  	{
  			var new_hangle=in_hangle.replace(/,/gi,"00741콤마00741");  			
  			//console.log(new_hangle);
  			new_hangle=new_hangle.htmlChars();
  			//console.log(new_hangle);
  			return new_hangle;
  	}
  	//form json데이터로 만들기 
  	jQuery.fn.serializeObject = function() { 
  		      var obj = null; 
  		      try { 
  		          if(this[0].tagName && this[0].tagName.toUpperCase() == "FORM" ) { 
  		              var arr = this.serializeArray(); 
  		              if(arr){ obj = {}; 
  		              jQuery.each(arr, function() { 
  		                  obj[this.name] = this.value; }); 
  		              } 
  		          } 
  		      }catch(e) { 
  		          alert(e.message); 
  		      }finally {} 
  		      return obj; 
  	}
  	//달력만들기 
  	function make_dr_work_time(in_target, in_nMonth)
	{
			in_target.empty();
		in_target.append('<colgroup>'
						+'<col style="width:12.5%">'
						+'<col style="width:12.5%">'
						+'<col style="width:12.5%">'
						+'<col style="width:12.5%">'
						+'<col style="width:12.5%">'
						+'<col style="width:12.5%">'
						+'<col style="width:12.5%">'
						+'<col style="width:12.5%">'
						+'</colgroup>'
						+'<tr>'
						+	'<th scope="col" rowspan="2">'+in_nMonth+'월</th>'
						+	'<th scope="col">일</th>'
						+	'<th scope="col">월</th>'
						+	'<th scope="col">화</th>'
						+	'<th scope="col">수</th>'
						+	'<th scope="col">목</th>'
						+	'<th scope="col">금</th>'
						+	'<th scope="col">토</th>'
						+'</tr>'
				);
			 var today = new Date(); // 오늘 날짜//지신의 컴퓨터를 기준으로
	   console.log('today:'+today);
	   var nMonth = new Date(today.getFullYear(), today.getMonth(), 1);  // 이번 달의 첫째 날
	   var lastDate = new Date(today.getFullYear(), today.getMonth()+1, 0); // 이번 달의 마지막 날
	   var nYearMonth=getTimeStamp_YYYY_MM();
	   
	   var cnt = 0;
	   // 1일이 시작되는 칸을 맞추어 줌
	   console.log('nMonth.getDay():'+nMonth.getDay());
	   var $tr1 = $("<tr>"); //$tr1.append('<th scope="col"></th>');
	   var $tr2 = $("<tr>"); $tr2.append('<th scope="row">오전</th>');
	   var $tr3 = $("<tr>"); $tr3.append('<th scope="row">오후</th>');
	   var $tr4 = $("<tr>"); $tr4.append('<th scope="row">야간</th>');
	   for (var i=0; i<nMonth.getDay(); i++) {
		  cnt = cnt + 1;
		  console.log('cnt:'+cnt);
		  $tr1.append('<th scope="col"></th>');
		  $tr2.append('<td></td>');
		  $tr3.append('<td></td>');
		  $tr4.append('<td></td>');
	   }
	   //var holiday='holiday';
	   for(var i=1;i<=lastDate.getDate(); i++)
	   {
		  cnt=cnt+1;
		  var holiday='';
		  if (cnt%7 == 1) //매주 일요일 빨간색
		  {	
			holiday='holiday';
		  }
		  var new_id = nYearMonth + '-' + leadingZeros(i, 2);
		  $tr1.append('<th id='+new_id+' class="'+holiday+'" scope="col">'+i+'</th>');
		  $tr2.append('<td id='+new_id+'_1'+'></td>');
		  $tr3.append('<td id='+new_id+'_2'+'></td>');
		  $tr4.append('<td id='+new_id+'_3'+'></td>');
		  
		  if (cnt%7 == 0)// 1주일이 7일 이므로
		  {
				in_target.append($tr1);
				in_target.append($tr2);
				in_target.append($tr3);
				in_target.append($tr4);
				$tr1 = $("<tr>"); $tr1.append('<th scope="col"></th>');
				$tr2 = $("<tr>"); $tr2.append('<th scope="row">오전</th>');
				$tr3 = $("<tr>"); $tr3.append('<th scope="row">오후</th>');
				$tr4 = $("<tr>"); $tr4.append('<th scope="row">야간</th>');
		  }
	    }
	    if (cnt%7 != 0)// 1주일이 7일 이므로
		{
			
			for(var i=cnt%7;i<7; i++)
			{
				 $tr1.append('<th scope="col"></th>');
				 $tr2.append('<td></td>');
				 $tr3.append('<td></td>');
				 $tr4.append('<td></td>');
			}
			in_target.append($tr1);
			in_target.append($tr2);
			in_target.append($tr3);
			in_target.append($tr4);
		}
	}
  	


  		
  				