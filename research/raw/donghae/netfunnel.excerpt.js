// EXCERPT of https://www.campingkorea.or.kr/resources/user/js/netfunnel.js (fetched 2026-09-29 13:17 KST, 92328 bytes).
// Only the header, the EditZone config block and the opcode/result constants are kept. Not the full file.

/**
 * Copyright (c) 2022 STCLab. All rights reserved.
 * Code licensed under the STCLab License
 * Version 2.2.25_hotfix
 *
 * @author jhh<jhh@stclab.com>
 */
//EditZoneStart ----------------------------------------------------------------
if (typeof window !== 'undefined') {
//운영용
NetFunnel.TS_HOST               = 'nf.campingkorea.or.kr';   // Default TS host
NetFunnel.TS_PORT               = 443;              // Default TS port
NetFunnel.TS_PROTO              = 'https';          // Default TS protocol [http|https]
//개발
//NetFunnel.TS_HOST               = '210.178.42.177';   // Default TS host
//NetFunnel.TS_PORT               = 80;              // Default TS port
//NetFunnel.TS_PROTO              = 'http';          // Default TS protocol [http|https]
NetFunnel.TS_QUERY              = 'ts.wseq';            // Default request query
NetFunnel.TS_SERVICE_ID         = 'service_1';          // Default TS Service id
NetFunnel.TS_ACTION_ID          = 'act_1';          // Default TS Action id
NetFunnel.TS_MAX_TTL            = 30;               // Default max ttl (second) 5~30
NetFunnel.TS_CONN_TIMEOUT       = 3;                // Default connect timeout (second)
NetFunnel.TS_CONN_RETRY         = 1;                // Default connect retry count
NetFunnel.TS_COOKIE_ID          = 'NetFunnel_ID';       // Default Cookie ID
NetFunnel.TS_COOKIE_TIME        = 10;               // Default Cookie Time (minute)
NetFunnel.TS_COOKIE_DOMAIN      = '';               // Default Cookie Domain
NetFunnel.TS_BYPASS             = false;            // NetFunnel Routine Bypass [true|false]
NetFunnel.TS_POPUP_TOP          = false;            // Popup Top Position ( "false" is center )
NetFunnel.TS_POPUP_LEFT         = false;            // Popup Left Position ( "false" is center )
NetFunnel.TS_AUTO_COMPLETE      = false;            // Auto setComplete [true|false]
NetFunnel.TS_DEBUG_MODE         = false;            // Debug Mode
NetFunnel.TS_SHOWTIME_LIMIT     = 0;                // Show WaitTime Limit (second, 0 is Unlimited)
NetFunnel.TS_SHOWCNT_LIMIT      = 0;                // Show WaitUser Limit (0 is Unlimited)
NetFunnel.TS_SHOWNEXT_LIMIT     = 0;                // Show NextWaitUser Limit (0 is Unlimited)
NetFunnel.TS_LIMIT_TEXT         = '다수';           // SHOWCNT,SHOWNEXT Limit를 넘었을때 출력되는 문자열
NetFunnel.TS_IFRAME_RESIZE      = false;            // true | false
NetFunnel.TS_USE_UNFOCUS        = true;             // object unfocus after netfunnel call
NetFunnel.TS_VIRT_WAIT          = 10000;            // virtual wait time (millisecond)
NetFunnel.TS_USE_MOBILE_UI      = true;             // Mobile UI
NetFunnel.TS_POPUP_TARGET       = window;           // Popup target window
NetFunnel.TS_USE_FRAME_BLOCK    = false;            // Block FrameSet Page
NetFunnel.TS_FRAME_BLOCK_LIST   = [];               // Frame Block Window List
NetFunnel.TS_USE_PRE_WAIT       = false;            // Pre waiting popup use
NetFunnel.TS_USER_DATA_KEYS     = [];               // Input UserData Key & Type(c=cookie,v=variable)
// ex) [ {"key":<user_data_key>, "type":<c|v>}, ... ]
NetFunnel.TS_CONFIG_USE         = true;             // 무조건 Config에 있는 IP 와 PORT로 사용
NetFunnel.TS_POPUP_ZINDEX       = 32000;            // 대기 Popup창의 z-index 값.
// 대기창이 뒤로 숨지 않도록 적당한 값을 넣어줘야 한다.
NetFunnel.TS_IP_ERROR_RETRY     = true;             // Retry(Re-Issue) Where IP Validation Error
NetFunnel.TS_SUCCESS_POPUP_VISIBILITY = false;
//일정 기간 동안 대기인원 변함 없을시 Bypass 처리
NetFunnel.TS_NWAIT_BYPASS       = false;            // 사용 유무
NetFunnel.TS_MAX_NWAIT_COUNT    = 100;              // 대기인원 반복 체크 기준값
//Server Block
NetFunnel.TS_BLOCK_MSG          = 'Service Block!!';        // Server Block시 팝업에 표시할 문구
NetFunnel.TS_BLOCK_URL          = '';               // Server Block시 등록된 url로 이동(미등록시 경고창 후 서비스 진입 불가)
NetFunnel.TS_IPBLOCK_WAIT_COUNT = 200;              // Server IP Block 가상대기창 반복 횟수
NetFunnel.TS_IPBLOCK_WAIT_TIME  = 10000;            // Server IP Block 가상대기시간
//대기창 미리보기
NetFunnel.TS_SHOW_WAIT_POPUP    = false;            //대기창 보기
//event skin 지정
NetFunnel.TS_SKIN_ID            = '';               // Skin ID (미지정시 default 대기창)
// Variable for MProtect
NetFunnel.MP_USE                = false;            // 매크로방지기능 사용유무 (true|false)
NetFunnel.MP_TIMELIMIT          = 20000;            // 사용자의 요청을 체크하기 위한 단위 시간 (ms)
NetFunnel.MP_MAXREQLIMIT        = NetFunnel.MP_TIMELIMIT/1100;  // TIMELIMIT 시간 내에 getTidChkEnter를 요청가능한 최대값
NetFunnel.MP_DEVLIMIT           = 20;               // 요청주기의 표준편차 제한값 (ms)
NetFunnel.MP_DEVCNTLIMIT        = 7;                // 표준편차 계산을 위한 item숫자
NetFunnel.MP_REQONLYLIMIT       = 10;               // setComplete 없이 getTidChkEnter만 요청한 횟수 제한값(횟수)
NetFunnel.MP_MINCOUNT           = 5;                // 계산을 하지 않는 자료개수
/* eslint-disable indent */
/* eslint-disable max-len */
/* eslint-disable no-unused-vars */
// Logo Image Data -------------------------------------------------------------
//   - height:16 pixel
//   - GIF Format Data (Base64 Encoding)
NetFunnel.gLogoData             = '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';
NetFunnel.gLogoText             = '';
NetFunnel.gLogoURL              = ' http://www.netfunnel.co.kr';
NetFunnel.gPreWaitData          = 'R0lGODlhKAAoALMMAPj4+MTExPT09NTU1NPT08XFxcbGxsLCwtXV1cPDw/X19b+/v////wAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQJBQAMACwAAAAAKAAoAAAEgJDJSau9OOvNu/9gKI5kaZ5oqq5sCwKIYSAABcv0qQRLvwQCyc73C5YGxB5BgkwuS4nk4iCJJqlQKdZKxJII0ifYaRLwfECJmZg2AQaFwqA2ecfnrry+dJvR80NoRi5NRE8uXD5eLYk9iyxjhnprgnt2cn97mpucnZ6foKGio3oRACH5BAkFAAwALAAAAAAoACgAAASAkMlJq7046827/2AojmRpnmiqrmwLAohhIAAFy/SpBEu/BALJzvcLlgbEHkGCTC5LieTiIIkmqVAp1krEkgjSJ9hpEvB8QImZmDYBBoXCoDZ5x+euvP4Vm9HzQ2hGLk1ETy5cPl4tiT2LLGOGemuCe3Zyf3uam5ydnp+goaKjnREAIfkECQUADAAsAAAAACgAKAAABICQyUmrvTjrzbv/YCiOZGmeaKqubAsCiGEgAAXL9KkES78EAsnO9wuWBsQeQYJMLkuJ5OIgiSapUCnWSsSSCNIn2GkS8HxAiZmYNgEGhcKgNnnH5668fnOb0fNDaEYuTURPLlw+Xi2JPYssY4Z6a4J7dnJ/e5qbnJ2en6ChoqOiEQAh+QQJBQAMACwAAAAAKAAoAAAEgJDJSau9OOvNu/9gKI5kaZ5oqq5sCwKIYSCAOynBoi+BYDOD3Y7wSwh1h+JxkbQRlkQJTEY7CXK7ngQn1JoAg0JhUJMEj1GX8dhUL9uk6azMeKJN3KyPce3uSWdCaWBiZCdrQnAsiDuKK3aCP316PwyEY3SVmpucnZ6foKGio6IRACH5BAkFAAwALAAAAAAoACgAAAR9kMlJq7046827/2AojmRpnmiqrmwLAohhIIA7KcGiL4FgM4PdjvBLCHWH4nGRtBGWRJsgt+v9GIBBoTCoXb/gDUxGo4xn3hJOaGWsq75S8BidC6Mk47GpFzbzS3yBJk90EoV3JlNscYtwJ1lbXWZaXGlhmJmam5ydnp+goBEAIfkECQUADAAsAAAAACgAKAAABH2QyUmrvTjrzbv/YCiOZGmeaKqubFsCiGEggDspwaIvgWAzg92O8EsIdYficZG0EZZEmyC36/0YgEGhMKhdv2ALTEajjGfeEk5oZayrvlLwGJ0LoyTjsakXNvNLfIEmT3QShXcmU2xxi3AnWVtdZlpcaWGYmZqbnJ2en6CgEQAh+QQJBQAMACwAAAAAKAAoAAAEfZDJSau9OOvNu/9gKI5kaZ5oqq5sqwKIYSCAOynBoi+BYDOD3Y7wSwh1h+JxkbQRlkSbILfr/RiAQaEwqF2/YGxs5pXAZLQTTmhlrKu+UvAYnQujJOOxqRc280t8gSZPdBKFdyZTbHGLcCdZW10UkVxlYZiZmpucnZ6foKARACH5BAUFAAwALAAAAAAoACgAAASBkMlJq7046827/2AojmRpnmiqrmyrAohhIIA7KcGiL4FgM4PdjvBLCHWH4nGRNMFktAlhSSzhhD2JILfLloLHKgMwKBQGNZPx2HSthe3WNDx5ztKlLdbHuHb5JWRmaBNgQmItbztxLIpIP3OHP3p/P2NlZ3iWm5ydnp+goaKjpD8RADs=';
NetFunnel.gTextDecoration           = false;
NetFunnel.gFixelData            = 'R0lGODlhAQABAJEAAAAAAP///////wAAACH5BAEAAAIALAAAAAABAAEAAAICVAEAOw==';
}//EditZoneEnd

// ---- constants (extracted from minified body) ----
NetFunnel.RTYPE_NONE=0;
NetFunnel.RTYPE_CHK_ENTER=5002;
NetFunnel.RTYPE_ALIVE_NOTICE=5003;
NetFunnel.RTYPE_SET_COMPLETE=5004;
NetFunnel.RTYPE_GET_TID_CHK_ENTER=5101;
NetFunnel.RTYPE_INIT=5105;
NetFunnel.RTYPE_STOP=5106;
NetFunnel.kSuccess=200;
NetFunnel.kContinue=201;
NetFunnel.kContinueDebug=202;
NetFunnel.kTsBypass=300;
NetFunnel.kTsBlock=301;
NetFunnel.kTsIpBlock=302;
NetFunnel.kTsExpressNumber=303;
NetFunnel.kTsErrorNoUservice=500;
NetFunnel.kTsErrorNoAction=501;
NetFunnel.kTsErrorAComplete=502;
NetFunnel.kTsErrorWrongServer=503;
NetFunnel.kTsErrorTooRecreate=504;
