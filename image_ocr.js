const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_QWEN_VL_MODEL = 'qwen3-vl-flash';

const EXT_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

function hasNonEmptyFile(filePath) {
  try {
    return fs.statSync(filePath).size > 0;
  } catch (_) {
    return false;
  }
}

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function qwenVlBaseUrl() {
  const raw =
    process.env.DASHSCOPE_VL_BASE_URL ||
    process.env.DASHSCOPE_COMPAT_BASE_URL ||
    process.env.DASHSCOPE_BASE_URL ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1';
  return normalizeBaseUrl(raw).replace(/\/api\/v1$/, '/compatible-mode/v1');
}

function mimeOf(filePath) {
  return EXT_MIME[path.extname(filePath).toLowerCase()] || 'image/jpeg';
}

function replacePlaceholders(template, values) {
  return String(template)
    .replace(/\{input\}/g, values.input)
    .replace(/\{output\}/g, values.output)
    .replace(/\{outdir\}/g, values.outdir);
}

function resolveOcrProvider() {
  return String(process.env.IMAGE_OCR_PROVIDER || 'tesseract')
    .trim()
    .toLowerCase();
}

function runProcess(command, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: !!opts.shell,
      cwd: opts.cwd,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) =>
      resolve({ ok: false, error: e.message, stdout, stderr })
    );
    child.on('close', (code) =>
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr: stderr.slice(-1000),
      })
    );
  });
}

function extractChatText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        return part?.text || '';
      })
      .join('')
      .trim();
  }
  return '';
}

async function runQwenVlOcr(imagePath, outputPath, opts = {}) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'DASHSCOPE_API_KEY is required for IMAGE_OCR_PROVIDER=qwen-vl' };
  }

  const imageBuf = await fsp.readFile(imagePath);
  const dataUrl = `data:${mimeOf(imagePath)};base64,${imageBuf.toString('base64')}`;
  const model = process.env.IMAGE_OCR_MODEL || DEFAULT_QWEN_VL_MODEL;
  const prompt =
    process.env.IMAGE_OCR_PROMPT ||
    '请识别图片中的所有可见文字，尽量保持原有顺序和换行。只输出识别出的文字，不要解释。';
  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0,
  };

  const r = await fetch(`${qwenVlBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const responseText = await r.text();
  if (!r.ok) {
    return { ok: false, error: `DashScope VL HTTP ${r.status}: ${responseText.slice(0, 500)}` };
  }

  let data;
  try {
    data = JSON.parse(responseText);
  } catch (e) {
    return { ok: false, error: `DashScope VL response is not JSON: ${responseText.slice(0, 300)}` };
  }
  const text = extractChatText(data);
  const rawPath = outputPath.replace(/\.txt$/i, `.${model}.json`);
  if (opts.writeRaw !== false) {
    await fsp.writeFile(rawPath, JSON.stringify(data, null, 2), 'utf8');
  }
  return { ok: true, chars: text.length, text, rawPath, model };
}

async function runDefaultTesseract(imagePath) {
  const lang = process.env.OCR_LANG || 'chi_sim+eng';
  const args = [imagePath, 'stdout', '-l', lang];
  if (process.env.OCR_PSM) {
    args.push('--psm', process.env.OCR_PSM);
  }
  return await runProcess('tesseract', args);
}

async function runCustomOcrCommand(imagePath, outputPath) {
  const outDir = path.dirname(outputPath);
  const command = replacePlaceholders(process.env.IMAGE_OCR_CMD, {
    input: imagePath,
    output: outputPath,
    outdir: outDir,
  });
  return await runProcess(command, [], { shell: true, cwd: outDir });
}

async function ocrImageFile(imagePath, outputPath, opts = {}) {
  if (!opts.force && hasNonEmptyFile(outputPath)) {
    const text = await fsp.readFile(outputPath, 'utf8');
    return {
      skipped: true,
      reason: 'OCR output already exists',
      chars: text.trim().length,
      text,
    };
  }

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const provider = resolveOcrProvider();
  const isQwenVl =
    provider === 'qwen' ||
    provider === 'qwen-vl' ||
    provider === 'qwen3-vl' ||
    provider === 'dashscope-vl' ||
    provider.startsWith('qwen');
  const result = isQwenVl
    ? await runQwenVlOcr(imagePath, outputPath, opts)
    : process.env.IMAGE_OCR_CMD
      ? await runCustomOcrCommand(imagePath, outputPath)
      : await runDefaultTesseract(imagePath);

  if (!result.ok) {
    return {
      ok: false,
      error: result.error || result.stderr || `exit ${result.code}`,
      stderr: result.stderr,
    };
  }

  let text = (result.text || result.stdout || '').replace(/\r\n/g, '\n').trim();
  if (!text && fs.existsSync(outputPath)) {
    text = (await fsp.readFile(outputPath, 'utf8')).replace(/\r\n/g, '\n').trim();
  }
  await fsp.writeFile(outputPath, text ? `${text}\n` : '', 'utf8');
  return {
    ok: true,
    chars: text.length,
    text,
    provider,
    rawPath: result.rawPath || '',
    model: result.model || '',
  };
}

module.exports = {
  extractChatText,
  ocrImageFile,
  qwenVlBaseUrl,
  runQwenVlOcr,
  replacePlaceholders,
  resolveOcrProvider,
};
