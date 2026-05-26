const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { createBiliClient } = require('./bili');
const {
  buildTextContent,
  collectImageUrls,
  collectVideoRefs,
  dateOf,
  deriveItemTitle,
  downloadImage,
  enrichItemWithDetail,
  prefetchArticleDetails,
  fmtTime,
  handleVideosForItem,
  sanitize,
} = require('./download');
const { ocrImageFile } = require('./image_ocr');
const {
  refreshCookie,
  generateQrCode,
  pollQrCode,
  cookieToRecord,
  recordToCookie,
} = require('./bili_login');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RISK_CONTROL_CODES = new Set([-352, -412]);
const AUTH_EXPIRED_CODES = new Set([-101, -2, -111]);
const DEFAULT_LOGIN_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 每小时最多校验一次

function loadEnvFile(filePath = process.env.SERVICE_ENV_FILE || path.join(__dirname, '.env')) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function parsePositiveInt(value, fallback, min = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

function parseWebhookHeaders(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (_) {
    return {};
  }
}

function isRiskControlCode(code) {
  return RISK_CONTROL_CODES.has(Number(code));
}

function describeRiskControlCode(code) {
  const normalized = Number(code);
  if (normalized === -352) return 'verification failed';
  if (normalized === -412) return 'request was banned';
  return 'risk control blocked the request';
}

function isAuthExpiredCode(code) {
  return AUTH_EXPIRED_CODES.has(Number(code));
}

function describeAuthExpiredCode(code) {
  const normalized = Number(code);
  if (normalized === -101) return 'account not logged in';
  if (normalized === -2) return 'account invalid';
  if (normalized === -111) return 'csrf check failed';
  return 'authentication required';
}

function formatLoginWarning(reason) {
  return (
    `SESSDATA appears to be expired or invalid (${reason}). ` +
    'Fans-only / charge-only dynamics will show up as [受限动态] and may miss updates. ' +
    'Please refresh BILI_SESSDATA (or the full BILI_COOKIE) from https://space.bilibili.com/<UID>/dynamic and restart the service.'
  );
}

function startOfTodayTs(nowMs = Date.now()) {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function resolveInitialSinceTs(mode, nowMs = Date.now()) {
  const value = String(mode || 'now').trim().toLowerCase();
  if (value === 'all') return 0;
  if (value === 'today') return startOfTodayTs(nowMs);
  return Math.floor(nowMs / 1000);
}

function parseConfig(env = process.env) {
  const intervalMs = env.SERVICE_INTERVAL_MS
    ? parsePositiveInt(env.SERVICE_INTERVAL_MS, 60_000, 10_000)
    : parsePositiveInt(Number(env.SERVICE_INTERVAL_SECONDS || 60) * 1000, 60_000, 10_000);
  const downloadRoot = path.resolve(env.DOWNLOAD_ROOT || path.join(__dirname, 'downloads'));
  const initialSince = env.SERVICE_INITIAL_SINCE || 'now';
  return {
    sessdata: env.BILI_SESSDATA || env.SESSDATA || '',
    hostMids: splitCsv(
      env.BILI_HOST_MIDS || env.BILI_HOST_MID || env.HOST_MIDS || env.HOST_MID
    ),
    intervalMs,
    downloadRoot,
    stateFile: path.resolve(env.SERVICE_STATE_FILE || path.join(downloadRoot, '.service-state.json')),
    maxPagesPerPoll: parsePositiveInt(env.SERVICE_MAX_PAGES_PER_POLL, 3, 1),
    seenLimit: parsePositiveInt(env.SERVICE_SEEN_LIMIT, 2000, 100),
    downloadAudio: env.SERVICE_DOWNLOAD_AUDIO !== '0',
    imageOcr: env.SERVICE_IMAGE_OCR !== '0',
    webhookUrl: env.WEBHOOK_URL || '',
    webhookHeaders: parseWebhookHeaders(env.WEBHOOK_HEADERS_JSON),
    webhookTimeoutMs: parsePositiveInt(env.WEBHOOK_TIMEOUT_MS, 15_000, 1000),
    pushplusToken: env.PUSHPLUS_TOKEN || '',
    pushplusTopic: env.PUSHPLUS_TOPIC || '',
    pushplusUrl: env.PUSHPLUS_URL || 'https://www.pushplus.plus/send/',
    pushplusTitle: env.PUSHPLUS_TITLE || 'Bilibili dynamic update',
    pushplusTemplate: env.PUSHPLUS_TEMPLATE || 'html',
    pushplusMaxContentChars: parsePositiveInt(env.PUSHPLUS_MAX_CONTENT_CHARS, 20_000, 1000),
    biliCookie: env.BILI_COOKIE || env.BILI_COOKIES || '',
    banBackoffMs: parsePositiveInt(
      Number(env.SERVICE_BAN_BACKOFF_MINUTES || 30) * 60 * 1000,
      30 * 60 * 1000,
      60 * 1000
    ),
    authFile: path.resolve(
      env.BILI_AUTH_FILE || path.join(downloadRoot, '.bili-auth.json')
    ),
    qrTimeoutMs: parsePositiveInt(env.BILI_QR_TIMEOUT_MS, 180_000, 30_000),
    qrRetryDelayMs: parsePositiveInt(env.BILI_QR_RETRY_DELAY_MS, 60_000, 30_000),
    loginCheckDynamicId: env.LOGIN_CHECK_DYNAMIC_ID || '',
    initialSince,
    initialSinceTs: resolveInitialSinceTs(initialSince),
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, filePath);
}

function updateEnvFile(filePath, key, value) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  let found = false;
  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) return line;
    const k = trimmed.slice(0, idx).trim();
    if (k === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    newLines.push(`${key}=${value}`);
  }
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, newLines.join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
  process.env[key] = value;
  return true;
}

async function loadAuthState(authFile) {
  try {
    const data = JSON.parse(await fsp.readFile(authFile, 'utf8'));
    if (!data || typeof data !== 'object') return null;
    return {
      refreshToken: data.refreshToken || '',
      cookie: data.cookie || '',
      updatedAt: data.updatedAt || '',
    };
  } catch (_) {
    return null;
  }
}

async function saveAuthState(authFile, state) {
  await fsp.mkdir(path.dirname(authFile), { recursive: true });
  const tmp = `${authFile}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fsp.rename(tmp, authFile);
}

function normalizeState(state) {
  const out = state && typeof state === 'object' ? state : {};
  if (!out.hosts || typeof out.hosts !== 'object') out.hosts = {};
  return out;
}

function hostStateFor(state, hostMid, initialSinceTs = 0) {
  if (!state.hosts[hostMid]) {
    state.hosts[hostMid] = {
      last_pub_ts: initialSinceTs,
      initial_since_ts: initialSinceTs,
      last_run_at: 0,
      seen_ids: [],
    };
  }
  if (!Array.isArray(state.hosts[hostMid].seen_ids)) {
    state.hosts[hostMid].seen_ids = [];
  }
  if (
    initialSinceTs &&
    !state.hosts[hostMid].last_pub_ts &&
    state.hosts[hostMid].seen_ids.length === 0
  ) {
    state.hosts[hostMid].last_pub_ts = initialSinceTs;
    state.hosts[hostMid].initial_since_ts = initialSinceTs;
  }
  if (state.hosts[hostMid].initial_since_ts === undefined) {
    state.hosts[hostMid].initial_since_ts = Number(state.hosts[hostMid].last_pub_ts || 0);
  }
  return state.hosts[hostMid];
}

function itemId(item) {
  return String(item && (item.id_str || item.id || ''));
}

function itemPubTs(item) {
  return Number(item?.modules?.module_author?.pub_ts || 0);
}

function isPinned(item) {
  return item?.modules?.module_tag?.text === '置顶';
}

function shouldQueueItem(item, hostState, queuedIds = new Set()) {
  const id = itemId(item);
  if (!id || queuedIds.has(id)) return false;
  if ((hostState.seen_ids || []).includes(id)) return false;
  const ts = itemPubTs(item);
  const initialSinceTs = Number(hostState.initial_since_ts || 0);
  if (initialSinceTs && ts && ts < initialSinceTs) return false;
  if (hostState.last_pub_ts && ts && ts < hostState.last_pub_ts && !isPinned(item)) {
    return false;
  }
  return true;
}

function rememberItem(hostState, item, seenLimit) {
  const id = itemId(item);
  if (!id) return;
  const seen = [id, ...(hostState.seen_ids || []).filter((x) => x !== id)];
  hostState.seen_ids = seen.slice(0, seenLimit);
  hostState.last_pub_ts = Math.max(Number(hostState.last_pub_ts || 0), itemPubTs(item));
}

async function fetchIncrementalItems({ bili, sessdata, hostMid, hostState, maxPagesPerPoll, log }) {
  const queuedIds = new Set();
  const items = [];
  let offset = '';
  for (let pageNo = 1; pageNo <= maxPagesPerPoll; pageNo++) {
    const page = await bili.fetchSpacePage({ sessdata, host_mid: hostMid, offset });
    if (!page || page.code !== 0) {
      const err = new Error(
        `space feed failed: code=${page && page.code} message=${page && page.message}`
      );
      err.biliCode = page && page.code;
      err.biliMessage = page && page.message;
      err.isRiskControl = isRiskControlCode(err.biliCode);
      err.isAuthExpired = isAuthExpiredCode(err.biliCode);
      throw err;
    }
    const pageItems = page.data?.items || [];
    if (!pageItems.length) break;

    let reachedKnown = false;
    for (const item of pageItems) {
      const id = itemId(item);
      const ts = itemPubTs(item);
      const initialSinceTs = Number(hostState.initial_since_ts || 0);
      if (initialSinceTs && ts && ts < initialSinceTs && !isPinned(item)) {
        reachedKnown = true;
      }
      if ((hostState.seen_ids || []).includes(id) && !isPinned(item)) {
        reachedKnown = true;
      }
      if (hostState.last_pub_ts && ts && ts <= hostState.last_pub_ts && !isPinned(item)) {
        reachedKnown = true;
      }
      if (shouldQueueItem(item, hostState, queuedIds)) {
        queuedIds.add(id);
        items.push(item);
      }
    }

    log(`host=${hostMid} page=${pageNo} fetched=${pageItems.length} queued=${items.length}`);
    if (reachedKnown || !page.data?.has_more) break;
    const nextOffset = page.data.offset;
    if (!nextOffset || nextOffset === offset) break;
    offset = nextOffset;
    await sleep(600);
  }
  return items.sort((a, b) => itemPubTs(a) - itemPubTs(b));
}

async function readTextIfExists(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

async function collectVideoTranscripts(itemDir) {
  const videosDir = path.join(itemDir, 'videos');
  let entries = [];
  try {
    entries = await fsp.readdir(videosDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const transcripts = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(videosDir, entry.name);
    const transcriptPath = path.join(dir, 'transcript.txt');
    const text = await readTextIfExists(transcriptPath);
    if (text.trim()) {
      transcripts.push({
        bvid: entry.name,
        path: transcriptPath,
        text,
      });
    }
  }
  return transcripts;
}

async function writeImageOcrSummary(itemDir, imageResults) {
  const blocks = imageResults
    .filter((r) => r.text && r.text.trim())
    .map((r) => [`# ${r.file}`, r.text.trim(), ''].join('\n'));
  if (!blocks.length) return '';
  const text = blocks.join('\n');
  await fsp.writeFile(path.join(itemDir, 'images_ocr.txt'), `${text.trim()}\n`, 'utf8');
  return text;
}

async function processImages({ item, itemDir, imageOcr, log }) {
  const urls = collectImageUrls(item);
  const imageResults = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const saved = await downloadImage(url, itemDir, i + 1);
      const imagePath = path.join(itemDir, saved.name);
      const imageResult = { url, file: saved.name, path: imagePath, bytes: saved.size };
      if (imageOcr) {
        const ocrPath = path.join(itemDir, `${path.parse(saved.name).name}.ocr.txt`);
        const ocr = await ocrImageFile(imagePath, ocrPath);
        imageResult.ocrPath = ocrPath;
        imageResult.ocrOk = !!ocr.ok || !!ocr.skipped;
        imageResult.ocrError = ocr.error || '';
        imageResult.text = ocr.text || '';
        if (!imageResult.ocrOk) {
          log(`image OCR failed ${saved.name}: ${imageResult.ocrError}`);
        }
      }
      imageResults.push(imageResult);
    } catch (e) {
      log(`image failed ${url}: ${e.message || e}`);
      imageResults.push({ url, ok: false, error: String(e.message || e) });
    }
  }
  const ocrText = await writeImageOcrSummary(itemDir, imageResults);
  return { imageResults, ocrText };
}

function truncateText(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n\n[truncated: ${s.length - maxChars} chars omitted]`;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPushPlusHtml(config, payload) {
  const parts = [];
  const title = escapeHtml(payload.title || '');
  const typeLabel = escapeHtml(payload.type || '');
  const pubTime = payload.pub_ts ? fmtTime(payload.pub_ts) : '';
  const url = escapeHtml(payload.url || '');

  parts.push(`<h2>${title || '动态更新'}</h2>`);
  parts.push(`<p><strong>类型:</strong> ${typeLabel}</p>`);
  if (pubTime) parts.push(`<p><strong>发布时间:</strong> ${escapeHtml(pubTime)}</p>`);
  if (url) parts.push(`<p><a href="${url}">查看原动态</a></p>`);

  if (payload.content_text) {
    parts.push('<hr>');
    parts.push(
      `<div style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(
        payload.content_text
      ).replace(/\n/g, '<br>')}</div>`
    );
  }

  // Images: embed directly; only fallback to OCR text on failure
  const images = payload.images || [];
  const okImages = images.filter((img) => img.url && !img.error);
  const failedImages = images.filter((img) => img.error);

  if (okImages.length) {
    parts.push('<hr><h3>图片</h3>');
    for (const img of okImages) {
      parts.push(
        `<img src="${escapeHtml(img.url)}" style="max-width:100%;display:block;margin:10px 0;border-radius:6px;" alt="dynamic image" referrerpolicy="no-referrer">`
      );
    }
  }

  if (failedImages.length) {
    parts.push('<hr><h3>加载失败的图片</h3>');
    for (const img of failedImages) {
      parts.push(`<p style="color:#999;font-size:12px;">图片加载失败: ${escapeHtml(img.error)}</p>`);
      if (img.text) {
        parts.push(
          `<div style="background:#f5f5f5;padding:8px;border-radius:4px;font-size:13px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(
            img.text
          )}</div>`
        );
      }
    }
  }

  for (const transcript of payload.video_transcripts || []) {
    if (transcript.text) {
      parts.push('<hr>');
      parts.push(`<h3>音频转录 ${escapeHtml(transcript.bvid)}</h3>`);
      parts.push(
        `<div style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(
          transcript.text
        ).replace(/\n/g, '<br>')}</div>`
      );
    }
  }

  return parts.join('\n');
}

function createPushPlusPayload(config, payload) {
  const dynamicTitle = String(payload.title || '').trim();
  const title = dynamicTitle || config.pushplusTitle;

  const isHtml = config.pushplusTemplate === 'html';
  let content;
  if (isHtml) {
    content = buildPushPlusHtml(config, payload);
  } else {
    const parts = [
      `## ${payload.title || '动态更新'}`,
      '',
      `- 链接: ${payload.url}`,
      `- 类型: ${payload.type}`,
      `- 时间: ${payload.pub_ts}`,
      '',
      '## 内容',
      payload.content_text || '',
    ];
    if (payload.image_ocr_text) {
      parts.push('', '## Image OCR', payload.image_ocr_text);
    }
    for (const transcript of payload.video_transcripts || []) {
      if (transcript.text) {
        parts.push('', `## Audio Transcript ${transcript.bvid}`, transcript.text);
      }
    }
    content = parts.join('\n');
  }

  const result = {
    token: config.pushplusToken,
    title,
    content,
    template: config.pushplusTemplate,
  };
  if (config.pushplusTopic) {
    result.topic = config.pushplusTopic;
  }
  return result;
}

function describeFetchError(e, timeoutMs) {
  if (!e) return 'unknown error';
  if (e.name === 'AbortError') return `request timeout after ${timeoutMs}ms`;
  const cause = e.cause;
  if (cause && (cause.code || cause.message)) {
    const code = cause.code ? `${cause.code}: ` : '';
    return `${e.message} (${code}${cause.message || cause})`;
  }
  return e.message || String(e);
}

async function postJson(url, body, headers, timeoutMs, opts = {}) {
  const { retries = 2, retryBaseMs = 1000 } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.ok) {
        return { ok: true, status: response.status, attempts: attempt + 1 };
      }
      // 4xx: don't retry — client/auth/payload issue
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`HTTP ${response.status}`);
      }
      lastErr = new Error(`HTTP ${response.status}`);
    } catch (e) {
      // HTTP 4xx already a finalized Error — rethrow as-is
      if (/^HTTP 4\d\d$/.test(e.message)) throw e;
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, retryBaseMs * Math.pow(2, attempt)));
    }
  }
  throw new Error(describeFetchError(lastErr, timeoutMs));
}

async function postPushplus(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    if (!data || data.code !== 200) {
      throw new Error(`pushplus code=${data?.code} msg=${data?.msg || text}`);
    }

    return { ok: true, status: response.status, code: data.code, msg: data.msg, data: data.data };
  } finally {
    clearTimeout(timer);
  }
}

async function sendWebhook(config, payload, log) {
  const results = [];
  if (config.pushplusToken) {
    try {
      const pushplusPayload = createPushPlusPayload(config, payload);
      const maxChars = 5000;
      const content = pushplusPayload.content;

      const chunks = [];
      if (content.length <= maxChars) {
        chunks.push(content);
      } else {
        for (let i = 0; i < content.length; i += maxChars) {
          chunks.push(content.slice(i, i + maxChars));
        }
      }

      for (let i = 0; i < chunks.length; i++) {
        const chunkPayload = {
          token: pushplusPayload.token,
          title: chunks.length === 1 ? pushplusPayload.title : `${pushplusPayload.title} (${i + 1}/${chunks.length})`,
          content: chunks[i],
          template: pushplusPayload.template,
        };
        if (pushplusPayload.topic) {
          chunkPayload.topic = pushplusPayload.topic;
        }

        try {
          const result = await postPushplus(config.pushplusUrl, chunkPayload, config.webhookTimeoutMs);
          results.push({ target: 'pushplus', ...result, part: `${i + 1}/${chunks.length}` });
          log(`pushplus sent for ${payload.id} [${i + 1}/${chunks.length}]: ok=${result.ok} code=${result.code} msg=${result.msg}`);
        } catch (e) {
          results.push({ target: 'pushplus', ok: false, error: String(e.message || e), part: `${i + 1}/${chunks.length}` });
          log(`pushplus failed for ${payload.id} [${i + 1}/${chunks.length}]: ${e.message || e}`);
        }

        if (i < chunks.length - 1) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    } catch (e) {
      log(`pushplus failed for ${payload.id}: ${e.message || e}`);
      results.push({ target: 'pushplus', ok: false, error: String(e.message || e) });
    }
  } else {
    log('pushplus skipped: PUSHPLUS_TOKEN not set');
  }

  if (config.webhookUrl) {
    try {
      const result = await postJson(
        config.webhookUrl,
        payload,
        config.webhookHeaders,
        config.webhookTimeoutMs
      );
      results.push({ target: 'webhook', ...result });
      log(`webhook sent for ${payload.id}: ok=${result.ok}`);
    } catch (e) {
      log(`webhook failed for ${payload.id}: ${e.message || e}`);
      results.push({ target: 'webhook', ok: false, error: String(e.message || e) });
    }
  } else {
    log('webhook skipped: WEBHOOK_URL not set');
  }

  if (!results.length) return { skipped: true };
  return { ok: results.every((r) => r.ok), results };
}

function createWebhookPayload({ hostMid, item, itemDir, contentText, imageResults, ocrText, transcripts }) {
  const author = item.modules?.module_author || {};
  return {
    event: 'bili.dynamic.processed',
    host_mid: String(hostMid),
    id: itemId(item),
    title: deriveItemTitle(item),
    type: item.type || '',
    author: {
      name: author.name || '',
      mid: author.mid || '',
    },
    pub_ts: itemPubTs(item),
    url: `https://www.bilibili.com/opus/${itemId(item)}`,
    output_dir: itemDir,
    content_text: contentText,
    image_ocr_text: ocrText,
    images: imageResults.map((r) => ({
      url: r.url,
      file: r.path || '',
      ocr_file: r.ocrPath || '',
      ocr_ok: !!r.ocrOk,
      error: r.error || '',
      ocr_error: r.ocrError || '',
      text: r.text || '',
    })),
    video_transcripts: transcripts.map((t) => ({
      bvid: t.bvid,
      file: t.path,
      text: t.text,
    })),
  };
}

async function processDynamicItem({ bili, config, hostMid, item, log }) {
  const ts = itemPubTs(item);
  const itemDir = path.join(
    config.downloadRoot,
    String(hostMid),
    dateOf(ts),
    sanitize(itemId(item))
  );
  await fsp.mkdir(itemDir, { recursive: true });

  await enrichItemWithDetail(bili, config.sessdata, item);
  await prefetchArticleDetails(bili, config.sessdata, [item]);
  const contentText = buildTextContent(item);
  await fsp.writeFile(path.join(itemDir, 'content.txt'), contentText, 'utf8');
  await fsp.writeFile(path.join(itemDir, 'raw.json'), JSON.stringify(item, null, 2), 'utf8');

  const { imageResults, ocrText } = await processImages({
    item,
    itemDir,
    imageOcr: config.imageOcr,
    log,
  });

  if (config.downloadAudio) {
    const videoTask = {
      id: `service_${itemId(item)}`,
      status: 'running',
      sessdata: config.sessdata,
      host_mid: String(hostMid),
      cancelled: false,
      doneVideos: 0,
      totalVideos: collectVideoRefs(item).length,
      subscribers: new Set([(evt) => evt.message && log(evt.message)]),
      events: [],
    };
    await handleVideosForItem(videoTask, item, itemDir, bili);
  }

  const transcripts = await collectVideoTranscripts(itemDir);
  const payload = createWebhookPayload({
    hostMid,
    item,
    itemDir,
    contentText,
    imageResults,
    ocrText,
    transcripts,
  });
  const webhookResult = await sendWebhook(config, payload, log);
  return { itemDir, imageCount: imageResults.length, transcriptCount: transcripts.length, webhookResult };
}

async function verifyAndLogLogin({ bili, sessdata, log, context = 'check' }) {
  if (typeof bili.fetchLoginStatus !== 'function') {
    log(`login ${context}: skipped (bili client missing fetchLoginStatus)`);
    return { ok: false, isLogin: false, skipped: true };
  }
  const status = await bili.fetchLoginStatus({ sessdata });
  if (status.isLogin && status.ok) {
    log(
      `login ${context}: ok isLogin=true mid=${status.mid} uname=${status.uname || '(unknown)'}`
    );
    return status;
  }
  if (!status.ok) {
    const reason = status.code
      ? `nav code=${status.code} message=${status.message || ''}`
      : `nav request failed: ${status.message || 'unknown error'}`;
    log(`login ${context}: ${formatLoginWarning(reason)}`);
    return status;
  }
  // ok=true but isLogin=false → guest session: SESSDATA missing / expired
  log(`login ${context}: ${formatLoginWarning('isLogin=false')}`);
  return status;
}

async function verifyLoginViaChargeDynamic({ bili, config, log }) {
  if (!config.loginCheckDynamicId) return null;
  try {
    const detail = await bili.fetchDynamicDetail({
      sessdata: config.sessdata,
      id: config.loginCheckDynamicId,
    });
    if (!detail || detail.code !== 0) {
      log(
        `login charge-dynamic check: error code=${detail && detail.code} message=${detail && detail.message}`
      );
      return { ok: false, isLogin: false, code: detail && detail.code, message: (detail && detail.message) || '' };
    }
    const item = detail.data && detail.data.item;
    const major = item && item.modules && item.modules.module_dynamic && item.modules.module_dynamic.major;
    if (major && major.type === 'MAJOR_TYPE_BLOCKED') {
      log(`login charge-dynamic check: expired (content blocked)`);
      return { ok: true, isLogin: false, code: -101, message: 'content blocked' };
    }
    log('login charge-dynamic check: ok');
    return { ok: true, isLogin: true, code: 0, message: '' };
  } catch (e) {
    log(`login charge-dynamic check: request failed: ${e.message}`);
    return { ok: false, isLogin: false, code: 0, message: e.message || '' };
  }
}

async function tryRefreshCookie({ bili, config, log }) {
  const auth = await loadAuthState(config.authFile);
  if (!auth || !auth.refreshToken || !auth.cookie) {
    log('tryRefreshCookie: no auth state or refresh_token, skipping');
    return false;
  }

  log('tryRefreshCookie: attempting cookie refresh...');
  const cookies = cookieToRecord(auth.cookie);

  const result = await refreshCookie({ cookies, refreshToken: auth.refreshToken });
  if (!result.ok) {
    log(`tryRefreshCookie: refresh failed: ${result.message || result.code}`);
    return false;
  }

  if (!result.refreshed) {
    log('tryRefreshCookie: cookie does not need refresh');
    return true;
  }

  const newCookie = recordToCookie(result.cookies);
  await saveAuthState(config.authFile, {
    refreshToken: result.refreshToken,
    cookie: newCookie,
    updatedAt: new Date().toISOString(),
  });

  updateEnvFile(
    process.env.SERVICE_ENV_FILE || path.join(__dirname, '.env'),
    'BILI_COOKIE',
    newCookie
  );

  config.biliCookie = newCookie;
  config.sessdata = result.cookies['SESSDATA'] || config.sessdata;

  if (bili && bili.setCookieOverride) {
    bili.setCookieOverride(newCookie);
  }

  log('tryRefreshCookie: cookie refreshed successfully');
  return true;
}

async function pushQrCodeMessage(config, qrcodeUrl, qrcodeImageUrl, log) {
  let pushed = false;

  if (config.pushplusToken) {
    try {
      const html = [
        '<h3>🔐 B站 Cookie 已过期</h3>',
        '<p>请用 <strong>B站 App</strong> 扫描下方二维码重新登录：</p>',
        `<p><img src="${qrcodeImageUrl}" style="max-width:100%;"></p>`,
        '<p>二维码有效期 3 分钟。</p>',
      ].join('\n');

      const result = await postPushplus(
        config.pushplusUrl,
        {
          token: config.pushplusToken,
          title: 'B站登录验证',
          content: html,
          template: 'html',
        },
        config.webhookTimeoutMs
      );
      pushed = result.ok;
      log(`pushplus QR code message sent: ok=${result.ok} code=${result.code} msg=${result.msg}`);
    } catch (e) {
      log(`pushplus QR message failed: ${e.message}`);
    }
  }

  if (config.webhookUrl) {
    try {
      await postJson(
        config.webhookUrl,
        {
          event: 'bili.auth.qr_login',
          qrcode_url: qrcodeUrl,
          qrcode_image_url: qrcodeImageUrl,
          message: 'B站 Cookie 已过期，请扫码登录',
          expires_in_seconds: Math.round(config.qrTimeoutMs / 1000),
        },
        config.webhookHeaders,
        config.webhookTimeoutMs
      );
      log('webhook QR code message sent');
      pushed = true;
    } catch (e) {
      log(`webhook QR message failed: ${e.message}`);
    }
  }

  return pushed;
}

async function pushQrCodeResult(config, success, message, log) {
  const title = success ? 'B站登录成功' : 'B站登录失败';
  const content = success
    ? '<h3>✅ 登录成功</h3><p>服务已恢复正常运行。</p>'
    : `<h3>❌ 登录失败</h3><p>${message}</p><p>请手动检查并重启服务。</p>`;

  if (config.pushplusToken) {
    try {
      const result = await postPushplus(
        config.pushplusUrl,
        { token: config.pushplusToken, title, content, template: 'html' },
        config.webhookTimeoutMs
      );
      log(`pushplus QR result sent: ok=${result.ok} code=${result.code} msg=${result.msg}`);
    } catch (e) {
      log(`pushplus QR result failed: ${e.message}`);
    }
  }

  if (config.webhookUrl) {
    try {
      await postJson(
        config.webhookUrl,
        {
          event: success ? 'bili.auth.qr_login.success' : 'bili.auth.qr_login.failed',
          message,
        },
        config.webhookHeaders,
        config.webhookTimeoutMs
      );
      log('webhook QR result sent');
    } catch (e) {
      log(`webhook QR result failed: ${e.message}`);
    }
  }
}

async function tryQrLogin({ bili, config, log }) {
  log('tryQrLogin: generating QR code...');

  let qr;
  try {
    qr = await generateQrCode();
  } catch (e) {
    log(`tryQrLogin: failed to generate QR code: ${e.message}`);
    return false;
  }

  const qrcodeImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr.url)}`;

  const pushOk = await pushQrCodeMessage(config, qr.url, qrcodeImageUrl, log);
  if (!pushOk) {
    log(`tryQrLogin: no push channel configured`);
    log(`tryQrLogin: QR code URL = ${qr.url}`);
    log(`tryQrLogin: QR code image = ${qrcodeImageUrl}`);
  }

  log('tryQrLogin: waiting for scan...');

  let result;
  try {
    result = await pollQrCode(qr.qrcodeKey, {
      onStatus: ({ code }) => {
        if (code === 86101) log('tryQrLogin: waiting for scan...');
        else if (code === 86090) log('tryQrLogin: scanned, waiting for confirmation...');
      },
      intervalMs: 3000,
      timeoutMs: config.qrTimeoutMs,
    });
  } catch (e) {
    log(`tryQrLogin: ${e.message}`);
    await pushQrCodeResult(config, false, e.message, log);
    return false;
  }

  const newCookie = recordToCookie(result.cookies);

  await saveAuthState(config.authFile, {
    refreshToken: result.refreshToken,
    cookie: newCookie,
    updatedAt: new Date().toISOString(),
  });

  updateEnvFile(
    process.env.SERVICE_ENV_FILE || path.join(__dirname, '.env'),
    'BILI_COOKIE',
    newCookie
  );

  config.biliCookie = newCookie;
  config.sessdata = result.cookies['SESSDATA'] || config.sessdata;

  if (bili && bili.setCookieOverride) {
    bili.setCookieOverride(newCookie);
  }

  log('tryQrLogin: login succeeded');
  await pushQrCodeResult(config, true, '登录成功，服务已恢复', log);
  return true;
}

async function runPollOnce({ bili, config, state, log }) {
  for (const hostMid of config.hostMids) {
    const hostState = hostStateFor(state, hostMid, config.initialSinceTs);
    const items = await fetchIncrementalItems({
      bili,
      sessdata: config.sessdata,
      hostMid,
      hostState,
      maxPagesPerPoll: config.maxPagesPerPoll,
      log,
    });
    if (!items.length) {
      log(`host=${hostMid} no new dynamics`);
      hostState.last_run_at = Math.floor(Date.now() / 1000);
      continue;
    }

    for (const item of items) {
      const id = itemId(item);
      log(`processing host=${hostMid} id=${id}`);
      const result = await processDynamicItem({ bili, config, hostMid, item, log });
      rememberItem(hostState, item, config.seenLimit);
      hostState.last_run_at = Math.floor(Date.now() / 1000);
      await writeJsonAtomic(config.stateFile, state);
      const webhookStatus = result.webhookResult?.skipped
        ? 'skipped'
        : (result.webhookResult?.results || [])
            .map((r) => `${r.target}=${r.ok ? 'ok' : 'fail'}`)
            .join(',');
      log(
        `done host=${hostMid} id=${id} images=${result.imageCount} transcripts=${result.transcriptCount} webhook=${webhookStatus}`
      );
    }
  }
  await writeJsonAtomic(config.stateFile, state);
}

async function main() {
  loadEnvFile();
  const config = parseConfig();
  if (!config.sessdata && !config.biliCookie) {
    throw new Error('BILI_SESSDATA/SESSDATA or BILI_COOKIE is required');
  }
  if (!config.hostMids.length) {
    throw new Error('BILI_HOST_MIDS or BILI_HOST_MID is required');
  }

  const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);
  const bili = createBiliClient();

  // 如果有持久化的 auth cookie，优先使用（覆盖 .env 中的值）
  const auth = await loadAuthState(config.authFile);
  if (auth && auth.cookie) {
    log(`loaded persisted auth cookie from ${config.authFile}`);
    config.biliCookie = auth.cookie;
    config.sessdata = cookieToRecord(auth.cookie)['SESSDATA'] || config.sessdata;
    bili.setCookieOverride(auth.cookie);
  }

  const state = normalizeState(await readJson(config.stateFile, { hosts: {} }));
  await fsp.mkdir(config.downloadRoot, { recursive: true });

  log(
    `service started hosts=${config.hostMids.join(',')} intervalMs=${config.intervalMs} root=${config.downloadRoot}`
  );

  // 启动时发送 pushplus 测试消息（只发个人）
  if (config.pushplusToken) {
    try {
      const result = await postPushplus(
        config.pushplusUrl,
        {
          token: config.pushplusToken,
          title: '群组test',
          content: '服务已启动',
          template: 'txt',
        },
        config.webhookTimeoutMs
      );
      log(`pushplus startup test: ok=${result.ok} code=${result.code} msg=${result.msg}`);
    } catch (e) {
      log(`pushplus startup test failed: ${e.message}`);
    }
  }

  // 启动时发送上次最后一条动态到群组
  if (config.pushplusToken && config.pushplusTopic) {
    for (const hostMid of config.hostMids) {
      const hostState = state.hosts && state.hosts[hostMid];
      const lastId = hostState && hostState.seen_ids && hostState.seen_ids[0];
      if (!lastId) {
        log(`pushplus startup last-dynamic: host=${hostMid} no last item`);
        continue;
      }
      try {
        const detail = await bili.fetchDynamicDetail({ sessdata: config.sessdata, id: lastId });
        if (detail?.code !== 0 || !detail?.data?.item) {
          log(`pushplus startup last-dynamic: host=${hostMid} id=${lastId} fetch failed code=${detail?.code}`);
          continue;
        }
        const item = detail.data.item;
        await enrichItemWithDetail(bili, config.sessdata, item);
        await prefetchArticleDetails(bili, config.sessdata, [item]);
        const text = buildTextContent(item);
        const author = item.modules?.module_author?.name || '';
        const title = deriveItemTitle(item) || '动态更新';
        const url = `https://www.bilibili.com/opus/${lastId}`;
        const result = await postPushplus(
          config.pushplusUrl,
          {
            token: config.pushplusToken,
            topic: config.pushplusTopic,
            title: `[上次动态] ${title}`,
            content: `作者: ${author}\n链接: ${url}\n\n${text}`.slice(0, 20000),
            template: 'txt',
          },
          config.webhookTimeoutMs
        );
        log(`pushplus startup last-dynamic: host=${hostMid} id=${lastId} ok=${result.ok} code=${result.code}`);
      } catch (e) {
        log(`pushplus startup last-dynamic: host=${hostMid} id=${lastId} error=${e.message}`);
      }
    }
  }

  // 启动时立即校验一次登录状态, 方便第一时间发现 SESSDATA 过期
  await verifyAndLogLogin({
    bili,
    sessdata: config.sessdata,
    log,
    context: 'startup',
  }).catch((e) => log(`login startup: check crashed: ${e.message || e}`));

  let running = false;
  let nextAllowedPollAt = 0;
  let lastLoginCheckAt = Date.now();
  const tick = async () => {
    if (Date.now() < nextAllowedPollAt) {
      return;
    }
    if (running) {
      log('previous poll still running; skip this tick');
      return;
    }
    running = true;
    try {
      if (Date.now() - lastLoginCheckAt >= DEFAULT_LOGIN_CHECK_INTERVAL_MS) {
        lastLoginCheckAt = Date.now();
        let loginStatus = await verifyLoginViaChargeDynamic({ bili, config, log });
        if (!loginStatus) {
          loginStatus = await verifyAndLogLogin({
            bili,
            sessdata: config.sessdata,
            log,
            context: 'periodic',
          }).catch((e) => log(`login periodic: check crashed: ${e.message || e}`));
        }
        if (loginStatus && !loginStatus.isLogin && !loginStatus.skipped) {
          const err = new Error(`login periodic: ${formatLoginWarning('isLogin=false')}`);
          err.biliCode = -101;
          err.isAuthExpired = true;
          throw err;
        }
      }
      await runPollOnce({ bili, config, state, log });
    } catch (e) {
      log(`poll failed: ${e.stack || e.message || e}`);
      if (e && isAuthExpiredCode(e.biliCode)) {
        log(`auth expired: attempting automatic recovery...`);

        // 步骤1：尝试 refresh_token 自动刷新
        const refreshed = await tryRefreshCookie({ bili, config, log }).catch((err) => {
          log(`tryRefreshCookie crashed: ${err.message}`);
          return false;
        });
        if (refreshed) {
          log('cookie refreshed successfully, resuming');
          return;
        }

        // 步骤2：refresh 失败，触发扫码登录
        const loggedIn = await tryQrLogin({ bili, config, log }).catch((err) => {
          log(`tryQrLogin crashed: ${err.message}`);
          return false;
        });
        if (loggedIn) {
          log('qr login succeeded, service resumed');
          return;
        }

        // Step 3: QR login did not complete. Retry QR shortly instead of using
        // the long risk-control backoff, so an expired QR code can be replaced.
        nextAllowedPollAt = Date.now() + config.qrRetryDelayMs;
        log(
          `Bilibili returned ${e.biliCode} (${describeAuthExpiredCode(e.biliCode)}). ` +
            formatLoginWarning(`space feed code=${e.biliCode}`) +
            ` QR login did not complete; retrying in ${Math.round(
              config.qrRetryDelayMs / 1000
            )} seconds.`
        );
        // 触发一次额外校验以在日志里确认当前登录态
        lastLoginCheckAt = 0;
      } else if (e && isRiskControlCode(e.biliCode)) {
        nextAllowedPollAt = Date.now() + config.banBackoffMs;
        log(
          `Bilibili returned ${e.biliCode} (${describeRiskControlCode(
            e.biliCode
          )}). Stop hammering for ${Math.round(
            config.banBackoffMs / 60_000
          )} minutes. Try BILI_COOKIE with a full browser Cookie from https://space.bilibili.com/<UID>/dynamic ; cloud-server IPs may still be blocked.`
        );
      }
    } finally {
      running = false;
    }
  };

  await tick();
  const timer = setInterval(tick, config.intervalMs);
  const stop = async () => {
    clearInterval(timer);
    await writeJsonAtomic(config.stateFile, state).catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.stack || e.message || e);
    process.exit(1);
  });
}

module.exports = {
  createWebhookPayload,
  createPushPlusPayload,
  fetchIncrementalItems,
  hostStateFor,
  loadEnvFile,
  normalizeState,
  parseConfig,
  rememberItem,
  resolveInitialSinceTs,
  shouldQueueItem,
  isRiskControlCode,
  isAuthExpiredCode,
  describeAuthExpiredCode,
  formatLoginWarning,
  verifyAndLogLogin,
  updateEnvFile,
  loadAuthState,
  saveAuthState,
  tryRefreshCookie,
  tryQrLogin,
};
