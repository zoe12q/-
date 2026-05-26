// 统一的 ASR 流水线: 降采样 → (必要时) 分片 → 分 provider 调用 → 合并 → 写文件
// 被 transcribe.js (批量) 和 download.js (下载时) 共用.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { groqTranscribe, verboseJsonToSrt } = require('./groq_asr');
const { qwenTranscribe, resultJsonToSrt, resultJsonToText } = require('./qwen_asr');

const PROVIDER_LIMITS = {
  // Qwen3-ASR-Flash-Filetrans (异步): API 单文件 ≤ 2GB.
  // 但本地直传过大的媒体会在 readFile + Blob + FormData 阶段瞬时吃掉太多内存，
  // 所以超过 localDirectBytes 时先压缩/必要时分片，再上传.
  qwen: {
    async: true,
    maxBytes: 2 * 1024 * 1024 * 1024,
    localDirectBytes: 64 * 1024 * 1024,
    chunkSeconds: 60 * 60,
  },
  // Groq: 文件 ≤ 25MB, 无时长硬限, 分片 15 分钟
  groq: { async: false, maxBytes: 24 * 1024 * 1024, chunkSeconds: 15 * 60 },
};

function fmtSize(n) {
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

function extractedAudioPathFor(inputPath, outDir) {
  if (path.extname(inputPath).toLowerCase() !== '.mp4') return inputPath;
  return path.join(outDir, 'audio.m4a');
}

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) =>
      resolve({ ok: code === 0, code, stderr: stderr.slice(-500) })
    );
  });
}

async function ffprobeDuration(audioPath) {
  return new Promise((resolve) => {
    const child = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', audioPath],
      { windowsHide: true }
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve(0));
    child.on('close', () => resolve(Number(out.trim()) || 0));
  });
}

async function compressTo16kMono(inputPath, outputPath) {
  const r = await runCmd('ffmpeg', [
    '-y', '-i', inputPath, '-vn',
    '-ac', '1', '-ar', '16000',
    '-c:a', 'libmp3lame', '-b:a', '48k',
    outputPath,
  ]);
  if (!r.ok) throw new Error('ffmpeg 转码失败 (可能未安装 ffmpeg): ' + (r.stderr || r.error));
}

async function splitAudio(inputPath, outputDir, segmentSeconds) {
  const pattern = path.join(outputDir, 'part-%03d.mp3');
  const r = await runCmd('ffmpeg', [
    '-y', '-i', inputPath,
    '-f', 'segment',
    '-segment_time', String(segmentSeconds),
    '-c', 'copy',
    pattern,
  ]);
  if (!r.ok) throw new Error('ffmpeg 分片失败: ' + (r.stderr || r.error));
  const files = (await fsp.readdir(outputDir))
    .filter((f) => /^part-\d+\.mp3$/.test(f))
    .sort();
  return files.map((f) => path.join(outputDir, f));
}

async function extractAudioTrack(inputPath, outputPath) {
  const copyResult = await runCmd('ffmpeg', [
    '-y', '-i', inputPath,
    '-vn',
    '-c:a', 'copy',
    outputPath,
  ]);
  if (copyResult.ok) return;

  const recodeResult = await runCmd('ffmpeg', [
    '-y', '-i', inputPath,
    '-vn',
    '-c:a', 'aac',
    '-b:a', '128k',
    outputPath,
  ]);
  if (!recodeResult.ok) {
    throw new Error(
      'ffmpeg 提取音轨失败: ' + (recodeResult.stderr || recodeResult.error || copyResult.stderr)
    );
  }
}

function resolveProvider(explicit) {
  if (explicit) return explicit;
  if (process.env.DASHSCOPE_API_KEY) return 'qwen';
  if (process.env.GROQ_API_KEY) return 'groq';
  return '';
}

function shouldDirectProcess(limit, statSize, audioSeconds = 0) {
  const sizeOk = statSize <= limit.maxBytes;
  const durationOk = !limit.maxSeconds || (audioSeconds > 0 && audioSeconds <= limit.maxSeconds);
  const localOk = !limit.localDirectBytes || statSize <= limit.localDirectBytes;
  return sizeOk && durationOk && localOk;
}

async function ensureTranscriptionSource(audioPath, outDir, log) {
  const extractedPath = extractedAudioPathFor(audioPath, outDir);
  if (extractedPath === audioPath) return audioPath;
  if (fs.existsSync(extractedPath) && fs.statSync(extractedPath).size > 0) {
    return extractedPath;
  }
  log(`检测到视频容器 ${path.basename(audioPath)}，先提取音轨到 ${path.basename(extractedPath)}`);
  await extractAudioTrack(audioPath, extractedPath);
  return extractedPath;
}

// 单文件直接调用 provider. 仅用于 groq 分片以及 qwen 的单次异步调用.
async function callProvider(provider, audioPath, opts = {}) {
  if (provider === 'qwen') {
    // 异步 filetrans: 上传 → 提交 → 轮询 → 下载
    const r = await qwenTranscribe(audioPath, {
      model: opts.model || undefined,
      language: opts.language,
      enableItn: !!opts.enableItn,
      enableWords: opts.enableWords,
      log: opts.log,
    });
    return { text: r.text, srt: r.srt, raw: r.raw };
  }
  if (provider === 'groq') {
    const r = await groqTranscribe(audioPath, {
      model: opts.model || undefined,
      language: opts.language || 'zh',
      responseFormat: 'verbose_json',
    });
    return { text: r.text, raw: r.raw };
  }
  throw new Error('未知 provider: ' + provider);
}

function mergeGroqVerbose(parts, offsets) {
  const merged = { task: 'transcribe', language: 'zh', duration: 0, text: '', segments: [] };
  parts.forEach((raw, i) => {
    if (!raw) return;
    const off = offsets[i] || 0;
    if (Array.isArray(raw.segments)) {
      for (const s of raw.segments) {
        merged.segments.push({
          ...s,
          id: merged.segments.length,
          start: (s.start || 0) + off,
          end: (s.end || 0) + off,
        });
      }
    }
    merged.text += (merged.text ? '\n' : '') + (raw.text || '').trim();
    if (typeof raw.duration === 'number') {
      merged.duration = Math.max(merged.duration, off + raw.duration);
    }
  });
  return merged;
}

function shiftQwenTime(value, offsetMs) {
  if (typeof value !== 'number') return value;
  return value + offsetMs;
}

function mergeQwenFileTransResults(parts, offsets) {
  const first = parts.find(Boolean) || {};
  const merged = { ...first, transcripts: [] };
  parts.forEach((raw, i) => {
    const tracks = (raw && raw.transcripts) || [];
    const offsetMs = Math.round((offsets[i] || 0) * 1000);
    tracks.forEach((track, trackIndex) => {
      if (!merged.transcripts[trackIndex]) {
        const { sentences, text, ...rest } = track;
        merged.transcripts[trackIndex] = { ...rest, text: '', sentences: [] };
      }
      const target = merged.transcripts[trackIndex];
      const shiftedSentences = (track.sentences || []).map((sentence) => ({
        ...sentence,
        begin_time: shiftQwenTime(sentence.begin_time, offsetMs),
        end_time: shiftQwenTime(sentence.end_time, offsetMs),
        words: (sentence.words || []).map((word) => ({
          ...word,
          begin_time: shiftQwenTime(word.begin_time, offsetMs),
          end_time: shiftQwenTime(word.end_time, offsetMs),
        })),
      }));
      target.sentences.push(...shiftedSentences);
      const pieceText =
        shiftedSentences
          .map((sentence) => (sentence.text || '').trim())
          .filter(Boolean)
          .join('\n') || String(track.text || '').trim();
      if (pieceText) {
        target.text = [target.text, pieceText].filter(Boolean).join('\n');
      }
    });
  });
  return merged;
}

// 主入口: 对 audioPath 做转写, 输出到 outDir/{transcript.txt, subtitle.srt?, transcript.<provider>.json}
// opts: { provider, force, model, log(msg) }
async function transcribeAudioFile(audioPath, outDir, opts = {}) {
  const provider = resolveProvider(opts.provider);
  if (!provider) throw new Error('未设置 DASHSCOPE_API_KEY 或 GROQ_API_KEY');
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const limit = PROVIDER_LIMITS[provider];
  if (!limit) throw new Error('未知 provider: ' + provider);

  const txtPath = path.join(outDir, 'transcript.txt');
  const srtPath = path.join(outDir, 'subtitle.srt');
  const rawPath = path.join(outDir, `transcript.${provider}.json`);
  if (!opts.force && fs.existsSync(txtPath) && fs.statSync(txtPath).size > 0) {
    return { skipped: true, reason: 'transcript.txt 已存在', provider };
  }
  const sourcePath = await ensureTranscriptionSource(audioPath, outDir, log);
  const stat = fs.statSync(sourcePath);
  // 若 provider 有时长上限, 先 ffprobe
  let audioSeconds = 0;
  if (limit.maxSeconds) {
    audioSeconds = await ffprobeDuration(sourcePath);
  }

  // 小文件 + 短时长 → 直传
  const canDirectProcess = shouldDirectProcess(limit, stat.size, audioSeconds);
  if (canDirectProcess) {
    log(`${fmtSize(stat.size)}${audioSeconds ? ` / ${audioSeconds.toFixed(0)}s` : ''} → ${provider}`);
    const { text, srt, raw } = await callProvider(provider, sourcePath, opts);
    await fsp.writeFile(txtPath, text + '\n', 'utf8');
    if (raw) {
      await fsp.writeFile(rawPath, JSON.stringify(raw, null, 2), 'utf8');
    }
    const subtitle = srt || (provider === 'groq' && raw ? verboseJsonToSrt(raw) : '');
    if (subtitle.trim()) {
      await fsp.writeFile(srtPath, subtitle, 'utf8');
    }
    return { ok: true, provider, chars: text.length };
  }

  // 超限: 降采样 + (必要时) 分片
  log(
    `${fmtSize(stat.size)}${audioSeconds ? ` / ${audioSeconds.toFixed(0)}s` : ''} 超出 ${provider} 本地直传阈值，降采样+分片`
  );
  const workDir = path.join(outDir, '.asr_work');
  await fsp.mkdir(workDir, { recursive: true });
  try {
    const compressed = path.join(workDir, 'compressed.mp3');
    await compressTo16kMono(sourcePath, compressed);
    const cSize = fs.statSync(compressed).size;
    log(`  压缩后 ${fmtSize(cSize)}`);

    let chunks = [];
    // 压缩后如果仍超大小 或 仍超时长限制, 继续按时长分片
    const compressedSec = limit.maxSeconds
      ? await ffprobeDuration(compressed)
      : 0;
    const needSplit =
      cSize > limit.maxBytes ||
      (limit.maxSeconds && compressedSec > limit.maxSeconds);
    if (!needSplit) {
      chunks = [compressed];
    } else {
      chunks = await splitAudio(compressed, workDir, limit.chunkSeconds);
      log(`  分成 ${chunks.length} 段 (每段 ≤ ${limit.chunkSeconds}s)`);
    }

    const rawList = [];
    const texts = [];
    const offsets = [];
    let acc = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const sz = fs.statSync(chunk).size;
      if (sz > limit.maxBytes) {
        throw new Error(`分片仍超上限 (${fmtSize(sz)} > ${fmtSize(limit.maxBytes)})`);
      }
      offsets.push(acc);
      log(`  ▸ 片段 ${i + 1}/${chunks.length} ${fmtSize(sz)}`);
      const { text, raw } = await callProvider(provider, chunk, opts);
      texts.push(text);
      rawList.push(raw);
      acc += await ffprobeDuration(chunk);
    }

    let finalText;
    if (provider === 'groq') {
      const merged = mergeGroqVerbose(rawList, offsets);
      finalText = merged.text.trim();
      await fsp.writeFile(rawPath, JSON.stringify(merged, null, 2), 'utf8');
      const srt = verboseJsonToSrt(merged);
      if (srt.trim()) await fsp.writeFile(srtPath, srt, 'utf8');
    } else if (provider === 'qwen') {
      const merged = mergeQwenFileTransResults(rawList, offsets);
      finalText = resultJsonToText(merged).trim() ||
        texts.map((t) => (t || '').trim()).filter(Boolean).join('\n');
      await fsp.writeFile(rawPath, JSON.stringify(merged, null, 2), 'utf8');
      const srt = resultJsonToSrt(merged);
      if (srt.trim()) await fsp.writeFile(srtPath, srt, 'utf8');
    } else {
      finalText = texts.map((t) => (t || '').trim()).filter(Boolean).join('\n');
      await fsp.writeFile(rawPath, JSON.stringify({ parts: rawList, offsets }, null, 2), 'utf8');
    }
    await fsp.writeFile(txtPath, finalText + '\n', 'utf8');
    return { ok: true, provider, chars: finalText.length };
  } finally {
    // 清理
    try {
      const entries = await fsp.readdir(workDir).catch(() => []);
      for (const e of entries) await fsp.unlink(path.join(workDir, e)).catch(() => {});
      await fsp.rmdir(workDir).catch(() => {});
    } catch (_) {}
  }
}

module.exports = {
  transcribeAudioFile,
  resolveProvider,
  PROVIDER_LIMITS,
  extractedAudioPathFor,
  ensureTranscriptionSource,
  fmtSize,
  mergeQwenFileTransResults,
  shouldDirectProcess,
};
