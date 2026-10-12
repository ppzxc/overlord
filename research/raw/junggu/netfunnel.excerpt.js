
/**
 * Copyright (c) 2020 STCLab. All rights reserved.
 * Code licensed under the STCLab License
 * Version 2.2.19
 *
 * @author jhh<jhh@stclab.com>
 */

var NetFunnel = {}; NetFunnel.Skin = {};
//EditZoneStart ----------------------------------------------------------------
NetFunnel.TS_HOST        		= 'campwait.junggu.ulsan.kr';	// Default TS host
NetFunnel.TS_PORT				= 443;				// Default TS port
NetFunnel.TS_PROTO				= 'https';			// Default TS protocol [http|https]
NetFunnel.TS_QUERY				= 'ts.wseq';			// Default request query
NetFunnel.TS_SERVICE_ID			= 'service_1';			// Default TS Service id
NetFunnel.TS_ACTION_ID			= 'debug';			// Default TS Action id
NetFunnel.TS_MAX_TTL			= 30;				// Default max ttl (second) 5~30
NetFunnel.TS_CONN_TIMEOUT		= 3;				// Default connect timeout (second)
NetFunnel.TS_CONN_RETRY			= 1;				// Default connect retry count
