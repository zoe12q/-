// Groq 语音转写封装: https://api.groq.com/openai/v1/audio/transcriptions
// 需要环境变量 GROQ_API_KEY
// 文档: https://console.groq.com/docs/speech-text

const fs = require('fs');
const path = require('path');

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_MODEL = 'whisper-large-v3-turbo'; // 免费、快、中文足够好
// 免费层单文件上限 25MB
const MAX_FILE_SIZE = 25 * 1024 * 1024;

// 选项: apiKey, model, language(zh), prompt(可选提示词), responseFormat('verbose_json'|'text')
async function groqTranscribe(audioPath, opts = {}) {
  const apiKey = opts.apiKey || process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('未设置 GROQ_API_KEY');

  const stat = fs.statSync(audioPath);
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(
      `音频超过 Groq 免费层 25MB 上限 (${(stat.size / 1024 / 1024).toFixed(2)} MB), 请分片后再转`
    );
  }

  const buf = fs.readFileSync(audioPath);
  const blob = new Blob([buf], { type: 'audio/mp4' });
  const form = new FormData();
  form.append('file', blob, path.basename(audioPath));
  form.append('model', opts.model || DEFAULT_MODEL);
  form.append('language', opts.language || 'zh');
  form.append('response_format', opts.responseFormat || 'verbose_json');
  form.append('temperature', '0');
  if (opts.prompt) form.append('prompt', opts.prompt);

  const r = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Groq HTTP ${r.status}: ${text.slice(0, 500)}`);
  }
  // response_format=text 直接是纯文本
  if ((opts.responseFormat || 'verbose_json') === 'text') {
    return { text: text.trim(), raw: null };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('Groq 响应解析失败: ' + text.slice(0, 300));
  }
  return { text: (data.text || '').trim(), raw: data };
}

// verbose_json → SRT
function verboseJsonToSrt(data) {
  const segs = (data && data.segments) || [];
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const srtTime = (sec) => {
    const s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    return `${pad(h)}:${pad(m)}:${pad(ss)},${pad(ms, 3)}`;
  };
  const out = [];
  segs.forEach((seg, i) => {
    out.push(String(i + 1));
    out.push(`${srtTime(seg.start)} --> ${srtTime(seg.end)}`);
    out.push((seg.text || '').trim());
    out.push('');
  });
  return out.join('\n');
}

module.exports = { groqTranscribe, verboseJsonToSrt, MAX_FILE_SIZE };
