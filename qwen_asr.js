// 阿里云百炼 Qwen3-ASR-Flash-Filetrans 异步调用.
// 流程: 获取上传凭证 → OSS 直传 → 提交异步任务 → 轮询 → 下载结果 JSON.
// 优势: 支持长音频 (单文件 2GB), 自带字级时间戳, 可生成 SRT.
// 文档:
//   https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference
//   https://help.aliyun.com/zh/model-studio/get-temporary-file-url

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

const DASHSCOPE_BASE = normalizeBaseUrl(
  process.env.DASHSCOPE_ASYNC_BASE_URL ||
    process.env.DASHSCOPE_BASE_URL?.replace(/\/compatible-mode\/v1$/, '/api/v1') ||
    'https://dashscope.aliyuncs.com/api/v1'
);

const DEFAULT_MODEL = 'qwen3-asr-flash-filetrans';
// filetrans 单文件 ≤ 2GB, 本地保险限制
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

const EXT_MIME = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.webm': 'audio/webm',
  '.amr': 'audio/amr',
  '.opus': 'audio/opus',
  '.wma': 'audio/x-ms-wma',
};

function mimeOf(audioPath) {
  return EXT_MIME[path.extname(audioPath).toLowerCase()] || 'application/octet-stream';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildDashScopeHeaders(apiKey, opts = {}) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (opts.async !== false) {
    headers['X-DashScope-Async'] = 'enable';
  }
  if (opts.resolveOss) {
    headers['X-DashScope-OssResourceResolve'] = 'enable';
  }
  return headers;
}

// 步骤 1: 获取 OSS 直传凭证
async function getUploadPolicy(apiKey, model) {
  const url = `${DASHSCOPE_BASE}/uploads?action=getPolicy&model=${encodeURIComponent(model)}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`getPolicy HTTP ${r.status}: ${text.slice(0, 400)}`);
  const data = JSON.parse(text);
  if (!data.data) throw new Error(`getPolicy 响应异常: ${text.slice(0, 400)}`);
  return data.data;
}

// 步骤 2: 上传到 OSS, 返回 oss:// URL
async function uploadToOss(policy, audioPath) {
  const fileName = path.basename(audioPath);
  const key = `${policy.upload_dir}/${fileName}`;
  const fileBuf = await fsp.readFile(audioPath);
  const blob = new Blob([fileBuf], { type: mimeOf(audioPath) });
  const form = new FormData();
  form.append('OSSAccessKeyId', policy.oss_access_key_id);
  form.append('Signature', policy.signature);
  form.append('policy', policy.policy);
  form.append('x-oss-object-acl', policy.x_oss_object_acl);
  form.append('x-oss-forbid-overwrite', policy.x_oss_forbid_overwrite);
  form.append('key', key);
  form.append('success_action_status', '200');
  form.append('file', blob, fileName);

  const r = await fetch(policy.upload_host, { method: 'POST', body: form });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`OSS 上传 HTTP ${r.status}: ${text.slice(0, 400)}`);
  }
  return `oss://${key}`;
}

// 步骤 3: 提交异步转写任务
async function submitTranscriptionTask(apiKey, fileUrl, opts = {}) {
  const url = `${DASHSCOPE_BASE}/services/audio/asr/transcription`;
  const body = {
    model: opts.model || DEFAULT_MODEL,
    input: { file_url: fileUrl },
    parameters: {
      channel_id: opts.channelId || [0],
      enable_itn: !!opts.enableItn,
      enable_words: opts.enableWords !== false, // 默认 true, 有字级时间戳便于做 SRT
      ...(opts.language ? { language: opts.language } : {}),
    },
  };
  const headers = buildDashScopeHeaders(apiKey, {
    resolveOss: fileUrl.startsWith('oss://'),
  });
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`提交任务 HTTP ${r.status}: ${text.slice(0, 500)}`);
  const data = JSON.parse(text);
  if (!data.output || !data.output.task_id) {
    throw new Error(`提交任务响应异常: ${text.slice(0, 500)}`);
  }
  return data.output.task_id;
}

// 步骤 4: 轮询任务直到结束
async function pollTask(apiKey, taskId, opts = {}) {
  const url = `${DASHSCOPE_BASE}/tasks/${encodeURIComponent(taskId)}`;
  const headers = buildDashScopeHeaders(apiKey);
  const pollInterval = opts.pollInterval || 3000;
  const timeoutMs = opts.timeoutMs || 30 * 60 * 1000; // 默认 30 分钟超时
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const started = Date.now();
  let lastStatus = '';
  while (true) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`任务 ${taskId} 轮询超时 (${(timeoutMs / 1000).toFixed(0)}s)`);
    }
    const r = await fetch(url, { headers });
    const text = await r.text();
    if (!r.ok) throw new Error(`查询任务 HTTP ${r.status}: ${text.slice(0, 400)}`);
    const data = JSON.parse(text);
    const status = (data.output && data.output.task_status) || '';
    if (status !== lastStatus) {
      lastStatus = status;
      log(`task ${taskId.slice(0, 8)}… ${status}`);
    }
    if (status === 'SUCCEEDED') return data.output;
    if (status === 'FAILED') {
      throw new Error(
        `任务失败: ${data.output && data.output.code}: ${data.output && data.output.message}`
      );
    }
    if (status === 'UNKNOWN') {
      throw new Error(`任务状态 UNKNOWN: ${taskId}`);
    }
    // PENDING / RUNNING 继续
    await sleep(pollInterval);
  }
}

// 步骤 5: 下载结果 JSON
async function fetchTranscriptionJson(resultUrl) {
  const r = await fetch(resultUrl);
  if (!r.ok) throw new Error(`下载识别结果 HTTP ${r.status}`);
  return await r.json();
}

// 毫秒 → SRT 时间戳
function msToSrt(ms) {
  const total = Math.max(0, Number(ms) || 0);
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const mm = total % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(mm, 3)}`;
}

// 把 filetrans 的 JSON 结果转成 SRT (用 sentences 粒度)
function resultJsonToSrt(resultJson) {
  const out = [];
  let idx = 1;
  const tracks = (resultJson && resultJson.transcripts) || [];
  for (const t of tracks) {
    for (const s of t.sentences || []) {
      out.push(String(idx++));
      out.push(`${msToSrt(s.begin_time)} --> ${msToSrt(s.end_time)}`);
      out.push((s.text || '').trim());
      out.push('');
    }
  }
  return out.join('\n');
}

// 把 filetrans 的 JSON 结果拼成纯文本 (按 sentence 逐行)
function resultJsonToText(resultJson) {
  const tracks = (resultJson && resultJson.transcripts) || [];
  const lines = [];
  for (const t of tracks) {
    for (const s of t.sentences || []) {
      const txt = (s.text || '').trim();
      if (txt) lines.push(txt);
    }
  }
  // 如果 sentences 为空但有整轨 text, 退回整轨
  if (!lines.length) {
    for (const t of tracks) {
      if (t.text) lines.push(String(t.text).trim());
    }
  }
  return lines.join('\n');
}

function getTranscriptionUrl(output) {
  return (
    output &&
    output.result &&
    (output.result.transcription_url || output.result.url)
  ) || (output && output.transcription_url) || '';
}

// 主函数: 异步转写一个本地音频文件
// opts: { apiKey, model, language, enableItn, enableWords, channelId, pollInterval, timeoutMs, log }
async function qwenTranscribe(audioPath, opts = {}) {
  const apiKey = opts.apiKey || process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('未设置 DASHSCOPE_API_KEY');
  const model = opts.model || DEFAULT_MODEL;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  const stat = fs.statSync(audioPath);
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(
      `音频超过 Qwen filetrans 2GB 上限 (${(stat.size / 1024 / 1024).toFixed(2)} MB)`
    );
  }

  log(`上传 ${path.basename(audioPath)} (${(stat.size / 1024 / 1024).toFixed(2)}MB)`);
  const policy = await getUploadPolicy(apiKey, model);
  const fileUrl = await uploadToOss(policy, audioPath);
  log(`已上传: ${fileUrl}`);

  log(`提交异步任务`);
  const taskId = await submitTranscriptionTask(apiKey, fileUrl, {
    model,
    language: opts.language,
    enableItn: opts.enableItn,
    enableWords: opts.enableWords,
    channelId: opts.channelId,
  });
  log(`task_id=${taskId}`);

  const output = await pollTask(apiKey, taskId, {
    pollInterval: opts.pollInterval,
    timeoutMs: opts.timeoutMs,
    log,
  });
  const transUrl = getTranscriptionUrl(output);
  if (!transUrl) throw new Error('任务完成但无 transcription_url');

  log(`下载识别结果`);
  const raw = await fetchTranscriptionJson(transUrl);
  const text = resultJsonToText(raw);
  const srt = resultJsonToSrt(raw);
  return { text, srt, raw, taskId, fileUrl };
}

module.exports = {
  qwenTranscribe,
  MAX_FILE_SIZE,
  buildDashScopeHeaders,
  getTranscriptionUrl,
  pollTask,
  resultJsonToSrt,
  resultJsonToText,
};
