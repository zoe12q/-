// 扫描 downloads/ 下的 videos/<bvid>/ 文件夹, 对缺 audio.m4a 的视频重跑 playurl + 音频下载 + 字幕.
// 目的: 批量补齐被风控 (v_voucher) 的那些失败视频.
//
// 用法:
//   $env:SESSDATA = "<你的 SESSDATA>"  (若不提供, 只能下载公开视频, 部分可能失败)
//   node retry_failed.js
//
// 选项:
//   --dir <path>            只扫描该目录 (默认 downloads/)
//   --delay <ms>            每个视频之间的间隔毫秒 (默认 1200, 失败时加倍)
//   --force-audio           即使 audio.m4a 已存在也重跑 (默认: 跳过已有)

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { createBiliClient } = require('./bili');
const { pickPreferredMediaSource } = require('./download');
const { loadEnvFile } = require('./service');

const TRANSCRIBABLE_MEDIA_NAMES = ['audio.m4a', 'audio.mp4'];

function parseArgs(argv) {
  const out = { dir: '', delay: 1200, forceAudio: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--dir') (out.dir = v), i++;
    else if (k === '--delay') (out.delay = Number(v) || 1200), i++;
    else if (k === '--force-audio') out.forceAudio = true;
  }
  return out;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function walkFindVideos(rootDir, hits) {
  let entries;
  try {
    entries = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    const full = path.join(rootDir, e.name);
    if (!e.isDirectory()) continue;
    // 视频目录 = 名字是 BV 开头 且 父目录是 videos
    if (/^BV/i.test(e.name) && path.basename(rootDir) === 'videos') {
      hits.push(full);
      continue;
    }
    await walkFindVideos(full, hits);
  }
}

function pickBestAudio(dash) {
  if (!dash) return null;
  const candidates = [];
  if (Array.isArray(dash.audio)) candidates.push(...dash.audio);
  if (dash.dolby && Array.isArray(dash.dolby.audio)) {
    candidates.push(...dash.dolby.audio);
  }
  if (dash.flac && dash.flac.audio) candidates.push(dash.flac.audio);
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  return candidates[0];
}

function normalizeUrl(u) {
  if (!u) return '';
  if (u.startsWith('//')) return 'https:' + u;
  return u;
}

async function downloadAudio(rawUrl, filePath, bvid) {
  const url = normalizeUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        Referer: `https://www.bilibili.com/video/${bvid}/`,
        Origin: 'https://www.bilibili.com',
        Range: 'bytes=0-',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    await fsp.writeFile(filePath, buf);
    return { size: buf.length };
  } finally {
    clearTimeout(timer);
  }
}

function findExistingMediaPath(dir) {
  return TRANSCRIBABLE_MEDIA_NAMES.map((name) => path.join(dir, name)).find(
    (filePath) => fs.existsSync(filePath) && fs.statSync(filePath).size > 0
  ) || '';
}

async function fetchSubtitleFile(subtitleUrl) {
  const url = normalizeUrl(subtitleUrl);
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

function subtitleJsonToText(data) {
  return ((data && data.body) || [])
    .map((s) => (s.content || '').trim())
    .filter(Boolean)
    .join('\n');
}

function srtTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(ss)},${pad(ms, 3)}`;
}

function subtitleJsonToSrt(data) {
  const out = [];
  ((data && data.body) || []).forEach((seg, i) => {
    out.push(String(i + 1));
    out.push(`${srtTime(seg.from)} --> ${srtTime(seg.to)}`);
    out.push((seg.content || '').trim());
    out.push('');
  });
  return out.join('\n');
}

async function retryOne(dir, bili, sessdata, opts) {
  const bvid = path.basename(dir);
  const infoPath = path.join(dir, 'info.json');
  const txtPath = path.join(dir, 'transcript.txt');

  const existingMediaPath = findExistingMediaPath(dir);
  const hasAudio = !!existingMediaPath;
  const hasTranscript = fs.existsSync(txtPath) && fs.statSync(txtPath).size > 0;
  if (!opts.forceAudio && hasAudio && hasTranscript) {
    return { skipped: true, reason: '音频+字幕已齐' };
  }

  // 拿 cid (info.json 里可能已经有)
  let cid = 0;
  if (fs.existsSync(infoPath)) {
    try {
      cid = JSON.parse(fs.readFileSync(infoPath, 'utf8')).cid || 0;
    } catch (_) {}
  }
  if (!cid) {
    const v = await bili.fetchVideoView({ sessdata, bvid });
    if (!v || v.code !== 0) {
      throw new Error(`view 失败: code=${v && v.code} ${v && v.message}`);
    }
    cid = v.data.cid;
    await fsp.writeFile(infoPath, JSON.stringify(v.data, null, 2), 'utf8');
  }

  const result = { audio: false, subtitle: false, bvid };

  // 音频 (缺才下)
  if (!hasAudio || opts.forceAudio) {
    const pu = await bili.fetchPlayUrl({ sessdata, bvid, cid });
    if (pu && pu.code === 0) {
      await fsp.writeFile(
        path.join(dir, 'playurl.json'),
        JSON.stringify(pu.data, null, 2),
        'utf8'
      );
      const mediaSource = pickPreferredMediaSource(pu.data);
      if (mediaSource) {
        const targetPath = path.join(dir, mediaSource.fileName);
        let lastErr;
        for (const u of mediaSource.urls) {
          try {
            const { size } = await downloadAudio(u, targetPath, bvid);
            result.audio = true;
            result.audioSize = size;
            result.mediaKind = mediaSource.kind;
            break;
          } catch (e) {
            lastErr = e;
          }
        }
        if (!result.audio) throw new Error(`音频下载失败: ${lastErr && lastErr.message}`);
      } else {
        const voucher = pu.data && pu.data.v_voucher;
        throw new Error(
          voucher
            ? `风控重试仍 v_voucher, 停下休息一下再跑`
            : `dash 缺失, support_formats=${JSON.stringify(pu.data && pu.data.support_formats)}`
        );
      }
    } else {
      throw new Error(`playurl 失败: code=${pu && pu.code} ${pu && pu.message}`);
    }
  }

  // 字幕 (缺才下)
  if (!hasTranscript) {
    const pv = await bili.fetchPlayerV2({ sessdata, bvid, cid });
    const list = (pv && pv.data && pv.data.subtitle && pv.data.subtitle.subtitles) || [];
    const picked = list.find((s) => /^zh/i.test(s.lan || '')) || list[0] || null;
    if (picked && picked.subtitle_url) {
      const sub = await fetchSubtitleFile(picked.subtitle_url);
      await fsp.writeFile(path.join(dir, 'subtitle.json'), JSON.stringify(sub, null, 2), 'utf8');
      await fsp.writeFile(txtPath, subtitleJsonToText(sub), 'utf8');
      const srt = subtitleJsonToSrt(sub);
      if (srt.trim()) await fsp.writeFile(path.join(dir, 'subtitle.srt'), srt, 'utf8');
      result.subtitle = true;
      result.lang = picked.lan_doc || picked.lan;
    }
    // 无字幕就不强求 - 后续 transcribe.js 用 Groq 补
  }

  return result;
}

async function main() {
  loadEnvFile();
  const args = parseArgs(process.argv);
  const rootDir = path.resolve(args.dir || path.join(__dirname, 'downloads'));
  if (!fs.existsSync(rootDir)) {
    console.error(`✗ 目录不存在: ${rootDir}`);
    process.exit(1);
  }
  const sessdata = process.env.SESSDATA || '';
  if (!sessdata) {
    console.warn('⚠ 未设置 SESSDATA, 登录相关视频 (包括充电专属) 会失败. 继续仅公开视频...');
  }

  const hits = [];
  await walkFindVideos(rootDir, hits);
  if (!hits.length) {
    console.log(`未找到视频目录 (目录: ${rootDir})`);
    return;
  }

  // 只处理缺 audio.m4a 的
  const pending = hits.filter((dir) => {
    return !findExistingMediaPath(dir);
  });
  const okCount = hits.length - pending.length;
  console.log(
    `扫描到 ${hits.length} 个视频目录, 已有音频 ${okCount} 个, 待补 ${pending.length} 个`
  );
  if (!pending.length) return;

  const bili = createBiliClient();

  let ok = 0;
  let failed = 0;
  let delay = args.delay;
  for (let i = 0; i < pending.length; i++) {
    const dir = pending[i];
    const label = path.relative(rootDir, dir);
    console.log(`▶ ${i + 1}/${pending.length}  ${label}`);
    try {
      const r = await retryOne(dir, bili, sessdata, { forceAudio: args.forceAudio });
      if (r.skipped) {
        console.log(`  ⏭ ${r.reason}`);
      } else {
        const bits = [];
        if (r.audio) {
          bits.push(
            `${r.mediaKind === 'progressive' ? '渐进式媒体' : '音频'} ${(
              r.audioSize /
              1024 /
              1024
            ).toFixed(2)}MB`
          );
        }
        if (r.subtitle) bits.push(`字幕(${r.lang})`);
        console.log(`  ✅ ${bits.join(' + ') || '完成'}`);
        ok += 1;
      }
      // 成功了恢复正常节拍
      delay = Math.max(args.delay, 800);
    } catch (e) {
      console.log(`  ✗ ${e.message}`);
      failed += 1;
      // 失败一次就多等一会儿
      delay = Math.min(delay * 2, 15_000);
      console.log(`  (延长等待至 ${delay}ms)`);
    }
    if (i < pending.length - 1) {
      await new Promise((rs) => setTimeout(rs, delay));
    }
  }

  console.log(`\n完成: 成功 ${ok}, 失败 ${failed}, 共 ${pending.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
