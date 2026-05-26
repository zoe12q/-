// 批量扫描 downloads/ 下的 audio.m4a, 对缺 transcript.txt 的视频调用 ASR.
//
// 自动选择 provider:
//   - 有 DASHSCOPE_API_KEY → qwen  (Qwen3-ASR-Flash, 默认, 中文质量更好)
//   - 有 GROQ_API_KEY     → groq  (whisper-large-v3-turbo)
//   可通过 --provider 强制指定.
//
// 用法:
//   $env:DASHSCOPE_API_KEY = "sk-xxx"
//   npm run transcribe
//   node transcribe.js --dir downloads/1420210197 --provider qwen --concurrency 2

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { transcribeAudioFile, resolveProvider } = require('./asr_pipeline');
const { loadEnvFile } = require('./service');

const TRANSCRIBABLE_MEDIA_ORDER = ['audio.m4a', 'audio.mp4'];

function parseArgs(argv) {
  const out = { dir: '', model: '', provider: '', concurrency: 2, force: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--dir') (out.dir = v), i++;
    else if (k === '--model') (out.model = v), i++;
    else if (k === '--provider') (out.provider = v), i++;
    else if (k === '--concurrency') (out.concurrency = Number(v) || 2), i++;
    else if (k === '--force') out.force = true;
  }
  return out;
}

async function walk(dir, hits) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  const fileNames = new Set(entries.filter((e) => e.isFile()).map((e) => e.name.toLowerCase()));

  // 已有官方字幕则跳过 ASR（字幕质量优于音频转录）
  if (fileNames.has('subtitle.json')) {
    return;
  }

  for (const preferredName of TRANSCRIBABLE_MEDIA_ORDER) {
    if (fileNames.has(preferredName)) {
      hits.push(path.join(dir, preferredName));
      break;
    }
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, hits);
    }
  }
}

async function main() {
  loadEnvFile();
  const args = parseArgs(process.argv);
  const provider = resolveProvider(args.provider);
  if (!provider) {
    console.error('✗ 未设置 DASHSCOPE_API_KEY 或 GROQ_API_KEY');
    console.error('  PowerShell: $env:DASHSCOPE_API_KEY = "sk-xxx"');
    process.exit(1);
  }
  if (provider === 'qwen' && !process.env.DASHSCOPE_API_KEY) {
    console.error('✗ --provider qwen 但未设置 DASHSCOPE_API_KEY');
    process.exit(1);
  }
  if (provider === 'groq' && !process.env.GROQ_API_KEY) {
    console.error('✗ --provider groq 但未设置 GROQ_API_KEY');
    process.exit(1);
  }

  const rootDir = path.resolve(args.dir || path.join(__dirname, 'downloads'));
  if (!fs.existsSync(rootDir)) {
    console.error(`✗ 目录不存在: ${rootDir}`);
    process.exit(1);
  }
  const hits = [];
  await walk(rootDir, hits);
  if (!hits.length) {
    console.log(`未找到可转写媒体文件 (目录: ${rootDir})`);
    return;
  }
  console.log(
    `扫描到 ${hits.length} 个媒体文件, provider=${provider}, 并发 ${args.concurrency}`
  );

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const queue = hits.slice();
  const workers = Array.from(
    { length: Math.max(1, args.concurrency) },
    async () => {
      while (queue.length) {
        const audioPath = queue.shift();
        const outDir = path.dirname(audioPath);
        const label = path.relative(rootDir, outDir);
        const started = Date.now();
        try {
          const r = await transcribeAudioFile(audioPath, outDir, {
            provider,
            model: args.model,
            force: args.force,
            log: (m) => console.log(`  ▶ [${label}] ${m}`),
          });
          const dur = ((Date.now() - started) / 1000).toFixed(1);
          if (r.skipped) {
            skipped += 1;
            console.log(`⏭ ${label}  (${r.reason})`);
          } else {
            ok += 1;
            console.log(`✅ ${label}  ${dur}s, ${r.chars} 字`);
          }
        } catch (e) {
          failed += 1;
          console.log(`✗ ${label}  ${e.message}`);
        }
      }
    }
  );
  await Promise.all(workers);
  console.log(`\n完成: 成功 ${ok}, 跳过 ${skipped}, 失败 ${failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
