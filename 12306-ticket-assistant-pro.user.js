// ==UserScript==
// @name         12306 抢票助手 Pro
// @namespace    https://github.com/black-mouse-sha/12306-ticket-assistant-pro
// @icon         https://black-mouse-sha.github.io/12306-ticket-assistant-pro/docs/images/icon.png
// @version      3.3.5
// @description  三步抢票：填条件 → 看方案 → 按顺序抢。支持直达 / 买长乘短 / 中转三类方案、按各站起售时间分段开火、中转分段接力、车厢图选座。
// @author       LittlePerson
// @match        https://www.12306.cn/*
// @match        https://kyfw.12306.cn/*
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        window.focus
// @connect      kyfw.12306.cn
// @connect      www.12306.cn
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // ==========================================================================
    // v3 相对 v2.1.17 的核心变化（给以后维护的人看）
    //   1. 删掉了整条「联程」链路（lcQuery / lcConfirmPassenger 那套接口）。
    //      理由：它要求参数与 12306 自己的 JS 逐字对齐，一旦改版就整条失效；
    //      而它想解决的问题（不会卡在换乘站）已经被"两段接力 + 半步继续"部分覆盖，
    //      真正原子的做法只有官方联程接口，代价是机会少一半，不划算。
    //   2. 单个定时（saleAtMs）改成多个起售点（salePoints[]）。
    //      12306 的起售时间按「乘车站」算，中转两段分属两个站，时刻通常不同；
    //      旧版只能填一个时刻，第二段永远等不到。
    //   3. 中转从"两段都有票才一起下"改成"两段接力、半步继续"。
    //      旧逻辑在两段起售时间不同时永远不会触发（第二段开售时第一段早没了）。
    //   4. 界面重做成三步：条件 → 方案 → 抢票。方案是查回来的真实车次，
    //      你勾选、删除、排序；脚本严格按你的顺序择优。
    //   5. 接力状态落盘：抢到半程票之后刷新/跳转，回来还认得自己是谁。
    //   6. 三路唤醒 + 「接力期间保持唤醒」：跨时段等第二段时，尽量别被浏览器限流。
    // ==========================================================================

    const SCRIPT_VERSION = '3.3.5';

    // --------------------------------------------------------------------------
    // 日志（技术日志 + 面板日志，都落盘，跳转页面后能捡回来）
    // --------------------------------------------------------------------------
    const TECH_LOG_MAX = 200;
    const techLog = [];
    const LOG_PERSIST_KEY = 'grab_log_persist';
    const LOG_PERSIST_MAX = 300;
    const LOG_PERSIST_TTL_MS = 2 * 3600 * 1000;
    const uiLogBuffer = [];
    let logPersistTimer = null;

    function flushLogsToStorage() {
        logPersistTimer = null;
        try {
            GM_setValue(LOG_PERSIST_KEY, JSON.stringify({
                at: Date.now(),
                ui: uiLogBuffer.slice(-LOG_PERSIST_MAX),
                tech: techLog.slice(-LOG_PERSIST_MAX)
            }));
        } catch (e) { /* 存不上不影响抢票 */ }
    }
    function scheduleLogPersist() {
        if (logPersistTimer) return;
        logPersistTimer = setTimeout(flushLogsToStorage, 1000);
    }
    function loadPersistedLogs() {
        try {
            const raw = GM_getValue(LOG_PERSIST_KEY, '');
            if (!raw) return null;
            const o = JSON.parse(raw);
            if (!o || !o.at || Date.now() - o.at > LOG_PERSIST_TTL_MS) return null;
            return o;
        } catch (e) { return null; }
    }

    function tlog(level, ...args) {
        const text = args.map(a => (a && a.stack) ? a.stack : String(a)).join(' ');
        techLog.push(`[${new Date().toLocaleTimeString()}]${level === 'log' ? '' : ' [' + level + ']'} ${text}`);
        if (techLog.length > TECH_LOG_MAX) techLog.shift();
        scheduleLogPersist();
        const emit = console[level] || console['log'];
        emit(...args);
    }
    tlog('log', `>>> 12306 抢票助手 Pro (v${SCRIPT_VERSION}) 已加载 <<<`);
    (function restoreTechLog() {
        const saved = loadPersistedLogs();
        if (!saved || !Array.isArray(saved.tech) || !saved.tech.length) return;
        techLog.push(...saved.tech.slice(-TECH_LOG_MAX));
    })();

    // --------------------------------------------------------------------------
    // 抢到票之后的落地保护（沿用 v2 的三道保险）
    // --------------------------------------------------------------------------
    const ORDER_NOTICE_KEY = 'grab_last_order';
    const ORDER_NOTICE_TTL_MS = 6 * 3600 * 1000;
    function saveOrderNotice(info) {
        try { GM_setValue(ORDER_NOTICE_KEY, JSON.stringify(Object.assign({ at: Date.now() }, info))); }
        catch (e) { /* 忽略 */ }
    }
    function readOrderNotice() {
        try {
            const raw = GM_getValue(ORDER_NOTICE_KEY, '');
            if (!raw) return null;
            const o = JSON.parse(raw);
            if (!o || !o.at || Date.now() - o.at > ORDER_NOTICE_TTL_MS) return null;
            return o;
        } catch (e) { return null; }
    }
    function clearOrderNotice() {
        try { GM_setValue(ORDER_NOTICE_KEY, ''); } catch (e) { /* 忽略 */ }
    }
    function orderNoticeLabel(n) {
        return `${n.trainCode || ''} ${n.trainDate || ''} ${n.fromName || ''}→${n.toName || ''} ${n.seatName || ''}`
            .replace(/\s+/g, ' ').trim();
    }

    // --------------------------------------------------------------------------
    // 接力状态落盘（v3 新增）
    // --------------------------------------------------------------------------
    // 为什么必须落盘：中转第 1 段 11:30 抢到、第 2 段 17:00 才开售，中间 5 个半小时。
    // 这期间用户很可能刷新页面、或者被脚本自己跳去支付页。状态只在内存里的话，
    // 回来就"失忆"了——手上那张半程票没人记得，第 2 段也不会再去抢。
    const RELAY_KEY = 'grab_relay_state';
    const RELAY_TTL_MS = 8 * 3600 * 1000;
    function saveRelayState(st) {
        try { GM_setValue(RELAY_KEY, JSON.stringify(Object.assign({ at: Date.now() }, st))); }
        catch (e) { /* 忽略 */ }
    }
    function readRelayState() {
        try {
            const raw = GM_getValue(RELAY_KEY, '');
            if (!raw) return null;
            const o = JSON.parse(raw);
            if (!o || !o.at || Date.now() - o.at > RELAY_TTL_MS) return null;
            return o;
        } catch (e) { return null; }
    }
    function clearRelayState() {
        try { GM_setValue(RELAY_KEY, ''); } catch (e) { /* 忽略 */ }
    }

    // ==========================================================================
    // 请求通道（v3.0.1 新增）
    // ==========================================================================
    // 为什么需要这一层：脚本要能在**任何** 12306 页面上用（主页、会员中心、查询页）。
    // 12306 的接口全在 kyfw.12306.cn 上，而页面可能在 www.12306.cn —— 那是跨域，
    // 页面的 fetch 会撞 CORS 预检（我们带了 X-Requested-With 这类自定义头），
    // 请求直接被浏览器拦掉，表现就是"点了没反应 / 一直在查询"。
    //
    // 油猴的 GM_xmlhttpRequest 是**由扩展在后台发出**的，不受页面跨域限制，
    // 而且会自动带上目标域的 cookie（登录态就在 cookie 里）。
    // 所以：能用页面 fetch 就用（请求头与浏览器真实操作完全一致，v2 的联程那条线就是靠这个），
    // fetch 被跨域拦掉时自动改走油猴通道。
    function headersFromText(text) {
        const h = new Headers();
        String(text || '').split(/\r?\n/).forEach(line => {
            const i = line.indexOf(':');
            if (i > 0) {
                try { h.append(line.slice(0, i).trim(), line.slice(i + 1).trim()); } catch (e) { /* 忽略畸形头 */ }
            }
        });
        return h;
    }
    let gmFallbackWarned = false;
    function gmRequest(url, init) {
        return new Promise((resolve, reject) => {
            const method = String((init && init.method) || 'GET').toUpperCase();
            const headers = {};
            try {
                const h = (init && init.headers) || {};
                Object.keys(h).forEach(k => {
                    // Host / Origin / Cookie 这类由扩展自己决定，硬塞会被拒
                    if (/^(host|origin|cookie|content-length)$/i.test(k)) return;
                    headers[k] = h[k];
                });
            } catch (e) { /* 忽略 */ }
            let data;
            try { data = init && init.body ? String(init.body) : undefined; } catch (e) { data = undefined; }
            GM_xmlhttpRequest({
                method, url, headers, data,
                timeout: (init && init.timeout) || 15000,
                responseType: 'text',
                onload: r => resolve({ status: r.status, headersText: r.responseHeaders || '', text: r.responseText || '' }),
                onerror: () => reject(new Error('NetworkError')),
                ontimeout: () => reject(new Error('Request timeout')),
                onabort: () => reject(new Error('Request timeout'))
            });
        });
    }
    // 把油猴通道的裸响应包成 fetch 风格的对象。
    // 用真 Response 最好；万一某些注入环境里没有 Response 构造器，
    // 就给一个只带本脚本用得到的那几个成员的鸭子类型，别让整条链断在这里。
    function wrapResponse(status, headersText, text) {
        const code = status || 200;
        const body = String(text == null ? '' : text);
        const headers = headersFromText(headersText);
        try {
            return new Response(body, { status: code, headers });
        } catch (e) {
            return {
                status: code, ok: code >= 200 && code < 300, url: '', headers,
                text: () => Promise.resolve(body),
                json: () => Promise.resolve(JSON.parse(body))
            };
        }
    }
    // 走油猴通道，并把结果包成 fetch 风格的对象
    async function gmFetch(target, init, timeoutMs) {
        const r = await gmRequest(target, Object.assign({}, init, { timeout: timeoutMs || (init && init.timeout) || 15000 }));
        if (!r.status) throw new Error('NetworkError');
        return wrapResponse(r.status, r.headersText, r.text);
    }
    function hostOf(u) {
        try { return new URL(u, location.href).host; } catch (e) { return ''; }
    }
    // 请求通道选择（v3.0.1 的核心）：
    //   跨域 → **直接**走油猴通道。跨域会先发 CORS 预检（我们带了 X-Requested-With），
    //          而 12306 的边缘节点对 OPTIONS 经常不回或回得极慢，浏览器就一直挂着 ——
    //          现象就是"点了没反应 / 一直在查询 / 乘车人也加载不出来"。
    //          这种情况 fetch 既不成功也不报错，所以"等它抛错再兜底"是等不到的。
    //   同源 → 先用页面 fetch：请求头、Referer 与浏览器真实操作完全一致，
    //          这是 v2.1.17 已经跑通的那条路，不动它。
    //   兜底 → 同源 fetch 无论因为什么失败（被拦/超时/预检挂住），都再用油猴通道试一次。
    async function httpFetch(url, init, timeoutMs) {
        const target = (typeof url === 'string') ? url : (url && url.url) || String(url);
        const gmOK = typeof GM_xmlhttpRequest === 'function';
        const sameHost = hostOf(target) === location.host;
        if (!sameHost && gmOK) {
            if (!gmFallbackWarned) {
                gmFallbackWarned = true;
                tlog('log', `[Net] 跨域请求（${location.host} → ${hostOf(target)}）直接走油猴通道，绕开 CORS 预检`);
            }
            return await gmFetch(target, init, timeoutMs);
        }
        const hardMs = (Number(timeoutMs) || 15000) + 3000;
        let timer = null;
        try {
            // 看门狗：即使 abort 没能把请求打断（预检挂住时确实打不断），也保证这一枪会结束
            const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('__watchdog__')), hardMs); });
            return await Promise.race([fetch(url, init), guard]);
        } catch (e) {
            if (!gmOK) throw e;
            const msg = String((e && e.message) || e);
            if (!gmFallbackWarned) {
                gmFallbackWarned = true;
                tlog('log', `[Net] 页面 fetch 走不通（${msg === '__watchdog__' ? '超时挂住' : msg}）——改走油猴通道`);
            }
            return await gmFetch(target, init, timeoutMs);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    // ==========================================================================
    // 常量
    // ==========================================================================
    const BASE_URL = 'https://kyfw.12306.cn';

    // 等价于 12306 自己的 otsRedirect("post", url, {})。
    // 支付页 payOrder/init 只认 POST，用 location.href（GET）只会看到「系统忙，请稍后重试」。
    function postRedirect(url) {
        try {
            const form = document.createElement('form');
            form.method = 'POST';
            form.action = url;
            form.style.display = 'none';
            (document.body || document.documentElement).appendChild(form);
            form.submit();
        } catch (e) {
            window.location.href = url;
        }
    }

    // 查票请求单独用短超时：轮询是「上一轮结束才排下一轮」，一个卡住的请求会堵死整条流水线
    const QUERY_TIMEOUT_MS = 3000;
    const QUERY_TIMEOUT_MS_HOT = 5000;

    // 查票接口候选池（被限流时连 c_url 都拿不到，所以要有备用路径可切）
    const QUERY_URL_KEY = 'query_url_pool';
    const QUERY_URL_DEFAULT = '/otn/leftTicket/query';
    let queryUrlPool = [QUERY_URL_DEFAULT];
    let QUERY_URL = QUERY_URL_DEFAULT;

    function rememberQueryUrl(url) {
        const next = String(url || '').trim();
        if (!next) return;
        queryUrlPool = [next].concat(queryUrlPool.filter(u => u !== next)).slice(0, 5);
        QUERY_URL = next;
        try { GM_setValue(QUERY_URL_KEY, queryUrlPool.join('\n')); } catch (e) { /* 忽略 */ }
    }
    function rotateQueryUrl() {
        if (queryUrlPool.length < 2) return false;
        const cur = queryUrlPool.indexOf(QUERY_URL);
        const next = queryUrlPool[(cur + 1) % queryUrlPool.length];
        if (!next || next === QUERY_URL) return false;
        tlog('log', `[Query] 查票接口连续被拒，切换: ${QUERY_URL} -> ${next}`);
        QUERY_URL = next;
        return true;
    }
    (function loadQueryUrlPool() {
        try {
            const saved = String(GM_getValue(QUERY_URL_KEY, '') || '');
            const arr = saved.split('\n').map(s => s.trim()).filter(Boolean);
            if (!arr.length) return;
            queryUrlPool = arr.filter((v, i, a) => a.indexOf(v) === i).slice(0, 5);
            QUERY_URL = queryUrlPool[0];
            tlog('log', `[Query] 已恢复查票接口: ${QUERY_URL}（候选 ${queryUrlPool.length} 条）`);
        } catch (e) { /* 忽略 */ }
    })();

    function queryUrlFromLocation(loc, baseUrl) {
        const raw = String(loc || '').trim();
        if (!raw) return '';
        let path = '';
        try {
            path = /^https?:\/\//i.test(raw)
                ? new URL(raw).pathname
                : new URL(raw, baseUrl || `${BASE_URL}${QUERY_URL_DEFAULT}`).pathname;
        } catch (e) { return ''; }
        const tail = path.split('/').filter(Boolean).pop() || '';
        if (!/^query[A-Z]?$/.test(tail)) return '';
        return path;
    }
    const REGEX_C_LEFT_TICKET_URL = /var\s+CLeftTicketUrl\s*=\s*['"]([^'"]+)['"]/;
    function queryUrlFromCLeftTicket(raw) {
        const val = String(raw || '').trim();
        if (!val) return '';
        let path = val;
        try { if (/^https?:\/\//i.test(val)) path = new URL(val).pathname; } catch (e) { return ''; }
        const seg = path.split('/').filter(Boolean);
        if (seg.length < 2) return '';
        const tail = seg[seg.length - 1];
        if (!/^query[A-Z]?$/.test(tail)) return '';
        if (seg[seg.length - 2] !== 'leftTicket') return '';
        return `/otn/${seg[seg.length - 2]}/${tail}`;
    }
    // 12306 自己把「当前该用的查票接口」写在页面变量里（var CLeftTicketUrl = 'leftTicket/queryG'），
    // 这是最权威的来源：不占查票额度，也不用追 302。
    async function learnQueryUrlFromCLeftTicket() {
        try {
            if (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow.CLeftTicketUrl) {
                const u = queryUrlFromCLeftTicket(unsafeWindow.CLeftTicketUrl);
                if (u) return { url: u, from: '当前页面变量' };
            }
        } catch (e) { /* 跨沙箱读不到就走下面 */ }
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            let res;
            try {
                res = await httpFetch(`${BASE_URL}/otn/leftTicket/init`, {
                    method: 'GET', redirect: 'follow', signal: controller.signal,
                    headers: {
                        'X-Requested-With': 'XMLHttpRequest',
                        'Referer': (typeof location !== 'undefined' && location.href) || `${BASE_URL}/otn/leftTicket/init`
                    }
                }, 5000);
            } finally { clearTimeout(timer); }
            if (!res || !res.ok) return null;
            const html = await res.text();
            const m = String(html).match(REGEX_C_LEFT_TICKET_URL);
            if (!m) return null;
            const u = queryUrlFromCLeftTicket(m[1]);
            return u ? { url: u, from: 'init 页面' } : null;
        } catch (e) { return null; }
    }
    async function probeQueryUrl(retries = 1) {
        try {
            const got = await learnQueryUrlFromCLeftTicket();
            if (got) {
                if (got.url !== QUERY_URL) {
                    rememberQueryUrl(got.url);
                    tlog('log', `[Query] 已拿到官方查票接口: ${got.url}（来源：${got.from}）`);
                    return true;
                }
                tlog('log', `[Query] 官方查票接口就是 ${QUERY_URL}（来源：${got.from}），无需切换`);
                return false;
            }
            tlog('log', '[Query] 没读到 CLeftTicketUrl，改用 302 探测');
        } catch (e) {
            tlog('log', `[Query] 读 CLeftTicketUrl 失败（${e.message}）`);
        }
        try {
            const q = new URLSearchParams({
                'leftTicketDTO.train_date': serverTodayIso(),
                'leftTicketDTO.from_station': 'BJP',
                'leftTicketDTO.to_station': 'TJP',
                'purpose_codes': 'ADULT'
            });
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            const probeUrl = `${BASE_URL}${QUERY_URL_DEFAULT}?${q.toString()}`;
            let res;
            try {
                res = await httpFetch(probeUrl, {
                    method: 'GET', redirect: 'follow', signal: controller.signal,
                    headers: {
                        'X-Requested-With': 'XMLHttpRequest',
                        'Referer': (typeof location !== 'undefined' && location.href) || `${BASE_URL}/otn/leftTicket/init`
                    }
                }, 5000);
            } finally { clearTimeout(timer); }
            const learned = queryUrlFromLocation(res.url, probeUrl);
            if (learned && learned !== QUERY_URL) {
                rememberQueryUrl(learned);
                tlog('log', `[Query] 已探到真实查票接口: ${QUERY_URL_DEFAULT} -> ${learned}`);
                return true;
            }
            tlog('log', `[Query] 探测查票接口: 没有重定向（HTTP ${res.status}），沿用 ${QUERY_URL}`);
            return false;
        } catch (e) {
            tlog('warn', `[Query] 探测真实查票接口失败（不影响抢票）: ${e.message}`);
            if (retries > 0) setTimeout(() => { probeQueryUrl(retries - 1); }, 15000);
            return false;
        }
    }

    // --------------------------------------------------------------------------
    // 席别码
    // --------------------------------------------------------------------------
    const SEAT_TYPE_CODE = {
        '商务座': '9', '特等座': 'P', '一等座': 'M', '优选一等座': 'D', '二等座': 'O',
        '高级软卧': '6', '软卧': '4', '一等卧': 'I', '硬卧': '3', '二等卧': 'J',
        '软座': '2', '硬座': '1', '无座': '1'
    };
    // 无座在 checkOrderInfo 要传 'WZ'（服务端认这个码）；但它只在这一步有效，
    // 到 getQueueCount / confirmSingleForQueue 必须换成硬座/二等座的码（官方 m()+aP() 规则）。
    function orderSeatCode(seatName) {
        if (seatName === '无座') return 'WZ';
        return SEAT_TYPE_CODE[seatName] || 'O';
    }
    // 卧铺列随车型变：rw_num 可能是软卧(4)也可能是一等卧(I)，yw_num 同理。
    // 判据用 seat_types（响应第 35 段）——它是"这趟车实际有哪些席别码"的权威列表。
    function resolveOrderSeatCode(trainInfo, seatName) {
        const berthCodes = { '软卧': ['I', '4'], '一等卧': ['I', '4'], '硬卧': ['J', '3'], '二等卧': ['J', '3'] };
        const want = berthCodes[seatName];
        if (!want) return orderSeatCode(seatName);
        const st = String((trainInfo && trainInfo.seatTypes) || '');
        for (const c of want) if (st.indexOf(c) !== -1) return c;
        return want[want.length - 1];
    }
    function hasSeatType(stockStr) { return !!stockStr && stockStr !== '--'; }
    function hasTicketStock(stockStr) {
        if (!stockStr) return false;
        const s0 = String(stockStr).trim();
        if (s0 === '有' || s0 === '是' || s0 === 'Y') return true;
        if (s0 === '无' || s0 === '--' || s0 === '-' || s0 === '' || s0 === '0' || s0 === 'N') return false;
        const num = parseInt(s0, 10);
        return !isNaN(num) && num > 0;
    }
    function leftTicketHasSeat(leftTicketStr, code) {
        const s = String(leftTicketStr || '');
        if (!s || !code) return false;
        for (let i = 0; i + 10 <= s.length; i += 10) if (s.charAt(i) === code) return true;
        return false;
    }
    const WUZUO_SEAT_CHAIN = [
        { name: '硬座', code: '1' }, { name: '二等座', code: 'O' }, { name: '硬卧', code: '3' },
        { name: '一等座', code: 'M' }, { name: '软座', code: '2' }, { name: '软卧', code: '4' },
        { name: '特等座', code: 'P' }, { name: '高级软卧', code: '6' }, { name: '商务座', code: '9' }
    ];
    function wuzuoOrderSeatCode(trainInfo, leftTicketStr) {
        const t = (trainInfo && trainInfo.tickets) || null;
        for (const s of WUZUO_SEAT_CHAIN) if (t && hasTicketStock(t[s.name])) return { code: s.code, name: s.name, from: `查票-${s.name}有票` };
        for (const s of WUZUO_SEAT_CHAIN) if (t && hasSeatType(t[s.name])) return { code: s.code, name: s.name, from: `查票-${s.name}席别存在` };
        for (const s of WUZUO_SEAT_CHAIN) if (leftTicketHasSeat(leftTicketStr, s.code)) return { code: s.code, name: s.name, from: `余票串-${s.name}席别存在` };
        return null;
    }
    // 中转查询接口返回的余票字段名（JSON 键），实测自 /lcquery/queryG 的 fullList
    const SEAT_NUM_FIELD = {
        '商务座': 'swz_num', '特等座': 'tz_num', '一等座': 'zy_num', '优选一等座': 'gg_num', '二等座': 'ze_num',
        '高级软卧': 'gr_num', '软卧': 'rw_num', '一等卧': 'rw_num',
        '硬卧': 'yw_num', '二等卧': 'yw_num', '软座': 'rz_num', '硬座': 'yz_num', '无座': 'wz_num'
    };
    function purposeCodesFor(passengers) {        return passengers.some(p => p.isStudent === true) ? '0X00' : 'ADULT';
    }
    function orderPurposeCodesFor(passengers) {
        return passengers.some(p => p.isStudent === true) ? '0X00' : '00';
    }
    // 从查价接口的返回里取出某个席别的票价。
    // 实测（2026-10）：**同一个响应里两种格式并存**——
    //   二等座/一等座/无座这类给的是带 ¥ 的成品串： "O":"¥57.0"
    //   商务座/卧铺/硬座这类给的是**角**的裸数字：   "9":"1990"（¥199）、"1":"235"（¥23.5）
    // 所以不能统一除 10，要先看有没有 ¥。
    function priceOfSeat(priceData, seatCode) {
        if (!priceData || !seatCode) return '';
        const raw = priceData[seatCode];
        if (raw === undefined || raw === null || raw === '') return '';
        const s = String(raw).trim();
        if (!s) return '';
        const trim = v => v.replace(/\.0+$/, '');
        if (s.charAt(0) === '\u00a5' || s.charAt(0) === '¥') return trim(s);
        const n = Number(s);
        if (!isFinite(n) || n <= 0) return '';
        return '\u00a5' + trim((n / 10).toFixed(1));
    }

    // --------------------------------------------------------------------------
    // 静音车厢（dw_flag 第 3 段以 Q 打头；12306 只对二等座开放）
    // --------------------------------------------------------------------------
    function supportsSilentCar(trainInfo) {
        if (!trainInfo || !trainInfo.dwFlag) return false;
        const seg = String(trainInfo.dwFlag).split('#');
        return seg.length > 2 && String(seg[2]).substring(0, 1) === 'Q';
    }
    function silentCarsOf(trainInfo) {
        if (!supportsSilentCar(trainInfo)) return [];
        const tail = String(trainInfo.dwFlag).split('#')[2].substring(1);
        const cars = [];
        for (let i = 0; i + 2 <= tail.length; i += 2) cars.push(tail.slice(i, i + 2));
        return cars;
    }
    function silentCarUsable(trainInfo, want, seatCode) {
        if (!want) return { usable: false, reason: '没勾「优选静音车厢」' };
        if (!supportsSilentCar(trainInfo)) return { usable: false, reason: '这趟车没有静音车厢' };
        if (seatCode !== 'O') return { usable: false, reason: `静音车厢 12306 只对二等座开放，这一单买的是「${(trainInfo && trainInfo.seatName) || seatCode}」` };
        const cars = silentCarsOf(trainInfo);
        return { usable: true, reason: cars.length ? `静音车厢在 ${cars.map(c => c + '车').join('、')}` : '这趟车有静音车厢' };
    }

    // --------------------------------------------------------------------------
    // 选座：只有二等座和一等座给选（字母集公开稳定）。
    // 商务座 / 优选一等座在不同车型上排布不一样（1+2 还是 1+1 都可能），
    // 字母集对不上；而 choose_seats 一旦发错，12306 会把整单判成非法参数，
    // 比"不选座"严重得多，所以干脆不给。
    // --------------------------------------------------------------------------
    const SEAT_LAYOUT = {
        '二等座': {
            left: [['A', '靠窗'], ['B', '中间'], ['C', '靠过道']],
            right: [['D', '靠过道'], ['F', '靠窗']],
            win: ['A', 'F'], aisle: ['C', 'D'], together: { 2: ['D', 'F'], 3: ['A', 'B', 'C'] }
        },
        '一等座': {
            left: [['A', '靠窗'], ['C', '靠过道']],
            right: [['D', '靠过道'], ['F', '靠窗']],
            win: ['A', 'F'], aisle: ['C', 'D'], together: { 2: ['A', 'C'] }
        }
    };
    const SEAT_PICKABLE = Object.keys(SEAT_LAYOUT);
    // 用户在图上的点选（字母数组）→ choose_seats 参数。
    // 格式：每 2 个字符一组，第一位是排号、第二位是字母（1A1F = 第一排 A + 第一排 F）。
    // 多人且同一排字母不够时自动跨排（3 人靠窗 → 1A1F2A）。
    function buildChooseSeatsFromLetters(letters, paxCount) {
        const list = (Array.isArray(letters) ? letters : [])
            .filter(s => typeof s === 'string' && /^[ABCDF]$/.test(s));
        if (!list.length || list.length !== paxCount) return '';
        return list.map(s => `1${s}`).join('');
    }
    function buildChooseSeatsFromPref(pref, seatType, paxCount) {
        const L = SEAT_LAYOUT[seatType];
        if (!L || !paxCount || pref === 'any') return { code: '', letters: [] };
        let pool;
        if (pref === 'win') pool = L.win;
        else if (pref === 'aisle') pool = L.aisle;
        else pool = L.together[paxCount] || L.together[2] || L.win;
        if (!pool || !pool.length) return { code: '', letters: [] };
        let code = '';
        const uniq = [];
        for (let i = 0; i < paxCount; i++) {
            code += (1 + Math.floor(i / pool.length)) + pool[i % pool.length];
            if (uniq.indexOf(pool[i % pool.length]) < 0) uniq.push(pool[i % pool.length]);
        }
        return { code, letters: uniq };
    }

    // --------------------------------------------------------------------------
    // 日期 / 时间小工具
    // --------------------------------------------------------------------------
    function pad2(n) { return String(n).padStart(2, '0'); }
    function shiftDate(isoDate, days) {
        const d = new Date(`${isoDate}T00:00:00`);
        d.setDate(d.getDate() + days);
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }
    function hhmmToMinutes(t) {
        const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return null;
        const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
        if (h > 24 || mi > 59) return null;
        return h * 60 + mi;
    }
    // sale_time 是 12 位 YYYYMMDDHHMM：该票的「起售日期 + 时刻」
    function parseSaleTime(raw) {
        const s = String(raw || '').trim();
        if (!/^\d{12}$/.test(s)) return null;
        const y = s.slice(0, 4), mo = s.slice(4, 6), d = s.slice(6, 8);
        const h = s.slice(8, 10), mi = s.slice(10, 12);
        const nM = parseInt(mo, 10), nD = parseInt(d, 10), nH = parseInt(h, 10), nMi = parseInt(mi, 10);
        if (nM < 1 || nM > 12 || nD < 1 || nD > 31 || nH > 23 || nMi > 59) return null;
        return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
    }
    function inDepartRange(startTime, from, to) {
        const lo = hhmmToMinutes(from);
        const hiRaw = hhmmToMinutes(to);
        if (lo === null && hiRaw === null) return true;
        const t = hhmmToMinutes(startTime);
        if (t === null) return true;
        const a = (lo === null) ? 0 : lo;
        const b = (hiRaw === null || hiRaw >= 1440) ? 1440 : hiRaw;
        return t >= a && t <= b;
    }

    // --------------------------------------------------------------------------
    // 服务器时间校准
    // --------------------------------------------------------------------------
    let serverClockOffset = null;
    const HTTP_DATE_RE = /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
    const MAX_CLOCK_SKEW_MS = 12 * 3600 * 1000;
    function noteServerTime(dateHeader, sentAt, receivedAt) {
        if (!dateHeader || !HTTP_DATE_RE.test(dateHeader)) return;
        const rtt = receivedAt - sentAt;
        if (rtt < 0 || rtt > 3000) return;
        const serverMs = new Date(dateHeader).getTime();
        if (isNaN(serverMs)) return;
        const sample = serverMs - Math.round((sentAt + receivedAt) / 2);
        if (Math.abs(sample) > MAX_CLOCK_SKEW_MS) return;
        if (serverClockOffset === null || sample > serverClockOffset) serverClockOffset = sample;
    }
    function serverNow() { return new Date(Date.now() + (serverClockOffset || 0)); }
    function serverTodayIso() {
        const d = serverNow();
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }
    // FYI：服务器时钟偏移量是"服务器 - 本地"，把本地时间戳换算成服务器时刻用它。
    function localTsOfServer(hms) {
        const [h, m, s] = String(hms).split(':').map(Number);
        const t = new Date(serverNow());
        t.setHours(h || 0, m || 0, s || 0, 0);
        return t.getTime() - (serverClockOffset || 0);
    }
    // 把内部时间戳换成"给人看的服务器时刻"。
    // 为什么必须这样：起售时刻（14:45 这种）是**服务器**的时间，
    // 而本地时钟可能和服务器差几十秒。如果这里按本地时间显示，
    // 同一件事就会出现"卡片写 14:45、提示写 14:44"的鬼现象 —— 内部逻辑其实是对的，
    // 但看起来像算错了。所有对外显示的时刻一律走这两个函数。
    function fmtClock(ts) {
        const d = new Date(ts + (serverClockOffset || 0));
        return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }
    function fmtClockDate(ts) {
        const d = new Date(ts + (serverClockOffset || 0));
        return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }
    // 把「起售日期 + 时刻」换算成本地时间戳；已经过去就顺延一天（跨日场景）
    function saleTsOf(dateIso, timeHm) {
        let ts = localTsOfServer(`${timeHm}:00`);
        const today = serverTodayIso();
        if (dateIso && dateIso > today) {
            // 起售日在未来：用日期差值补天数
            const a = new Date(`${today}T00:00:00`).getTime();
            const b = new Date(`${dateIso}T00:00:00`).getTime();
            const days = Math.round((b - a) / 86400000);
            ts += days * 86400000;
        } else if (ts <= Date.now()) {
            // 起售日就是今天（或没给日期）且时刻已过 —— 保持原值，让调用方判断为"已开售"
        }
        return ts;
    }

    // ==========================================================================
    // 配置
    // ==========================================================================
    const CONFIG_KEY = 'grab_config_pro_v3';
    const DEFAULT_CONFIG = {
        trainDates: [],          // 主日期 + 备选日期（ISO），第一个是主日期
        reserveDate: '',         // 预约：预售期外的出行日期（ISO）
        reserveAt: '',           // 预约的开火时刻 HH:MM；留空则用记住的起售时刻推算
        fromStation: '上海', toStation: '杭州',
        fromCode: '', toCode: '',
        trainCodes: [],          // 车次过滤，留空 = 不限
        seatTypes: ['ze', 'zy'], // 数组顺序 = 优先顺序（面板上按点击顺序写）
        seatPref: 'any',         // win / aisle / together / any
        seatLetters: [],         // 图上直接点的字母
        passengers: [],
        passengerDetails: {},
        altToStation: '', altToCode: '',   // 买长乘短
        altToStationEnabled: true,         // 高级里那个"备选到达站"开关
        acceptSameCity: false,
        departFrom: '', departTo: '',
        waitMinutes: 10,
        waitlistEnabled: true,
        alarmEnabled: true,
        soundAlert: true,
        keepAwake: true,         // 接力期间保持唤醒
        silentCar: false,
        relayWarnOff: false,
        // ★ 起售时刻按**乘车站**记，一个站一个值：{ '杭州东': '10:45', '上海虹桥': '13:45' }
        //   以前只存单个值 —— 你一换出发站，旧站的时刻还留着，预约会按错误的时刻开火。
        //   晚几小时 = 必然错过，而且界面上看不出来。
        saleTimes: {},
        reserveAtFor: ''         // 手填的开火时刻是给哪个出发站填的（换站时要提醒）
    };
    function loadConfig() {
        const saved = GM_getValue(CONFIG_KEY, null);
        if (saved) {
            if (!saved.passengerDetails) saved.passengerDetails = {};
            return Object.assign({}, DEFAULT_CONFIG, saved);
        }
        return Object.assign({}, DEFAULT_CONFIG);
    }
    function saveConfig(c2) {
        try { GM_setValue(CONFIG_KEY, c2); } catch (e) { /* 忽略 */ }
    }
    let cfg = loadConfig();

    // 方案列表的勾选 / 删除 / 顺序（跨刷新保留）
    const PLAN_STATE_KEY = 'grab_plan_state';
    function loadPlanState() {
        try {
            const raw = GM_getValue(PLAN_STATE_KEY, '');
            if (!raw) return { order: [], unsel: {}, removed: {} };
            const o = JSON.parse(raw);
            return {
                order: Array.isArray(o.order) ? o.order : [],
                unsel: o.unsel || {},
                removed: o.removed || {}
            };
        } catch (e) { return { order: [], unsel: {}, removed: {} }; }
    }
    function savePlanState(st) {
        try { GM_setValue(PLAN_STATE_KEY, JSON.stringify(st)); } catch (e) { /* 忽略 */ }
    }

    const SEAT_MAP_UI = {
        swz: { name: '商务/特等' }, zy: { name: '一等座' }, yy: { name: '优选一等座' }, ze: { name: '二等座' },
        gr: { name: '高级软卧' }, rw: { name: '软卧/一等卧' }, yw: { name: '硬卧/二等卧' },
        rz: { name: '软座' }, yz: { name: '硬座' }, wz: { name: '无座' }
    };

    // ==========================================================================
    // 站点简码
    // ==========================================================================
    let stationMap = {};
    let stationNameByCode = null;
    async function fetchStationMap(retries = 3) {
        for (let i = 0; i < retries; i++) {
            try {
                tlog('log', `正在获取站点简码表 (尝试 ${i + 1}/${retries})...`);
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);
                const response = await httpFetch(`${BASE_URL}/otn/resources/js/framework/station_name.js`, { signal: controller.signal }, 10000);
                clearTimeout(timeoutId);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const text = await response.text();
                const start = text.indexOf("'");
                const end = text.lastIndexOf("'");
                if (start > -1 && end > -1) {
                    const data = text.substring(start + 1, end);
                    data.split('@').forEach(part => {
                        if (!part) return;
                        const fields = part.split('|');
                        if (fields.length >= 3) stationMap[fields[1]] = fields[2];
                    });
                    tlog('log', `站点简码表加载完成，共 ${Object.keys(stationMap).length} 个站点`);
                    return true;
                }
                throw new Error('解析站点数据失败');
            } catch (e) {
                tlog('warn', `获取站点简码表失败 (尝试 ${i + 1}):`, e.message);
                if (i === retries - 1) return false;
                await new Promise(r => setTimeout(r, 3000 * (i + 1)));
            }
        }
        return false;
    }
    function stationNameOf(code) {
        const c = String(code || '').trim();
        if (!c) return '';
        if (!stationNameByCode) {
            stationNameByCode = {};
            for (const name of Object.keys(stationMap)) {
                if (!stationNameByCode[stationMap[name]]) stationNameByCode[stationMap[name]] = name;
            }
        }
        return stationNameByCode[c] || c;
    }

    // ==========================================================================
    // NetworkModule
    // ==========================================================================
    const NetworkModule = (() => {
        async function request(url, options = {}, timeout = 15000) {
            const pageReferer = (typeof location !== 'undefined' && location.href) || `${BASE_URL}/otn/leftTicket/init`;
            const defaultOptions = {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': pageReferer,
                    'Host': 'kyfw.12306.cn',
                    'Origin': BASE_URL
                }
            };
            const finalOptions = Object.assign({}, defaultOptions, options);
            if (options.headers) finalOptions.headers = Object.assign({}, defaultOptions.headers, options.headers);
            const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);
            finalOptions.signal = controller.signal;
            const sentAt = Date.now();
            try {
                const response = await httpFetch(fullUrl, finalOptions, timeout);
                const receivedAt = Date.now();
                clearTimeout(timeoutId);
                noteServerTime(response.headers.get('date'), sentAt, receivedAt);
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                const contentType = response.headers.get('content-type');
                if (contentType && contentType.includes('application/json')) return await response.json();
                const text = await response.text();
                try { return JSON.parse(text); }
                catch (e) { return { status: false, messages: ['Response is not JSON', text.substring(0, 200)] }; }
            } catch (error) {
                clearTimeout(timeoutId);
                if (error.name === 'AbortError') throw new Error('Request timeout');
                tlog('error', `[Network] Request failed after ${Date.now() - sentAt}ms: ${error.message} @ ${url}`);
                throw error;
            }
        }

        return {
            async checkLoginStatus() {
                const data = await request('/otn/login/checkUser', { method: 'POST', body: '_json_att=' }, 10000);
                return !!(data && data.data && data.data.flag === true);
            },
            async queryTickets(trainDate, fromStation, toStation, purposeCodes = 'ADULT', timeout = QUERY_TIMEOUT_MS) {
                const params = new URLSearchParams({
                    'leftTicketDTO.train_date': trainDate,
                    'leftTicketDTO.from_station': fromStation,
                    'leftTicketDTO.to_station': toStation,
                    'purpose_codes': purposeCodes
                });
                const res = await request(`${QUERY_URL}?${params.toString()}`, {}, timeout);
                if (res && res.c_url) {
                    const cUrl = String(res.c_url).replace(/^\/+/, '');
                    const next = cUrl.startsWith('otn/') ? `/${cUrl}` : `/otn/${cUrl}`;
                    if (next !== QUERY_URL) {
                        tlog('log', `[Query] 12306 告知查票接口已轮换: ${QUERY_URL} -> ${next}`);
                        rememberQueryUrl(next);
                        return request(`${QUERY_URL}?${params.toString()}`, {}, timeout);
                    }
                }
                return res;
            },
            async submitOrderRequest(secretStr, trainDate, backTrainDate, fromStationName, toStationName, purposeCodes = 'ADULT') {
                const body = new URLSearchParams({
                    'secretStr': decodeURIComponent(secretStr),
                    'train_date': trainDate,
                    'back_train_date': backTrainDate,
                    'tour_flag': 'dc',
                    'purpose_codes': purposeCodes,
                    'query_from_station_name': fromStationName,
                    'query_to_station_name': toStationName,
                    'undefined': ''
                });
                return request('/otn/leftTicket/submitOrderRequest', { method: 'POST', body });
            },
            async getInitDcPage() {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);
                try {
                    const response = await httpFetch(`${BASE_URL}/otn/confirmPassenger/initDc`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: '_json_att=',
                        signal: controller.signal
                    }, 15000);
                    if (!response.ok) throw new Error(`initDc HTTP ${response.status}`);
                    return await response.text();
                } finally { clearTimeout(timeoutId); }
            },
            async getPassengerDTOs() {
                return request('/otn/confirmPassenger/getPassengerDTOs', { method: 'POST', body: '_json_att=' });
            },
            // 中转查询（不需要登录）。路径在 /lcquery/ 下，不在 /otn/ 下。
            async queryTransfer(trainDate, fromCode, toCode, middleCode = '') {
                const params = new URLSearchParams({
                    train_date: trainDate,
                    from_station_telecode: fromCode,
                    to_station_telecode: toCode,
                    middle_station: middleCode,
                    result_index: '0',
                    can_query: 'Y',
                    isShowWZ: 'Y',
                    purpose_codes: '00',
                    channel: 'E'
                });
                return request(`${lcSearchUrl()}?${params.toString()}`, {}, QUERY_TIMEOUT_MS);
            },
            // 经停站核对（买长乘短专用）。
            // 为什么必须核对：买长乘短买的是一张更远的票，但你得在中途的站下车。
            // 如果这趟车根本不经过那一站（比如杭州东→龙岩的车走的是沿海线，不经过瑞金），
            // 票就白买了。查票接口只给起终站，不给经停站，所以只能单独查一次。
            // 拿不到就返回 null，调用方按"放行 + 日志警告"处理——不让它成为硬依赖。
            async queryTrainStops(trainNo, fromCode, toCode, departDate) {
                const params = new URLSearchParams({
                    train_no: trainNo,
                    from_station_telecode: fromCode,
                    to_station_telecode: toCode,
                    depart_date: departDate
                });
                try {
                    const res = await request(`/otn/czxx/queryByTrainNo?${params.toString()}`, {}, 8000);
                    const list = res && res.data && res.data.data;
                    if (!Array.isArray(list)) return null;
                    return list.map(s => s.station_name || '').filter(Boolean);
                } catch (e) {
                    tlog('warn', `[Stops] 经停站查询失败（不影响抢票，只是没法核对）：${e.message}`);
                    return null;
                }
            },
            // 查票价（每趟车一次请求，所以只在下单前查）
            // 返回形如： {"1":"235","3":"695","WZ":"¥23.5","A1":"¥23.5",...}
            // 注意两种格式：席别码（"1"/"O"/"M"…）给的是**角**的裸数字（235 = ¥23.5），
            // 无座和 A 开头那组给的是带 ¥ 的成品字符串。
            async queryTicketPrice(trainNo, fromStationNo, toStationNo, seatTypes, trainDate) {
                const params = new URLSearchParams({
                    train_no: trainNo,
                    from_station_no: fromStationNo,
                    to_station_no: toStationNo,
                    seat_types: seatTypes || '',
                    train_date: trainDate
                });
                return request(`/otn/leftTicket/queryTicketPrice?${params.toString()}`, {}, 8000);
            },
            // 提交候补订单（来自 12306 自己的 queryLeftTicket_end_js.js bg 函数）
            async submitWaitlist(secretList) {
                return request('/otn/afterNate/submitOrderRequest', {
                    method: 'POST',
                    body: new URLSearchParams({ secretList })
                }, 15000);
            },
            async checkOrderInfo(passengerTicketStr, oldPassengerStr, tourFlag = 'dc', token) {
                const body = new URLSearchParams({
                    'cancel_flag': '2',
                    'bed_level_order_num': '000000000000000000000000000000',
                    'passengerTicketStr': passengerTicketStr,
                    'oldPassengerStr': oldPassengerStr,
                    'tour_flag': tourFlag,
                    'randCode': '',
                    'whatsSelect': '1',
                    'sessionId': '',
                    'sig': '',
                    'scene': 'nc_login',
                    '_json_att': '',
                    'REPEAT_SUBMIT_TOKEN': token
                });
                return request('/otn/confirmPassenger/checkOrderInfo', { method: 'POST', body });
            },
            async getQueueCount(trainDate, trainNo, stationTrainCode, seatType, fromStationTelecode, toStationTelecode, token, leftTicketStr = '', trainLocation = '', purposeCodes = '00') {
                const body = new URLSearchParams({
                    'train_date': new Date(trainDate).toString(),
                    'train_no': trainNo,
                    'stationTrainCode': stationTrainCode,
                    'seatType': seatType,
                    'fromStationTelecode': fromStationTelecode,
                    'toStationTelecode': toStationTelecode,
                    'leftTicket': leftTicketStr,
                    'purpose_codes': purposeCodes,
                    'train_location': trainLocation,
                    '_json_att': '',
                    'REPEAT_SUBMIT_TOKEN': token
                });
                return request('/otn/confirmPassenger/getQueueCount', { method: 'POST', body });
            },
            async confirmSingleForQueue(passengerTicketStr, oldPassengerStr, keyCheckIsChange, token, leftTicketStr, trainLocation, chooseSeats = '', purposeCodes = '00', isJy = 'N') {
                const body = new URLSearchParams({
                    'passengerTicketStr': passengerTicketStr,
                    'oldPassengerStr': oldPassengerStr,
                    'purpose_codes': purposeCodes,
                    'key_check_isChange': keyCheckIsChange,
                    'leftTicketStr': leftTicketStr,
                    'train_location': trainLocation,
                    'choose_seats': chooseSeats,
                    'seatDetailType': '000',
                    'is_jy': isJy,
                    'is_cj': 'Y',
                    'encryptedData': '',
                    'whatsSelect': '1',
                    'roomType': '00',
                    'dwAll': 'N',
                    '_json_att': '',
                    'REPEAT_SUBMIT_TOKEN': token
                });
                return request('/otn/confirmPassenger/confirmSingleForQueue', { method: 'POST', body });
            }
        };
    })();

    function lcSearchUrl() {
        return GM_getValue('lc_search_url', '') || '/lcquery/queryG';
    }
    function sniffLcSearchUrl() {
        let found = '';
        try { if (typeof window.lc_search_url === 'string') found = window.lc_search_url; } catch (e) { /* 忽略 */ }
        try {
            if (!found && typeof unsafeWindow !== 'undefined' && unsafeWindow && typeof unsafeWindow.lc_search_url === 'string') {
                found = unsafeWindow.lc_search_url;
            }
        } catch (e) { /* 忽略 */ }
        if (found && found !== GM_getValue('lc_search_url', '')) {
            GM_setValue('lc_search_url', found);
            tlog('log', `[LC] 中转查询接口地址已更新: ${found}`);
            return true;
        }
        return false;
    }

    // ==========================================================================
    // TicketLogicModule
    // ==========================================================================
    const TicketLogicModule = (() => {
        function toIsoDate(raw) {
            const s = String(raw || '').trim();
            return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
        }
        function parseTrainInfo(rawString) {
            if (!rawString) return null;
            const parts = rawString.split('|');
            if (parts.length < 33) return null;
            return {
                secretStr: parts[0], status: parts[1], trainNo: parts[2], trainCode: parts[3],
                fromStation: parts[6], toStation: parts[7], startTime: parts[8], endTime: parts[9],
                duration: parts[10], canBuy: parts[11], leftTicket: parts[12],
                trainDate: toIsoDate(parts[13]), trainLocation: parts[15],
                // 站序：查价接口必须要这两个（同一趟车在不同区间价格不同）
                fromStationNo: parts[16] || '', toStationNo: parts[17] || '',
                houbuSeatLimit: parts[38] || '', houbuEnabled: parts[37] === '1',
                saleTime: parts[55] || '', seatTypes: parts[35] || '', dwFlag: parts[46] || '',
                tickets: {
                    '商务座': parts[32] || '', '特等座': parts[25] || '', '一等座': parts[31] || '',
                    '二等座': parts[30] || '', '优选一等座': parts[20] || '',
                    '软卧': parts[23] || '', '一等卧': parts[23] || '',
                    '硬卧': parts[28] || '', '二等卧': parts[28] || '',
                    '软座': parts[24] || '', '硬座': parts[29] || '', '无座': parts[26] || ''
                },
                raw: rawString
            };
        }
        function hasTicket(stockStr) { return hasTicketStock(stockStr); }

        const SEAT_NAME_CANDIDATES = {
            swz: ['商务座', '特等座'], zy: ['一等座'], yy: ['优选一等座'], ze: ['二等座'],
            gr: ['高级软卧'], rw: ['软卧', '一等卧'], yw: ['硬卧', '二等卧'],
            rz: ['软座'], yz: ['硬座'], wz: ['无座']
        };
        const SEAT_NAME_ALIAS = { '一等卧': '软卧', '二等卧': '硬卧' };
        function getSeatNamesByCode(code) { return SEAT_NAME_CANDIDATES[code] || ['二等座']; }

        function explainNotBuyable(info) {
            if (info.canBuy === 'IS_TIME_NOT_BUY') return '未到起售时间';
            const st = parseSaleTime(info.saleTime);
            if (!st) return `当前不可预订(canWebBuy=${info.canBuy})——12306 这次没返回起售时间，多半是本次不放票`;
            const when = `${st.date} ${st.time}`;
            const today = serverTodayIso();
            if (st.date > today) return `未到起售时间（${when} 开售）`;
            if (st.date < today) return `已过起售时间且不可预订（起售时间 ${when}，多半已售完）`;
            const now = serverNow();
            const cur = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
            return cur < st.time ? `未到起售时间（${when} 开售）` : `已过起售时间且不可预订（起售时间 ${when}，多半已售完）`;
        }

        function explainMiss(resultList, targetTrainCode, targetSeats = ['二等座'], departFrom = '', departTo = '') {
            if (!Array.isArray(resultList)) return '查票结果格式异常';
            const code = String(targetTrainCode || '').trim().toUpperCase();
            if (!code) return explainMissAny(resultList, targetSeats, departFrom, departTo);
            const same = [];
            for (const rawStr of resultList) {
                const info = parseTrainInfo(rawStr);
                if (info && info.trainCode.toUpperCase() === code) same.push(info);
            }
            if (!same.length) return `${targetTrainCode} 不在本次查票结果中`;
            const detailOf = info => targetSeats.map(sc => {
                const names = getSeatNamesByCode(sc);
                return `${names.join('/')}=${names.map(n => info.tickets[n] || '--').join('/')}`;
            }).join(' ');
            const hasAny = info => targetSeats.some(sc => getSeatNamesByCode(sc).some(n => hasTicket(info.tickets[n])));
            const withTicket = same.find(info => info.canBuy === 'Y' && hasAny(info));
            if (withTicket) {
                if (!inDepartRange(withTicket.startTime, departFrom, departTo)) {
                    return `${withTicket.trainCode}(${withTicket.startTime}) 有票但发车时间不在筛选范围内`;
                }
                return `${withTicket.trainCode} 这趟有票 [${detailOf(withTicket)}]，但它的乘车区间是 `
                    + `${stationNameOf(withTicket.fromStation)}→${stationNameOf(withTicket.toStation)}，`
                    + `和你填的不是同一个站，按默认设置跳过了`;
            }
            const info = same[0];
            if (info.canBuy !== 'Y') return `${info.trainCode} ${explainNotBuyable(info)}`;
            if (!inDepartRange(info.startTime, departFrom, departTo)) return `${info.trainCode}(${info.startTime}) 发车时间不在筛选范围内`;
            return `${info.trainCode} 可预订但无票 [${detailOf(info)}]`;
        }
        function explainMissAny(resultList, targetSeats, departFrom, departTo) {
            if (!resultList.length) return '本次查票结果为空';
            let buyable = 0, inRange = 0, withTicket = 0;
            for (const rawStr of resultList) {
                const info = parseTrainInfo(rawStr);
                if (!info || info.canBuy !== 'Y') continue;
                buyable++;
                if (!inDepartRange(info.startTime, departFrom, departTo)) continue;
                inRange++;
                if (targetSeats.some(sc => getSeatNamesByCode(sc).some(n => hasTicket(info.tickets[n])))) withTicket++;
            }
            if (buyable === 0) return '所有车次都未到起售时间或当前不可预订';
            if (inRange === 0) return `没有任何车次的发车时间落在 ${departFrom || '00:00'}~${departTo || '24:00'} 内`;
            if (withTicket > 0) return `共 ${inRange} 趟可订车次，其中 ${withTicket} 趟你要的席别有票（多半是乘车区间不符被跳过了）`;
            return `共 ${inRange} 趟可订车次，但所选席别都没有余票`;
        }
        function summarizeMiss(resultList, trainCodes, targetSeats, departFrom = '', departTo = '') {
            const list = (trainCodes && trainCodes.length) ? trainCodes : [''];
            const msgs = list.map(c => explainMiss(resultList, c, targetSeats, departFrom, departTo));
            if (list.length === 1) return msgs[0];
            const reasonOf = m => String(m).replace(/^[^\s(]+(\([^)]*\))?\s*/, '').trim();
            const reasons = msgs.map(reasonOf);
            const distinct = reasons.filter((v, i, a) => a.indexOf(v) === i);
            if (distinct.length === 1) return `${list.length} 趟车情况相同：${distinct[0]}`;
            return `共 ${list.length} 趟车，情况如下：${msgs.join('；')}`;
        }

        const HB_MAX_COMBOS = 5;
        function buildWaitlistSecretList(resultList, trainCodes, targetSeats, departFrom = '', departTo = '', maxCombos = HB_MAX_COMBOS) {
            if (!Array.isArray(resultList)) return { secretList: '', combos: [] };
            const codes = (trainCodes && trainCodes.length) ? trainCodes.map(c => String(c).trim().toUpperCase()) : null;
            const combos = [];
            for (const rawStr of resultList) {
                if (combos.length >= maxCombos) break;
                const info = parseTrainInfo(rawStr);
                if (!info) continue;
                if (codes && codes.indexOf(info.trainCode.toUpperCase()) === -1) continue;
                if (info.canBuy !== 'Y') continue;
                if (!info.secretStr) continue;
                if (!inDepartRange(info.startTime, departFrom, departTo)) continue;
                for (const seatCode of targetSeats) {
                    if (combos.length >= maxCombos) break;
                    const groups = [];
                    for (const n of getSeatNamesByCode(seatCode)) {
                        const canon = SEAT_NAME_ALIAS[n] || n;
                        let g = groups.find(x => x.canon === canon);
                        if (!g) { g = { canon, names: [] }; groups.push(g); }
                        g.names.push(n);
                    }
                    for (const g of groups) {
                        if (combos.length >= maxCombos) break;
                        const valid = g.names.filter(n => hasSeatType(info.tickets[n]));
                        if (!valid.length) continue;
                        const seatName = valid.find(n => info.seatTypes && info.seatTypes.indexOf(SEAT_TYPE_CODE[n]) !== -1) || valid[0];
                        const hbSeatCode = SEAT_TYPE_CODE[seatName];
                        if (!hbSeatCode) continue;
                        if (info.houbuSeatLimit && info.houbuSeatLimit.indexOf(hbSeatCode) > -1) continue;
                        combos.push({ trainCode: info.trainCode, startTime: info.startTime, seatName, seatCode: hbSeatCode, secretStr: info.secretStr });
                    }
                }
            }
            return { secretList: combos.map(c => `${c.secretStr}#${c.seatCode}|`).join(''), combos };
        }

        return {
            parseTrainInfo, hasTicket, getSeatNamesByCode, explainMiss, summarizeMiss,
            buildWaitlistSecretList, explainNotBuyable,

            // 在查票结果里找一趟"可下单"的车。
            // targetTrainCode 留空 = 不限车次；stationExpect 校验乘车区间（默认严格，
            // 因为 12306 会把同城其它车站的车次一起返回，那些车你上不了）。
            findTargetTrain(resultList, targetTrainCode, targetSeats = ['二等座'], departFrom = '', departTo = '', stationExpect = null, stats = null) {
                if (!resultList || !Array.isArray(resultList)) return null;
                const code = String(targetTrainCode || '').trim().toUpperCase();
                const wantFrom = String((stationExpect && stationExpect.from) || '').trim();
                const wantTo = String((stationExpect && stationExpect.to) || '').trim();
                const acceptSameCity = !!(stationExpect && stationExpect.acceptSameCity);
                const checkStation = !!(wantFrom || wantTo);
                let fallback = null;
                const hits = [];
                for (const rawStr of resultList) {
                    const info = parseTrainInfo(rawStr);
                    if (!info) continue;
                    if (code && info.trainCode.toUpperCase() !== code) continue;
                    if (info.canBuy !== 'Y') continue;
                    if (!inDepartRange(info.startTime, departFrom, departTo)) continue;
                    for (const seatCode of targetSeats) {
                        let seatName = null;
                        for (const name of getSeatNamesByCode(seatCode)) {
                            if (hasTicket(info.tickets[name])) { seatName = name; break; }
                        }
                        if (!seatName) continue;
                        const hit = {
                            secretStr: info.secretStr, trainDate: info.trainDate, trainNo: info.trainNo,
                            trainCode: info.trainCode, fromStation: info.fromStation, toStation: info.toStation,
                            startTime: info.startTime, endTime: info.endTime,
                            seatName, seatCode,
                            leftTicket: info.leftTicket, trainLocation: info.trainLocation,
                            tickets: info.tickets, seatTypes: info.seatTypes, dwFlag: info.dwFlag,
                            saleTime: info.saleTime, raw: info.raw
                        };
                        if (!checkStation) return hit;
                        const okFrom = !wantFrom || info.fromStation === wantFrom;
                        const okTo = !wantTo || info.toStation === wantTo;
                        if (okFrom && okTo) hits.push(hit);
                        else {
                            if (stats) {
                                stats.skipCount = (stats.skipCount || 0) + 1;
                                if (!stats.skipSample) {
                                    stats.skipSample = {
                                        trainCode: info.trainCode, fromStation: info.fromStation,
                                        toStation: info.toStation, seatName, startTime: info.startTime
                                    };
                                }
                            }
                            if (acceptSameCity && !fallback) {
                                fallback = Object.assign({}, hit, { stationMismatch: true, expectFrom: wantFrom, expectTo: wantTo });
                            }
                        }
                        break;
                    }
                }
                if (hits.length) {
                    // 同一区间有票时按发车时间早的优先（用户要的是"能走就行"）
                    hits.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
                    return hits[0];
                }
                return fallback;
            },

            // 读出目标车次的起售时刻
            readSaleTimes(resultList, trainCodes, departFrom = '', departTo = '') {
                if (!Array.isArray(resultList)) return [];
                const codes = (trainCodes && trainCodes.length) ? trainCodes.map(c => String(c).trim().toUpperCase()) : null;
                const out = [];
                const seen = {};
                for (const rawStr of resultList) {
                    const info = parseTrainInfo(rawStr);
                    if (!info) continue;
                    if (codes && codes.indexOf(info.trainCode.toUpperCase()) === -1) continue;
                    if (!inDepartRange(info.startTime, departFrom, departTo)) continue;
                    const st = parseSaleTime(info.saleTime);
                    if (!st) continue;
                    const key = `${info.trainCode}@${st.date} ${st.time}`;
                    if (seen[key]) continue;
                    seen[key] = true;
                    out.push({ trainCode: info.trainCode, date: st.date, time: st.time });
                }
                return out;
            },
            // 这批车次的起售时刻里，最早的那个（用来给"这一组什么时候开火"定性）
            earliestSaleTime(resultList, departFrom = '', departTo = '') {
                const times = this.readSaleTimes(resultList, [], departFrom, departTo);
                if (!times.length) return null;
                return times.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];
            },

            // 中转方案：**返回全部候选**（v2 只返回第一个，于是"它自己挑了个错的换乘站"）。
            // 排序原则：只接受"同站换乘"（第二段的出发站就是第一段的到达站，同一个站码），
            // 然后按全程耗时短的优先。跨站换乘的方案直接丢——那要求用户自己拖着行李换站，
            // 而脚本并不知道两个站之间有多远。
            pickTransferPlans(data, seatTypes, minWait = 30, maxPlans = 8) {
                if (!data || !Array.isArray(data.middleList)) return [];
                const wantSeats = (seatTypes || []).flatMap(c => getSeatNamesByCode(c));
                const limit = Number(minWait);
                const okWait = t => !Number.isFinite(limit) || limit <= 0 || t >= limit;
                const out = [];
                for (const p of data.middleList) {
                    if (!p || !p.middle_station_code || !p.middle_station_name) continue;
                    if (!Array.isArray(p.fullList) || p.fullList.length < 2) continue;
                    const waitRaw = Number(p.wait_time_minutes);
                    // 拿不到换乘等待就别猜——宁可不列，也不列一个换乘时间不明的方案
                    if (!Number.isFinite(waitRaw)) continue;
                    // 同车换乘（两段是同一趟车，只是换了座位）不用下车，
                    // 等待时间再短也无所谓，别被最小换乘时间筛掉。
                    if (!okWait(waitRaw) && !p.same_train) continue;
                    const legSeats = p.fullList.map(leg => wantSeats.find(name => {
                        const key = SEAT_NUM_FIELD[name];
                        return key && hasTicket(leg[key]);
                    }) || '');
                    if (legSeats.some(s => !s)) continue;   // 两段都要有你勾的席别
                    const legCodes = p.fullList.map(l => l.from_station_telecode || '');
                    const legToCodes = p.fullList.map(l => l.to_station_telecode || '');
                    // 同站换乘：第 1 段的到达站 == 第 2 段的出发站
                    const sameStation = legToCodes[0] && legToCodes[0] === legCodes[1];
                    if (!sameStation) {
                        tlog('log', `[Transfer] 跳过「${p.middle_station_name}」：两段不在同一个站，`
                            + `第1段到 ${stationNameOf(legToCodes[0])}、第2段从 ${stationNameOf(legCodes[1])} 发车`);
                        continue;
                    }
                    out.push({
                        middleCode: p.middle_station_code,
                        middleName: p.middle_station_name,
                        waitMinutes: waitRaw,
                        sameTrain: !!p.same_train || (p.fullList[0] && p.fullList[1]
                            && p.fullList[0].station_train_code === p.fullList[1].station_train_code),
                        totalTime: p.all_lishi || '',
                        trainDate: p.train_date || '',
                        legSeats,
                        legs: p.fullList.map((l, i) => ({
                            trainCode: l.station_train_code || '',
                            trainNo: l.train_no || '',
                            fromCode: legCodes[i],
                            toCode: legToCodes[i],
                            fromName: stationNameOf(legCodes[i]),
                            toName: stationNameOf(legToCodes[i]),
                            startTime: l.start_time || '',
                            arriveTime: l.arrive_time || '',
                            seatName: legSeats[i],
                            secretStr: p.scretstr || ''
                        }))
                    });
                }
                out.sort((a, b) => {
                    const ta = String(a.totalTime || '').localeCompare(String(b.totalTime || ''));
                    return ta !== 0 ? ta : a.waitMinutes - b.waitMinutes;
                });
                return out.slice(0, maxPlans);
            }
        };
    })();

    // ==========================================================================
    // OrderLogicModule（下单：5 步严格串行）
    // ==========================================================================
    const OrderLogicModule = (() => {
        // 三个正则都写成 [:＝] 通吃（:` 和 `=` 都要认）。
        // 为什么：12306 的下单页里，这些值一部分是内联脚本的变量赋值（var x = '…'），
        // 一部分是 JSON 对象里的字段（"x":"…"）。只认一种，改版换写法就会静默失效——
        // 而失效点在"下单第一步"，代价最大。线上 JS 里这些名字至今仍在用，写法不做赌注。
        const REGEX_TOKEN = /["']?globalRepeatSubmitToken["']?\s*[:=]\s*["']([^"']+)["']/;
        const REGEX_KEY_CHECK = /["']?key_check_isChange["']?\s*[:=]\s*["']([^"']+)["']/;
        const REGEX_LEFT_TICKET = /["']?leftTicketStr["']?\s*[:=]\s*["']([^"']+)["']/;
        // 12306 下单页自己声明"这个席别能不能选座"。这两个变量在页面里赋值、官方 JS 只读不写。
        // 正则同时接受 = 和 :（页面版本不同写法不一样）；只认 = 的话一旦改版就会静默失效，
        // 而且日志还会误报成"这趟车不支持选座"。
        const REGEX_CAN_CHOOSE = /canChooseSeats\s*[:=]\s*['"]([YN])['"]/;
        const REGEX_CHOOSE_SEATS_LIST = /choose_Seats\s*[:=]\s*['"]([^'"]*)['"]/;

        function resolveChooseSeats(htmlContent, want, seatCode) {
            if (!want) return '';
            const html = String(htmlContent || '');
            const can = html.match(REGEX_CAN_CHOOSE);
            if (!can || can[1] !== 'Y') return '';
            const list = html.match(REGEX_CHOOSE_SEATS_LIST);
            if (!list) return '';
            return String(list[1]).indexOf(seatCode) > -1 ? want : '';
        }
        function buildPassengerStrings(passengers, seatCode) {
            const passengerTicketList = [];
            const oldPassengerList = [];
            passengers.forEach(p => {
                const ticketType = p.isStudent === true ? '3' : '1';
                const allEncStr = p.allEncStr || '';
                passengerTicketList.push(`${seatCode},0,${ticketType},${p.passenger_name},${p.passenger_id_type_code},${p.passenger_id_no},${p.mobile_no || ''},N,${allEncStr}`);
                oldPassengerList.push(`${p.passenger_name},${p.passenger_id_type_code},${p.passenger_id_no},${ticketType}_`);
            });
            return { passengerTicketStr: passengerTicketList.join('_'), oldPassengerStr: oldPassengerList.join('') };
        }

        return {
            REGEX_TOKEN, REGEX_KEY_CHECK, REGEX_LEFT_TICKET,

            // 一趟车、一段行程的完整下单。返回 { success, orderId?, error? }
            async executeOrderSequence(trainInfo, passengers, chooseSeats = '', silentCar = false) {
                tlog('log', `[Order] 开始下单 ${trainInfo.trainCode} ${trainInfo.fromStation}→${trainInfo.toStation} ${trainInfo.seatName}`);
                try {
                    const submitRes = await NetworkModule.submitOrderRequest(
                        trainInfo.secretStr, trainInfo.trainDate, trainInfo.trainDate,
                        trainInfo.fromStation, trainInfo.toStation, purposeCodesFor(passengers)
                    );
                    if (submitRes.status === false) {
                        const m = (submitRes.messages || []).join(',') || 'Unknown error';
                        // ★ 最常见的"下单被拒"：脚本不在 kyfw.12306.cn 上。
                        //   跨域时请求走油猴通道，而扩展不能伪造 Referer ——
                        //   12306 的下单接口会因此返回一张 HTML 错误页（不是数据）。
                        //   查票不受影响，所以前面一切看起来都正常，只有下单死在这里。
                        if (/Response is not JSON/i.test(m) && location.hostname !== 'kyfw.12306.cn') {
                            throw new Error('12306 把这一单挡回来了（返回的是错误页而不是数据）。'
                                + `原因：脚本现在跑在 ${location.hostname} 上，而 12306 的下单接口要求请求来自 `
                                + 'kyfw.12306.cn（同源）—— 跨域时浏览器和扩展都不允许带上它要的 Referer。'
                                + '请换到 kyfw.12306.cn 的任意页面（个人中心、查询页都行）重新开始。');
                        }
                        throw new Error(`Submit failed: ${m}`);
                    }
                    const htmlContent = await NetworkModule.getInitDcPage();
                    const tokenMatch = htmlContent.match(REGEX_TOKEN);
                    const keyMatch = htmlContent.match(REGEX_KEY_CHECK);
                    const leftTicketMatch = htmlContent.match(REGEX_LEFT_TICKET);
                    if (!tokenMatch || !keyMatch || !leftTicketMatch) {
                        const hint = '。注意：submitOrderRequest 已提交，可能有订单挂在「未完成订单」里，建议去检查一下';
                        if (!htmlContent || htmlContent.length < 5000) {
                            throw new Error(`会话已过期或下单页异常（仅返回 ${htmlContent ? htmlContent.length : 0} 字节），请重新登录${hint}`);
                        }
                        const missing = [!tokenMatch && 'Token', !keyMatch && 'Key', !leftTicketMatch && 'LeftTicket'].filter(Boolean).join('/');
                        // 这里是"12306 一改版就静默失效"的位置，所以把现场留在日志里：
                        // 页面多大、三个变量名到底出现过没有 —— 足够区分"写法变了"和"值没了"。
                        // 面板上的「复制日志」会把技术日志一起带走。
                        const has = n => htmlContent.indexOf(n) > -1;
                        tlog('log', `[Order] initDc 解析失败：页面 ${htmlContent.length} 字节，缺少 ${missing}；`
                            + `变量名出现情况 —— globalRepeatSubmitToken=${has('globalRepeatSubmitToken')} `
                            + `key_check_isChange=${has('key_check_isChange')} leftTicketStr=${has('leftTicketStr')}`);
                        tlog('log', '[Order] 页面开头 300 字：' + htmlContent.slice(0, 300).replace(/\s+/g, ' '));
                        log(`下单页解析失败（缺少 ${missing}）。诊断信息已写进日志 —— 点「复制日志」发出来就能定位`, 'error');
                        throw new Error(`下单页解析失败，缺少 ${missing}，12306 可能已改版${hint}`);
                    }
                    const token = tokenMatch[1];
                    let keyCheckIsChange = keyMatch[1];
                    let leftTicketStr = leftTicketMatch[1];
                    let effTrainLocation = trainInfo.trainLocation || '';
                    tlog('log', `[Order] 下单页参数: token=${token.length}位 key=${keyCheckIsChange.length}位`
                        + ` leftTicketStr=${leftTicketStr.length}位 train_location=${effTrainLocation || '(空!)'}`);

                    let seatCode = resolveOrderSeatCode(trainInfo, trainInfo.seatName);
                    const BERTH_NAME_OF_CODE = { '4': '软卧', 'I': '一等卧', '3': '硬卧', 'J': '二等卧' };
                    if (BERTH_NAME_OF_CODE[seatCode] && BERTH_NAME_OF_CODE[seatCode] !== trainInfo.seatName) {
                        tlog('log', `[Order] ${trainInfo.trainCode} 勾的是「${trainInfo.seatName}」，`
                            + `这趟车的卧铺票种是「${BERTH_NAME_OF_CODE[seatCode]}」（码 ${seatCode}），按实际票种下单`);
                    }
                    // ★ 无座必须在**下单前**换成硬座/二等座的码（官方 m()+aP() 规则）
                    const altCodes = [];
                    if (trainInfo.seatName === '无座') {
                        const swap = wuzuoOrderSeatCode(trainInfo, leftTicketStr);
                        if (swap && swap.code !== seatCode) {
                            seatCode = swap.code;
                            tlog('log', `[Order] 无座按 12306 规则改用 ${swap.code}(${swap.name}) 下单（依据：${swap.from}）`);
                        } else if (!swap) {
                            tlog('warn', '[Order] 拿不到硬座/二等座席别信息，无座只能按 WZ 提交');
                        }
                        for (const c of ['1', 'O']) if (c !== seatCode) altCodes.push(c);
                    }
                    let { passengerTicketStr, oldPassengerStr } = buildPassengerStrings(passengers, seatCode);

                    const seatsToSubmit = resolveChooseSeats(htmlContent, chooseSeats, seatCode);
                    if (chooseSeats && !seatsToSubmit) {
                        tlog('log', `[Order] ${trainInfo.trainCode} ${trainInfo.seatName} 不支持选座，已退回自动分配（原选座 ${chooseSeats}）`);
                    }

                    let checkRes = await NetworkModule.checkOrderInfo(passengerTicketStr, oldPassengerStr, 'dc', token);
                    if (altCodes.length && (!checkRes.data || !checkRes.data.submitStatus)
                        && /硬座|席别|座位/.test(String((checkRes.data && checkRes.data.errMsg) || ''))) {
                        for (const fallback of altCodes) {
                            tlog('warn', `[Order] 席别码 ${seatCode} 被拒，改试 '${fallback}'`);
                            seatCode = fallback;
                            ({ passengerTicketStr, oldPassengerStr } = buildPassengerStrings(passengers, seatCode));
                            checkRes = await NetworkModule.checkOrderInfo(passengerTicketStr, oldPassengerStr, 'dc', token);
                            if (checkRes.data && checkRes.data.submitStatus) break;
                        }
                    }
                    if (!checkRes.data || !checkRes.data.submitStatus) {
                        throw new Error(`CheckOrderInfo failed: ${(checkRes.data && checkRes.data.errMsg) || 'Unknown'}`);
                    }
                    // ★ leftTicketStr / key_check_isChange / train_location 的权威来源是 checkOrderInfo 响应
                    const ord = (checkRes.data && checkRes.data.result) || '';
                    if (ord) {
                        const seg = String(ord).split('#');
                        if (seg[0]) effTrainLocation = seg[0];
                        if (seg[1]) keyCheckIsChange = seg[1];
                        if (seg[2] && seg[2].length > leftTicketStr.length) leftTicketStr = seg[2];
                        tlog('log', `[Order] checkOrderInfo 分段: location=${seg[0] || '(空)'}`
                            + ` key=${(seg[1] || '').length}位 leftTicketStr=${(seg[2] || '').length}位`);
                    }
                    if (leftTicketStr.length < 100) {
                        tlog('warn', `[Order] leftTicketStr 只有 ${leftTicketStr.length} 位（正常 300+），getQueueCount 可能拿不到票额快照`);
                    }

                    const dateObj = new Date(`${trainInfo.trainDate}T00:00:00`);
                    const orderPurpose = orderPurposeCodesFor(passengers);
                    const jy = silentCarUsable(trainInfo, silentCar, seatCode);
                    tlog('log', `[Order] 静音车厢：${jy.usable ? `✔ 按静音车厢提交（${jy.reason}）` : `✘ ${jy.reason}`}`);

                    const queueRes = await NetworkModule.getQueueCount(
                        dateObj, trainInfo.trainNo, trainInfo.trainCode, seatCode,
                        trainInfo.fromStation, trainInfo.toStation, token,
                        leftTicketStr, effTrainLocation, orderPurpose
                    );
                    const qd = queueRes.data || {};
                    tlog('log', `[Order] Queue count: ${qd.countT} 席别码=${seatCode}`
                        + ` ticket=${qd.ticket === undefined || qd.ticket === null || qd.ticket === '' ? '(空)' : String(qd.ticket).slice(0, 30)}`);

                    const confirmRes = await NetworkModule.confirmSingleForQueue(
                        passengerTicketStr, oldPassengerStr, keyCheckIsChange, token, leftTicketStr,
                        effTrainLocation, seatsToSubmit, orderPurpose, jy.usable ? 'Y' : 'N'
                    );
                    if (confirmRes.data && confirmRes.data.submitStatus) {
                        tlog('log', '🎉 下单成功!');
                        return { success: true, orderId: confirmRes.data.orderId || confirmRes.data.order_id || '' };
                    }
                    const errMsg = (confirmRes.data && confirmRes.data.errMsg) || 'Unknown';
                    tlog('warn', `[Order] 下单被拒：席别码=${seatCode}(${trainInfo.seatName}) countT=${qd.countT} 服务端=${errMsg}`);
                    throw new Error(`Confirm failed: ${errMsg}`);
                } catch (error) {
                    tlog('error', '[Order] 下单失败:', error);
                    return { success: false, error: error.message };
                }
            }
        };
    })();

    // ==========================================================================
    // UIModule —— 三步面板
    // ==========================================================================
    const UIModule = (() => {
        const PANEL_ID = 'ticket-helper-panel';
        const PRESALE_DAYS = 15;    // 预售期：今天 ~ 今天+14

        const STYLES = `
#${PANEL_ID} *, #${PANEL_ID} *::before, #${PANEL_ID} *::after { box-sizing: border-box; }
#${PANEL_ID} {
    --ink:#1b1f24; --ink2:#5b6472; --ink3:#98a1ad; --line:#eef1f5; --line2:#dde3ea; --fill:#f5f6f8;
    --acc:#2563eb; --acc-h:#1d4ed8; --acc-soft:#f0f5ff; --acc-line:#c9dcff;
    --amber:#b45309; --amber-soft:#fef6e7; --amber-line:#f2e2c4;
    --red:#dc2626; --red-soft:#fdecec; --green:#047857; --green-soft:#eaf7f0;
    position:fixed; top:50px; right:20px; width:378px; z-index:2147483000;
    display:flex; flex-direction:column; max-height:min(84vh,780px);
    background:#fff; border-radius:14px; overflow:hidden; color:var(--ink);
    font-family:-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
    font-size:13px; line-height:1.6; text-align:left;
    box-shadow:0 12px 40px rgba(16,24,40,.16), 0 0 0 1px rgba(16,24,40,.05);
    -webkit-font-smoothing:antialiased;
}
#${PANEL_ID} .th-hd { display:flex; align-items:center; justify-content:space-between; padding:12px 12px 12px 16px; cursor:move; user-select:none; }
#${PANEL_ID} .th-hd-l { display:flex; align-items:center; gap:8px; font-size:15px; font-weight:600; }
#${PANEL_ID} .th-v { font-size:11.5px; font-weight:400; color:var(--ink3); }
#${PANEL_ID} .th-hd-r { display:flex; gap:2px; }
#${PANEL_ID} .th-icon { width:28px; height:28px; border:0; background:transparent; border-radius:8px; color:var(--ink3);
    font-size:14px; cursor:pointer; line-height:1; font-family:inherit; padding:0; }
#${PANEL_ID} .th-icon:hover { background:var(--fill); color:var(--ink); }
#${PANEL_ID} .th-steps { display:flex; align-items:center; gap:5px; padding:0 12px 10px; border-bottom:1px solid var(--line); }
#${PANEL_ID} .th-stp { display:inline-flex; align-items:center; gap:5px; height:26px; padding:0 9px; border:0;
    background:transparent; border-radius:8px; font:inherit; font-size:11.5px; color:var(--ink3); cursor:pointer; }
#${PANEL_ID} .th-stp:hover { background:var(--fill); color:var(--ink2); }
#${PANEL_ID} .th-stp.on { background:var(--acc-soft); color:var(--acc); font-weight:600; }
#${PANEL_ID} .th-stp i { width:15px; height:15px; border-radius:50%; background:var(--fill); color:var(--ink3);
    display:inline-flex; align-items:center; justify-content:center; font-style:normal; font-size:10px; font-weight:600; }
#${PANEL_ID} .th-stp.on i { background:var(--acc); color:#fff; }
#${PANEL_ID} .th-stp.locked { opacity:.42; cursor:not-allowed; }
#${PANEL_ID} .th-stp.locked:hover { background:transparent; color:var(--ink3); }
#${PANEL_ID} .th-live { width:6px; height:6px; border-radius:50%; background:var(--green); }
#${PANEL_ID} .th-recap { display:flex; align-items:center; gap:6px; width:calc(100% - 32px); margin:10px 16px 0; padding:7px 10px;
    border:0; border-radius:10px; background:var(--fill); font:inherit; font-size:11.5px; color:var(--ink2);
    cursor:pointer; text-align:left; line-height:1.5; }
#${PANEL_ID} .th-recap:hover { background:var(--acc-soft); color:var(--acc); }
#${PANEL_ID} .th-recap .th-txt { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#${PANEL_ID} .th-recap .th-go { margin-left:auto; flex:0 0 auto; color:var(--ink3); font-size:11.5px; }
#${PANEL_ID} .th-recap:hover .th-go { color:var(--acc); }
#${PANEL_ID} .th-bd { flex:1 1 auto; min-height:0; padding:2px 16px 16px; overflow-y:auto; overscroll-behavior:contain; }
#${PANEL_ID} .th-ft { flex:0 0 auto; border-top:1px solid var(--line); padding:13px 16px 15px; background:#fff; }
#${PANEL_ID}.th-folded .th-bd, #${PANEL_ID}.th-folded .th-ft, #${PANEL_ID}.th-folded .th-steps, #${PANEL_ID}.th-folded .th-recap { display:none; }
#${PANEL_ID}.th-folded .th-hd { border-bottom:0; }
#${PANEL_ID} .th-pane { display:none; }
#${PANEL_ID} .th-pane.on { display:block; }
#${PANEL_ID} section { padding:13px 0; border-bottom:1px solid var(--line); }
#${PANEL_ID} section:last-of-type { border-bottom:0; }
#${PANEL_ID} .th-lbl { display:flex; align-items:baseline; justify-content:space-between; margin-bottom:9px;
    font-size:11.5px; font-weight:600; letter-spacing:.1em; color:var(--ink3); }
#${PANEL_ID} .th-lbl .th-aside { font-size:11.5px; font-weight:400; letter-spacing:0; display:flex; gap:10px; align-items:baseline; }
#${PANEL_ID} .th-aside button { border:0; background:0; padding:0; font:inherit; color:var(--ink3); cursor:pointer;
    text-decoration:underline; text-underline-offset:3px; text-decoration-color:var(--line2); }
#${PANEL_ID} .th-aside button:hover { color:var(--acc); text-decoration-color:currentColor; }
#${PANEL_ID} .th-inp { width:100%; height:40px; padding:0 11px; border:1px solid var(--line2); border-radius:10px;
    background:#fff; font:inherit; font-size:14px; color:var(--ink); outline:none; }
#${PANEL_ID} .th-inp:focus { border-color:var(--acc); box-shadow:0 0 0 3px rgba(37,99,235,.1); }
#${PANEL_ID} .th-inp::placeholder { color:#b6bdc7; font-size:13px; }
#${PANEL_ID} .th-row { display:flex; align-items:center; gap:8px; }
#${PANEL_ID} .th-row + .th-row { margin-top:8px; }
#${PANEL_ID} .th-swap { flex:0 0 auto; width:32px; height:40px; border:1px solid var(--line2); background:var(--fill);
    border-radius:10px; color:var(--ink2); cursor:pointer; font-size:14px; font-family:inherit; }
#${PANEL_ID} .th-swap:hover { border-color:#c3cbd6; color:var(--ink); }
#${PANEL_ID} .th-fold-row { display:flex; align-items:center; gap:8px; width:100%; height:40px; padding:0 12px;
    border:1px solid var(--line2); border-radius:10px; background:#fff; font:inherit; cursor:pointer; text-align:left; }
#${PANEL_ID} .th-fold-row:hover { border-color:#c3cbd6; }
#${PANEL_ID} .th-fold-row.open { border-color:var(--acc); box-shadow:0 0 0 3px rgba(37,99,235,.1); }
#${PANEL_ID} .th-fold-main { font-size:14px; font-weight:600; }
#${PANEL_ID} .th-fold-sub { margin-left:auto; font-size:11.5px; color:var(--ink3); }
#${PANEL_ID} .th-fold-row .th-arw { font-size:10px; color:var(--ink3); }
#${PANEL_ID} .th-fold-row.open .th-arw { transform:rotate(180deg); }
#${PANEL_ID} .th-fold-bd { display:none; padding-top:10px; }
#${PANEL_ID} .th-fold-bd.open { display:block; }
#${PANEL_ID} .th-cal { border:1px solid var(--line2); border-radius:10px; padding:9px 10px 10px; }
#${PANEL_ID} .th-cal-hd { display:flex; align-items:center; justify-content:space-between; margin-bottom:7px; }
#${PANEL_ID} .th-cal-hd .th-t { font-size:13px; font-weight:600; }
#${PANEL_ID} .th-cal-nav { display:flex; gap:2px; }
#${PANEL_ID} .th-cal-nav button { width:24px; height:24px; border:0; background:transparent; border-radius:6px;
    color:var(--ink3); cursor:pointer; font-family:inherit; }
#${PANEL_ID} .th-cal-nav button:hover { background:var(--fill); color:var(--ink); }
#${PANEL_ID} .th-cal-grid { display:grid; grid-template-columns:repeat(7,1fr); gap:2px; }
#${PANEL_ID} .th-cal-grid .th-wd { height:17px; line-height:17px; text-align:center; font-size:11.5px; color:var(--ink3); }
#${PANEL_ID} .th-day { height:29px; border:0; background:transparent; border-radius:7px; font:inherit; font-size:13px;
    color:var(--ink2); cursor:pointer; padding:0; }
#${PANEL_ID} .th-day:hover { background:var(--fill); }
#${PANEL_ID} .th-day.pad { color:#cdd3db; cursor:default; }
#${PANEL_ID} .th-day.pad:hover { background:transparent; }
#${PANEL_ID} .th-day.future { color:#c8ced7; cursor:pointer; }
#${PANEL_ID} .th-day.future:hover { background:var(--amber-soft); color:var(--amber); }
#${PANEL_ID} .th-day.reserved { background:var(--amber-soft); color:var(--amber); font-weight:600;
    box-shadow:inset 0 0 0 1px var(--amber-line); }
#${PANEL_ID} .th-reserve { padding:10px 11px; border-radius:10px; background:var(--amber-soft); border:1px solid var(--amber-line); }
#${PANEL_ID} .th-rl { font-size:13px; font-weight:600; color:#8a5a12; margin-bottom:8px; }
#${PANEL_ID} .th-rrow { display:flex; align-items:center; gap:7px; flex-wrap:wrap; font-size:11.5px; color:#8a5a12; }
#${PANEL_ID} .th-rrow input[type=time] { height:30px; padding:0 7px; border:1px solid var(--amber-line); border-radius:7px;
    background:#fff; font:inherit; font-size:13px; color:var(--ink); }
#${PANEL_ID} .th-rrow button { height:30px; padding:0 9px; border:1px solid var(--amber-line); background:#fff;
    border-radius:7px; font:inherit; font-size:11.5px; color:#8a5a12; cursor:pointer; }
#${PANEL_ID} .th-rrow button:hover { background:#fff8ec; }
#${PANEL_ID} .th-rhint { margin-top:8px; font-size:11.5px; line-height:1.65; color:#8a5a12; }
#${PANEL_ID} .th-rhint b { color:#8a5a12; font-weight:600; }
#${PANEL_ID} .th-rnote { margin-top:8px; padding-top:8px; border-top:1px solid var(--amber-line);
    font-size:11.5px; line-height:1.7; color:#9a6a20; }
#${PANEL_ID} .th-rnote b { color:#8a5a12; font-weight:600; }
#${PANEL_ID} .th-calnote { margin-top:9px; padding:8px 10px; border-radius:8px; background:var(--amber-soft);
    border:1px solid var(--amber-line); font-size:11.5px; line-height:1.65; color:#8a5a12; display:none; }
#${PANEL_ID} .th-calnote.show { display:block; }
#${PANEL_ID} .th-calnote b { color:#8a5a12; font-weight:600; }
#${PANEL_ID} .th-day.extra { background:var(--acc-soft); color:var(--acc); font-weight:600; }
#${PANEL_ID} .th-day.main { background:var(--acc); color:#fff; font-weight:600; }
#${PANEL_ID} .th-quick { display:flex; gap:6px; margin-top:9px; flex-wrap:wrap; }
#${PANEL_ID} .th-quick button { height:26px; padding:0 9px; border:1px solid var(--line2); background:#fff; border-radius:7px;
    font:inherit; font-size:11.5px; color:var(--ink2); cursor:pointer; }
#${PANEL_ID} .th-quick button:hover { border-color:var(--acc-line); color:var(--acc); background:var(--acc-soft); }
#${PANEL_ID} .th-chips { display:flex; flex-wrap:wrap; gap:6px; }
#${PANEL_ID} .th-chip { height:32px; padding:0 10px; border:1px solid var(--line2); background:#fff; border-radius:8px;
    font:inherit; font-size:13px; color:var(--ink2); cursor:pointer; }
#${PANEL_ID} .th-chip:hover { border-color:#c3cbd6; color:var(--ink); }
#${PANEL_ID} .th-chip.on { background:var(--acc-soft); border-color:var(--acc-line); color:var(--acc); font-weight:600; }
#${PANEL_ID} .th-chip.locked { opacity:.45; cursor:default; }
#${PANEL_ID} .th-chip.locked:hover { border-color:var(--line2); color:var(--ink2); background:#fff; }
#${PANEL_ID} .th-sum { margin-top:9px; font-size:11.5px; color:var(--ink3); min-height:17px; }
#${PANEL_ID} .th-sum b { color:var(--acc); font-weight:600; }
#${PANEL_ID} .th-sum.warn { color:var(--amber); }
#${PANEL_ID} .th-hint { margin-top:8px; font-size:11.5px; line-height:1.65; color:var(--ink3); }
#${PANEL_ID} .th-hint b { color:var(--ink2); font-weight:600; }
#${PANEL_ID} .th-pax { display:flex; flex-wrap:wrap; gap:6px; }
#${PANEL_ID} .th-pax-chip { display:inline-flex; align-items:stretch; height:32px; padding:0; border:1px solid var(--line2);
    background:#fff; border-radius:8px; font:inherit; font-size:13px; color:var(--ink2); cursor:pointer; overflow:hidden; }
#${PANEL_ID} .th-pax-chip .th-nm { padding:0 10px; line-height:30px; }
#${PANEL_ID} .th-pax-chip .th-st { padding:0 9px; line-height:30px; border-left:1px solid var(--line); font-size:11.5px; color:var(--ink3); }
#${PANEL_ID} .th-pax-chip.on { border-color:var(--acc-line); background:var(--acc-soft); color:var(--acc); }
#${PANEL_ID} .th-pax-chip.on .th-nm { font-weight:600; }
#${PANEL_ID} .th-pax-chip.on .th-st { border-left-color:var(--acc-line); }
#${PANEL_ID} .th-pax-chip.stu .th-st { background:var(--amber-soft); color:var(--amber); font-weight:700; }
#${PANEL_ID} .th-adv-hd { display:flex; align-items:center; justify-content:space-between; cursor:pointer; user-select:none; }
#${PANEL_ID} .th-adv-hd .th-t { font-size:11.5px; font-weight:600; letter-spacing:.1em; color:var(--ink3); }
#${PANEL_ID} .th-adv-hd .th-arw { font-size:10px; color:var(--ink3); }
#${PANEL_ID} .th-adv.open .th-adv-hd .th-arw { transform:rotate(90deg); }
#${PANEL_ID} .th-adv-bd { display:none; padding-top:6px; }
#${PANEL_ID} .th-adv.open .th-adv-bd { display:block; }
#${PANEL_ID} .th-sw { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:9px 0; }
#${PANEL_ID} .th-sw .th-tx { flex:1; }
#${PANEL_ID} .th-sw .th-t { font-size:13px; color:var(--ink); }
#${PANEL_ID} .th-sw .th-d { margin-top:2px; font-size:11.5px; line-height:1.55; color:var(--ink3); }
#${PANEL_ID} .th-sw input[type=checkbox] { margin:2px 0 0; flex:0 0 auto; accent-color:var(--acc); width:16px; height:16px; }
#${PANEL_ID} .th-layout { display:flex; align-items:center; gap:11px; padding:11px 12px; border:1px solid var(--line2);
    border-radius:10px; background:#fff; }
#${PANEL_ID} .th-layout .th-blk { display:flex; gap:5px; }
#${PANEL_ID} .th-layout .th-aisle { font-size:11.5px; color:var(--ink3); letter-spacing:.08em; }
#${PANEL_ID} .th-seat { width:40px; padding:5px 0 4px; border:1px solid var(--line2); border-radius:8px; background:#fff;
    cursor:pointer; display:flex; flex-direction:column; align-items:center; gap:1px; font:inherit; }
#${PANEL_ID} .th-seat:hover { border-color:#c3cbd6; }
#${PANEL_ID} .th-seat b { font-size:14px; font-weight:600; color:var(--ink); }
#${PANEL_ID} .th-seat span { font-size:11.5px; line-height:1.25; color:var(--ink3); }
#${PANEL_ID} .th-seat.on { background:var(--acc-soft); border-color:var(--acc-line); }
#${PANEL_ID} .th-seat.on b, #${PANEL_ID} .th-seat.on span { color:var(--acc); }
#${PANEL_ID} .th-note { padding:10px 11px; border-radius:10px; background:var(--amber-soft); border:1px solid var(--amber-line);
    font-size:11.5px; line-height:1.7; color:#8a5a12; }
#${PANEL_ID} .th-note b { color:#8a5a12; font-weight:600; }
#${PANEL_ID} .th-relay { padding:11px 12px; border-radius:10px; background:var(--amber-soft); border:1px solid var(--amber-line); }
#${PANEL_ID} .th-relay .th-rt { font-size:13px; font-weight:600; color:var(--amber); margin-bottom:5px; }
#${PANEL_ID} .th-relay .th-rd { font-size:11.5px; line-height:1.7; color:#8a5a12; }
#${PANEL_ID} .th-relay .th-rd + .th-rd { margin-top:6px; }
#${PANEL_ID} .th-relay b { color:#8a5a12; font-weight:600; }
#${PANEL_ID} .th-rsw { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:9px;
    font-size:13px; font-weight:600; color:var(--amber); }
#${PANEL_ID} .th-rsw input { width:16px; height:16px; flex:0 0 auto; accent-color:var(--amber); }
#${PANEL_ID} .th-rbtns { display:flex; gap:8px; margin-top:11px; }
#${PANEL_ID} .th-rbtns .th-chip { flex:1; height:34px; background:#fff; border-color:#e6d3ae; color:#8a5a12; font-weight:600; }
#${PANEL_ID} .th-legend { display:flex; flex-direction:column; gap:5px; margin-top:10px; }
#${PANEL_ID} .th-lg { display:flex; gap:9px; font-size:11.5px; line-height:1.6; color:var(--ink3); }
#${PANEL_ID} .th-lg b { flex:0 0 62px; color:var(--ink2); font-weight:600; }
#${PANEL_ID} .th-lg.off { opacity:.35; }
#${PANEL_ID} .th-count { font-size:11.5px; color:var(--ink3); margin-bottom:9px; }
#${PANEL_ID} .th-count b { color:var(--ink2); }
#${PANEL_ID} .th-plans { display:flex; flex-direction:column; gap:6px; }
#${PANEL_ID} .th-grp { display:flex; align-items:center; gap:8px; margin:12px 0 1px; font-size:11.5px; letter-spacing:.05em; }
#${PANEL_ID} .th-grp:first-child { margin-top:0; }
#${PANEL_ID} .th-grp .th-t { font-weight:600; color:var(--ink2); }
#${PANEL_ID} .th-grp i { flex:1; height:1px; background:var(--line2); }
#${PANEL_ID} .th-grp .th-n { color:var(--ink3); }
#${PANEL_ID} .th-plan { position:relative; display:flex; gap:9px; padding:9px 30px 9px 10px; border:1px solid var(--line2);
    border-radius:10px; background:#fff; }
#${PANEL_ID} .th-plan.sel { border-color:var(--acc-line); background:var(--acc-soft); }
#${PANEL_ID} .th-plan.no { opacity:.45; }
#${PANEL_ID} .th-plan.dragging { opacity:.35; }
#${PANEL_ID} .th-plan.dropzone { border-color:var(--acc); }
#${PANEL_ID} .th-grip { flex:0 0 auto; color:#ccd2da; cursor:grab; font-size:11px; user-select:none; padding-top:1px; }
#${PANEL_ID} .th-plan input[type=checkbox] { flex:0 0 auto; margin:2px 0 0; accent-color:var(--acc); width:15px; height:15px; }
#${PANEL_ID} .th-plan .th-body2 { flex:1; min-width:0; }
#${PANEL_ID} .th-l1 { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
#${PANEL_ID} .th-badge { font-size:11.5px; font-weight:600; padding:1px 6px; border-radius:5px; }
#${PANEL_ID} .th-badge.z { background:var(--acc-soft); color:var(--acc); }
#${PANEL_ID} .th-badge.t { background:#f1f3f6; color:#5b6472; }
#${PANEL_ID} .th-badge.c { background:var(--green-soft); color:var(--green); }
#${PANEL_ID} .th-badge.y { background:var(--amber-soft); color:var(--amber); }
#${PANEL_ID} .th-code { font-size:14px; font-weight:600; }
#${PANEL_ID} .th-l2 { display:flex; gap:11px; flex-wrap:wrap; margin-top:3px; font-size:11.5px; color:var(--ink3); }
#${PANEL_ID} .th-l2 .ok { color:var(--green); font-weight:600; }
#${PANEL_ID} .th-l2 .price { color:var(--ink); font-weight:600; font-variant-numeric:tabular-nums; }
#${PANEL_ID} .th-l2 .dim { color:#c2c8d1; }
#${PANEL_ID} .th-l2 .sale { color:var(--ink3); }
#${PANEL_ID} .th-l2 .sale.warn { color:var(--amber); font-weight:600; }
#${PANEL_ID} .th-del { position:absolute; top:6px; right:6px; width:22px; height:22px; border:0; background:transparent;
    border-radius:6px; color:#ccd2da; cursor:pointer; font-size:13px; line-height:1; font-family:inherit; padding:0; }
#${PANEL_ID} .th-del:hover { background:var(--red-soft); color:var(--red); }
#${PANEL_ID} .th-legs { margin-top:6px; display:flex; flex-direction:column; gap:3px; }
#${PANEL_ID} .th-leg { display:flex; gap:9px; font-size:11.5px; color:var(--ink3); line-height:1.5; }
#${PANEL_ID} .th-leg .th-seg { min-width:110px; }
#${PANEL_ID} .th-leg .th-sl { color:var(--amber); }
#${PANEL_ID} .th-leg .th-st { margin-left:auto; }
#${PANEL_ID} .th-run { display:flex; flex-direction:column; gap:5px; margin-top:4px; }
#${PANEL_ID} .th-run-row { display:flex; align-items:center; gap:8px; padding:7px 10px; border-radius:8px;
    background:var(--fill); font-size:13px; color:var(--ink3); flex-wrap:wrap; }
#${PANEL_ID} .th-run-row.now { background:var(--acc-soft); color:var(--acc); font-weight:600; }
#${PANEL_ID} .th-run-row .th-no { width:15px; height:15px; border-radius:50%; background:#fff; color:var(--ink3);
    display:inline-flex; align-items:center; justify-content:center; font-size:10px; font-weight:600; flex:0 0 auto; }
#${PANEL_ID} .th-run-row.now .th-no { background:var(--acc); color:#fff; }
#${PANEL_ID} .th-run-row .th-rc { font-size:13px; color:var(--ink2); }
#${PANEL_ID} .th-run-row .th-rs { font-size:11.5px; color:var(--ink3); }
#${PANEL_ID} .th-run-row .th-rv { margin-left:auto; font-size:11.5px; font-weight:600; white-space:nowrap; }
#${PANEL_ID} .th-run-row .th-rv.hunt { font-weight:400; color:var(--ink3); }
#${PANEL_ID} .th-run-row .th-rv.wait { font-weight:400; color:var(--ink3); opacity:.7; }
#${PANEL_ID} .th-run-row .th-rv.hit { color:var(--red); }
#${PANEL_ID} .th-run-row .th-rv.got { color:var(--green); }
#${PANEL_ID} .th-run-row .th-legs { flex:1 0 100%; }
#${PANEL_ID} .th-status { display:flex; align-items:center; gap:9px; padding:10px 12px; border-radius:10px;
    background:var(--fill); font-size:13px; font-weight:600; color:var(--ink3); margin-bottom:12px; }
#${PANEL_ID} .th-status .th-dot { width:7px; height:7px; border-radius:50%; background:currentColor; flex:0 0 auto; }
#${PANEL_ID} .th-status .th-n { margin-left:auto; font-weight:400; font-size:11.5px; opacity:.8; }
#${PANEL_ID} .th-status.wait { background:var(--amber-soft); color:var(--amber); }
#${PANEL_ID} .th-status.run { background:var(--acc-soft); color:var(--acc); }
#${PANEL_ID} .th-status.hit { background:var(--red-soft); color:#b91c1c; }
#${PANEL_ID} .th-status.err { background:var(--red-soft); color:#b91c1c; }
#${PANEL_ID} .th-status.ok { background:var(--green-soft); color:var(--green); }
#${PANEL_ID} .th-btn { width:100%; height:44px; border:0; border-radius:10px; background:var(--acc); color:#fff;
    font:inherit; font-size:15px; font-weight:600; cursor:pointer; box-shadow:0 4px 14px rgba(37,99,235,.22); }
#${PANEL_ID} .th-btn:hover { background:var(--acc-h); }
#${PANEL_ID} .th-btn.stop { background:var(--red); box-shadow:0 4px 14px rgba(220,38,38,.2); }
#${PANEL_ID} .th-btn.stop:hover { background:#b91c1c; }
#${PANEL_ID} .th-btn.ghost { background:#fff; color:var(--ink2); border:1px solid var(--line2); box-shadow:none; font-weight:500; }
#${PANEL_ID} .th-btn.ghost:hover { background:var(--fill); color:var(--ink); }
#${PANEL_ID} .th-btn[disabled] { background:#e8ebf0; color:#a9b1bd; box-shadow:none; cursor:not-allowed; }
#${PANEL_ID} .th-btns { display:flex; gap:8px; }
#${PANEL_ID} .th-btns .th-btn { flex:1; }
#${PANEL_ID} .th-links { display:flex; justify-content:center; gap:16px; margin-top:11px; }
#${PANEL_ID} .th-links button { border:0; background:0; padding:0; font:inherit; font-size:11.5px; color:var(--ink3);
    cursor:pointer; text-decoration:underline; text-underline-offset:3px; text-decoration-color:var(--line2); }
#${PANEL_ID} .th-links button:hover { color:var(--acc); text-decoration-color:currentColor; }
#${PANEL_ID} .th-ftnote { margin-bottom:9px; font-size:11.5px; line-height:1.55; color:var(--amber); }
#${PANEL_ID} .th-log { margin-top:11px; padding:10px 11px; border-radius:10px; background:#11161d; color:#c3ccd8;
    font:11.5px/1.75 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; max-height:150px; overflow:auto; display:none; }
#${PANEL_ID} .th-log.show { display:block; }
#${PANEL_ID} .th-log div { white-space:pre-wrap; word-break:break-word; }
#${PANEL_ID} .th-log .s { color:#6ee7b7; } #${PANEL_ID} .th-log .w { color:#fcd34d; }
#${PANEL_ID} .th-log .e { color:#fca5a5; } #${PANEL_ID} .th-log .i { color:#93c5fd; }
@media (prefers-color-scheme: dark) {
  #${PANEL_ID} { filter:none; }
}
        `;

        const uiState = {
            step: 1,
            running: false,
            testing: false,
            tested: false,
            stale: false,
            plans: [],
            filters: { z: true, c: true, t: true },
            planState: loadPlanState(),
            passengersList: [],
            letters: (cfg.seatLetters || []).slice(),
            pref: cfg.seatPref || 'any',
            cal: { y: new Date().getFullYear(), m: new Date().getMonth() + 1 },
            onStart: null, onStop: null, onTest: null
        };
        let panelEl = null, logContainer = null, statusEl = null, startBtn = null;
        let wakeCtx = null, wakeNode = null;
        const logRepeatMap = new Map();
        const LOG_REPEAT_EVERY = 8;
        const LOG_MIN_GAP_MS = 3000;
        const MAX_LOG_ENTRIES = 200;

        // ---------- 基础 ----------
        const $ = s => panelEl ? panelEl.querySelector(s) : null;
        const $$ = s => panelEl ? Array.prototype.slice.call(panelEl.querySelectorAll(s)) : [];

        function playBeep() {
            try {
                const ctx = ensureAudioContext();
                if (!ctx) return;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain); gain.connect(ctx.destination);
                osc.frequency.value = 880; osc.type = 'sine';
                gain.gain.setValueAtTime(0.5, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
                osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.4);
            } catch (e) { tlog('log', '声音播放失败:', e); }
        }
        function showNotification(title, body) {
            if (cfg.soundAlert !== false) playBeep();
            if ('Notification' in window) {
                if (Notification.permission === 'granted') {
                    new Notification(title, { body, icon: 'https://kyfw.12306.cn/favicon.ico' });
                } else if (Notification.permission === 'default') {
                    Notification.requestPermission().then(p => { if (p === 'granted') new Notification(title, { body }); });
                }
            }
            try { window.focus(); } catch (e) { /* 忽略 */ }
        }
        function setStatus(text, cls, note) {
            if (!statusEl) return;
            statusEl.className = 'th-status ' + (cls || '');
            statusEl.children[1].textContent = text;
            statusEl.children[2].textContent = note || '';
        }
        // 日志默认是收起的（不然面板太长）。但只要出错就自动展开——
        // 否则错误写在一个看不见的地方，用户看到的就是"点了没反应"。
        function revealLog() {
            if (!logContainer || logContainer.classList.contains('show')) return;
            logContainer.classList.add('show');
            const tg = $('#th-log-toggle');
            if (tg) tg.textContent = '运行日志 ▴';
        }
        function log(msg, type = 'info') {
            if (!logContainer) return;
            if (type === 'error') revealLog();
            const fp = String(msg).replace(/\d+/g, '#');
            const now = Date.now();
            const rec = logRepeatMap.get(fp) || { count: 0, lastAt: 0 };
            rec.count++;
            const tooSoon = rec.lastAt && (now - rec.lastAt) < LOG_MIN_GAP_MS;
            const notTimeYet = rec.count % LOG_REPEAT_EVERY !== 0;
            if (tooSoon && notTimeYet) { logRepeatMap.set(fp, rec); return; }
            rec.lastAt = now;
            logRepeatMap.set(fp, rec);
            if (logRepeatMap.size > 60) logRepeatMap.clear();
            const shown = rec.count > 1 ? `${msg}（同类已重复 ${rec.count} 次）` : msg;
            const entry = document.createElement('div');
            entry.className = 'th-log-' + type;
            const time = new Date().toLocaleTimeString();
            entry.textContent = `[${time}] ${shown}`;
            logContainer.appendChild(entry);
            uiLogBuffer.push(`[${time}] ${shown}`);
            if (uiLogBuffer.length > LOG_PERSIST_MAX) uiLogBuffer.shift();
            scheduleLogPersist();
            while (logContainer.children.length > MAX_LOG_ENTRIES) logContainer.removeChild(logContainer.children[0]);
            logContainer.scrollTop = logContainer.scrollHeight;
        }
        function alertBanner(title, detail, type = 'error', onClose) {
            try {
                let box = document.getElementById('th-alert-banner');
                if (!box) {
                    box = document.createElement('div');
                    box.id = 'th-alert-banner';
                    box.style.cssText = ['position:fixed', 'top:16px', 'left:50%', 'transform:translateX(-50%)',
                        'z-index:2147483600', 'max-width:min(560px, 92vw)', 'font-size:14px', 'line-height:1.6',
                        'display:none', 'font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif'
                    ].join(';');
                    (document.body || document.documentElement).appendChild(box);
                }
                const skins = {
                    error: { bg: '#7f1d1d', fg: '#fecaca', hi: '#fca5a5' },
                    warn: { bg: '#78350f', fg: '#fef3c7', hi: '#fcd34d' },
                    success: { bg: '#064e3b', fg: '#d1fae5', hi: '#6ee7b7' }
                };
                const s = skins[type] || skins.error;
                const card = document.createElement('div');
                card.style.cssText = 'padding:14px 18px;border-radius:12px;margin-bottom:8px;white-space:pre-wrap;'
                    + 'word-break:break-word;box-shadow:0 10px 40px rgba(0,0,0,.35)';
                card.style.background = s.bg; card.style.color = s.fg; card.style.border = `2px solid ${s.hi}`;
                const head = document.createElement('div');
                head.textContent = title;
                head.style.cssText = `font-weight:700;font-size:16px;margin-bottom:6px;color:${s.hi}`;
                card.appendChild(head);
                if (detail) {
                    const body = document.createElement('div');
                    body.textContent = detail;
                    card.appendChild(body);
                }
                const close = document.createElement('div');
                close.textContent = '知道了（点这里关掉）';
                close.style.cssText = 'margin-top:10px;text-align:center;cursor:pointer;'
                    + `border:1px solid ${s.hi};border-radius:6px;padding:5px 0;font-weight:600`;
                close.addEventListener('click', () => {
                    if (card.parentNode) card.parentNode.removeChild(card);
                    if (!box.children.length) box.style.display = 'none';
                    try { if (typeof onClose === 'function') onClose(); } catch (e) { /* 忽略 */ }
                });
                card.appendChild(close);
                box.appendChild(card);
                while (box.children.length > 3) box.removeChild(box.children[0]);
                box.style.display = 'block';
                log(`【页面提示】${title}`, type === 'error' ? 'error' : 'warn');
            } catch (e) { /* 提示失败不影响抢票 */ }
        }

        // ---------- 音频：上下文 / 报警 / 接力保持唤醒 ----------
        function ensureAudioContext() {
            if (wakeCtx) return wakeCtx;
            try {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) return null;
                wakeCtx = new Ctx();
                if (wakeCtx.state === 'suspended') wakeCtx.resume();
                return wakeCtx;
            } catch (e) {
                tlog('log', '[Audio] 无法创建音频上下文:', e.message);
                return null;
            }
        }
        let alarmNodes = null;
        function startAlarm() {
            if (cfg.alarmEnabled === false) return;
            if (alarmNodes) return;
            const ctx = ensureAudioContext();
            if (!ctx) return;
            try {
                const carrier = ctx.createOscillator();
                const gate = ctx.createOscillator();
                const gateDepth = ctx.createGain();
                const out = ctx.createGain();
                carrier.type = 'sine'; carrier.frequency.value = 880;
                gate.type = 'square'; gate.frequency.value = 1;
                gateDepth.gain.value = 0.2;
                out.gain.value = 0.2;
                gate.connect(gateDepth); gateDepth.connect(out.gain);
                carrier.connect(out); out.connect(ctx.destination);
                carrier.start(); gate.start();
                alarmNodes = { carrier, gate, gateDepth, out };
                tlog('log', '[Alarm] 连续报警已启动');
            } catch (e) { tlog('log', '[Alarm] 启动失败:', e.message); }
            try { window.focus(); } catch (e) { /* 忽略 */ }
        }
        function stopAlarm() {
            if (!alarmNodes) return;
            const n = alarmNodes; alarmNodes = null;
            try {
                n.carrier.stop(); n.gate.stop();
                n.carrier.disconnect(); n.gate.disconnect(); n.gateDepth.disconnect(); n.out.disconnect();
            } catch (e) { /* 已停就算了 */ }
            tlog('log', '[Alarm] 报警已停止');
        }
        // 接力期间保持唤醒：维持一个极低音量、近乎听不见的信号。
        // 为什么有用：Chrome 对「正在出声」的页面豁免深度定时器限流，
        // 而跨时段等第二段（几小时）正好是最容易被限流的场景。
        function setKeepAwake(on) {
            if (!on) {
                if (wakeNode) {
                    try { wakeNode.osc.stop(); wakeNode.osc.disconnect(); wakeNode.gain.disconnect(); } catch (e) { /* 忽略 */ }
                    wakeNode = null;
                    tlog('log', '[Wake] 保持唤醒已关闭');
                }
                return;
            }
            if (wakeNode) return;
            const ctx = ensureAudioContext();
            if (!ctx) return;
            try {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = 18600;   // 近乎听不见
                gain.gain.value = 0.008;       // 非零即可让浏览器判定"在出声"
                osc.connect(gain); gain.connect(ctx.destination);
                osc.start();
                wakeNode = { osc, gain };
                tlog('log', '[Wake] 保持唤醒已开启');
            } catch (e) { tlog('log', '[Wake] 开启失败:', e.message); }
        }
        function isKeepAwakeOn() { return !!wakeNode; }

        // ---------- 日历 ----------
        function dateKey(d) { return d.y * 10000 + d.m * 100 + d.d; }
        function toDateObj(iso) {
            const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
            return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
        }
        function isoOf(d) { return `${d.y}-${pad2(d.m)}-${pad2(d.d)}`; }
        function todayObj() { const d = serverNow(); return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }; }
        function addDays(d, n) {
            const t = new Date(d.y, d.m - 1, d.d);
            t.setDate(t.getDate() + n);
            return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
        }
        function mainDateObj() {
            const list = cfg.trainDates || [];
            return toDateObj(list[0]) || todayObj();
        }
        function extraDates() {
            const list = cfg.trainDates || [];
            return list.slice(1).map(toDateObj).filter(Boolean);
        }
        function refreshDate() {
            const m = mainDateObj();
            const ex = extraDates();
            const hasDates = (cfg.trainDates || []).length > 0;
            const rsv = cfg.reserveDate ? toDateObj(cfg.reserveDate) : null;
            const rsvTxt = rsv ? `${pad2(rsv.m)}-${pad2(rsv.d)}` : '';
            const el = $('#th-date-main');
            if (el) {
                // 只设了预约时，标题直接显示预约那一天 ——
                // 否则日历收起后你会看到"日期还是今天"，以为预约没生效。
                el.textContent = (!hasDates && rsv)
                    ? `${rsvTxt} 预约`
                    : `${pad2(m.m)}-${pad2(m.d)} ${'周' + '日一二三四五六'[new Date(m.y, m.m - 1, m.d).getDay()]}`;
            }
            const sub = $('#th-date-sub');
            if (sub) {
                const bits = [];
                if (hasDates) bits.push(ex.length ? `备选 ${ex.length} 天` : '只抢这一天');
                if (rsv) bits.push(`＋预约 ${rsvTxt}`);
                if (!bits.length) bits.push('只抢这一天');
                sub.textContent = bits.join(' · ');
            }
            const sum = $('#th-date-sum');
            if (sum) {
                if (!hasDates && rsv) {
                    sum.innerHTML = `只抢<b>预约</b>那天：<b>${rsvTxt}</b>（预售期外，到点自动查票并抢）`;
                } else {
                    const all = [m].concat(ex.slice().sort((a, b) => dateKey(a) - dateKey(b)));
                    sum.innerHTML = '已选 ' + all.length + ' 天：' + all.map((d, i) =>
                        i === 0 ? `<b>${pad2(d.m)}-${pad2(d.d)}</b>` : `${pad2(d.m)}-${pad2(d.d)}`).join(' · ')
                        + (rsv ? ` <b>＋预约 ${rsvTxt}</b>` : '');
                }
            }
            renderCal();
            refreshReserveRow();
            touchConfig();
        }
        function renderCal() {
            const grid = $('#th-cal-grid');
            if (!grid) return;
            $('#th-cal-title').textContent = `${state0().cal.y} 年 ${state0().cal.m} 月`;
            grid.innerHTML = '';
            ['一', '二', '三', '四', '五', '六', '日'].forEach(w => {
                const e = document.createElement('div');
                e.className = 'th-wd'; e.textContent = w; grid.appendChild(e);
            });
            const y = state0().cal.y, mo = state0().cal.m;
            const lead = (new Date(y, mo - 1, 1).getDay() + 6) % 7;
            const days = new Date(y, mo, 0).getDate();
            for (let i = 0; i < lead; i++) {
                const p = document.createElement('button');
                p.className = 'th-day pad'; grid.appendChild(p);
            }
            const t0 = dateKey(todayObj());
            const tEnd = dateKey(addDays(todayObj(), PRESALE_DAYS - 1));
            const main = mainDateObj();
            const ex = extraDates();
            for (let d = 1; d <= days; d++) {
                const cur = { y, m: mo, d };
                const k = dateKey(cur);
                const b = document.createElement('button');
                b.className = 'th-day';
                b.textContent = d;
                if (k < t0) {
                    b.classList.add('pad');
                    b.title = '已经过去了';
                    grid.appendChild(b);
                    continue;
                }
                if (k > tEnd) {
                    // 预售期外：12306 查不到任何数据，但**可以预约** ——
                    // 手填/推算一个开火时刻，到点脚本自己去查票并开抢（v2 就是这个用法）。
                    const iso = isoOf(cur);
                    b.classList.add('future');
                    if (cfg.reserveDate === iso) b.classList.add('reserved');
                    b.title = cfg.reserveDate === iso ? '已设为预约，再点一下取消' : '预售期外：点一下设为「预约抢票」';
                    b.addEventListener('click', () => pickReserveDate(iso));
                    grid.appendChild(b);
                    continue;
                }
                if (dateKey(main) === k) b.classList.add('main');
                else if (ex.some(x => dateKey(x) === k)) b.classList.add('extra');
                b.addEventListener('click', ev => {
                    if (ev.shiftKey) {
                        const a = dateKey(main), z = k;
                        const lo = Math.min(a, z), hi = Math.max(a, z);
                        const t = new Date(main.y, main.m - 1, main.d);
                        const out = [];
                        for (let n = 0; n < 400; n++) {
                            const kk = t.getFullYear() * 10000 + (t.getMonth() + 1) * 100 + t.getDate();
                            if (kk > hi) break;
                            if (kk >= lo && kk !== a) out.push({ y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() });
                            t.setDate(t.getDate() + 1);
                        }
                        cfg.trainDates = [isoOf(main)].concat(out.map(isoOf));
                    } else {
                        const iso = isoOf(cur);
                        if ((cfg.trainDates || [])[0] === iso) {
                            // 再点一次已选中的日期 = 取消它。
                            // 没这个的话主日期就永远去不掉 —— 想"只留预约"根本做不到。
                            cfg.trainDates = (cfg.trainDates || []).slice(1);
                        } else {
                            const rest = (cfg.trainDates || []).slice(1).filter(x => x !== iso);
                            cfg.trainDates = [iso].concat(rest);
                        }
                        // 一个日期都不剩、也没有预约时，把日历留在展开状态，
                        // 免得面板变成"什么都没有"还自动收起来，让人以为点坏了
                        if (!cfg.trainDates.length && !cfg.reserveDate) {
                            showFutureNote(isoOf(addDays(todayObj(), PRESALE_DAYS)));
                        } else {
                            setCalOpen(false);
                            hideFutureNote();
                        }
                    }
                    saveConfig(cfg);
                    refreshDate();
                });
                grid.appendChild(b);
            }
        }
        function setCalOpen(open) {
            const r = $('#th-date-row'), b = $('#th-date-bd');
            if (r) r.classList.toggle('open', open);
            if (b) b.classList.toggle('open', open);
            if (open) {
                // 一打开就说清"预售期到哪天、下一个窗口外的日期该什么时候回来抢"
                showFutureNote(isoOf(addDays(todayObj(), PRESALE_DAYS)));
            }
        }
        // ---- 预售期外的日期：算"该哪天几点回来抢" ----
        // 12306 的规则：出行日期 T 的票，在 T-(预售期-1) 那天、按**乘车站的起售时刻**开售。
        // 起售时刻按乘车站固定（杭州东 10:45、上海虹桥 13:45 这种），
        // 所以只要查过一次预售期内的日期，就能把它记下来推算任意未来日期。
        function saleMomentOf(iso) {
            const t = toDateObj(iso);
            if (!t) return null;
            const s = addDays(t, -(PRESALE_DAYS - 1));
            return { m: pad2(s.m), d: pad2(s.d) };
        }
        function futureText(iso) {
            const s = saleMomentOf(iso);
            if (!s) return '';
            const who = currentFromName() || '出发站';
            const st = saleTimeForCurrent();
            if (!st) {
                return `${iso} 的票还没开售（12306 预售期 ${PRESALE_DAYS} 天，今天最远能买 `
                    + `${pad2(addDays(todayObj(), PRESALE_DAYS - 1).m)}-${pad2(addDays(todayObj(), PRESALE_DAYS - 1).d)}）。`
                    + `<b>脚本还不知道「${who}」的起售时刻</b> —— 点一次「下一步」它就会学到（就算只设了预约，它也会单独查一天去学）。`;
            }
            return `${iso} 的票还没开售。<b>${who} 的起售时刻是 ${st}</b> —— 预计 <b>${s.m}-${s.d} ${st}</b> 开售。`
                + `<b>到那天再来点一次「下一步」</b>，脚本会把开火时间自动定到那一刻。`;
        }
        function showFutureNote(iso) {
            const el = $('#th-calnote');
            if (!el) return;
            el.innerHTML = futureText(iso);
            el.classList.add('show');
        }
        function hideFutureNote() {
            const el = $('#th-calnote');
            if (el) el.classList.remove('show');
        }
        function pickReserveDate(iso) {
            cfg.reserveDate = (cfg.reserveDate === iso) ? '' : iso;
            if (!cfg.reserveDate) cfg.reserveAt = '';
            if (cfg.reserveDate && (cfg.trainDates || []).length) {
                // 「预约」的意思是"我要的就是那一天"，所以把原来的出行日期清掉：
                // 否则方案里会混进你并不想抢的日期的车次，还白花查询额度。
                // 两个都想要的话，再点一次日期就加回来了。
                cfg.trainDates = [];
                log(`已设为预约 ${iso}，同时清掉了原来的出行日期（预约 = 只抢那一天）。`
                    + '如果两个都要抢，再点一次那两个日期即可。', 'info');
            }
            saveConfig(cfg);
            refreshDate();
            if (cfg.reserveDate) showFutureNote(iso); else hideFutureNote();
        }
        // 当前填的出发站名（起售时刻按这个站查表，不是"上次那个站"）
        function currentFromName() {
            const el = $('#th-from');
            return el ? String(el.value || '').trim() : '';
        }
        // 当前出发站的起售时刻。
        // ★ 查不到就说查不到，**绝不退回用别的站的旧值** ——
        //   那会按错误的时刻开火（比如上海虹桥 13:45 用到杭州东上，晚 3 小时），
        //   而且界面上完全看不出来。
        function saleTimeForCurrent() {
            const n = currentFromName();
            return (n && cfg.saleTimes && cfg.saleTimes[n]) || '';
        }
        // 预约的开火时刻 = 「出行日期 − (预售期−1)」那天的起售时刻。
        // 这个推算和 v2 手填时刻是一回事，只是把"你得自己去查几点开售"这一步省了。
        function reserveFireAt(iso, hhmm) {
            const t = String(hhmm || cfg.reserveAt || saleTimeForCurrent() || '').trim();
            const m = t.match(/^(\d{1,2}):(\d{2})/);
            const day = toDateObj(iso || cfg.reserveDate);
            if (!m || !day) return 0;
            const s = addDays(day, -(PRESALE_DAYS - 1));
            return saleTsOf(isoOf(s), `${pad2(parseInt(m[1], 10))}:${m[2]}`);
        }
        function refreshReserveRow() {
            const row = $('#th-reserve-row');
            if (!row) return;
            if (!cfg.reserveDate) { row.style.display = 'none'; return; }
            row.style.display = 'block';
            const at = $('#th-reserve-at');
            const fire = reserveFireAt(cfg.reserveDate);
            const fmt = fmtClockDate;
            const who = currentFromName() || '出发站';
            const st = saleTimeForCurrent();
            $('#th-reserve-date').textContent = cfg.reserveDate;
            if (at && document.activeElement !== at) at.value = cfg.reserveAt || st || '';
            const hint = $('#th-reserve-hint');
            if (fire) {
                // 手填的时刻也带出处：如果它是给**另一个站**填的，必须当场说清楚。
                // 不然你换了出发站，旧时刻还在用，看起来像"没生效"，其实是用了错的站的值。
                const staleFor = (cfg.reserveAt && cfg.reserveAtFor && cfg.reserveAtFor !== who) ? cfg.reserveAtFor : '';
                hint.innerHTML = `<b>${fmt(fire)}</b>（服务器时间）开火。到点脚本会自己去查票并开抢——`
                    + `车次不限（除非你在第①步填了车次），席别按你的优先顺序。`
                    + (cfg.reserveAt ? '' : `（开火时刻是按 ${who} 的起售时刻 ${st} 推算的，可改）`)
                    + (staleFor
                        ? `<br><b style="color:var(--red)">⚠ 注意：这个 ${cfg.reserveAt} 是你在出发站是「${staleFor}」时填的。`
                          + `现在出发站是「${who}」，起售时刻通常不一样 —— 请点「用起售时刻」或重新填一个。</b>`
                        : '');
            } else if (!st) {
                hint.innerHTML = `<b>还不知道「${who}」的起售时刻</b> —— 点一次「下一步」脚本就会去学`
                    + `（就算只设了预约，它也会单独查一天学回来）；也可以直接在上面手填一个几点。`;
            } else {
                hint.innerHTML = `<b>还差开火时刻</b>——填一个几点，或者点「用起售时刻」填 ${st}。`;
            }
        }
        // uiState 的 cal 放在一个 getter 里，避免和闭包变量名冲突
        function state0() { return uiState; }

        // ---------- 顶部回顾 ----------
        function refreshRecap() {
            const el = $('#th-recap-txt');
            if (!el) return;
            const seats = seatChipsOn().map(c => c.textContent.trim());
            const pax = $$('#th-pax .th-pax-chip.on').map(c => c.querySelector('.th-nm').textContent);
            const m = mainDateObj();
            const ex = extraDates().length;
            el.textContent = [
                `${pad2(m.m)}-${pad2(m.d)}` + (ex ? ` +${ex} 天` : ''),
                `${($('#th-from') || {}).value || '?'} → ${($('#th-to') || {}).value || '?'}`,
                seats.length ? (seats.length > 2 ? seats.slice(0, 2).join('/') + ` 等 ${seats.length} 种` : seats.join('/')) : '未选席别',
                pax.length ? pax.join('、') : '未选乘车人'
            ].join(' · ');
        }

        // ---------- 席别 ----------
        function seatChipsOn() { return $$('#th-seats .th-chip.on'); }
        function seatCodesInOrder() {
            // DOM 顺序就是点选顺序（点一下排到最后）
            return seatChipsOn().map(c => c.dataset.code);
        }
        function renderSeatSum() {
            const on = seatChipsOn();
            const el = $('#th-seat-sum');
            if (!el) return;
            if (!on.length) { el.className = 'th-sum warn'; el.textContent = '至少选一个席别'; return; }
            el.className = 'th-sum';
            el.innerHTML = '优先顺序：' + on.map(c => `<b>${c.textContent.trim()}</b>`).join(' → ');
        }
        // ---------- 座位图 ----------
        function paxCount() { return $$('#th-pax .th-pax-chip.on').length; }
        function seatTypeNow() {
            const on = seatChipsOn();
            return on.length ? on[0].textContent.trim() : '';
        }
        function renderSeatPick() {
            const st = seatTypeNow();
            const L = SEAT_LAYOUT[st];
            const head = $('#th-seatpick-head');
            if (head) head.textContent = st || '先选席别';
            const box = $('#th-seatpick-box'), off = $('#th-seatpick-off');
            if (!box || !off) return;
            if (!L) {
                box.style.display = 'none';
                off.style.display = 'block';
                uiState.letters = [];
                return;
            }
            box.style.display = 'block';
            off.style.display = 'none';
            const g = $('#th-layout');
            g.innerHTML = '';
            const mkBlock = list => {
                const d = document.createElement('div');
                d.className = 'th-blk';
                list.forEach(s => {
                    const b = document.createElement('button');
                    b.className = 'th-seat' + (uiState.letters.indexOf(s[0]) > -1 ? ' on' : '');
                    b.dataset.l = s[0];
                    b.innerHTML = `<b>${s[0]}</b><span>${s[1]}</span>`;
                    d.appendChild(b);
                });
                return d;
            };
            g.appendChild(mkBlock(L.left));
            const a = document.createElement('div');
            a.className = 'th-aisle'; a.textContent = '过道';
            g.appendChild(a);
            g.appendChild(mkBlock(L.right));
            renderSeatPickSum();
        }
        function renderSeatPickSum() {
            const L = SEAT_LAYOUT[seatTypeNow()], n = paxCount(), el = $('#th-seatpick-sum');
            if (!el) return;
            if (!L) { el.innerHTML = ''; return; }
            if (!uiState.letters.length) { el.innerHTML = '不选 = 由系统自动分配'; return; }
            const code = buildChooseSeatsFromLetters(uiState.letters, n);
            if (!code) {
                el.innerHTML = `已选 <b>${uiState.letters.join(' · ')}</b>，但和乘车人数（${n} 人）对不上 —— 这一单会退回自动分配`;
                return;
            }
            el.innerHTML = `已选 <b>${uiState.letters.join(' · ')}</b> → 提交 <b>${code}</b>（${n} 人）`;
        }

        // ---------- 乘车人 ----------
        function escapeAttr(v) {
            return String(v == null ? '' : v)
                .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        function renderPassengers(list) {
            const box = $('#th-pax');
            if (!box) return;
            box.innerHTML = '';
            if (!list.length) {
                box.innerHTML = '<div class="th-hint">还没有加载到乘车人 —— 点右上角「重新加载」</div>';
                return;
            }
            list.forEach(p => {
                const name = p.passenger_name;
                const isStu = cfg.passengerDetails && cfg.passengerDetails[name] && cfg.passengerDetails[name].isStudent === true;
                const chip = document.createElement('button');
                chip.className = 'th-pax-chip' + ((cfg.passengers || []).indexOf(name) > -1 ? ' on' : '') + (isStu ? ' stu' : '');
                chip.dataset.name = name;
                chip.dataset.full = JSON.stringify(p);
                chip.innerHTML = `<span class="th-nm">${escapeAttr(name)}</span><span class="th-st">学</span>`;
                box.appendChild(chip);
            });
            renderSeatPick();
            // 乘车人列表加载完之后按钮上的"还差什么"要跟着变
            updateFooter();
        }

        // ---------- 高级里的开关 ----------
        function bindSwitch(id, key, onChange) {
            const el = $(id);
            if (!el) return;
            el.checked = cfg[key] !== false && cfg[key] !== undefined ? !!cfg[key] : !!DEFAULT_CONFIG[key];
            el.addEventListener('change', () => {
                cfg[key] = el.checked;
                saveConfig(cfg);
                if (typeof onChange === 'function') onChange(el.checked);
                touchConfig();
            });
        }

        // ---------- 方案列表 ----------
        function orderOf(key) {
            const i = uiState.planState.order.indexOf(key);
            return i < 0 ? 1e6 : i;
        }
        function orderedPlans() {
            return uiState.plans.slice().sort((a, b) => {
                const d = orderOf(a.key) - orderOf(b.key);
                return d !== 0 ? d : (a.seq - b.seq);
            });
        }
        function visiblePlans() {
            // 'y'（预约）没有筛选开关，永远可见
            return orderedPlans().filter(p => (p.type === 'y' || uiState.filters[p.type]) && !uiState.planState.removed[p.key]);
        }
        function activePlans() {
            return visiblePlans().filter(p => p.ok !== false && !uiState.planState.unsel[p.key]);
        }
        function groupPlans(list) {
            const groups = [];
            list.forEach(p => {
                const w = p.win || '随时';
                let g = groups.find(x => x.w === w);
                if (!g) { g = { w, at: p.winAt || 0, items: [] }; groups.push(g); }
                g.items.push(p);
            });
            groups.sort((a, b) => a.at - b.at);
            return groups;
        }
        function renderPlans() {
            const list = $('#th-plans');
            if (!list) return;
            list.innerHTML = '';
            const groups = groupPlans(visiblePlans());
            groups.forEach(g => {
                const hd = document.createElement('div');
                hd.className = 'th-grp';
                // 起售时间已经过去的组不该写"开火"——那是"现在就能抢，在捡漏"，
                // 两者对用户要做的事完全不一样（一个要守着，一个随时可点）
                const started = g.at && g.at <= Date.now();
                const title = started ? `已开售（${g.w} 起售）` : `${g.w} 开火`;
                hd.innerHTML = `<span class="th-t">${title}</span><i></i><span class="th-n">${g.items.length} 条</span>`;
                list.appendChild(hd);
                g.items.forEach(p => list.appendChild(planRow(p)));
            });
            bindDrag();
            renderCount();
        }
        function planRow(p) {
            const row = document.createElement('div');
            const sel = !uiState.planState.unsel[p.key];
            row.className = 'th-plan' + (sel ? ' sel' : '') + (p.ok === false ? ' no' : '');
            row.draggable = true;
            row.dataset.key = p.key;
            row.dataset.win = p.win || '';
            const legs = p.legs ? '<div class="th-legs">' + p.legs.map(l =>
                `<div class="th-leg"><span class="th-seg">${l.seg}</span>`
                + (l.code ? `<span>${l.code}</span>` : '')
                + `<span class="th-sl">${l.sale} 开售</span></div>`).join('') + '</div>' : '';
            row.innerHTML =
                '<span class="th-grip">⠿</span>' +
                `<input type="checkbox"${sel ? ' checked' : ''}${p.ok === false ? ' disabled' : ''}>` +
                '<div class="th-body2">' +
                  `<div class="th-l1"><span class="th-badge ${p.type}">${p.typeName}</span>` +
                  `<span class="th-code">${p.title}</span></div>` +
                  '<div class="th-l2">'
                    + (p.priceText ? `<span class="price">${p.priceText}</span>` : '')
                    + p.lines.map(x => `<span class="${x.cls || ''}">${x.t}</span>`).join('')
                  + '</div>' +
                  legs +
                '</div>' +
                '<button class="th-del" title="删掉这条，重新查也不会再出现">✕</button>';
            const cb = row.querySelector('input');
            cb.addEventListener('change', () => {
                if (cb.checked) delete uiState.planState.unsel[p.key];
                else uiState.planState.unsel[p.key] = true;
                row.classList.toggle('sel', cb.checked);
                savePlanState(uiState.planState);
                renderCount(); updateFooter();
            });
            row.querySelector('.th-del').addEventListener('click', () => {
                uiState.planState.removed[p.key] = true;
                savePlanState(uiState.planState);
                renderPlans(); updateFooter();
            });
            return row;
        }
        function bindDrag() {
            let dragging = null;
            $$('#th-plans .th-plan').forEach(row => {
                row.addEventListener('dragstart', () => { dragging = row; row.classList.add('dragging'); });
                row.addEventListener('dragend', () => {
                    row.classList.remove('dragging');
                    $$('#th-plans .th-plan').forEach(r => r.classList.remove('dropzone'));
                    dragging = null;
                    const order = $$('#th-plans .th-plan').map(r => r.dataset.key);
                    // 没被拖过的方案补在后面，保持稳定
                    const rest = uiState.plans.map(p => p.key).filter(k => order.indexOf(k) < 0);
                    uiState.planState.order = order.concat(rest);
                    savePlanState(uiState.planState);
                    renderCount();
                });
                row.addEventListener('dragover', e => {
                    e.preventDefault();
                    if (!dragging || dragging === row) return;
                    if (dragging.dataset.win !== row.dataset.win) return;   // 只在同一开火组内排序
                    $$('#th-plans .th-plan').forEach(r => r.classList.remove('dropzone'));
                    row.classList.add('dropzone');
                    const rect = row.getBoundingClientRect();
                    const after = (e.clientY - rect.top) > rect.height / 2;
                    row.parentNode.insertBefore(dragging, after ? row.nextSibling : row);
                });
                row.addEventListener('drop', e => e.preventDefault());
            });
        }
        function renderCount() {
            ['z', 'c', 't'].forEach(t => {
                const n = uiState.plans.filter(p => p.type === t && !uiState.planState.removed[p.key]).length;
                const chip = document.querySelector(`#${PANEL_ID} #th-filters .th-chip[data-f="${t}"]`);
                const lg = document.querySelector(`#${PANEL_ID} #th-legend .th-lg[data-l="${t}"]`);
                const cnt = document.querySelector(`#${PANEL_ID} #th-cnt-${t}`);
                if (cnt) cnt.textContent = ' ' + n;
                if (chip) {
                    if (!n) { chip.classList.remove('on'); chip.classList.add('locked'); uiState.filters[t] = false; }
                    else chip.classList.remove('locked');
                }
                if (lg) lg.classList.toggle('off', !uiState.filters[t]);
            });
            const sel = activePlans().length;
            const all = visiblePlans().length;
            const pc = $('#th-pick-count');
            if (pc) pc.textContent = `已选 ${sel} 条`;
            const oh = $('#th-order-hint');
            if (oh) {
                oh.innerHTML = sel
                    ? `按住 ⠿ 拖动排序（<b>只在同一开火组内</b>）。到点开火后，按这个顺序从上到下试。`
                    : '<b>一条都没勾</b>——回上面勾几条。';
            }
            const removed = Object.keys(uiState.planState.removed).length;
            const rs = $('#th-restore');
            if (rs) {
                rs.style.display = removed ? 'inline' : 'none';
                rs.textContent = removed ? `恢复已删 ${removed} 条` : '';
            }
            updateRelayWarn();
        }

        // ---------- 接力提醒 ----------
        function relayGapMin() {
            let gap = 0;
            activePlans().forEach(p => {
                if (p.type !== 't' || !p.saleGapMin) return;
                if (p.saleGapMin > gap) gap = p.saleGapMin;
            });
            return gap;
        }
        function updateRelayWarn() {
            const box = $('#th-relay-warn');
            if (!box) return;
            const gap = relayGapMin();
            if (gap >= 120 && !cfg.relayWarnOff) {
                const h = Math.floor(gap / 60), m = gap % 60;
                $('#th-relay-warn-title').textContent = `这一单要分两次抢，中间隔 ${h} 小时${m ? ' ' + m + ' 分' : ''}`;
                box.style.display = 'block';
            } else {
                box.style.display = 'none';
            }
        }

        // ---------- 第 3 步：运行列表 ----------
        // 人话时长：天/小时/分/秒，按需省略高位
        function humanLeft(ms) {
            const s = Math.max(0, Math.floor(ms / 1000));
            const d = Math.floor(s / 86400);
            const h = Math.floor((s % 86400) / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = s % 60;
            if (d) return `${d} 天 ${h} 小时 ${m} 分`;
            if (h) return `${h} 小时 ${m} 分 ${pad2(sec)} 秒`;
            if (m) return `${m} 分 ${pad2(sec)} 秒`;
            return `${sec} 秒`;
        }
        function updateNextFire() {
            const el = $('#th-next-fire');
            if (!el) return;
            const now = Date.now();
            let best = null;
            activePlans().forEach(p => {
                (p.units || []).forEach(u => {
                    if (u.status === 'got' || u.status === 'fail') return;
                    if (u.saleAt && u.saleAt > now && (best === null || u.saleAt < best)) best = u.saleAt;
                });
            });
            if (best === null) {
                el.innerHTML = uiState.running ? '勾选的方案都已开售 —— 正在捡漏' : '勾选的方案都已开售';
                return;
            }
            const diff = best - now;
            const urgent = diff <= 60000;
            el.innerHTML = `下一场开火 <b>${fmtClock(best)}</b> · 还有 `
                + `<b${urgent ? ' style="color:var(--red)"' : ''}>${humanLeft(diff)}</b>`
                + (urgent ? ' —— 就快了，别切走标签页' : '');
        }
        // 把「服务器时间」和「本地差多少」摆出来。
        // 起售时刻是服务器的时间；本地时钟偏几十秒的话，你会觉得脚本早了或晚了，
        // 所以直接把校验结果显示出来，而不是藏在日志里。
        function updateClockLine() {
            const el = $('#th-clock');
            if (!el) return;
            const sn = serverNow();
            const t = `${pad2(sn.getHours())}:${pad2(sn.getMinutes())}:${pad2(sn.getSeconds())}`;
            if (serverClockOffset === null) {
                el.innerHTML = `服务器时间 <b>${t}</b> · 还没校准（等一次查票响应）`;
                return;
            }
            const sec = Math.round(serverClockOffset / 1000);
            if (Math.abs(sec) < 1) {
                el.innerHTML = `服务器时间 <b>${t}</b> · 本机时钟准`;
                return;
            }
            const sign = sec > 0 ? '慢' : '快';
            const warn = Math.abs(sec) >= 30;
            el.innerHTML = `服务器时间 <b>${t}</b> · 本机${sign} ${Math.abs(sec)} 秒`
                + (warn ? ` <span style="color:var(--amber)">（差得有点多，脚本已按服务器时间开火）</span>` : '');
        }
        // 每秒跳一次。
        // 为什么必须单独有它：原来倒计时只在"一轮查完"时更新，而"所有段都在等开售"
        // 走的是提前返回的分支，根本不更新 —— 盯着看的数字是死的。
        let tickTimer = null;
        function startClock() {
            if (tickTimer) return;
            tickTimer = setInterval(() => {
                if (!uiState.running) return;
                updateNextFire();
                updateClockLine();
            }, 1000);
        }
        function renderRunList() {
            const box = $('#th-run-list');
            if (!box) return;
            updateReserveWarn();
            const sel = activePlans();
            box.innerHTML = '';
            if (!sel.length) {
                box.innerHTML = '<div class="th-run-row">还没有勾选任何方案 —— 回第 ② 步勾几条再来</div>';
                return;
            }
            let focus = 0;
            sel.forEach((p, i) => {
                const st = planStatusOf(p);
                if (st.kind === 'hit') focus = i;
            });
            sel.forEach((p, i) => {
                const st = planStatusOf(p);
                const row = document.createElement('div');
                row.className = 'th-run-row' + (i === focus ? ' now' : '');
                const head = `<span class="th-no">${i + 1}</span>`
                    + `<span class="th-badge ${p.type}">${p.typeName}</span>`
                    + `<span class="th-rc">${p.title}</span>`
                    + `<span class="th-rs">${[p.saleShort || '', p.priceText || ''].filter(Boolean).join(' · ')}</span>`
                    + `<span class="th-rv ${st.kind}">${st.text}</span>`;
                const legs = (p.units && p.units.length > 1)
                    ? '<div class="th-legs">' + p.units.map(u =>
                        `<div class="th-leg"><span class="th-seg">${u.dest.fromName}→${u.dest.toName}</span>`
                        + (u.train ? `<span>${u.train.trainCode}</span>` : '')
                        + `<span class="th-sl">${u.saleText}</span>`
                        + `<span class="th-st">${unitStatusText(u)}</span></div>`).join('') + '</div>'
                    : '';
                row.innerHTML = head + legs;
                box.appendChild(row);
            });
            const rc = $('#th-run-count');
            if (rc) rc.textContent = sel.length ? `共 ${sel.length} 条` : '';
        }
        // 第③步：有条目是"预约"时，明确写出它只抢直达 ——
        // 别让人盯着运行列表以为中转也在抢。
        function updateReserveWarn() {
            const el = $('#th-reserve-warn');
            if (!el) return;
            const ys = activePlans().filter(p => p.type === 'y');
            if (!ys.length) { el.style.display = 'none'; return; }
            el.style.display = 'block';
            el.innerHTML = `你有 <b>${ys.length}</b> 条<b>预约</b>（${ys.map(p => p.date).join('、')}）——`
                + '预约<b>只抢直达</b>，不含中转 / 买长乘短。'
                + '那天要是也想要中转：开售前十几分钟用正常流程点一次「下一步」，把中转一起列进方案。';
        }
        function unitStatusText(u) {
            if (u.status === 'got') return '已到手';
            if (u.status === 'hit') return '正在下单';
            if (u.status === 'wait') return u.reserve ? '预约等待中' : '还没开售';
            if (u.status === 'fail') return u.statusText || '没抢到';
            return u.statusText || '捡漏中';
        }
        function planStatusOf(p) {
            const units = p.units || [];
            if (units.some(u => u.status === 'hit')) return { kind: 'hit', text: '正在下单' };
            const got = units.filter(u => u.status === 'got').length;
            if (got && got === units.length) return { kind: 'got', text: '全部到手' };
            if (got) return { kind: 'got', text: `第 ${units.findIndex(u => u.status === 'got') + 1} 段已到手` };
            if (units.every(u => u.status === 'wait')) return { kind: 'wait', text: '还没开售' };
            if (units.some(u => u.status === 'fail')) return { kind: 'hunt', text: units.find(u => u.status === 'fail').statusText || '没抢到' };
            return { kind: 'hunt', text: '捡漏中 · 无票' };
        }

        // ---------- 步骤 / 页脚 ----------
        // 把查回来的方案装进面板，并切到第 ② 步。
        // 抽成有名字的函数是必须的：调用它的地方在下面的事件处理里，
        // 而写成对象字面量里的箭头函数就只能在那个对象里用，外面引用不到。
        function applyPlans(plans) {
            if (!Array.isArray(plans)) return;
            uiState.plans = plans;
            uiState.tested = true;
            uiState.stale = false;
            // 把没见过的 key 追加到顺序表末尾
            const ord = uiState.planState.order.filter(k => plans.some(p => p.key === k));
            plans.forEach(p => { if (ord.indexOf(p.key) < 0) ord.push(p.key); });
            uiState.planState.order = ord;
            savePlanState(uiState.planState);
            renderPlans();
            goStep(2);
            updateFooter();
        }

        function canProceed() {
            const miss = [];
            if (!seatChipsOn().length) miss.push('选席别');
            if (!paxCount()) miss.push(uiState.passengersList.length ? '勾乘车人' : '加载乘车人');
            const f = $('#th-from'), t = $('#th-to');
            if (!f.value.trim() || !t.value.trim()) miss.push('填站点');
            return miss;
        }
        function note(t) {
            const el = $('#th-ft-note');
            if (!el) return;
            el.textContent = t || '';
            el.style.display = t ? 'block' : 'none';
        }
        function updateFooter() {
            const miss = canProceed();
            const stale = uiState.stale && uiState.step >= 2;
            const bt = $('#th-btn-test'), bs = $('#th-btn-start');
            // 按钮自己说清"还差什么"——禁用状态下的按钮点不动，
            // 只在旁边写一行小字的话，用户看到的就是"点了没反应"。
            if (bt) {
                bt.disabled = miss.length > 0 || uiState.running || uiState.testing;
                if (!uiState.testing) {
                    if (miss.length) {
                        bt.textContent = '还差：' + miss.join('、');
                        bt.style.fontSize = '13px';
                    } else {
                        bt.textContent = '下一步';
                        bt.style.fontSize = '';
                    }
                }
            }
            if (bs) bs.disabled = stale || !activePlans().length;
            if (uiState.step === 1 && miss.length) note('还差：' + miss.join('、'));
            else if (stale) note('条件改过了，方案得重新查一次 —— 回第 ① 步点「下一步」。');
            else if (uiState.step === 2 && !activePlans().length) note('一条方案都没勾，抢不了。');
            else note('');
        }
        function touchConfig() {
            refreshRecap();
            if (uiState.tested) uiState.stale = true;
            updateFooter();
        }
        function goStep(n) {
            if (n === 3 && !uiState.running) return;
            uiState.step = n;
            $$('.th-pane').forEach(p => p.classList.remove('on'));
            const pane = $('#th-pane' + n);
            if (pane) pane.classList.add('on');
            $$('#th-steps .th-stp').forEach(s => {
                const i = +s.dataset.s;
                s.classList.toggle('on', i === n);
                s.classList.toggle('locked', i === 3 && !uiState.running);
                const live = s.querySelector('.th-live');
                if (i === 3 && uiState.running && !live) {
                    const d = document.createElement('span'); d.className = 'th-live'; s.appendChild(d);
                } else if (i === 3 && !uiState.running && live) live.remove();
            });
            const away = uiState.running && n !== 3;
            const set = (id, show) => { const el = $(id); if (el) el.style.display = show ? 'flex' : 'none'; };
            set('#th-ft1', n === 1 && !away);
            set('#th-ft2', (n === 2 && !away) || (n === 3 && !uiState.running));
            set('#th-ft3', n === 3 && uiState.running);
            set('#th-ftrun', away);
            const st = $('#th-status');
            if (st) st.style.display = (n === 3 || away) ? 'flex' : 'none';
            const rc = $('#th-recap');
            if (rc) rc.style.display = (n === 1) ? 'none' : 'flex';
            refreshRecap();
            updateFooter();
            if (n === 3) { renderRunList(); updateNextFire(); updateClockLine(); }
        }

        // ---------- 面板 ----------
        function createPanel() {
            const old = document.getElementById(PANEL_ID);
            if (old) old.remove();
            const styleEl = document.createElement('style');
            styleEl.textContent = STYLES;
            document.head.appendChild(styleEl);

            // 席别 chips 的 DOM 顺序必须等于用户的优先顺序 ——
            // 读取时用的是 DOM 顺序（点一下会 appendChild 到末尾），
            // 所以渲染时也要按存档里的顺序排，否则刷新一次就把顺序反转了。
            const prio = cfg.seatTypes || [];
            const seatList = Object.entries(SEAT_MAP_UI).map(([k, v]) => ({ k, name: v.name }));
            seatList.sort((a, b) => {
                const ia = prio.indexOf(a.k), ib = prio.indexOf(b.k);
                if (ia < 0 && ib < 0) return 0;
                if (ia < 0) return 1;
                if (ib < 0) return -1;
                return ia - ib;
            });
            const seatChips = seatList.map(s =>
                `<button class="th-chip${prio.indexOf(s.k) > -1 ? ' on' : ''}" data-code="${s.k}">${s.name}</button>`
            ).join('');
            const m0 = mainDateObj();
            const panel = document.createElement('div');
            panel.id = PANEL_ID;
            panel.innerHTML = `
<div class="th-hd">
  <div class="th-hd-l">抢票助手 <span class="th-v">v${SCRIPT_VERSION}</span></div>
  <div class="th-hd-r">
    <button class="th-icon" id="th-fold" title="收起">—</button>
    <button class="th-icon" id="th-close" title="关闭">✕</button>
  </div>
</div>
<div class="th-steps" id="th-steps">
  <button class="th-stp on" data-s="1"><i>1</i>条件</button>
  <button class="th-stp" data-s="2"><i>2</i>方案</button>
  <button class="th-stp locked" data-s="3"><i>3</i>抢票</button>
</div>
<button class="th-recap" id="th-recap" style="display:none"><span class="th-txt" id="th-recap-txt"></span><span class="th-go">点这里改 ›</span></button>
<div class="th-bd">

  <div class="th-pane on" id="th-pane1">
    <section>
      <div class="th-lbl">出行日期</div>
      <button class="th-fold-row" id="th-date-row">
        <span class="th-fold-main" id="th-date-main">${pad2(m0.m)}-${pad2(m0.d)}</span>
        <span class="th-fold-sub" id="th-date-sub"></span>
        <span class="th-arw">▾</span>
      </button>
      <div class="th-fold-bd" id="th-date-bd">
        <div class="th-cal">
          <div class="th-cal-hd">
            <span class="th-t" id="th-cal-title"></span>
            <span class="th-cal-nav"><button id="th-cal-prev">‹</button><button id="th-cal-next">›</button></span>
          </div>
          <div class="th-cal-grid" id="th-cal-grid"></div>
          <div class="th-calnote" id="th-calnote"></div>
        </div>
        <div class="th-quick">
          <button data-q="prev">+ 前一天</button>
          <button data-q="next">+ 后一天</button>
          <button data-q="both">+ 前后一天</button>
          <button data-q="clear">清空备选</button>
          <button data-q="clearall">清空所有日期</button>
        </div>
        <div class="th-sum" id="th-date-sum"></div>
        <div class="th-hint">点一下选主日期，<b>再点一次取消</b>，<b>Shift + 点</b>选一段。预售期 ${PRESALE_DAYS} 天。备选日越多，轮到每一天的次数越少。</div>
        <div class="th-hint">灰底的日期是预售期外的（12306 还查不到）——<b>点一下可以设成预约</b>，到点自动开抢。
          不过<b>预约只抢直达</b>，不含中转/买长乘短（设成预约时下面会说明）。</div>
      </div>
      <div class="th-reserve" id="th-reserve-row" style="display:none;margin-top:10px">
        <div class="th-rl">预约抢票：<b id="th-reserve-date"></b> 的票</div>
        <div class="th-rrow">
          <span>开火时刻</span>
          <input type="time" id="th-reserve-at" step="60">
          <button id="th-reserve-fill">用起售时刻</button>
          <button id="th-reserve-clear">取消预约</button>
        </div>
        <div class="th-rhint" id="th-reserve-hint"></div>
        <div class="th-rnote">
          <b>预约只抢直达</b>（一张票、不下车）。中转要两段都可售才查得到、买长乘短要核对经停站 ——
          开售那一秒都来不及做，所以这两样不参与预约。
        </div>
        <div class="th-rnote">
          想把中转/买长乘短也一起抢：等这个日期<b>进了预售期</b>之后，在<b>开售前十几分钟</b>用正常流程 ——
          回第 ① 步点一次「下一步」，那时直达 / 买长乘短 / 中转会全列出来，各自标好开火时刻。
        </div>
      </div>
    </section>

    <section>
      <div class="th-lbl">从哪到哪</div>
      <div class="th-row">
        <input class="th-inp" id="th-from" value="${escapeAttr(cfg.fromStation)}" placeholder="杭州东">
        <button class="th-swap" id="th-swap" title="交换">⇄</button>
        <input class="th-inp" id="th-to" value="${escapeAttr(cfg.toStation)}" placeholder="瑞金">
      </div>
    </section>

    <section>
      <div class="th-lbl">席别<span class="th-aside">点选顺序 = 优先顺序</span></div>
      <div class="th-chips" id="th-seats">${seatChips}</div>
      <div class="th-sum" id="th-seat-sum"></div>
      <input class="th-inp" id="th-trains" value="${escapeAttr((cfg.trainCodes || []).join(','))}" placeholder="车次，留空 = 不限车次" style="margin-top:10px">
    </section>

    <section>
      <div class="th-lbl">谁坐<span class="th-aside"><button id="th-reload-pax">重新加载</button></span></div>
      <div class="th-pax" id="th-pax"></div>
      <div class="th-hint">点姓名选中，点「学」标记学生票。</div>
    </section>

    <section class="th-adv" id="th-adv">
      <div class="th-adv-hd" id="th-adv-hd"><span class="th-t">高级设置</span><span class="th-arw">▶</span></div>
      <div class="th-adv-bd">
        <div style="padding:2px 0 4px">
          <div class="th-lbl">想坐哪儿<span class="th-aside" id="th-seatpick-head"></span></div>
          <div id="th-seatpick-box">
            <div class="th-layout" id="th-layout"></div>
            <div class="th-chips" id="th-seatquick" style="margin-top:9px">
              <button class="th-chip" data-p="win">靠窗</button>
              <button class="th-chip" data-p="aisle">靠过道</button>
              <button class="th-chip" data-p="together">挨着坐</button>
              <button class="th-chip${(cfg.seatPref || 'any') === 'any' ? ' on' : ''}" data-p="any">无所谓</button>
            </div>
            <div class="th-sum" id="th-seatpick-sum"></div>
          </div>
          <div class="th-note" id="th-seatpick-off" style="display:none">
            这一单不给选座。<b>商务座 / 优选一等座在不同车型上的排布不一样</b>（1+2 还是 1+1 都可能），
            字母集对不上——猜错会让 12306 把整单判成非法参数，比不选座严重得多。由系统自动分配。
          </div>
          <div class="th-hint">上面就是车厢布局，点座位号直接选；也可以用下面的快捷方式。这趟车要是不支持选座，脚本会自动退回随机分配。</div>
        </div>
        <div class="th-sw">
          <div class="th-tx"><div class="th-t">接受同城其它车站</div>
            <div class="th-d">可能买到别的站，你还得自己换过去坐车。</div></div>
          <input type="checkbox" id="th-sw-samecity">
        </div>
        <div class="th-sw">
          <div class="th-tx"><div class="th-t">备选到达站（买长乘短）</div>
            <div class="th-d">买远一点、提前下车。脚本会核对这趟车确实经停你的到达站，不经过的不买。</div></div>
          <input type="checkbox" id="th-sw-alt">
        </div>
        <div id="th-alt-box" style="padding:0 0 6px">
          <input class="th-inp" id="th-alt-to" value="${escapeAttr(cfg.altToStation || '')}" placeholder="留空 = 不用这一招，如：长汀南">
        </div>
        <div class="th-sw">
          <div class="th-tx"><div class="th-t">自动提交候补</div>
            <div class="th-d">该段开售之后才交得上，脚本在开火窗口里顺手交。同一账号别在手机上重复交，额度共用。</div></div>
          <input type="checkbox" id="th-sw-waitlist">
        </div>
        <div class="th-sw">
          <div class="th-tx"><div class="th-t">掉线时连续报警</div>
            <div class="th-d">一直响，直到你切回这个页面。</div></div>
          <input type="checkbox" id="th-sw-alarm">
        </div>
        <div class="th-sw">
          <div class="th-tx"><div class="th-t">声音提示</div></div>
          <input type="checkbox" id="th-sw-sound">
        </div>
        <div class="th-sw">
          <div class="th-tx"><div class="th-t">优选静音车厢</div>
            <div class="th-d">只在二等座、且这趟车确实有静音车厢时生效，其余情况自动忽略。</div></div>
          <input type="checkbox" id="th-sw-silent">
        </div>
      </div>
    </section>
  </div>

  <div class="th-pane" id="th-pane2">
    <section id="th-relay-warn" style="display:none">
      <div class="th-relay">
        <div class="th-rt" id="th-relay-warn-title">这一单要分两次抢</div>
        <div class="th-rd">第 1 段和第 2 段的起售时间差得比较远。你会先拿到一张<b>半程票</b>（30 分钟内不付款会释放），
          过一段时间再抢第二段；<b>第二段没抢到，第一段要退掉</b>（有手续费）。</div>
        <div class="th-rd"><b>三个替代方案：</b><br>
          · 换乘站改成起售时间和第 1 段接近的<br>
          · 第 2 段交给候补 + 手机 12306 免密支付 —— 兑现自动扣款，不用守着<br>
          · 改买长乘短 —— 一张票，根本不存在"第二段"</div>
        <div class="th-rbtns">
          <button class="th-chip" id="th-relay-change">回第 ① 步换一下</button>
          <button class="th-chip on" id="th-relay-go">知道了，就这么抢</button>
        </div>
      </div>
    </section>
    <section>
      <div class="th-lbl">要抢哪几类<span class="th-aside">不勾 = 不抢这类</span></div>
      <div class="th-chips" id="th-filters">
        <button class="th-chip on" data-f="z">直达<span id="th-cnt-z"></span></button>
        <button class="th-chip on" data-f="c">买长乘短<span id="th-cnt-c"></span></button>
        <button class="th-chip on" data-f="t">中转<span id="th-cnt-t"></span></button>
      </div>
      <div class="th-legend" id="th-legend">
        <div class="th-lg" data-l="z"><b>直达</b><span>一张票、不下车，只买你填的区间。到手 = 到家。</span></div>
        <div class="th-lg" data-l="c"><b>买长乘短</b><span>买到目的地以远的站、提前下车。脚本会核对这趟车确实经停你要下的那一站，不经过就丢掉。</span></div>
        <div class="th-lg" data-l="t"><b>中转</b><span>两段接力，抢到哪段算哪段。第 1 段到手只是<b>半步</b>，脚本会继续盯第 2 段并马上催你付款。</span></div>
      </div>
      <div class="th-hint">按<b>开火时刻</b>分组：起售时间不同的票不在同一时刻竞争，顺序只在组内生效。</div>
    </section>
    <section>
      <div class="th-lbl">方案顺序<span class="th-aside"><button id="th-restore" style="display:none"></button><span id="th-pick-count"></span></span></div>
      <div class="th-count" id="th-order-hint"></div>
      <div class="th-plans" id="th-plans"></div>
    </section>
  </div>

  <div class="th-pane" id="th-pane3">
    <section>
      <div class="th-lbl">定时抢票是怎么跑的</div>
      <div class="th-note">到点脚本会<b>自动</b>连发下单请求，不需要你点任何东西。但有个浏览器层面的硬限制：<br>
        · 标签页切到后台超过 5 分钟，定时器会被压到<b>每分钟才跑 1 次</b>——那一枪可能晚几十秒；<br>
        · <b>电脑休眠 = 完全不动</b>，什么脚本都一样。</div>
      <div class="th-rsw"><span>保持唤醒（建议开着）</span><input type="checkbox" id="th-keepawake"></div>
      <div class="th-hint">打开后页面会维持一个近乎听不见的音调，让浏览器认为"这个页面在出声"，从而不把它当静默后台页来限流。
        这是唯一能对抗后台限流的办法——但它<b>对抗不了电脑休眠</b>，也对抗不了合上盖子。</div>
      <div class="th-note" id="th-reserve-warn" style="display:none;margin-top:10px"></div>
    </section>
    <section id="th-relay-sec" style="display:none">
      <div class="th-relay">
        <div class="th-rt" id="th-relay-title">接力中</div>
        <div class="th-rd">这期间你不用守着。开火前 5 分钟脚本开始报警——报警走音频线程，页面在后台也响。</div>
        <div class="th-rd"><b>要离开电脑的话，照这两条做：</b><br>
          ① 保持上面的「保持唤醒」是开着的——不然浏览器会把后台页面限流，第一枪最晚可能晚 60 秒；<br>
          ② 让第 2 段走<b>候补</b>，并在手机 12306 里开<b>免密支付</b>——候补兑现时自动扣款，这条路全程不需要你在场。</div>
      </div>
    </section>
    <section>
      <div class="th-lbl">按你的顺序择优<span class="th-aside" id="th-run-count"></span></div>
      <div class="th-count" id="th-next-fire"></div>
      <div class="th-count" id="th-clock" style="margin-top:-4px"></div>
      <div class="th-run" id="th-run-list"></div>
    </section>
  </div>

</div>
<div class="th-ft">
  <div class="th-status" id="th-status" style="display:none"><span class="th-dot"></span><span>未开始</span><span class="th-n"></span></div>
  <div class="th-ftnote" id="th-ft-note" style="display:none"></div>
  <div class="th-btns" id="th-ft1"><button class="th-btn" id="th-btn-test">下一步</button></div>
  <div class="th-btns" id="th-ft2" style="display:none"><button class="th-btn" id="th-btn-start">开始抢票</button></div>
  <div class="th-btns" id="th-ft3" style="display:none"><button class="th-btn stop" id="th-btn-stop">停止抢票</button></div>
  <div class="th-btns" id="th-ftrun" style="display:none">
    <button class="th-btn ghost" id="th-btn-torun">返回抢票</button>
    <button class="th-btn stop" id="th-btn-stop2">停止抢票</button>
  </div>
  <div class="th-links">
    <button id="th-test-sound">测试声音</button>
    <button id="th-copy-log">复制日志</button>
    <button id="th-log-toggle">运行日志 ▾</button>
  </div>
  <div class="th-log" id="th-log"></div>
</div>`;
            document.body.appendChild(panel);
            panelEl = panel;
            logContainer = document.getElementById('th-log');
            statusEl = document.getElementById('th-status');
            startBtn = document.getElementById('th-btn-start');
            bindEvents();
            makeDraggable(panel);
            restorePersistedLogs();
            renderPassengers(uiState.passengersList);
            renderSeatSum();
            renderSeatPick();
            refreshDate();
            refreshReserveRow();
            setCalOpen(false);
            startClock();
            goStep(1);
            log('面板就绪。填好条件点「下一步」，脚本会去查一遍真实车次。', 'success');
        }

        function restorePersistedLogs() {
            if (!logContainer) return;
            const saved = loadPersistedLogs();
            if (!saved) return;
            const lines = [].concat(saved.ui || []);
            if (!lines.length) return;
            logContainer.innerHTML = '';
            uiLogBuffer.length = 0;
            lines.forEach(line => {
                const d = document.createElement('div');
                d.className = 'th-log-i';
                d.textContent = line;
                logContainer.appendChild(d);
                uiLogBuffer.push(line);
            });
            logContainer.scrollTop = logContainer.scrollHeight;
            log(`（以上是 ${new Date(saved.at).toLocaleTimeString()} 上次运行的日志）`, 'warn');
        }

        function makeDraggable(el) {
            const header = el.querySelector('.th-hd');
            let dragging = false, sx = 0, sy = 0, il = 0, it = 0;
            header.addEventListener('mousedown', e => {
                if (e.target.closest('button')) return;
                e.preventDefault();
                dragging = true; sx = e.clientX; sy = e.clientY;
                const r = el.getBoundingClientRect();
                il = r.left; it = r.top;
                el.style.right = 'auto'; el.style.left = il + 'px'; el.style.top = it + 'px';
            });
            document.addEventListener('mousemove', e => {
                if (!dragging) return;
                el.style.left = (il + e.clientX - sx) + 'px';
                el.style.top = (it + e.clientY - sy) + 'px';
            });
            document.addEventListener('mouseup', () => { dragging = false; });
        }

        function bindEvents() {
            // 步骤条
            $('#th-steps').addEventListener('click', e => {
                const b = e.target.closest('.th-stp');
                if (!b || b.classList.contains('locked')) return;
                goStep(+b.dataset.s);
            });
            $('#th-recap').addEventListener('click', () => goStep(1));

            // 日期
            $('#th-date-row').addEventListener('click', () => {
                setCalOpen(!$('#th-date-bd').classList.contains('open'));
            });
            $('#th-cal-prev').addEventListener('click', () => {
                uiState.cal.m--;
                if (uiState.cal.m < 1) { uiState.cal.m = 12; uiState.cal.y--; }
                renderCal();
            });
            $('#th-cal-next').addEventListener('click', () => {
                uiState.cal.m++;
                if (uiState.cal.m > 12) { uiState.cal.m = 1; uiState.cal.y++; }
                renderCal();
            });
            $$('.th-quick button').forEach(b => {
                b.addEventListener('click', () => {
                    // 一键回到"什么都没有"：想只留预约时的最快路径
                    if (b.dataset.q === 'clearall') {
                        cfg.trainDates = [];
                        saveConfig(cfg);
                        refreshDate();
                        log(cfg.reserveDate
                            ? `已清空所有出行日期 —— 现在只剩预约 ${cfg.reserveDate} 这一条`
                            : '已清空所有出行日期，请重新点一个日期', cfg.reserveDate ? 'success' : 'warn');
                        return;
                    }
                    const main = mainDateObj();
                    let ex = extraDates();
                    if (b.dataset.q === 'prev') ex.push(addDays(main, -1));
                    if (b.dataset.q === 'next') ex.push(addDays(main, 1));
                    if (b.dataset.q === 'both') { ex.push(addDays(main, -1)); ex.push(addDays(main, 1)); }
                    if (b.dataset.q === 'clear') ex = [];
                    const t0 = dateKey(todayObj()), tEnd = dateKey(addDays(todayObj(), PRESALE_DAYS - 1));
                    const seen = {}; const out = [];
                    ex.forEach(x => {
                        const k = dateKey(x);
                        if (k === dateKey(main) || seen[k] || k < t0 || k > tEnd) return;
                        seen[k] = 1; out.push(x);
                    });
                    out.sort((a, c) => dateKey(a) - dateKey(c));
                    cfg.trainDates = [isoOf(main)].concat(out.map(isoOf));
                    saveConfig(cfg);
                    refreshDate();
                });
            });

            // 预约（预售期外的日期）：手填开火时刻，或一键用记住的起售时刻
            $('#th-reserve-at').addEventListener('change', e => {
                cfg.reserveAt = e.target.value || '';
                cfg.reserveAtFor = cfg.reserveAt ? currentFromName() : '';   // 记下是给哪个站填的
                saveConfig(cfg);
                refreshReserveRow();
                touchConfig();
            });
            $('#th-reserve-at').addEventListener('input', e => {
                cfg.reserveAt = e.target.value || '';
                cfg.reserveAtFor = cfg.reserveAt ? currentFromName() : '';
                saveConfig(cfg);
            });
            $('#th-reserve-fill').addEventListener('click', () => {
                const st = saleTimeForCurrent();
                const who = currentFromName() || '出发站';
                if (!st) {
                    // ★ 提示必须出现在**看得见的地方**：直接写进面板那一行 + 弹横幅。
                    //   只写日志没用 —— 日志在第③步，用户在①步点这个按钮，等于没提示。
                    log(`还不知道「${who}」的起售时刻 —— 点一次「下一步」脚本会单独查一天把它学回来（只设了预约也会查）`, 'warn');
                    const hint = $('#th-reserve-hint');
                    if (hint) {
                        hint.innerHTML = `<b>还不知道「${who}」的起售时刻</b> —— 脚本还没学到这个站的。<br>`
                            + '点一次「下一步」它就会去查（就算只设了预约，也会单独查一天学回来）；也可以直接在左边手填一个几点。';
                    }
                    alertBanner('还不知道这个出发站的起售时刻',
                        `你现在填的出发站是「${who}」，但脚本还没有它的起售时刻。\n\n`
                        + '起售时刻是按「乘车站」算的（杭州东 10:45、上海虹桥 13:45 这种），'
                        + '所以不能拿别的站的旧值顶上来。\n\n'
                        + '两个办法：\n1. 点一次「下一步」—— 脚本会去查并记住它\n'
                        + '2. 直接在「开火时刻」里手填一个几点', 'warn');
                    return;
                }
                cfg.reserveAt = st;
                cfg.reserveAtFor = who;
                saveConfig(cfg);
                refreshReserveRow();
                touchConfig();
                log(`开火时刻已填成 ${st}（${who} 的起售时刻）`, 'success');
            });
            $('#th-reserve-clear').addEventListener('click', () => pickReserveDate(''));

            // 站点
            $('#th-swap').addEventListener('click', () => {
                const f = $('#th-from'), t = $('#th-to');
                const a = f.value; f.value = t.value; t.value = a;
                touchConfig();
            });
            ['#th-from', '#th-to', '#th-trains', '#th-alt-to'].forEach(sel => {
                $(sel).addEventListener('input', () => {
                    // 换了出发站，预约的开火时刻要跟着重算 —— 起售时刻是按乘车站算的
                    if (sel === '#th-from') { refreshReserveRow(); refreshDate(); }
                    touchConfig();
                });
            });

            // 席别
            $('#th-seats').addEventListener('click', e => {
                const c = e.target.closest('.th-chip');
                if (!c) return;
                c.classList.toggle('on');
                // 点选的排到最后，保证 DOM 顺序 = 优先顺序
                c.parentNode.appendChild(c);
                cfg.seatTypes = seatCodesInOrder();
                saveConfig(cfg);
                renderSeatSum(); renderSeatPick(); touchConfig();
            });

            // 乘车人
            $('#th-pax').addEventListener('click', e => {
                const chip = e.target.closest('.th-pax-chip');
                if (!chip) return;
                const name = chip.dataset.name;
                if (e.target.classList.contains('th-st')) {
                    chip.classList.toggle('stu');
                    cfg.passengerDetails = cfg.passengerDetails || {};
                    cfg.passengerDetails[name] = cfg.passengerDetails[name] || {};
                    cfg.passengerDetails[name].isStudent = chip.classList.contains('stu');
                    saveConfig(cfg);
                    return;
                }
                chip.classList.toggle('on');
                cfg.passengers = $$('#th-pax .th-pax-chip.on').map(c => c.dataset.name);
                saveConfig(cfg);
                renderSeatPick(); touchConfig();
            });
            $('#th-reload-pax').addEventListener('click', () => refreshPassengers());

            // 高级
            $('#th-adv-hd').addEventListener('click', () => $('#th-adv').classList.toggle('open'));
            bindSwitch('#th-sw-samecity', 'acceptSameCity');
            bindSwitch('#th-sw-alt', 'altToStationEnabled', on => {
                $('#th-alt-box').style.display = on ? 'block' : 'none';
            });
            bindSwitch('#th-sw-waitlist', 'waitlistEnabled');
            bindSwitch('#th-sw-alarm', 'alarmEnabled', on => { if (!on) stopAlarm(); });
            bindSwitch('#th-sw-sound', 'soundAlert');
            bindSwitch('#th-sw-silent', 'silentCar');
            $('#th-alt-box').style.display = cfg.altToStationEnabled !== false ? 'block' : 'none';
            const ka = $('#th-keepawake');
            if (ka) ka.checked = cfg.keepAwake !== false;

            // 座位图
            $('#th-layout').addEventListener('click', e => {
                const b = e.target.closest('.th-seat');
                if (!b) return;
                const l = b.dataset.l;
                const i = uiState.letters.indexOf(l);
                if (i > -1) uiState.letters.splice(i, 1); else uiState.letters.push(l);
                $$('#th-seatquick .th-chip').forEach(c => c.classList.remove('on'));
                cfg.seatPref = '';
                cfg.seatLetters = uiState.letters.slice();
                saveConfig(cfg);
                renderSeatPick(); touchConfig();
            });
            $('#th-seatquick').addEventListener('click', e => {
                const c = e.target.closest('.th-chip');
                if (!c) return;
                $$('#th-seatquick .th-chip').forEach(x => x.classList.toggle('on', x === c));
                const pref = c.dataset.p;
                cfg.seatPref = pref;
                if (pref === 'any') { uiState.letters = []; }
                else {
                    const r = buildChooseSeatsFromPref(pref, seatTypeNow(), paxCount());
                    uiState.letters = r.letters;
                }
                cfg.seatLetters = uiState.letters.slice();
                saveConfig(cfg);
                renderSeatPick(); touchConfig();
            });

            // 筛选
            $('#th-filters').addEventListener('click', e => {
                const c = e.target.closest('.th-chip');
                if (!c || c.classList.contains('locked')) return;
                c.classList.toggle('on');
                uiState.filters[c.dataset.f] = c.classList.contains('on');
                renderPlans(); updateFooter();
            });
            $('#th-restore').addEventListener('click', () => {
                uiState.planState.removed = {};
                savePlanState(uiState.planState);
                renderPlans(); updateFooter();
            });
            $('#th-relay-go').addEventListener('click', () => {
                cfg.relayWarnOff = true; saveConfig(cfg); updateRelayWarn();
            });
            $('#th-relay-change').addEventListener('click', () => goStep(1));

            // 底部动作
            $('#th-btn-test').addEventListener('click', () => {
                if (canProceed().length) return;
                const btn = $('#th-btn-test');
                uiState.testing = true;
                btn.disabled = true; btn.textContent = '正在查询 12306…';
                log('开始查询方案…', 'info');
                Promise.resolve(uiState.onTest && uiState.onTest())
                    // ★ 这一步不能少：查询把方案 return 出来，必须有人接住并装进面板。
                    //   漏掉它的话，方案算完就丢，界面纹丝不动、日志也没有报错 ——
                    //   表现就是"点了下一步没反应"。
                    .then(plans => applyPlans(plans))
                    .catch(e => {
                        log(`查询出错：${e.message}`, 'error');
                        alertBanner('查询没成功', `${e.message}\n\n常见原因：\n`
                            + '· 站点名写错了\n'
                            + '· 12306 正在限流 —— 过一会儿再点一次「下一步」\n'
                            + '· 油猴里没勾「允许跨域」（GM_xmlhttpRequest）', 'error');
                    })
                    .finally(() => {
                        uiState.testing = false;
                        btn.disabled = false; btn.textContent = '下一步';
                        updateFooter();
                    });
            });
            $('#th-btn-start').addEventListener('click', () => {
                if (uiState.stale || !activePlans().length) { updateFooter(); return; }
                uiState.running = true;
                setStatus('正在抢票', 'run', '');
                goStep(3);
                if (uiState.onStart) uiState.onStart();
            });
            const stopRun = () => {
                uiState.running = false;
                setStatus('已停止', '', '');
                if (uiState.onStop) uiState.onStop();
                goStep(2);
            };
            $('#th-btn-stop').addEventListener('click', stopRun);
            $('#th-btn-stop2').addEventListener('click', stopRun);
            $('#th-btn-torun').addEventListener('click', () => goStep(3));
            $('#th-test-sound').addEventListener('click', () => { playBeep(); log('🔔 测试声音', 'info'); });
            $('#th-log-toggle').addEventListener('click', e => {
                const l = $('#th-log');
                l.classList.toggle('show');
                e.target.textContent = l.classList.contains('show') ? '运行日志 ▴' : '运行日志 ▾';
            });
            $('#th-copy-log').addEventListener('click', async () => {
                const text = buildLogText();
                try {
                    await navigator.clipboard.writeText(text);
                    log(`✅ 日志已复制（${text.length} 字）`, 'success');
                } catch (err) {
                    try {
                        const ta = document.createElement('textarea');
                        ta.value = text;
                        ta.style.position = 'fixed'; ta.style.top = '-9999px';
                        document.body.appendChild(ta); ta.select();
                        document.execCommand('copy'); document.body.removeChild(ta);
                        log(`✅ 日志已复制（${text.length} 字）`, 'success');
                    } catch (e2) { log(`复制失败：${e2.message}`, 'error'); }
                }
            });
            $('#th-fold').addEventListener('click', () => panelEl.classList.toggle('th-folded'));
            $('#th-close').addEventListener('click', () => { panelEl.style.display = 'none'; });
            $('#th-keepawake').addEventListener('change', e => {
                cfg.keepAwake = e.target.checked;
                saveConfig(cfg);
                setKeepAwake(e.target.checked && uiState.running);
            });
            // 切回前台 = 用户回来了，停掉报警
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) stopAlarm();
            });
        }
        function buildLogText() {
            const lines = [];
            lines.push('===== 12306 抢票助手 Pro 日志 =====');
            lines.push(`版本: v${SCRIPT_VERSION}`);
            lines.push(`导出时间: ${new Date().toLocaleString()}`);
            lines.push(`页面地址: ${location.href}`);
            lines.push(`标签页: ${document.hidden ? '后台（会被浏览器限流）' : '前台'}`);
            lines.push(`服务器时间校准: ${serverClockOffset === null ? '未校准' : (serverClockOffset > 0 ? '+' : '') + serverClockOffset + 'ms'}`);
            lines.push(`任务状态: ${uiState.running ? '运行中' : '已停止'}`);
            lines.push('');
            lines.push('----- 面板日志 -----');
            if (logContainer && logContainer.children.length) {
                for (const entry of logContainer.children) lines.push(entry.textContent || '');
            } else lines.push('(无)');
            lines.push('');
            lines.push('----- 技术日志（Console）-----');
            lines.push(...(techLog.length ? techLog : ['(无)']));
            return lines.join('\n');
        }

        async function refreshPassengers() {
            log('正在获取乘车人…', 'info');
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const res = await NetworkModule.getPassengerDTOs();
                    if (res && res.data && res.data.normal_passengers) {
                        uiState.passengersList = res.data.normal_passengers;
                        renderPassengers(uiState.passengersList);
                        log(`已加载 ${uiState.passengersList.length} 位乘车人`, 'success');
                        return true;
                    }
                    // 请求成功但没数据：12306 这时通常是把人踢到登录页了
                    log('请求成功了，但没返回乘车人——基本可以确定是没登录。请先登录 12306，再点「重新加载」', 'error');
                    return false;
                } catch (e) {
                    const msg = String((e && e.message) || e);
                    if (attempt < 3) {
                        log(`获取乘车人失败（第 ${attempt} 次）：${msg} —— 2 秒后重试`, 'warn');
                        await new Promise(r => setTimeout(r, 2000));
                        continue;
                    }
                    log(`获取乘车人失败：${msg}`, 'error');
                    alertBanner('拿不到乘车人',
                        `请求失败：${msg}\n\n两种可能：\n`
                        + '① 没登录 —— 先登录 12306，再点面板上的「重新加载」\n'
                        + '② 请求被浏览器拦了（跨域）—— 脚本会自动改走油猴通道重试，'
                        + '留意日志里有没有「改走油猴通道」这行；如果一直没有，说明脚本版本旧了，重新装一次', 'error');
                    return false;
                }
            }
            return false;
        }

        return {
            init: (onTest, onStart, onStop) => {
                uiState.onTest = onTest; uiState.onStart = onStart; uiState.onStop = onStop;
                createPanel();
                refreshPassengers();
            },
            log, setStatus, alertBanner, playBeep, showNotification,
            startAlarm, stopAlarm, setKeepAwake, isKeepAwakeOn,
            // 必须由「用户手势」里调一次：浏览器不允许在没交互的情况下创建/恢复音频上下文，
            // 否则它一直是 suspended 状态 —— 到点报警就是一声不响。
            ensureAudio: () => { try { const c = ensureAudioContext(); if (c && c.state === 'suspended') c.resume(); return !!c; } catch (e) { return false; } },
            getIsRunning: () => uiState.running,
            setRunning: v => { uiState.running = v; },
            getConfigFromForm: () => cfg,
            saveCfg: () => saveConfig(cfg),
            setPlans: applyPlans,
            activePlans,
            renderRunList, updateNextFire,
            setPlanUnitStatus: (planKey, unitIdx, status, text) => {
                const p = uiState.plans.find(x => x.key === planKey);
                if (!p || !p.units || !p.units[unitIdx]) return;
                p.units[unitIdx].status = status;
                if (text !== undefined) p.units[unitIdx].statusText = text;
                renderRunList(); updateNextFire();
            },
            setRelayVisible: show => {
                const el = $('#th-relay-sec');
                if (el) el.style.display = show ? 'block' : 'none';
            },
            setRelayTitle: t => {
                const el = $('#th-relay-title');
                if (el) el.textContent = t;
            },
            goStep,
            updateFooter,
            // buildPlans（Main 作用域）要用它算预约的开火时刻，
            // 所以必须从这里暴露出去 —— 光在 UIModule 里定义，外面看不见。
            reserveFireAt,
            humanLeft,
            // 查询过程中把"现在查到哪一步"写在按钮上——否则一个查询要发十几个请求，
            // 用户看到的就是一个不动的「正在查询 12306…」，跟卡死没法区分
            setTestProgress: t => {
                if (!uiState.testing) return;
                const b = $('#th-btn-test');
                if (b) b.textContent = String(t).slice(0, 26);
            }
        };
    })();

    // ==========================================================================
    // Main —— 方案构建 + 调度
    // ==========================================================================
    const P = s => document.querySelector(`#ticket-helper-panel ${s}`);
    const $$P = s => Array.prototype.slice.call(document.querySelectorAll(`#ticket-helper-panel ${s}`));
    const log = (m, t) => UIModule.log(m, t);

    // 轮询档位（按"离下一个起售点还有多远"自适应）
    const POLL = {
        far: [20000, 30000],  // 距开火 > 10 分钟（预约可能等几小时甚至一天，别空转）
        probe: [12000, 20000],// 预约的开火前 5 分钟试探期：万一提前放票能抓到
        idle: [1000, 1500],   // 距开火 > 60s
        warmup: [500, 800],   // 开火前 60s ~ 5s
        hot: [250, 400],      // 开火窗口 T-5s ~ T+30s
        settle: [500, 800],   // T+30s ~ T+3min（回流票高发期）
        cool: [800, 1200]     // 之后
    };
    const HOT_BEFORE_MS = 5000;
    const HOT_AFTER_MS = 30000;
    const SETTLE_AFTER_MS = 180000;
    const PREHEAT_MS = 1500;
    const AGG_WINDOW_MS = 60;          // "聚合窗口"：给优先级更高的查询一点追赶时间
    const WARMUP_MS = 5 * 60 * 1000;   // 预约的开火前试探期
    const NIGHT_WARN_BEFORE_MS = 5 * 60 * 1000;
    const KEEPALIVE_MIN_MS = 45000, KEEPALIVE_MAX_MS = 75000;
    const RESTART_COOLDOWN_MS = 15000;

    let checkTimer = null, fireTimer = null, beatTimer = null, keepAliveTimer = null;
    let lastBeat = 0, inRound = false, throttleWarned = false, lastFiredLogAt = 0;
    let taskCtx = null;
    let lastStopAt = Number(GM_getValue('grab_last_stop_at', 0)) || 0;
    let netFailWindow = [];
    let netFailStreak = 0;
    let everQueryOk = false;
    let orderMissStreak = 0;
    let orderFailStreak = 0;
    let warningAlarmOn = false;
    let sameDayTransferWarned = false;

    function randBetween(r) { return Math.floor(Math.random() * (r[1] - r[0] + 1)) + r[0]; }
    function findStationCode(input) {
        if (!input) return null;
        if (stationMap[input]) return stationMap[input];
        if (/^[A-Z]+$/.test(input)) return input;
        for (const name of Object.keys(stationMap)) {
            if (name.includes(input) || input.includes(name)) return stationMap[name];
        }
        return null;
    }

    // --------------------------------------------------------------------------
    // 读表单 → 任务配置
    // --------------------------------------------------------------------------
    function readForm() {
        const fromName = (P('#th-from').value || '').trim();
        const toName = (P('#th-to').value || '').trim();
        if (!Object.keys(stationMap).length) throw new Error('站点简码还没加载好，等两秒再点');
        const fromCode = findStationCode(fromName);
        const toCode = findStationCode(toName);
        if (!fromCode || !toCode) throw new Error(`站点识别失败：${fromName || '(空)'} / ${toName || '(空)'}`);
        const trainDates = (cfg.trainDates && cfg.trainDates.length) ? cfg.trainDates.slice()
            : (cfg.reserveDate ? [] : [serverTodayIso()]);
        const seatTypes = $$P('#th-seats .th-chip.on').map(c => c.dataset.code);
        const trainCodes = (P('#th-trains').value || '').split(/[,，]/).map(s => s.trim().toUpperCase()).filter(Boolean);
        const passengers = [];
        $$P('#th-pax .th-pax-chip.on').forEach(chip => {
            let p;
            try { p = JSON.parse(chip.dataset.full); } catch (e) { return; }
            p.isStudent = chip.classList.contains('stu');
            passengers.push(p);
        });
        const altToName = (P('#th-alt-to').value || '').trim();
        const altOn = P('#th-sw-alt').checked && altToName;
        const altToCode = altOn ? findStationCode(altToName) : '';
        return {
            trainDates, fromStation: fromCode, toStation: toCode,
            fromName, toName, fromCode, toCode,
            trainCodes, seatTypes, passengers,
            reserveDate: cfg.reserveDate || '', reserveAt: cfg.reserveAt || '',
            altToName: altOn ? altToName : '', altToCode: altToCode || '',
            acceptSameCity: P('#th-sw-samecity').checked,
            departFrom: '', departTo: '',
            purposeCodes: purposeCodesFor(passengers)
        };
    }

    // --------------------------------------------------------------------------
    // 构建方案（点「下一步」时跑一次真实的查询）
    // --------------------------------------------------------------------------
    async function safeQuery(date, fromCode, toCode, purposeCodes) {
        try {
            const res = await NetworkModule.queryTickets(date, fromCode, toCode, purposeCodes, QUERY_TIMEOUT_MS_HOT);
            if (res && res.data && Array.isArray(res.data.result)) { everQueryOk = true; return res.data.result; }
        } catch (e) {
            tlog('warn', `[Plan] 查询失败 ${date} ${fromCode}→${toCode}: ${e.message}`);
        }
        return null;
    }
    function seatNamesOf(codes) {
        return (codes || []).map(c => TicketLogicModule.getSeatNamesByCode(c));
    }
    function stockTextOf(t, seatCodes) {
        const names = (seatCodes || []).flatMap(c => TicketLogicModule.getSeatNamesByCode(c));
        return names.map(n => `${n} ${t.tickets[n] || '--'}`).slice(0, 3).join(' · ');
    }
    function saleTextOf(rawList, conf) {
        const t = TicketLogicModule.earliestSaleTime(rawList || [], conf.departFrom, conf.departTo);
        return t ? { text: `${t.time} 开售`, date: t.date, time: t.time } : { text: '', date: '', time: '' };
    }
    function saleAtOf(sale) {
        if (!sale || !sale.time) return 0;
        return saleTsOf(sale.date || serverTodayIso(), sale.time);
    }
    // 票价描述：查价接口按「车次 + 上下车站序 + 席别码」定价，
    // 同一趟车买不同区间价格不同，所以站序必须带上。
    function priceReqOf(info, seatName, date) {
        if (!info || !info.trainNo || !info.fromStationNo || !info.toStationNo) return null;
        return {
            trainNo: info.trainNo, fromNo: info.fromStationNo, toNo: info.toStationNo,
            seatTypes: info.seatTypes || '', seatCode: SEAT_TYPE_CODE[seatName] || '', date
        };
    }
    function sumPrices(list) {
        let s = 0;
        for (const v of list) {
            const n = Number(String(v).replace(/[^\d.]/g, ''));
            if (isFinite(n)) s += n;
        }
        return '\u00a5' + s.toFixed(1).replace(/\.0+$/, '');
    }
    function inRawByCode(raw, code) {
        if (!raw || !code) return null;
        const want = String(code).trim().toUpperCase();
        for (const rs of raw) {
            const info = TicketLogicModule.parseTrainInfo(rs);
            if (info && info.trainCode.toUpperCase() === want) return info;
        }
        return null;
    }
    // 查询票价。
    // 为什么单独一趟：查价是**一车一次请求**，而"下一步"本来就要发好几个请求，
    // 所以这里设了预算上限 + 连续失败就停 —— 票价只是给你做参考，
    // 绝不能因为它把限流额度烧光，更不能影响真正要紧的抢票。
    const PRICE_BUDGET = 12;
    async function attachPrices(plans) {
        const targets = [];
        ['z', 'c', 't'].forEach(t => plans.filter(p => p.type === t).forEach(p => {
            if (p.priceReqs && p.priceReqs.length) targets.push(p);
        }));
        // 已开售的排前面：查价预算有限，先保证"现在就能抢"的那些方案有价格
        targets.sort((a, b) => (a.notYet ? 1 : 0) - (b.notYet ? 1 : 0));
        if (!targets.length) return 0;
        let budget = PRICE_BUDGET, got = 0, fails = 0;
        for (const p of targets) {
            if (budget <= 0) break;
            const parts = [];
            for (const req of p.priceReqs) {
                if (budget <= 0) break;
                budget--;
                try {
                    const res = await NetworkModule.queryTicketPrice(req.trainNo, req.fromNo, req.toNo, req.seatTypes, req.date);
                    const v = priceOfSeat(res && res.data, req.seatCode);
                    if (v) { parts.push(v); fails = 0; } else { fails++; }
                } catch (e) {
                    fails++;
                    tlog('warn', `[Price] 查价失败 ${req.trainNo}: ${e.message}`);
                }
                if (fails >= 3) {
                    log('查票价连续失败 3 次，先不查了（多半是被限流）—— 票价只是参考，不影响抢票', 'warn');
                    budget = 0;
                    break;
                }
                await new Promise(r => setTimeout(r, 180));
            }
            if (parts.length) {
                p.priceText = parts.length > 1 ? `${parts.join(' + ')} = ${sumPrices(parts)}` : parts[0];
                got++;
            }
        }
        return got;
    }
    function makeUnit(dest, seatTypes, codes, sale) {
        const at = saleAtOf(sale);
        return {
            dest, seatTypes, codes,
            saleAt: at,
            saleText: sale && sale.text ? sale.text : '已开售',
            status: (at && at > Date.now()) ? 'wait' : 'hunt',
            statusText: '', train: null, orderId: ''
        };
    }
    // 这趟车有没有这个席别（不问有没有票）。
    // 用在"还没开售"的车次上：那时候余票字段是空的，但 seat_types 已经告诉了你
    // 这趟车到底挂不挂二等座 —— 这决定了它还值不值得抢。
    function seatOffered(info, seatName) {
        const code = SEAT_TYPE_CODE[seatName];
        return !!code && String(info.seatTypes || '').indexOf(code) > -1;
    }
    // 从查票结果里挑出"可订（或即将可订）+ 有票 + 区间对 + 时间在范围内"的车次，按发车时间排序
    //
    // ★ 这里必须放行 canBuy === 'IS_TIME_NOT_BUY' 的车次。
    //   新放出来的那批票，在开售之前就是这个状态；如果按"必须 Y"过滤掉，
    //   用户在开售前点「下一步」会得到 0 条方案 —— 想提前布阵就没法布，
    //   而"抢最新放出来的票"恰恰要求提前把方案排好、到点开火。
    function listTrains(raw, seatCodes, conf, dest, stats, limit) {
        const out = [];
        const want = seatNamesOf(seatCodes);
        const fromName = stationNameOf(dest.fromCode), toName = stationNameOf(dest.toCode);
        for (const rawStr of raw) {
            const info = TicketLogicModule.parseTrainInfo(rawStr);
            if (!info) continue;
            const notYet = info.canBuy === 'IS_TIME_NOT_BUY';
            if (info.canBuy !== 'Y' && !notYet) continue;
            if (conf.trainCodes && conf.trainCodes.length
                && conf.trainCodes.indexOf(info.trainCode.toUpperCase()) < 0) continue;
            if (!inDepartRange(info.startTime, conf.departFrom, conf.departTo)) continue;
            if (!conf.acceptSameCity && (info.fromStation !== dest.fromCode || info.toStation !== dest.toCode)) {
                if (stats) {
                    stats.skipCount = (stats.skipCount || 0) + 1;
                    if (!stats.skipSample) {
                        stats.skipSample = {
                            trainCode: info.trainCode, fromStation: info.fromStation, toStation: info.toStation,
                            seatName: '二等座', startTime: info.startTime
                        };
                    }
                }
                continue;
            }
            let seatName = null, seatCode = null;
            for (let i = 0; i < seatCodes.length; i++) {
                for (const n of want[i]) {
                    // 已开售 → 看余票；还没开售 → 看这趟车有没有这个席别（余票字段此刻是空的）
                    const ok = notYet ? seatOffered(info, n) : TicketLogicModule.hasTicket(info.tickets[n]);
                    if (ok) { seatName = n; seatCode = seatCodes[i]; break; }
                }
                if (seatName) break;
            }
            if (!seatName) continue;
            const sale = saleTextOf([rawStr], conf);
            // 未开售的车次没有 secretStr（要等开售那一刻才有），所以这里不给它 secretStr，
            // 到点开火时脚本会重新查一次，那时才有可下单的串。
            out.push({
                notYet, secretStr: notYet ? '' : info.secretStr,
                trainDate: info.trainDate, trainNo: info.trainNo,
                trainCode: info.trainCode, fromStation: info.fromStation, toStation: info.toStation,
                startTime: info.startTime, endTime: info.endTime,
                seatName, seatCode, leftTicket: info.leftTicket, trainLocation: info.trainLocation,
                fromStationNo: info.fromStationNo, toStationNo: info.toStationNo,
                tickets: info.tickets, seatTypes: info.seatTypes, dwFlag: info.dwFlag,
                saleTime: info.saleTime, raw: info.raw, fromName, toName, sale
            });
        }
        // 未开售的排最前面。
        // 理由：它们才是"马上要放出来、必须提前布阵"的那批 —— 而按发车时间排的话，
        // 它们会被"早就开售、随时能买"的车挤出列表（列表只有 6 个位置）。
        out.sort((a, b) => ((b.notYet ? 1 : 0) - (a.notYet ? 1 : 0))
            || String(a.startTime).localeCompare(String(b.startTime)));
        if (stats) {
            stats.total = out.length;
            stats.notYetTotal = out.filter(t => t.notYet).length;
            stats.limit = limit || 6;
        }
        return out.slice(0, limit || 6);
    }

    async function buildPlans() {
        const conf = readForm();
        const plans = [];
        let seq = 0;
        // 一个日期最多要发 4~6 个请求，多个备选日期就是十几个 ——
        // 必须把"现在查到哪"写出来，否则按钮上那个不动的「正在查询」和卡死没区别
        const say = s => { try { UIModule.setTestProgress('正在查 ' + s); } catch (e) { /* 忽略 */ } };
        sameDayTransferWarned = false;
        // 主站（出发站）每天的查票结果：中转第 1 段的起售时间要从它这里读，
        // 因为起售时间按**乘车站**算，第 1 段的乘车站就是出发站。
        const mainRawByDate = {};

        // ---- 直达 + 买长乘短 ----
        for (const date of conf.trainDates) {
            say(`直达 ${date}`);
            const raw = await safeQuery(date, conf.fromCode, conf.toCode, conf.purposeCodes);
            mainRawByDate[date] = raw;
            if (raw) {
                const stats = {};
                const list = listTrains(raw, conf.seatTypes, conf, { fromCode: conf.fromCode, toCode: conf.toCode }, stats, 6);
                list.forEach(t => {
                    const sale = t.sale;
                    plans.push({
                        key: `z|${t.trainCode}|${date}|`, seq: seq++,
                        type: 'z', typeName: '直达', date,
                        title: t.trainCode,
                        notYet: t.notYet,
                        priceReqs: [priceReqOf(t, t.seatName, date)].filter(Boolean),
                        win: sale.time || '已开售',
                        winAt: saleAtOf(sale) || Date.now(),
                        saleShort: sale.time ? `${sale.time} 开售` : '已开售',
                        lines: [
                            { t: `${t.startTime} → ${t.endTime}` },
                            { t: `抢${t.seatName}` },
                            { t: t.notYet ? '等开售' : stockTextOf(t, conf.seatTypes), cls: t.notYet ? 'dim' : 'ok' },
                            { t: sale.text || '已开售', cls: sale.time ? 'sale' : 'dim' }
                        ],
                        units: [makeUnit({ date, fromCode: conf.fromCode, toCode: conf.toCode, fromName: conf.fromName, toName: conf.toName },
                            conf.seatTypes, conf.trainCodes, sale)]
                    });
                });
                if (stats.total > stats.limit) {
                    log(`直达：${date} 共 ${stats.total} 趟可选（其中 ${stats.notYetTotal} 趟还没开售），`
                        + `列表只显示 ${stats.limit} 趟（未开售的排在最前）。想指定车次，在第 ① 步的「车次」里填车次号。`, 'info');
                }
                if (!list.length && stats.skipCount) {                    // 这是最常见的"查得到车却一条方案都没有"：站名写的是城市，实际车走的是同城的另一个站。
                    // 光说"跳过 61 趟"没用，得把查到的那两个站名摆出来。
                    const s = stats.skipSample || {};
                    const got = `${stationNameOf(s.fromStation)}→${stationNameOf(s.toStation)}`;
                    log(`直达：${date} 查到 ${stats.skipCount} 趟有票的车，但区间是「${got}」这种，`
                        + `和你填的「${conf.fromName}→${conf.toName}」不是同一个站，全跳过了`, 'warn');
                    UIModule.alertBanner('车站名对不上，一条都没剩',
                        `你填的是「${conf.fromName} → ${conf.toName}」。\n`
                        + `但查回来有票的车，区间是「${got}」这样的。\n\n`
                        + '高铁最常见的坑：\n'
                        + `· ${conf.fromName} → ${conf.toName} 这条线上，车多半走的是同城的另一个站\n`
                        + '· 写「杭州」是杭州站，不是杭州东；「上海」是上海站，不是上海虹桥\n\n'
                        + '两个办法（任选一个）：\n'
                        + '1. 把站名改成精确的那两个站（推荐）\n'
                        + '2. 在「高级设置」里打开「接受同城其它车站」—— 但那样可能买到别的站，你得自己换过去', 'warn');
                }
            }
            if (conf.altToCode) {
                say(`买长乘短 ${date}`);
                const raw2 = await safeQuery(date, conf.fromCode, conf.altToCode, conf.purposeCodes);
                if (raw2) {
                    const stats2 = {};
                    const list = listTrains(raw2, conf.seatTypes, conf,
                        { fromCode: conf.fromCode, toCode: conf.altToCode }, stats2, 4);
                    let checked = 0;
                    for (const t of list) {
                        if (checked >= 2) break;      // 经停站核对要发请求，最多核两趟
                        checked++;
                        // ★ 买长乘短必须确认"这趟车真的停你要下的那一站"，
                        //   否则买到的可能是一张走别的线路、根本到不了目的地的票。
                        const stops = await NetworkModule.queryTrainStops(t.trainNo, conf.fromCode, conf.altToCode, date);
                        const target = stationNameOf(conf.toCode);
                        if (stops && stops.length && stops.indexOf(target) < 0) {
                            log(`买长乘短：${t.trainCode} 不经过「${target}」，已丢弃`, 'warn');
                            continue;
                        }
                        if (!stops) log(`买长乘短：${t.trainCode} 的经停站没查到，先按"经过"处理——请自行确认它停「${target}」`, 'warn');
                        const sale = t.sale;
                        plans.push({
                            key: `c|${t.trainCode}|${date}|${conf.altToCode}`, seq: seq++,
                            type: 'c', typeName: '买长乘短', date,
                            title: t.trainCode,
                            notYet: t.notYet,
                            priceReqs: [priceReqOf(t, t.seatName, date)].filter(Boolean),
                            win: sale.time || '已开售',
                            winAt: saleAtOf(sale) || Date.now(),
                            saleShort: sale.time ? `${sale.time} 开售` : '已开售',
                            lines: [
                                { t: `${t.startTime} → ${t.endTime}` },
                                { t: `抢${t.seatName} · 到${conf.altToName}，在${stationNameOf(conf.toCode)}下车` },
                                { t: t.notYet ? '等开售' : stockTextOf(t, conf.seatTypes), cls: t.notYet ? 'dim' : 'ok' },
                                { t: sale.text || '已开售', cls: sale.time ? 'sale' : 'dim' }
                            ],
                            units: [makeUnit({ date, fromCode: conf.fromCode, toCode: conf.altToCode, fromName: conf.fromName, toName: conf.altToName },
                                conf.seatTypes, conf.trainCodes, sale)]
                        });
                    }
                }
            }
        }

        // ---- 记住出发站的起售时刻 ----
        // 起售时刻按**乘车站**算（杭州东 10:45、上海虹桥 13:45），一个站一个值。
        // 只设了预约时，一个预售期内的日期都没有 —— 那就单独查今天这一天，
        // 只为把出发站的起售时刻学回来。不查的话预约只能瞎猜，
        // 或者（以前的 bug）沿用别的站的旧值，按错误时刻开火、界面上还看不出来。
        if (conf.reserveDate && !conf.trainDates.length) {
            say(`出发站起售时刻`);
            const probeDate = serverTodayIso();
            const probeRaw = await safeQuery(probeDate, conf.fromCode, conf.toCode, conf.purposeCodes);
            if (probeRaw) mainRawByDate[probeDate] = probeRaw;
            else log(`查不到 ${conf.fromName}→${conf.toName} 今天的数据，没法学到起售时刻 —— `
                + '预约的开火时刻请手动填，或者换个预售期内的日期点一次「下一步」', 'warn');
        }
        {
            // 用查到的最早时刻：宁早勿晚 —— 早开火只是多查几次
            //（开火前 5 分钟本来就是慢速试探），晚开火票就没了。
            const learned = Object.values(mainRawByDate)
                .map(raw => TicketLogicModule.earliestSaleTime(raw || [], conf.departFrom, conf.departTo))
                .filter(x => x && x.time)
                .sort((a, b) => String(a.time).localeCompare(String(b.time)));
            const pick0 = learned[0];
            if (pick0) {
                cfg.saleTimes = cfg.saleTimes || {};
                const prev = cfg.saleTimes[conf.fromName];
                if (prev !== pick0.time) {
                    cfg.saleTimes[conf.fromName] = pick0.time;
                    cfg.stationSaleTime = pick0.time;      // 兼容旧字段
                    cfg.stationSaleName = conf.fromName;
                    saveConfig(cfg);
                    log(`已记住 ${conf.fromName} 的起售时刻 ${pick0.time}`
                        + (prev ? `（原来是 ${prev}，已更新）` : '')
                        + ' —— 预约的开火时刻靠它推算', 'info');
                }
            }
        }

        // ---- 中转 ----
        for (const date of conf.trainDates) {
            say(`中转 ${date}`);
            let data = null;
            let lcMsg = '';
            try {
                const res = await NetworkModule.queryTransfer(date, conf.fromCode, conf.toCode, '');
                data = res && res.data;
                if (!data && res && res.errorMsg) lcMsg = String(res.errorMsg);
            } catch (e) {
                tlog('warn', `[Plan] 中转查询失败 ${date}: ${e.message}`);
                lcMsg = e.message;
            }
            if (!data) {
                // 实测（2026-10）：12306 对「当天出发」的接续换乘一律返回空，
                // 换成明天的日期同一个接口就返回完整方案。必须说出来，
                // 否则用户会以为是脚本的中转功能坏了。
                if (date <= serverTodayIso()) {
                    log(`中转：「${date}」是当天出发 —— 12306 不给当天的接续换乘方案（换乘要留出第二段的购票时间）。`
                        + '这是 12306 的限制，不是脚本的问题。想用中转，把日期选到明天以后。', 'warn');
                    if (!sameDayTransferWarned) {
                        sameDayTransferWarned = true;
                        UIModule.alertBanner('中转需要一个未来的日期',
                            `你选的「${date}」就是今天。\n\n`
                            + '12306 的接续换乘对**当天出发**一律返回"没有查询到中转方案"——'
                            + '我刚用明天的日期试了同一个接口，方案是正常返回的。\n\n'
                            + '想用中转：回第 ① 步，把日期选到明天或以后。\n'
                            + '只想抢今天：直达和买长乘短照常用，不受影响。', 'warn');
                    }
                } else {
                    log(`中转：${date} 12306 没有给出换乘方案${lcMsg ? `（${lcMsg}）` : ''}`, 'warn');
                }
                continue;
            }
            const tPlans = TicketLogicModule.pickTransferPlans(data, conf.seatTypes, cfg.waitMinutes || 10, 6);
            // 每个不同的中转站查一次 leftTicket：既拿第 2 段的余票，也拿它的起售时间。
            // （起售时间按乘车站算，中转站和出发站是两个站，时刻通常不同。）
            const midCache = {}, legInCache = {};
            for (const tp of tPlans) {
                if (!midCache[tp.middleCode]) {
                    say(`换乘站 ${tp.middleName}`);
                    midCache[tp.middleCode] = await safeQuery(date, tp.middleCode, conf.toCode, conf.purposeCodes);
                }
            }
            for (const tp of tPlans) {
                const midRaw = midCache[tp.middleCode];
                // 第 1 段的车次站序要单独查一次（出发站→中转站）：查价接口按**区间**定价，
                // 而"出发站→终到站"的结果里没有"出发站→中转站"这个区间的行。
                // 这一次查询顺带也给出出发站的起售时间，所以不算白花。
                if (!legInCache[tp.middleCode]) {
                    say(`换乘第1段 ${tp.middleName}`);
                    legInCache[tp.middleCode] = await safeQuery(date, conf.fromCode, tp.middleCode, conf.purposeCodes);
                }
                const legInRaw = legInCache[tp.middleCode];
                const i0 = inRawByCode(legInRaw, tp.legs[0].trainCode);
                const i1 = inRawByCode(midRaw, tp.legs[1].trainCode);
                // 第 1 段的起售时间看**出发站**，第 2 段看**中转站**（各查各的乘车站）
                const leg0Sale = saleTextOf(legInRaw || mainRawByDate[date] || midRaw, conf);
                const leg1Sale = saleTextOf(midRaw, conf);
                const l0 = makeUnit({ date, fromCode: conf.fromCode, toCode: tp.middleCode, fromName: conf.fromName, toName: tp.middleName },
                    conf.seatTypes, [tp.legs[0].trainCode], leg0Sale);
                const l1 = makeUnit({ date, fromCode: tp.middleCode, toCode: conf.toCode, fromName: tp.middleName, toName: conf.toName },
                    conf.seatTypes, [tp.legs[1].trainCode], leg1Sale);
                const gapMin = (l1.saleAt && l0.saleAt) ? Math.round((l1.saleAt - l0.saleAt) / 60000) : 0;
                plans.push({
                    key: `t|${tp.legs.map(l => l.trainCode).join('+')}|${date}|${tp.middleCode}`, seq: seq++,
                    type: 't', typeName: '中转', date,
                    title: tp.legs.map(l => l.trainCode).join(' ＋ '),
                    priceReqs: [
                        i0 ? priceReqOf(i0, tp.legSeats[0], date) : null,
                        i1 ? priceReqOf(i1, tp.legSeats[1], date) : null
                    ].filter(Boolean),
                    win: leg0Sale.time || '已开售',
                    winAt: l0.saleAt || Date.now(),
                    saleShort: `${leg0Sale.text || '已开售'}${leg1Sale.text ? ' / ' + leg1Sale.text : ''}`,
                    saleGapMin: gapMin > 0 ? gapMin : 0,
                    warn: gapMin >= 120,
                    legs: [
                        { seg: `${conf.fromName}→${tp.middleName}`, code: tp.legs[0].trainCode, sale: leg0Sale.time || '已开售' },
                        { seg: `${tp.middleName}→${conf.toName}`, code: tp.legs[1].trainCode, sale: leg1Sale.time || '已开售' }
                    ],
                    lines: [
                        { t: `${tp.legs[0].startTime} → ${tp.legs[1].arriveTime || '—'}` },
                        { t: `${tp.middleName}${tp.sameTrain ? '同车换乘（不用下车）' : `换乘 ${tp.waitMinutes} 分`}` },
                        { t: `抢 ${tp.legSeats.join(' / ')}` },
                        { t: gapMin >= 120 ? `两段相差 ${Math.floor(gapMin / 60)} 小时` : '两段接力', cls: gapMin >= 120 ? 'sale warn' : 'sale' }
                    ],
                    units: [l0, l1]
                });
            }
        }

        // ---- 预约（预售期外的日期）----
        // 这个日期 12306 此刻查不到任何车次，所以方案里没有车次信息：
        // 只记下"哪天几点开火"，到点脚本自己去查票，再按你的席别优先顺序抢。
        // （这就是 v2 手填「定时抢票」时刻的用法，区别只是时刻可以自动推算。）
        if (conf.reserveDate) {
            const at = UIModule.reserveFireAt(conf.reserveDate);
            if (!at) {
                log(`预约 ${conf.reserveDate}：还差开火时刻 —— 展开日历，在「预约抢票」那一行填上几点开售（或点「用起售时刻」）`, 'warn');
            } else {
                const u = makeUnit({ date: conf.reserveDate, fromCode: conf.fromCode, toCode: conf.toCode, fromName: conf.fromName, toName: conf.toName },
                    conf.seatTypes, conf.trainCodes, null);
                u.saleAt = at;
                u.status = at > Date.now() ? 'wait' : 'hunt';
                u.reserve = true;
                u.saleText = `${fmtClockDate(at)} 开火`;
                const seatText = seatNamesOf(conf.seatTypes).map(x => x[0]).join(' / ');
                plans.push({
                    key: `y|${conf.reserveDate}|${conf.fromCode}|${conf.toCode}`, seq: seq++,
                    type: 'y', typeName: '预约', date: conf.reserveDate,
                    title: `${conf.fromName} → ${conf.toName}`,
                    notYet: true,
                    win: u.saleText.replace(' 开火', ''),
                    winAt: at,
                    saleShort: u.saleText,
                    lines: [
                        { t: `${conf.reserveDate} 的票` },
                        { t: `抢 ${seatText}` },
                        { t: '只抢直达 · 车次开售时才知道', cls: 'dim' },
                        { t: u.saleText, cls: 'sale' }
                    ],
                    units: [u]
                });
                log(`已加入预约：${conf.reserveDate} 的票，${u.saleText}。这个日期 12306 现在还查不到车次，`
                    + '到点脚本会自己查票并开抢——车次不限，席别按你的优先顺序。', 'success');
                log('注意：预约**只抢直达**（一张票、不下车）。中转要两段都可售才查得到，'
                    + '开售那一秒还查不到，没法提前布阵；买长乘短要核对经停站，抢首发时多一个请求就多一分丢票风险。'
                    + '想把中转也一起抢：在「开售前十几分钟」用正常流程 —— 那时这个日期已经进了预售期，'
                    + '点一次「下一步」就会把直达 / 买长乘短 / 中转全列出来，各自标好开火时刻。', 'info');
            }
        }

        // 票价放在最后查：一趟车一次请求，所以带预算、失败就停，
        // 绝不因为"想看个价"把限流额度烧光。
        if (plans.length) {
            say('票价');
            const n = await attachPrices(plans);
            if (!n) log('票价没查到（12306 没给，或者正在限流）—— 不影响抢票，付款页会显示实际金额', 'warn');
        }
        const coverText = conf.trainDates.length
            ? `覆盖 ${conf.trainDates.length} 天`
            : (conf.reserveDate ? '只含 1 条预约' : '无日期');
        log(`查询完成：直达/买长乘短 ${plans.filter(p => p.type !== 't' && p.type !== 'y').length} 条 · 中转 ${plans.filter(p => p.type === 't').length} 条 · 预约 ${plans.filter(p => p.type === 'y').length} 条（${coverText}）`,
            plans.length ? 'success' : 'warn');
        // 把"开售 = 开抢"这件事说清楚：很多人以为可以先等开售、再从容地抢，
        // 实际上开售那一秒就是抢的那一秒，热门车次几秒内就没。
        const notYetPlans = plans.filter(p => p.notYet);
        if (notYetPlans.length) {
            const times = Array.from(new Set(notYetPlans.map(p => p.win))).filter(Boolean).sort();
            log(`其中 ${notYetPlans.length} 条还没开售（${times.join(' / ')} 开售）。`
                + '注意：开售那一刻就是开抢那一刻——12306 是把票"放进池子"的同时开始接单，没有"先开售、再从容抢"这回事。'
                + '脚本会守着，到点自动连发下单请求；这段时间别关页面、别切走标签页。', 'info');
        }
        if (!plans.length) {
            UIModule.alertBanner('没查到任何方案',
                '换个日期或站点再试；也可能是 12306 这会儿在限流，过一会儿再点一次「下一步」。', 'warn');
        }
        return plans;
    }

    // --------------------------------------------------------------------------
    // 调度
    // --------------------------------------------------------------------------
    function collectUnits() {
        const out = [];
        if (!taskCtx) return out;
        taskCtx.plans.forEach((p, pi) => (p.units || []).forEach((u, i) => out.push({ plan: p, u, i, pi, order: pi * 10 + i })));
        return out;
    }
    function destKey(d) { return `${d.date}|${d.fromCode}|${d.toCode}`; }
    function nextSaleAt() {
        const now = Date.now();
        let best = null;
        collectUnits().forEach(x => {
            if (x.u.status === 'got' || x.u.status === 'fail') return;
            if (x.u.saleAt && x.u.saleAt > now && (best === null || x.u.saleAt < best)) best = x.u.saleAt;
        });
        return best;
    }
    function msToNextSale() { const n = nextSaleAt(); return n === null ? null : n - Date.now(); }
    function lastFiredAt() {
        const now = Date.now();
        let best = null;
        collectUnits().forEach(x => {
            if (!x.u.saleAt || x.u.saleAt > now) return;
            if (best === null || x.u.saleAt > best) best = x.u.saleAt;
        });
        return best;
    }
    function inHotWindow() {
        const now = Date.now();
        return collectUnits().some(x =>
            x.u.status !== 'got' && x.u.saleAt &&
            now >= x.u.saleAt - HOT_BEFORE_MS && now <= x.u.saleAt + HOT_AFTER_MS);
    }
    // 预约是否处在"开火前试探期"（用来把轮询放慢到 12~20 秒一次）
    function reserveWarmupAt() {
        const now = Date.now();
        let best = null;
        collectUnits().forEach(x => {
            if (!x.u.reserve || x.u.status === 'got' || x.u.status === 'fail') return;
            if (!x.u.saleAt) return;
            const d = x.u.saleAt - now;
            if (d > 0 && d <= WARMUP_MS && (best === null || d < best)) best = d;
        });
        return best;
    }
    // 预约的开火时刻已经过了、但还没抢到 —— 说明推算不准（或者还没放票）。
    // 这时候绝不能按普通"捡漏"频率（约 1 秒一次）转下去：可能空转几小时甚至更久，
    // 那点请求量够被 12306 当成刷单。**不设时限**，一直慢速试探到抢到或用户停掉为止。
    // （实测教训：一开始加了个"3 小时内"的窗口，结果开火后 3 小时又退回每秒一次，等于没修。）
    function reserveMissedAt() {
        const now = Date.now();
        let best = null;
        collectUnits().forEach(x => {
            if (!x.u.reserve || x.u.status === 'got' || x.u.status === 'fail') return;
            if (!x.u.saleAt || x.u.saleAt > now) return;
            const d = now - x.u.saleAt;
            if (best === null || d < best) best = d;
        });
        return best;
    }
    function pollDelay() {
        const ms = msToNextSale();
        if (inHotWindow()) return randBetween(POLL.hot);
        const fired = lastFiredAt();
        if (fired && Date.now() - fired < SETTLE_AFTER_MS) return randBetween(POLL.settle);
        if (ms === null) return reserveMissedAt() !== null ? randBetween(POLL.probe) : randBetween(POLL.cool);
        if (ms > 600000) return randBetween(POLL.far);
        if (ms > 60000) {
            // 预约的试探期用慢速：这一刻查了也是"未开售"，密集轮询纯烧额度，
            // 但也不能不查 —— 万一 12306 提前放票，等到推算时刻就晚了。
            return randBetween(reserveWarmupAt() !== null ? POLL.probe : POLL.idle);
        }
        if (ms > HOT_BEFORE_MS) return randBetween(POLL.warmup);
        return randBetween(POLL.hot);
    }
    function backoffFactor() {
        if (netFailWindow.length < 3) return 1;
        const rate = netFailWindow.reduce((a, b) => a + b, 0) / netFailWindow.length;
        if (rate >= 0.7) return 6;
        if (rate >= 0.5) return 4;
        if (rate >= 0.25) return 2;
        return 1;
    }
    function circuitFloorMs() {
        if (netFailStreak >= 10) return 8000;
        if (netFailStreak >= 6) return 5000;
        return 0;
    }
    function noteRound(failed) {
        netFailWindow.push(failed ? 1 : 0);
        if (netFailWindow.length > 8) netFailWindow.shift();
        netFailStreak = failed ? netFailStreak + 1 : 0;
        if (netFailStreak >= 3 && netFailStreak % 3 === 0) {
            const floor = circuitFloorMs();
            log(`⚠️ 已连续 ${netFailStreak} 轮连不上 12306，`
                + (floor ? `自动放慢到 ${floor / 1000} 秒一轮。` : '已自动放慢请求间隔。')
                + '保活请求是正常的，所以这不是断网，是查票接口被掐——慢下来让它缓一缓。', 'warn');
        }
        if (netFailStreak > 0 && netFailStreak % 5 === 0) {
            if (rotateQueryUrl()) log(`查票接口连续 ${netFailStreak} 轮被拒，已换到 ${QUERY_URL} 再试`, 'warn');
        }
    }
    function scheduleNext(delay) {
        if (!UIModule.getIsRunning()) return;
        if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
        let wait;
        if (delay !== undefined) wait = delay;
        else wait = Math.max(Math.round(pollDelay() * backoffFactor()), circuitFloorMs());
        checkTimer = setTimeout(runRound, wait);
    }

    async function queryDest(d) {
        try {
            const res = await NetworkModule.queryTickets(d.dest.date, d.dest.fromCode, d.dest.toCode,
                taskCtx.conf.purposeCodes, inHotWindow() ? QUERY_TIMEOUT_MS_HOT : QUERY_TIMEOUT_MS);
            everQueryOk = true;
            if (res && res.status === false) {
                const msgs = (res.messages || []).join(' ');
                if (/登录|login/i.test(msgs)) {
                    try {
                        const still = await NetworkModule.checkLoginStatus();
                        if (!still) return { logout: true };
                    } catch (e) { /* 连不上不算掉线 */ }
                }
                return { fail: true };
            }
            if (!res || !res.data || !Array.isArray(res.data.result)) return { fail: true };
            return { raw: res.data.result };
        } catch (e) {
            return { fail: true, err: e.message };
        }
    }

    // 在某个目的地的查票结果里，按用户顺序找第一个能下单的单元
    function pickHit(d, liveUnits) {
        const cands = liveUnits.filter(x => destKey(x.u.dest) === d.k);
        cands.sort((a, b) => a.order - b.order);
        for (const x of cands) {
            const codes = (x.u.codes && x.u.codes.length) ? x.u.codes : [''];
            let best = null;
            for (const code of codes) {
                const t = TicketLogicModule.findTargetTrain(d.raw, code, x.u.seatTypes,
                    taskCtx.conf.departFrom, taskCtx.conf.departTo,
                    { from: x.u.dest.fromCode, to: x.u.dest.toCode, acceptSameCity: taskCtx.conf.acceptSameCity }, null);
                if (!t) continue;
                if (!best || String(t.startTime) < String(best.startTime)) best = t;
            }
            if (best) {
                // ★ 用「查询日期」覆盖 parts[13]。
                //   parts[13] 是**列车始发日期**，不是乘车日期：过路车如果在始发站是前一天晚上
                //   开的，这个字段会比乘车日期早一天甚至两天（实测 341 条里 13 条如此，
                //   例：Z175 乘车站 04:08 发车，parts[13] 却是前天）。
                //   而 submitOrderRequest / getQueueCount 要的都是**乘车日期** ——
                //   12306 自己的 JS 也是取日期输入框的值（$("#train_date").val()），不是行里这个字段。
                //   传错的后果是下单被拒，而报错信息看起来像"票没了"，极难查。
                best.trainDate = x.u.dest.date;
                // 站名补上：findTargetTrain 只填简码，日志里会打出 undefined→undefined
                best.fromName = stationNameOf(x.u.dest.fromCode) || x.u.dest.fromCode;
                best.toName = stationNameOf(x.u.dest.toCode) || x.u.dest.toCode;
                return { unit: x.u, plan: x.plan, train: best, order: x.order };
            }
        }
        return null;
    }

    async function runRound() {
        if (!UIModule.getIsRunning() || inRound) return;
        inRound = true;
        const roundStart = Date.now();
        try {
            const now = Date.now();
            const units = collectUnits().filter(x => x.u.status !== 'got' && x.u.status !== 'fail');
            if (!units.length) { inRound = false; return; }

            // 还没到开售时刻的：不查（查了也是"未到起售时间"，纯浪费限流额度）
            const live = [], pending = [];
            units.forEach(x => {
                // 预约的开火时刻是**推算**的（12306 对窗口外的日期查不到）。
                // 万一它提前放票，等到推算时刻就晚了 —— 所以提前 5 分钟就开始慢速试探。
                const warm = x.u.reserve ? WARMUP_MS : 0;
                if (x.u.saleAt && x.u.saleAt > now + warm) { pending.push(x); x.u.status = 'wait'; }
                else live.push(x);
            });
            if (pending.length && Date.now() - lastFiredLogAt > 30000) {
                lastFiredLogAt = Date.now();
                const ns = nextSaleAt();
                log(`等待开火：${pending.length} 段还没到起售时间（下一场 ${ns ? fmtClock(ns) : '—'}`
                    + `${ns ? '，还有 ' + UIModule.humanLeft(ns - Date.now()) : ''}）`, 'info');
            }
            if (!live.length) { inRound = false; UIModule.renderRunList(); UIModule.updateNextFire(); scheduleNext(); return; }

            // 按目的地去重：一次请求覆盖所有指向同一目的地的单元，请求数不随方案数膨胀
            const dests = [];
            live.forEach(x => {
                const k = destKey(x.u.dest);
                if (!dests.some(y => y.k === k)) dests.push({ k, dest: x.u.dest, raw: null, fail: false });
            });
            log(`本轮查 ${dests.length} 个目的地（覆盖 ${live.length} 段）`, 'info');

            const state = { hits: [], done: 0, total: dests.length, ordered: false };
            let aggTimer = null;
            const maybeOrder = () => {
                if (state.ordered || !state.hits.length) return;
                state.ordered = true;
                state.hits.sort((a, b) => a.order - b.order);
                placeOrder(state.hits[0]).catch(e => tlog('error', '[Order] 未捕获异常:', e));
            };

            dests.forEach(d => {
                queryDest(d).then(r => {
                    state.done++;
                    if (r.logout) { handleLoggedOut(); return; }
                    if (r.raw) {
                        d.raw = r.raw;
                        const h = pickHit(d, live);
                        if (h) {
                            state.hits.push(h);
                            // 第一个命中后开一个很短（60ms）的聚合窗口：
                            // 既不让"最慢那个请求"拖死整轮，又给优先级更高的结果一点追赶时间。
                            if (!aggTimer) aggTimer = setTimeout(maybeOrder, AGG_WINDOW_MS);
                        }
                    }
                });
            });

            await new Promise(resolve => {
                const t = setInterval(() => {
                    if (state.ordered || state.done >= state.total) {
                        clearInterval(t);
                        if (!state.ordered && state.hits.length) { if (aggTimer) clearTimeout(aggTimer); maybeOrder(); }
                        resolve();
                    }
                }, 20);
            });

            const failN = dests.filter(d => d.fail).length;
            noteRound(dests.length > 0 && failN === dests.length);
            if (inHotWindow() || failN) {
                tlog('log', `[Probe] t=${new Date(roundStart).toLocaleTimeString()} jobs=${dests.length}`
                    + ` fail=${failN} hot=${inHotWindow() ? 1 : 0} rtt=${Date.now() - roundStart}ms`);
            }
            UIModule.renderRunList();
            UIModule.updateNextFire();
            if (!state.ordered) {
                if (!inHotWindow()) log(`捡漏中：${live.length} 段，本轮没有可下单的余票`, 'warn');
                inRound = false;
                scheduleNext();
                return;
            }
            inRound = false;   // 下单流程自己会安排后续
        } catch (e) {
            tlog('error', '[Round] 出错:', e);
            log(`查票出错：${e.message}`, 'error');
            inRound = false;
            scheduleNext();
        }
    }

    function explainOrderError(err) {
        const msg = String(err || '');
        if (/过于频繁|频繁/.test(msg)) {
            log('   ↳ 这是 12306 的限流，不是票没了。脚本会自动放慢再试', 'warn');
            return;
        }
        if (/非法的订票请求/.test(msg)) {
            if (taskCtx && taskCtx.conf.passengers.some(p => p.isStudent === true)) {
                log('   ↳ 这个报错基本可以确定是学生票：你买的路段不在学生票的「优惠区间」内。', 'error');
                UIModule.alertBanner('学生票用不了这段路',
                    '12306 拒绝了下单（"非法的订票请求"）。\n你勾了「学生票」，但买的路段不在学生票的优惠区间内。\n\n'
                    + '两种办法：\n1. 去 12306 App 把优惠区间改成你现在要坐的路段\n2. 取消勾选「学生票」，改买成人票');
            } else {
                log('   ↳ 12306 没给具体原因。如果反复出现，把日志发出来看看', 'warn');
            }
        }
    }

    function isPlanComplete(plan) { return (plan.units || []).every(u => u.status === 'got'); }

    async function placeOrder(hit) {
        const { unit, plan, train } = hit;
        if (!UIModule.getIsRunning()) return;
        const idx = plan.units.indexOf(unit);
        unit.status = 'hit';
        unit.train = train;
        UIModule.setPlanUnitStatus(plan.key, idx, 'hit', '正在下单');
        UIModule.setStatus('发现有票，正在下单…', 'hit', `${train.trainCode} ${train.seatName}`);
        UIModule.playBeep();
        log(`🎉 有票：${train.trainCode} ${train.startTime} ${train.fromName}→${train.toName} ${train.seatName}，开始下单`, 'success');

        const chooseSeats = buildChooseSeatsFromLetters(cfg.seatLetters, taskCtx.conf.passengers.length);
        const res = await OrderLogicModule.executeOrderSequence(train, taskCtx.conf.passengers, chooseSeats, cfg.silentCar);
        if (res.success) {
            orderFailStreak = 0; orderMissStreak = 0;
            unit.status = 'got';
            unit.orderId = res.orderId || '';
            UIModule.setPlanUnitStatus(plan.key, idx, 'got', '已到手');
            log(`✅ 下单成功${res.orderId ? '，订单号 ' + res.orderId : ''}（${train.fromName}→${train.toName} ${train.seatName}）`, 'success');
            saveOrderNotice({
                trainCode: train.trainCode, trainDate: train.trainDate,
                fromName: train.fromName, toName: train.toName,
                seatName: train.seatName, orderId: res.orderId || ''
            });
            recordRelay(plan, unit, train, res.orderId);
            if (isPlanComplete(plan)) { finishSuccess(plan); return; }
            // 半步：继续盯着剩下的段，同时催付款
            const rest = plan.units.filter(u => u.status !== 'got');
            const nextAt = rest.map(u => u.saleAt).filter(Boolean).sort()[0];
            const when = nextAt ? fmtClock(nextAt) : '';
            UIModule.setStatus('已拿到一半，继续盯下一段', 'run', when ? `第 2 段 ${when} 开火` : '');
            UIModule.alertBanner('第 1 段到手了，先去付款',
                `订单号：${res.orderId || '见 12306 订单页'}\n`
                + `${train.trainCode} ${train.fromName}→${train.toName} ${train.seatName}\n\n`
                + (when ? `第 2 段 ${when} 才开售，脚本会继续盯着。\n\n` : '')
                + '注意：未支付订单 30 分钟后会被取消。先把这一段付掉，别等第二段。', 'success');
            showRelayPanel();
            scheduleNext(1200);
        } else {
            unit.status = 'hunt';
            UIModule.setPlanUnitStatus(plan.key, idx, 'hunt', '没抢到');
            log(`❌ 下单失败：${res.error}`, 'error');
            explainOrderError(res.error);
            if (/未处理的订单|未完成订单/.test(String(res.error))) {
                UIModule.alertBanner('抢不了：账号里有未完成订单',
                    '12306 在「未完成订单」被处理掉之前，会拒绝一切新订单。\n\n'
                    + '请去 12306 的【未完成订单】页，把里面的订单全部支付或取消掉，然后重新点「开始抢票」。');
                stopWithMessage('已停止：需要先处理 12306 的未完成订单');
                return;
            }
            const normalRush = /排队人数|超过余票|没有足够的票|余票不足|票已售完|无票/.test(String(res.error));
            if (normalRush) {
                orderMissStreak++;
                if (orderMissStreak === 3) {
                    log('连续撞上「票被抢走」——把重试间隔拉长一点：一秒两单在 12306 看来就是刷单。一旦抢到立刻恢复原速。', 'warn');
                }
                scheduleNext();
            } else {
                orderFailStreak++;
                if (orderFailStreak >= 10) {
                    log(`⛔ 下单连续失败 ${orderFailStreak} 次，而且不是"票被抢走"，停止重试。最后一次：${res.error}`, 'error');
                    stopWithMessage('已停止：下单反复失败，请检查日志里的原因');
                    return;
                }
                scheduleNext();
            }
        }
    }

    function showRelayPanel() {
        const half = readRelayState();
        if (!half || !half.legs || !half.legs.length) return;
        UIModule.setRelayVisible(true);
        const pend = half.pendingSaleAt;
        const idText = half.legs[0].orderId || '—';
        if (pend && pend > Date.now()) {
            const diff = pend - Date.now();
            UIModule.setRelayTitle(`第 1 段已到手（订单 ${idText}）· 距第 2 段开火 `
                + `${Math.floor(diff / 3600000)} 小时 ${Math.floor((diff % 3600000) / 60000)} 分`);
        } else if (pend) {
            UIModule.setRelayTitle(`第 1 段已到手（订单 ${idText}）· 第 2 段已开售，正在抢`);
        } else {
            UIModule.setRelayTitle(`第 1 段已到手（订单 ${idText}）· 继续盯第 2 段`);
        }
    }
    function recordRelay(plan, unit, train, orderId) {
        try {
            const half = readRelayState() || { legs: [] };
            const idx = plan.units.indexOf(unit);
            half.legs = (half.legs || []).filter(l => !(l.planKey === plan.key && l.idx === idx));
            half.legs.push({
                planKey: plan.key, idx,
                trainCode: train.trainCode, seatName: train.seatName,
                fromName: train.fromName, toName: train.toName,
                orderId: orderId || '', at: Date.now(), deadline: Date.now() + 30 * 60000
            });
            const rest = plan.units.filter(u => u.status !== 'got').map(u => u.saleAt).filter(Boolean).sort();
            half.pendingSaleAt = rest.length ? rest[0] : 0;
            half.label = `${train.trainCode} ${train.fromName}→${train.toName}`;
            half.trainDate = train.trainDate;
            saveRelayState(half);
        } catch (e) { /* 忽略 */ }
    }

    function finishSuccess(plan) {
        const label = plan.title + ' ' + plan.lines.map(l => l.t).slice(0, 2).join(' ');
        log(`✅✅ 整程到手：${label}`, 'success');
        UIModule.setStatus('抢到了！', 'ok', '去支付');
        UIModule.showNotification('抢票成功', `${plan.title}，请及时支付`);
        UIModule.alertBanner('抢到了，请尽快支付',
            `${label}\n\n订单号见 12306 的【未完成订单】。席位已锁定，30 分钟内完成支付，否则会自动释放。`, 'success');
        const orderId = (plan.units[0] && plan.units[0].orderId) || '';
        stopTaskInternal();
        clearRelayState();
        finishWithOrder(label, orderId);
    }

    async function finishWithOrder(label, orderId) {
        try {
            log('5 秒后自动跳转「未完成订单」页…', 'info');
            await new Promise(r => setTimeout(r, 5000));
            let logged = true;
            try { logged = await NetworkModule.checkLoginStatus(); }
            catch (e) { tlog('warn', `[Order] 跳转前检查登录态失败（按可跳处理）: ${e.message}`); }
            if (logged) {
                try {
                    techLog.push('--- 以下是跳转前的面板日志 ---');
                    for (const line of uiLogBuffer.slice(-40)) techLog.push(line);
                } catch (e) { /* 忽略 */ }
                flushLogsToStorage();
                window.location.href = `${BASE_URL}/otn/queryOrder/initNoComplete`;
                return;
            }
            const orderLine = orderId ? `订单号 ${orderId}` : '订单号以 12306 订单页为准';
            log(`⚠️ 票已经抢到了，但登录态失效了——先不跳。${orderLine}`, 'error');
            UIModule.alertBanner('票抢到了，但登录失效了',
                `${label}\n${orderLine}\n\n票已经在你账号里了（未支付状态）。跳过去只会看到登录页，所以脚本没跳。\n`
                + '请重新登录 12306，然后打开【未完成订单】完成支付。注意：30 分钟后会被取消。');
        } catch (e) {
            tlog('warn', `[Order] 收尾流程出错（订单已生成，不影响支付）: ${e.message}`);
        }
    }

    function handleLoggedOut() {
        UIModule.alertBanner('登录已失效，抢票停止',
            '你的 12306 登录掉线了，脚本已经停下来。\n\n请重新登录 12306，然后重新点「开始抢票」。');
        stopWithMessage('⚠️ 登录已失效，停止抢票，请重新登录后再开始');
    }

    function stopWithMessage(msg) {
        log(msg, 'error');
        stopTaskInternal();
        UIModule.setRunning(false);
        UIModule.goStep(2);
    }
    function stopTaskInternal() {
        if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
        if (fireTimer) { clearTimeout(fireTimer); fireTimer = null; }
        if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
        if (keepAliveTimer) { clearTimeout(keepAliveTimer); keepAliveTimer = null; }
        inRound = false;
        taskCtx = null;
        UIModule.setKeepAwake(false);
        UIModule.stopAlarm();
        warningAlarmOn = false;
        throttleWarned = false;
        GM_setValue('grab_running', false);
        lastStopAt = Date.now();
        try { GM_setValue('grab_last_stop_at', lastStopAt); } catch (e) { /* 忽略 */ }
    }

    // --------------------------------------------------------------------------
    // 三路唤醒
    // --------------------------------------------------------------------------
    function startWatches() {
        stopWatches();
        // 第一路：长 setTimeout 直接定到开火点（提前 PREHEAT_MS 醒）
        const next = nextSaleAt();
        if (next !== null) {
            const delay = Math.max(0, next - Date.now() - PREHEAT_MS);
            fireTimer = setTimeout(() => {
                fireTimer = null;
                if (!UIModule.getIsRunning()) return;
                log(`⏰ 到开火点了（${fmtClock(next)}）`, 'success');
                UIModule.playBeep();
                if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
                runRound();
            }, delay);
            tlog('log', `[Wake] 长定时器已定到 ${fmtClock(next)}（服务器时间，${Math.round(delay / 1000)}s 后）`);
        }
        // 第二路：1 秒心跳——既测限流，也做长定时器的兜底
        lastBeat = Date.now();
        beatTimer = setInterval(() => {
            const now = Date.now();
            const drift = now - lastBeat - 1000;
            lastBeat = now;
            if (!UIModule.getIsRunning()) return;
            if (drift > 3000 && !throttleWarned) {
                throttleWarned = true;
                log(`⚠️ 定时器被拉长到约 ${Math.round(drift / 1000)} 秒一次——浏览器在限流后台标签页，请切回本页面！`, 'error');
                UIModule.showNotification('请切回抢票页面', '浏览器会限制后台标签页的轮询');
                warningAlarmOn = true;
                UIModule.startAlarm();
            }
            if (!document.hidden && throttleWarned) {
                throttleWarned = false;
                log('✅ 定时器已恢复正常速度', 'success');
                if (warningAlarmOn) { UIModule.stopAlarm(); warningAlarmOn = false; }
            }
            // 兜底：到点了但长定时器没醒（被限流吞了）
            const n = nextSaleAt();
            if (n !== null && now >= n - PREHEAT_MS && !inRound) {
                if (checkTimer) {
                    clearTimeout(checkTimer); checkTimer = null;
                    log('[Wake] 心跳发现已经到开火点了，补一枪', 'warn');
                    runRound();
                }
            }
            // 快开火了但人在后台 → 报警叫他回来
            if (document.hidden && n !== null && (n - now) < NIGHT_WARN_BEFORE_MS && !warningAlarmOn) {
                warningAlarmOn = true;
                const mins = Math.max(0, Math.round((n - now) / 60000));
                UIModule.alertBanner('该切回抢票页面了',
                    `离下一场开火还有约 ${mins} 分钟。\n\n标签页在后台时，浏览器会把抢票轮询掐到每分钟 1 次——`
                    + '开票那一秒你就只剩一枪的机会。\n\n现在切回来，报警声就会停。');
                UIModule.startAlarm();
            }
            if (!document.hidden && warningAlarmOn && throttleWarned === false) {
                UIModule.stopAlarm(); warningAlarmOn = false;
            }
        }, 1000);
        // 第三路是报警本身（音频线程，不受定时器限流影响），见 UIModule.startAlarm
    }
    function stopWatches() {
        if (fireTimer) { clearTimeout(fireTimer); fireTimer = null; }
        if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
    }
    function startKeepAlive() {
        if (keepAliveTimer) return;
        const loop = async () => {
            keepAliveTimer = null;
            if (!UIModule.getIsRunning()) return;
            try {
                const ok = await NetworkModule.checkLoginStatus();
                if (!ok) {
                    log('⚠️ 保活检测到登录已失效，请尽快重新登录', 'error');
                    UIModule.setStatus('登录已失效', 'err', '需要重新登录');
                    UIModule.showNotification('登录已失效', '请重新登录 12306');
                    UIModule.startAlarm();
                    warningAlarmOn = true;
                } else {
                    tlog('log', '[KeepAlive] checkUser ok');
                }
            } catch (e) { tlog('warn', `[KeepAlive] 失败（不算掉线）: ${e.message}`); }
            if (!UIModule.getIsRunning()) return;
            keepAliveTimer = setTimeout(loop, randBetween([KEEPALIVE_MIN_MS, KEEPALIVE_MAX_MS]));
        };
        loop();
    }

    // --------------------------------------------------------------------------
    // 开始 / 停止
    // --------------------------------------------------------------------------
    function uiStart() {
        const cooldownLeft = lastStopAt ? Math.max(0, Math.ceil((RESTART_COOLDOWN_MS - (Date.now() - lastStopAt)) / 1000)) : 0;
        if (cooldownLeft > 0) {
            log(`⏸️ 刚停下不到 ${RESTART_COOLDOWN_MS / 1000} 秒，先等 ${cooldownLeft} 秒再开始（连着重启会一直撞限流）`, 'warn');
            UIModule.setRunning(false);
            UIModule.goStep(2);
            UIModule.alertBanner('先别急着重启',
                `任务刚停下来不到 ${RESTART_COOLDOWN_MS / 1000} 秒。\n\n马上重启会立刻重新发一轮请求，而 12306 这会儿多半还在限流。`
                + `\n\n请再等 ${cooldownLeft} 秒，然后重新点「开始抢票」。`, 'warn');
            return;
        }
        let conf;
        try { conf = readForm(); }
        catch (e) { log(`配置错误：${e.message}`, 'error'); UIModule.setRunning(false); UIModule.goStep(1); return; }
        if (conf.passengers.length === 0) { log('请选择至少一位乘车人', 'warn'); UIModule.setRunning(false); UIModule.goStep(1); return; }
        if (conf.seatTypes.length === 0) { log('请至少勾选一个席别', 'warn'); UIModule.setRunning(false); UIModule.goStep(1); return; }

        const plans = UIModule.activePlans();
        if (!plans.length) { log('一条方案都没勾', 'warn'); UIModule.setRunning(false); UIModule.goStep(2); return; }

        // ★ 硬拦截：不在 kyfw.12306.cn 上就不让开始。
        //   这不是"可能有问题"—— 实测从 www.12306.cn 抢：10:44:59 准时开火、10:45:00 就抓到了 D3123 的票，
        //   然后 submitOrderRequest 被 12306 挡回来（返回 HTML 错误页），连试 10 次全废，票就这么丢了。
        //   查票能走油猴通道绕开跨域，但**下单接口要同源** —— 所以只拦"开始抢票"，不拦查票/建方案。
        if (/12306\.cn$/.test(location.hostname) && location.hostname !== 'kyfw.12306.cn') {
            log(`✘ 抢票必须在 kyfw.12306.cn 域名下开始（任何页面都行：查询页、个人中心、订单中心…）。`
                + `现在在 ${location.hostname}：下单接口会被 12306 挡回来（它检查请求来源，跨域时补不上），抢到的票也提交不上去。`, 'error');
            UIModule.setRunning(false);
            UIModule.goStep(2);
            UIModule.alertBanner('换个页面再开始抢票',
                `现在这个页面是 ${location.hostname}，下单会被拒。\n\n`
                + '**规则只看域名**：地址栏开头是 kyfw.12306.cn 就行，不必非去查询页。\n'
                + '· 个人中心（kyfw.12306.cn/otn/view/index.html）—— ✅ 实测在这儿下出过真订单\n'
                + '· 车票查询（kyfw.12306.cn/otn/leftTicket/init）—— ✅\n\n'
                + '换成上面任意一个页面（面板会自动出现），再点「开始抢票」即可。\n\n'
                + '· 查票、建方案、算起售时刻 —— 在当前页面其实都能正常工作\n'
                + '· 但「提交订单」12306 会检查请求来源，跨域时必被挡回来（实测 10 次全拒，票就没了）', 'error');
            UIModule.showNotification('换个 kyfw 页面再抢', `${location.hostname} 上下单会被拒`);
            return;
        }

        taskCtx = { conf, plans };
        orderMissStreak = 0; orderFailStreak = 0;
        netFailWindow = []; netFailStreak = 0; everQueryOk = false;
        GM_setValue('grab_running', true);
        // 抢票按钮的点击就是"用户手势"，趁这一刻把音频唤醒（见 UIModule.ensureAudio 的注释）
        const audioOK = UIModule.ensureAudio();
        // 保持唤醒不再跟"接力"绑定：定时抢票本身就是"人到别处去了、等它自己开火"，
        // 后台限流是所有场景的共同敌人，不是接力专属。
        UIModule.setKeepAwake(cfg.keepAwake !== false);
        if (cfg.keepAwake !== false) {
            log('已开启「保持唤醒」：页面会维持一个近乎听不见的音调，避免浏览器把后台标签页限流到每分钟一次。'
                + '（它对抗不了电脑休眠——合盖/睡眠期间什么都不会跑）', 'info');
        } else {
            log('未开启「保持唤醒」：如果你要切走标签页，第一枪可能晚几十秒。建议在第 ③ 步打开它。', 'warn');
        }
        UIModule.setRelayVisible(!!readRelayState());
        if (readRelayState()) showRelayPanel();

        const all = collectUnits();
        const pendingCount = all.filter(x => x.u.status !== 'got' && x.u.saleAt > Date.now()).length;
        const liveCount = all.filter(x => x.u.status !== 'got' && (!x.u.saleAt || x.u.saleAt <= Date.now())).length;
        log(`开始抢票：${plans.length} 条方案 / ${all.length} 段（已开售 ${liveCount} 段，待开火 ${pendingCount} 段）`, 'info');
        if (!audioOK) log('⚠️ 浏览器没让脚本用声音（多半是页面还没交互过）—— 报警可能不会响，请先点一下页面上的任意位置再开始', 'warn');
        startKeepAlive();
        startWatches();
        runRound();
    }
    function uiStop() {
        stopWithMessage('已停止');
    }

    // --------------------------------------------------------------------------
    // 新页面加载时接着提醒上一笔订单
    // --------------------------------------------------------------------------
    function checkOrderNoticeOnLoad() {
        const n = readOrderNotice();
        if (!n) return;
        const label = orderNoticeLabel(n);
        UIModule.log(`ℹ️ 上次抢到的票还没支付：${label}${n.orderId ? `（订单号 ${n.orderId}）` : ''}`, 'warn');
        UIModule.alertBanner('你有一笔抢到的票还没支付',
            `${label}\n${n.orderId ? `订单号 ${n.orderId}` : '订单号见 12306 订单页'}\n\n`
            + '如果是刚抢到的，去【未完成订单】支付（30 分钟内有效）。\n已经付过或已经处理掉，点下面关掉这条提示就行。',
            'error', clearOrderNotice);
    }

    // ==========================================================================
    // 初始化
    // ==========================================================================
    setTimeout(async () => {
        await fetchStationMap(3);
        UIModule.init(buildPlans, uiStart, uiStop);
        // 开局就把"环境"写进日志：这一行能让所有"加载不出来"的报障一眼定性
        UIModule.log(`运行环境：${location.hostname} ｜ 油猴跨域通道 `
            + (typeof GM_xmlhttpRequest === 'function' ? '✔ 可用' : '✘ 不可用（脚本版本可能旧了，重新装一次）')
            + ` ｜ 站点表 ${Object.keys(stationMap).length} 个`, 'info');
        // 主页（www.12306.cn）上，页面 fetch 往 kyfw.12306.cn 发请求会撞跨域。
        // 有油猴通道兜着就没事；万一没有（比如脚本被塞进别的注入器），当场说清楚。
        if (location.hostname === 'www.12306.cn') {
            if (typeof GM_xmlhttpRequest === 'function') {
                // 之前这里写的是"可以正常用"—— 实测证明是错的：
                // 查票能绕开跨域，但**下单接口会被 12306 挡回来**（它检查 Referer，
                // 而扩展不允许伪造 Referer），表现是返回一张 HTML 错误页。
                UIModule.log('⚠️ 你在 12306 的 www 域名上（首页/会员服务）。查票能走油猴通道绕开跨域，'
                    + '但【下单】接口会被挡回来（12306 检查请求来源，扩展没法伪造 Referer）——'
                    + '抢票请换到 kyfw.12306.cn 的任意页面（个人中心、查询页都行）。', 'error');
                UIModule.alertBanner('换个 kyfw 页面再用',
                    '当前页面是 www.12306.cn（首页/会员服务），下单会被拒。\n\n'
                    + '**规则只看域名**：地址栏开头是 kyfw.12306.cn 就行。\n'
                    + '· 个人中心 kyfw.12306.cn/otn/view/index.html —— ✅ 实测在这儿下出过真订单\n'
                    + '· 车票查询 kyfw.12306.cn/otn/leftTicket/init —— ✅\n\n'
                    + '· 查票、算起售时刻 —— 在当前页面也能正常工作（走油猴通道绕开了跨域）\n'
                    + '· 但「提交订单」12306 会检查请求来源，跨域时必被挡回来', 'warn');
            } else {
                UIModule.log('⚠️ 当前在 www.12306.cn，而且拿不到油猴的跨域通道——请到【车票】→【单程】查询页再开始', 'error');
                UIModule.alertBanner('请到车票查询页再开始',
                    '脚本现在跑在 www.12306.cn 上，往 kyfw.12306.cn 发的请求会被浏览器跨域拦掉，而且没拿到油猴的跨域通道。\n\n'
                    + '请点顶部【车票】→【单程】，进到查询页（地址是 kyfw.12306.cn/otn/leftTicket/init），'
                    + '面板会自动出现在那里。', 'warn');
            }
        }
        checkOrderNoticeOnLoad();
        const half = readRelayState();
        if (half && half.legs && half.legs.length) {
            UIModule.log('检测到上次没跑完的接力（手上有一段票），进第 ③ 步看一眼', 'warn');
            UIModule.setRelayVisible(true);
            showRelayPanel();
        }
        probeQueryUrl();
        sniffLcSearchUrl();
    }, 1000);
})();

// ---------------------------------------------------------------------------
// 作者：LittlePerson
// 二次开发说明（不参与执行）：
//   本项目参考 辻弌20 的开源脚本「12306 抢票助手 Pro v2.1.17」
//   （MIT License，https://scriptcat.org/zh-CN/script-show-page/6106），
//   在其基础上完成 v3.0 ~ v3.3.5 的重构与维护。
//   改动清单与设计说明见 README.md、docs/CHANGELOG.md、docs/ARCHITECTURE.md。
// ---------------------------------------------------------------------------
