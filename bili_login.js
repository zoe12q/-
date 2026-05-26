const crypto = require('node:crypto');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`;

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

function cookieToRecord(cookie) {
  const record = {};
  for (const part of normalizeCookieHeader(cookie).split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      record[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  return record;
}

function recordToCookie(record) {
  return Object.entries(record)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function cookiePair(cookie, name) {
  return cookieToRecord(cookie)[name] || '';
}

async function generateQrCode() {
  const r = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
  });
  const data = await r.json();
  if (!data || data.code !== 0 || !data.data) {
    throw new Error(`generateQrCode failed: ${data?.code} ${data?.message}`);
  }
  return { url: data.data.url, qrcodeKey: data.data.qrcode_key };
}

async function pollQrCode(qrcodeKey, { onStatus, intervalMs = 3000, timeoutMs = 180000 } = {}) {
  const start = Date.now();
  const base = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';

  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${base}?qrcode_key=${encodeURIComponent(qrcodeKey)}`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    });
    const data = await r.json();
    if (!data || data.code !== 0 || !data.data) {
      throw new Error(`pollQrCode failed: ${data?.code} ${data?.message}`);
    }

    const statusCode = data.data.code;
    const message = data.data.message || '';
    if (onStatus) onStatus({ code: statusCode, message });

    if (statusCode === 0) {
      const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      const pairs = parseSetCookies(setCookies);
      const cookies = {};
      for (const pair of pairs) {
        const eq = pair.indexOf('=');
        if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
      return { cookies, refreshToken: data.data.refresh_token || '' };
    }

    if (statusCode === 86038) {
      throw new Error('qrcode expired');
    }

    await sleep(intervalMs);
  }

  throw new Error('qrcode polling timeout');
}

async function checkCookieNeedRefresh(cookie) {
  const csrf = cookiePair(cookie, 'bili_jct');
  const url = `https://passport.bilibili.com/x/passport-login/web/cookie/info?csrf=${encodeURIComponent(csrf)}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: cookie },
  });
  const data = await r.json();
  if (!data || data.code !== 0) {
    throw new Error(`checkCookieNeedRefresh failed: ${data?.code} ${data?.message}`);
  }
  return {
    needRefresh: !!data.data?.refresh,
    timestamp: Number(data.data?.timestamp) || Date.now(),
  };
}

function generateCorrespondPath(timestamp) {
  const message = `refresh_${timestamp}`;
  const encrypted = crypto.publicEncrypt(
    {
      key: PUBLIC_KEY_PEM,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha1',
    },
    Buffer.from(message, 'utf8')
  );
  return encrypted.toString('hex').toLowerCase();
}

async function fetchRefreshCsrf(correspondPath, cookie) {
  const url = `https://www.bilibili.com/correspond/1/${correspondPath}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: cookie },
  });
  const html = await r.text();
  const match = html.match(/<div[^>]*id=["']1-name["'][^>]*>([^<]+)<\/div>/i);
  if (!match) {
    throw new Error('refresh_csrf not found in correspond page');
  }
  return match[1].trim();
}

async function doRefreshCookie({ cookies, refreshToken, refreshCsrf }) {
  const cookie = recordToCookie(cookies);
  const body = new URLSearchParams();
  body.set('csrf', cookies['bili_jct'] || '');
  body.set('refresh_csrf', refreshCsrf);
  body.set('source', 'main_web');
  body.set('refresh_token', refreshToken);

  const r = await fetch('https://passport.bilibili.com/x/passport-login/web/cookie/refresh', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookie,
    },
    body: body.toString(),
  });

  const data = await r.json();
  const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  const newCookies = { ...cookies };
  for (const pair of parseSetCookies(setCookies)) {
    const eq = pair.indexOf('=');
    if (eq > 0) newCookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }

  if (data?.code === 0 && data.data) {
    return {
      ok: true,
      cookies: newCookies,
      refreshToken: data.data.refresh_token || '',
    };
  }

  return { ok: false, code: data?.code, message: data?.message || '', cookies: newCookies };
}

async function doConfirmRefresh({ cookies, oldRefreshToken }) {
  const cookie = recordToCookie(cookies);
  const body = new URLSearchParams();
  body.set('csrf', cookies['bili_jct'] || '');
  body.set('refresh_token', oldRefreshToken);

  const r = await fetch('https://passport.bilibili.com/x/passport-login/web/confirm/refresh', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookie,
    },
    body: body.toString(),
  });

  const data = await r.json();
  return { ok: data?.code === 0, code: data?.code, message: data?.message || '' };
}

async function refreshCookie({ cookies, refreshToken }) {
  if (!refreshToken) {
    return { ok: false, message: 'no refresh_token' };
  }

  const cookie = recordToCookie(cookies);

  let needRefresh = true;
  let timestamp = Date.now();
  try {
    const info = await checkCookieNeedRefresh(cookie);
    needRefresh = info.needRefresh;
    timestamp = info.timestamp;
  } catch (e) {
    needRefresh = true;
  }

  if (!needRefresh) {
    return { ok: true, refreshed: false, cookies, refreshToken };
  }

  let refreshCsrf;
  try {
    refreshCsrf = await fetchRefreshCsrf(generateCorrespondPath(timestamp), cookie);
  } catch (e) {
    return { ok: false, message: `fetchRefreshCsrf failed: ${e.message}` };
  }

  const oldRefreshToken = refreshToken;
  const result = await doRefreshCookie({ cookies, refreshToken, refreshCsrf });
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }

  const confirm = await doConfirmRefresh({ cookies: result.cookies, oldRefreshToken });
  if (!confirm.ok) {
    return { ok: false, code: confirm.code, message: `confirm failed: ${confirm.message}` };
  }

  return { ok: true, refreshed: true, cookies: result.cookies, refreshToken: result.refreshToken };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  generateQrCode,
  pollQrCode,
  refreshCookie,
  parseSetCookies,
  cookieToRecord,
  recordToCookie,
  cookiePair,
  generateCorrespondPath,
  fetchRefreshCsrf,
  doRefreshCookie,
  doConfirmRefresh,
  checkCookieNeedRefresh,
};
