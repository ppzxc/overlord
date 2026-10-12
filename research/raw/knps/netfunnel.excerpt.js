/**
 * Copyright (c) 2020 STCLab. All rights reserved.
 * Code licensed under the STCLab License
 * Version 2.2.19
 *
 * @author jhh<jhh@stclab.com>
 */

var NetFunnel = {}; NetFunnel.Skin = {};
//EditZoneStart ----------------------------------------------------------------
NetFunnel.TS_HOST        		= 'netfunnel.knps.or.kr';	// Default TS host
NetFunnel.TS_PORT				= 443;				// Default TS port
 * Copyright (c) 2020 STCLab. All rights reserved.
 * Code licensed under the STCLab License
 * Version 2.2.19
 *
 * @author jhh<jhh@stclab.com>
 */
NetFunnel.TS_HOST        		= 'netfunnel.knps.or.kr';	// Default TS host
NetFunnel.TS_PORT				= 443;				// Default TS port
NetFunnel.TS_PROTO				= 'https';			// Default TS protocol [http|https]
NetFunnel.TS_QUERY				= 'ts.wseq';			// Default request query
NetFunnel.TS_SERVICE_ID			= 'service_1';			// Default TS Service id
NetFunnel.TS_ACTION_ID			= 'reservation2';			// Default TS Action id
NetFunnel.TS_MAX_TTL			= 30;				// Default max ttl (second) 5~30
NetFunnel.TS_CONN_TIMEOUT		= 3;				// Default connect timeout (second)
NetFunnel.TS_CONN_RETRY			= 1;				// Default connect retry count
NetFunnel.TS_COOKIE_ID			= 'NetFunnel_ID';		// Default Cookie ID
NetFunnel.TS_COOKIE_TIME		= 10;				// Default Cookie Time (minute)
NetFunnel.TS_COOKIE_DOMAIN		= '';				// Default Cookie Domain
NetFunnel.TS_BYPASS				= false;			// NetFunnel Routine Bypass [true|false]
NetFunnel.TS_POPUP_TOP			= false;			// Popup Top Position ( "false" is center )
NetFunnel.TS_POPUP_LEFT			= false;			// Popup Left Position ( "false" is center )
NetFunnel.TS_AUTO_COMPLETE		= true;			// Auto setComplete [true|false]
NetFunnel.TS_DEBUG_MODE			= false;			// Debug Mode
NetFunnel.TS_SHOWTIME_LIMIT		= 0;				// Show WaitTime Limit (second, 0 is Unlimited)
NetFunnel.TS_SHOWCNT_LIMIT		= 0;				// Show WaitUser Limit (0 is Unlimited)
NetFunnel.TS_SHOWNEXT_LIMIT		= 0;				// Show NextWaitUser Limit (0 is Unlimited)
NetFunnel.TS_LIMIT_TEXT			= '다수';			// SHOWCNT,SHOWNEXT Limit를 넘었을때 출력되는 문자열
NetFunnel.TS_IFRAME_RESIZE		= false;			// true | false
NetFunnel.TS_USE_UNFOCUS		= true;				// object unfocus after netfunnel call
NetFunnel.TS_VIRT_WAIT			= 10000;			// virtual wait time (millisecond)
NetFunnel.TS_USE_MOBILE_UI		= true;				// Mobile UI
NetFunnel.TS_POPUP_TARGET		= window;			// Popup target window
NetFunnel.TS_USE_FRAME_BLOCK	= false;			// Block FrameSet Page
NetFunnel.TS_FRAME_BLOCK_LIST	= [];				// Frame Block Window List
NetFunnel.TS_USE_PRE_WAIT		= false;			// Pre waiting popup use
NetFunnel.TS_USER_DATA_KEYS		= [];				// Input UserData Key & Type(c=cookie,v=variable)
NetFunnel.TS_CONFIG_USE			= true;				// 무조건 Config에 있는 IP 와 PORT로 사용
NetFunnel.TS_POPUP_ZINDEX		= 32000;			// 대기 Popup창의 z-index 값.
NetFunnel.TS_IP_ERROR_RETRY		= true;				// Retry(Re-Issue) Where IP Validation Error
NetFunnel.TS_SUCCESS_POPUP_VISIBILITY = false;
NetFunnel.TS_NWAIT_BYPASS		= true;				// 사용 유무
NetFunnel.TS_MAX_NWAIT_COUNT	= 100;				// 대기인원 반복 체크 기준값
NetFunnel.TS_BLOCK_MSG			= 'Service Block!!';		// Server Block시 팝업에 표시할 문구
NetFunnel.TS_BLOCK_URL			= '';				// Server Block시 등록된 url로 이동(미등록시 경고창 후 서비스 진입 불가)
NetFunnel.TS_IPBLOCK_WAIT_COUNT	= 200;				// Server IP Block 가상대기창 반복 횟수
NetFunnel.TS_IPBLOCK_WAIT_TIME	= 10000;			// Server IP Block 가상대기시간
NetFunnel.TS_SHOW_WAIT_POPUP	= false;			//대기창 보기
