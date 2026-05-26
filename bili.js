// B 站 Web 接口薄封装: buvid / wbi / bili_ticket 缓存, 以及本工具需要的几个端点.
// 被 server.js / download.js 共享复用.

const crypto = require('node:crypto');
const { encWbi } = require('./wbi');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

function parseSetCookies(setCookie) {
  const arr = Array.isArray(setCookie)
    ? setCookie
    : setCookie
    ? String(setCookie).split(/,(?=[^;]+?=)/)
    : [];
  return arr.map((line) => line.split(';', 1)[0].trim()).filter(Boolean);
}

function normalizeCookieHeader(cookie) {
  return String(cookie || '')
    .replace(/^cookie:\s*/i, '')
    .replace(/\r?\n/g, '; ')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('; ');
}

function envCookieHeader() {
  return normalizeCookieHeader(process.env.BILI_COOKIE || process.env.BILI_COOKIES || '');
}

function cookieHas(header, name) {
  const needle = `${String(name).toLowerCase()}=`;
  return normalizeCookieHeader(header)
    .split(';')
    .map((part) => part.trim().toLowerCase())
    .some((part) => part.startsWith(needle));
}

function cookiePair(header, name) {
  const needle = `${String(name).toLowerCase()}=`;
  return (
    normalizeCookieHeader(header)
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.toLowerCase().startsWith(needle)) || ''
  );
}

function createBiliClient() {
  const cache = {
    buvidCookie: '',
    buvidExpire: 0,
    wbi: null,
    ticket: '', // bili_ticket
    ticketExpire: 0,
    cookieOverride: '',
  };

  // 生成 bili_ticket 用的 hexsign
  function genHexSign(timestamp) {
    return crypto
      .createHmac('sha256', 'XgwSnGZ1p')
      .update('ts' + timestamp)
      .digest('hex');
  }

  function clientEnvCookieHeader() {
    return normalizeCookieHeader(
      cache.cookieOverride || process.env.BILI_COOKIE || process.env.BILI_COOKIES || ''
    );
  }

  function setCookieOverride(cookieString) {
    cache.cookieOverride = normalizeCookieHeader(cookieString);
  }

  async function ensureBiliTicket(csrf = '') {
    const now = Date.now();
    if (cache.ticket && now < cache.ticketExpire) return cache.ticket;
    const cookieTicket = cookiePair(clientEnvCookieHeader(), 'bili_ticket');
    if (cookieTicket) return cookieTicket.slice('bili_ticket='.length);
    try {
      const ts = Math.floor(now / 1000);
      const hexsign = genHexSign(ts);
      const params = new URLSearchParams();
      params.set('key_id', 'ec02');
      params.set('hexsign', hexsign);
      params.set('context[ts]', String(ts));
      if (csrf) params.set('csrf', csrf);
      const url =
        'https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket?' +
        params.toString();
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          Referer: 'https://www.bilibili.com/',
          Accept: 'application/json, text/plain, */*',
        },
      });
      const data = await r.json();
      if (data && data.code === 0 && data.data && data.data.ticket) {
        cache.ticket = data.data.ticket;
        const ttlMs = Math.max(1, (data.data.ttl || 3600) - 300) * 1000;
        cache.ticketExpire = now + ttlMs;
        // 顺便把 wbi 也缓存上 (nav 字段)
        if (data.data.nav && data.data.nav.img && data.data.nav.sub) {
          cache.wbi = {
            imgKey: data.data.nav.img,
            subKey: data.data.nav.sub,
            ts: now,
          };
        }
      } else {
        console.warn(
          '[bili_ticket] 获取失败:',
          data && data.code,
          data && data.message
        );
      }
    } catch (e) {
      console.warn('[bili_ticket] 请求异常:', e.message);
    }
    return cache.ticket;
  }

  async function ensureBuvid() {
    const now = Date.now();
    if (cache.buvidCookie && now < cache.buvidExpire) return cache.buvidCookie;
    const browserCookie = clientEnvCookieHeader();
    const fromBrowser = ['buvid3', 'buvid4', 'b_nut', '_uuid']
      .map((name) => cookiePair(browserCookie, name))
      .filter(Boolean)
      .join('; ');
    if (fromBrowser) {
      cache.buvidCookie = fromBrowser;
      cache.buvidExpire = now + 30 * 60 * 1000;
      return cache.buvidCookie;
    }
    try {
      const r = await fetch('https://www.bilibili.com/', {
        headers: {
          'User-Agent': UA,
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        redirect: 'follow',
      });
      const setCookies =
        (r.headers.getSetCookie && r.headers.getSetCookie()) ||
        (r.headers.raw && r.headers.raw()['set-cookie']) ||
        [];
      const pairs = parseSetCookies(setCookies);
      cache.buvidCookie = pairs
        .filter((p) => /^(buvid3|buvid4|b_nut|_uuid)=/.test(p))
        .join('; ');
      cache.buvidExpire = now + 30 * 60 * 1000;
    } catch (e) {
      console.warn('[buvid] 获取失败:', e.message);
    }
    return cache.buvidCookie;
  }

  async function ensureWbiKeys(sessdata) {
    const now = Date.now();
    if (cache.wbi && now - cache.wbi.ts < 10 * 60 * 1000) return cache.wbi;
    const buvid = await ensureBuvid();
    const headers = buildHeaders({
      sessdata,
      referer: 'https://www.bilibili.com/',
      buvid,
    });

    const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers,
    });
    const data = await r.json();
    const imgUrl = data?.data?.wbi_img?.img_url || '';
    const subUrl = data?.data?.wbi_img?.sub_url || '';
    const parse = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'));
    if (!imgUrl || !subUrl) {
      throw new Error('无法获取 wbi_img (' + (data && data.message) + ')');
    }
    cache.wbi = { imgKey: parse(imgUrl), subKey: parse(subUrl), ts: now };
    return cache.wbi;
  }

  // 查询当前 SESSDATA 对应的登录状态; 失败时 ok=false 并携带 code/message
  async function fetchLoginStatus({ sessdata } = {}) {
    const buvid = await ensureBuvid();
    const ticket = await ensureBiliTicket();
    const headers = buildHeaders({
      sessdata,
      referer: 'https://www.bilibili.com/',
      buvid,
      ticket,
    });
    try {
      const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        headers,
      });
      const data = await r.json();
      // 成功响应时顺便把 wbi 缓存一下
      if (data && data.code === 0 && data.data) primeWbiFromNav(data);
      return {
        ok: !!(data && data.code === 0),
        code: data && Number.isFinite(data.code) ? data.code : 0,
        message: (data && data.message) || '',
        isLogin: !!(data && data.data && data.data.isLogin),
        mid: (data && data.data && data.data.mid) || 0,
        uname: (data && data.data && data.data.uname) || '',
        raw: data || null,
      };
    } catch (e) {
      return {
        ok: false,
        code: 0,
        message: String(e && e.message ? e.message : e),
        isLogin: false,
        mid: 0,
        uname: '',
        error: e,
      };
    }
  }

  // 主动缓存 wbi (来自 verify-login 的响应), 省一次请求
  function primeWbiFromNav(data) {
    const imgUrl = data?.data?.wbi_img?.img_url || '';
    const subUrl = data?.data?.wbi_img?.sub_url || '';
    if (!imgUrl || !subUrl) return;
    const parse = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'));
    cache.wbi = {
      imgKey: parse(imgUrl),
      subKey: parse(subUrl),
      ts: Date.now(),
    };
  }

  function buildHeaders({ sessdata, referer, buvid = '', ticket = '' }) {
    const h = {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Origin: 'https://www.bilibili.com',
      'Sec-Ch-Ua': '"Chromium";v="148", "Google Chrome";v="148", "Not-A.Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
    };
    if (referer) h.Referer = referer;
    const cookieParts = [];
    const browserCookie = clientEnvCookieHeader();
    if (browserCookie) cookieParts.push(browserCookie);
    if (sessdata && !cookieHas(browserCookie, 'SESSDATA')) {
      cookieParts.push(`SESSDATA=${sessdata}`);
    }
    for (const pair of normalizeCookieHeader(buvid).split(';').filter(Boolean)) {
      const name = pair.split('=', 1)[0];
      if (name && !cookieHas(cookieParts.join('; '), name)) cookieParts.push(pair.trim());
    }
    if (ticket && !cookieHas(cookieParts.join('; '), 'bili_ticket')) {
      cookieParts.push(`bili_ticket=${ticket}`);
    }
    if (cookieParts.length) h.Cookie = cookieParts.join('; ');
    return h;
  }

  async function fetchSpacePage({ sessdata, host_mid, offset = '' }) {
    const buvid = await ensureBuvid();
    const ticket = await ensureBiliTicket();
    const { imgKey, subKey } = await ensureWbiKeys(sessdata);

    const rawParams = {
      offset: offset || '',
      host_mid: String(host_mid),
      timezone_offset: -480,
      platform: 'web',
      features: [
        'itemOpusStyle',
        'listOnlyfans',
        'opusBigCover',
        'onlyfansVote',
        'forwardListHidden',
        'decorationCard',
        'commentsNewVersion',
        'onlyfansAssetsV2',
        'ugcDelete',
        'onlyfansQaCard',
      ].join(','),
      web_location: '333.1387',
      dm_img_list: '[]',
      dm_img_str: 'V2ViR0wgMS4w',
      dm_cover_img_str:
        'QU5HTEUgKEludGVsLCBJbnRlbChSKSBVSEQgR3JhcGhpY3MgNjMwIERpcmVjdDNEMTEgdnNfNV8wIHBzXzVfMCwgRDNEMTEp',
      dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
    };

    const { query } = encWbi(rawParams, imgKey, subKey);
    const url = `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?${query}`;
    const r = await fetch(url, {
      headers: buildHeaders({
        sessdata,
        referer: `https://space.bilibili.com/${host_mid}/dynamic`,
        buvid,
        ticket,
      }),
    });
    return await r.json();
  }

  // 取单条动态详情 (space feed 列表里经常返回截断内容，用此接口补全)
  async function fetchDynamicDetail({ sessdata, id }) {
    const buvid = await ensureBuvid();
    const ticket = await ensureBiliTicket();
    const url = `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${encodeURIComponent(String(id))}`;
    const r = await fetch(url, {
      headers: buildHeaders({
        sessdata,
        referer: `https://www.bilibili.com/opus/${id}`,
        buvid,
        ticket,
      }),
    });
    return await r.json();
  }

  // 取专栏文章详情 (空间动态列表对文章只给摘要，正文需走此接口)
  async function fetchArticleView({ sessdata, cvid }) {
    const buvid = await ensureBuvid();
    const ticket = await ensureBiliTicket();
    const url = `https://api.bilibili.com/x/article/view?id=${encodeURIComponent(String(cvid))}`;
    const r = await fetch(url, {
      headers: buildHeaders({
        sessdata,
        referer: `https://www.bilibili.com/read/cv${cvid}`,
        buvid,
        ticket,
      }),
    });
    return await r.json();
  }

  // 取图文(opus)详情 (新版专栏必须用此接口+htmlNewStyle才能拿到正文)
  async function fetchOpusDetail({ sessdata, id }) {
    const buvid = await ensureBuvid();
    const ticket = await ensureBiliTicket();
    const features =
      'onlyfansVote,onlyfansAssetsV2,decorationCard,htmlNewStyle,ugcDelete,editable,opusPrivateVisible,tribeeEdit,avatarAutoTheme,avatarTypeOpus';
    const url = `https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/detail?id=${encodeURIComponent(String(id))}&features=${features}`;
    const r = await fetch(url, {
      headers: buildHeaders({
        sessdata,
        referer: `https://www.bilibili.com/opus/${id}`,
        buvid,
        ticket,
      }),
    });
    return await r.json();
  }

  // 根据 bvid 拿基本信息 (主要是 cid)
  async function fetchVideoView({ sessdata, bvid }) {
    const buvid = await ensureBuvid();
    const ticket = await ensureBiliTicket();
    const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(
      bvid
    )}`;
    const r = await fetch(url, {
      headers: buildHeaders({
        sessdata,
        referer: `https://www.bilibili.com/video/${bvid}/`,
        buvid,
        ticket,
      }),
    });
    return await r.json();
  }

  // 取 DASH 音视频流信息; 遇到 v_voucher 风控会自动退避重试
  async function fetchPlayUrl({ sessdata, bvid, cid, maxRetry = 3 }) {
    const buvid = await ensureBuvid();
    const ticket = await ensureBiliTicket();
    const { imgKey, subKey } = await ensureWbiKeys(sessdata);

    const doFetch = async () => {
      // 每次重签 wts 防止被判重放
      const rawParams = {
        bvid,
        cid,
        qn: 64,
        fnval: 4048,
        fnver: 0,
        fourk: 1,
      };
      const { query } = encWbi(rawParams, imgKey, subKey);
      const url = `https://api.bilibili.com/x/player/wbi/playurl?${query}`;
      const r = await fetch(url, {
        headers: buildHeaders({
          sessdata,
          referer: `https://www.bilibili.com/video/${bvid}/`,
          buvid,
          ticket,
        }),
      });
      return await r.json();
    };

    let last;
    for (let i = 0; i <= maxRetry; i++) {
      last = await doFetch();
      // 风控: data 只有 v_voucher / 或 code === -352
      const voucher = last && last.data && last.data.v_voucher;
      const isRisk = (last && last.code === -352) || (last && last.code === 0 && voucher && !last.data.dash && !last.data.durl);
      if (!isRisk) return last;
      // 指数退避 + 抖动: 1.5s, 3s, 6s
      const wait = 1500 * Math.pow(2, i) + Math.floor(Math.random() * 500);
      await new Promise((rs) => setTimeout(rs, wait));
    }
    return last;
  }

  // 取播放器信息 (含 subtitle 列表)
  async function fetchPlayerV2({ sessdata, bvid, cid }) {
    const buvid = await ensureBuvid();
    const ticket = await ensureBiliTicket();
    const { imgKey, subKey } = await ensureWbiKeys(sessdata);
    const rawParams = { bvid, cid };
    const { query } = encWbi(rawParams, imgKey, subKey);
    const url = `https://api.bilibili.com/x/player/wbi/v2?${query}`;
    const r = await fetch(url, {
      headers: buildHeaders({
        sessdata,
        referer: `https://www.bilibili.com/video/${bvid}/`,
        buvid,
        ticket,
      }),
    });
    return await r.json();
  }

  function debugSnapshot() {
    return {
      buvidCookie: cache.buvidCookie ? '(已缓存)' : '',
      ticket: cache.ticket ? '(已缓存)' : '',
      wbi: cache.wbi
        ? { imgKey: cache.wbi.imgKey, subKey: cache.wbi.subKey }
        : null,
    };
  }

  return {
    UA,
    ensureBuvid,
    ensureBiliTicket,
    ensureWbiKeys,
    primeWbiFromNav,
    buildHeaders,
    fetchLoginStatus,
    fetchSpacePage,
    fetchDynamicDetail,
    fetchArticleView,
    fetchOpusDetail,
    fetchVideoView,
    fetchPlayUrl,
    fetchPlayerV2,
    debugSnapshot,
    setCookieOverride,
    envCookieHeader: clientEnvCookieHeader,
  };
}

module.exports = { createBiliClient, UA };
