if (typeof NetFunnel == "object") {
    var tstr = '\
    <style>\
    	body{font-family: "Pretendard";}\
    	#netFu{position:relative; margin:10% auto 0 auto; border:3px solid #004ea2; border-radius:16px; background:#fff; box-shadow:7px 7px 15px rgba(0,0,0,0.1); max-width:720px; min-width:260px; overflow:hidden;}\
    	#netFu .fuTop{display:flex; justify-content:space-between; align-items:center; position:relative; padding:16px 24px; width:100%; height:62px; background:#004ea2;}\
    	#netFu .fuTop .tit{font-size:24px !important; font-weight:600; color:#fff !important;}\
    	#netFu .fuTop .x{display:flex; align-items:center; gap:4px; justify-content:center; width:60px; height:30px; border:1px solid #fff; color:#fff !important; border-radius:4px; font-size:14px !important;}\
    	#netFu .fuTop .x:hover{background:rgba(255,255,255,0.1);}\
    	#netFu .fuTop .x:active{opacity:.6;}\
    	#netFu .fuBody{padding:24px; }\
    	#netFu .fuBody .txt{text-align:center; font-size:24px !important; font-weight:600; line-height:1.2em;}\
    	#netFu .fuBody .box{padding:16px; border-radius:16px; border:1px solid #dbdbdb; background:#f9f9f9; width:100%; text-align:center; font-size:20px !important;}\
    	#netFu .fuBody .box p{line-height:1.3em; font-size:22px !important;}\
    	#netFu .fuBody .box1{padding:16px 40px; margin-top:24px;}\
    	#netFu .fuBody .box1 .num{font-size:22px !important; font-weight:600 !important; color:#e41d95 !important;}\
    	#netFu .fuBody .box1 .NetFunnel_Wait_Value{font-size:22px !important; font-weight:600 !important; color:#e41d95 !important;} \
    	#netFu .fuBody .box1 .progress{position:relative; margin-top:16px; width:100%; height:15px; border-radius:100px; border:1px solid #dbdbdb; background:#fff; overflow:hidden;}\
    	#netFu .fuBody .box1 .progress .now{position:absolute; left:0; top:0; height:100%; width:40%; background:#004ea2 url(/assets/img/bgslide.svg) repeat; animation: progress 1s linear infinite alternate-reverse;}\
    	#netFu .fuBody .box2{margin-top:32px; }\
    	#netFu .fuBody .box2 .stop{font-size: 22px !important; font-weight:600; color: #004ea2 !important;}\
    	#netFu .fuBody .box2 br{display:none;}\
    	#netFu .fuBody .box2 .stop:hover{text-decoration:underline; opacity:.6;}\
    	#netFu .fuBody .box2 .emNt{color:#BA0000 !important; font-weight:600; font-size: 20px !important; }\
    	#netFu .fuBody .stxt{margin-top:12px; font-size:16px !important; color:#666 !important; line-height:1.2em;}\
    	#netFu .fuBody .stxt1{font-size:20px !important;}\
    	@keyframes progress{\
    		0%{opacity:1;}\
    		100%{opacity:.5;}\
    	}\
    	@media all and (max-width:768px){\
    		#netFu{border-radius:8px;}\
    		#netFu .fuTop{padding:12px 16px; height:56px;}\
    		#netFu .fuTop .tit{font-size:20px !important;}\
    		#netFu .fuBody{padding:16px;}\
    		#netFu .fuBody .txt{font-size:14px !important;}\
    		#netFu .fuBody .box{font-size:14px !important; border-radius:8px;}\
    		#netFu .fuBody .box1{padding:16px; margin-top:8px;}\
    		#netFu .fuBody .stxt{font-size:12px !important;}\
    		#netFu .fuBody .box2{margin-top:16px; line-height:1.3em;}\
    		#netFu .fuBody .box2 br{display:inline-block;}\
    		#netFu .fuBody .box2 .stop{font-size:16px !important;}\
    	}\
   	</style>\
    <div id = "NetFunnel_Skin_Top">\
    	<div id="netFu">\
			<div class="fuTop">\
				<p class="tit">예약접속 대기</p>\
				<button class="x" onclick="NetFunnel.countdown_stop();">닫기<img src="/assets/img/close.svg" alt=""></button>\
			</div>\
			<div class="fuBody">\
				<p class="txt">기다림이 기대로 바뀌는 기적 같은 시간,<br/>예약 접속까지 최장 30분 이상 소요될 수 있습니다.</p>\
				<div class="box box1">\
					<p class="numTxt">현재 <span class="num"><span id="NetFunnel_Loading_Popup_Count" class="NetFunnel_Wait_Value"></span></span>명이 접속대기 중이며,<br/>대기 순서에 따라 자동 접속됩니다.</p>\
					<div id="NetFunnel_Wait_Progress" class="progress"><span class="now"></span></div>\
				</div>\
				<p class="stxt stxt1">\
					※ 고객님이 선호하는 일자의 시설과 서비스는 예약 시작 초기에 매진될 수 있습니다.<br/>\
					※ 예약화면 접속 후 잔여 시설과 서비스가 없는 경우 예약이 어려울 수 있습니다.\
				</p>\
				<div class="box box2">\
					<button class="stop" onclick="NetFunnel.countdown_stop();">[중지]</button> 버튼을 누르면 <span class="emNt">대기 순서가 다시 부여</span> 됩니다.\
				</div>\
				<p class="stxt">\
					※ 일시적 통신장애 등으로 접속이 끊겨 대기자 수가 줄지 않고 멈춘 경우에만 사용하여 주십시오.\
				</p>\
			</div>\
		</div>\
    </div>\
    ';
    
    NetFunnel.SkinUtil.add('knps_skin', {
        prepareCallback: function () {
            var progress = document.getElementById("NetFunnel_Wait_Progress");
            // progress_print.innerHTML="0 % (0/0) - 0 sec";
			
            if(progress) {
            	var run = progress.getElementsByTagName("span")[0];
            	run.style.width = "0%";
            }
        },
        updateCallback: function (percent, nwait, totwait, timeleft) {
        	var progress = document.getElementById("NetFunnel_Wait_Progress");
        	// var prog=totwait - nwait;
        	// progress_print.innerHTML = percent+" % ("+prog+"/"+totwait+") - "+timeleft+" sec";        	

			if(progress) {
				var run = progress.getElementsByTagName("span")[0];
				run.style.width = percent + "%";
			}
        },
        
        htmlStr: tstr
    }, 'normal');

    NetFunnel.SkinUtil.add('knps_skin', {
        prepareCallback: function () {
        	var progress = document.getElementById("NetFunnel_Wait_Progress");
            if(progress) {
            	var run = progress.getElementsByTagName("span")[0];
            	run.style.width = "0%";
            }
        },
        updateCallback: function (percent, nwait, totwait, timeleft) {
        	var progress = document.getElementById("NetFunnel_Wait_Progress");
        	if(progress) {
				var run = progress.getElementsByTagName("span")[0];
				run.style.width = percent + "%";
			}
        },

        htmlStr: tstr
    }, 'mobile');

}
