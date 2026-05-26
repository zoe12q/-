// 批量下载任务管理 + SSE 进度推送
// - POST /api/download/start      创建任务, 返回 taskId
// - GET  /api/download/events     SSE 订阅进度 ?taskId=xxx
// - POST /api/download/cancel     取消任务
// - GET  /api/download/status     轮询任务状态 (备用)

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { transcribeAudioFile, resolveProvider } = require('./asr_pipeline');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tasks = new Map(); // taskId -> task

function newTaskId() {
  return (
    Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
  );
}

function pushEvent(task, evt) {
  const e = { ts: Date.now(), ...evt };
  task.events.push(e);
  // 限制内存占用
  if (task.events.length > 2000) task.events.splice(0, task.events.length - 2000);
  for (const sub of task.subscribers) {
    try {
      sub(e);
    } catch (_) {}
  }
}

function sanitize(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function dateOf(ts) {
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ----- 图片 URL 收集 -----
function collectUrlsFromMajor(major, out) {
  if (!major) return;
  const t = major.type;
  if (t === 'MAJOR_TYPE_DRAW' && major.draw) {
    for (const p of major.draw.items || []) if (p.src) out.push(p.src);
  }
  if (t === 'MAJOR_TYPE_OPUS' && major.opus) {
    for (const p of major.opus.pics || []) if (p.url) out.push(p.url);
  }
  if (t === 'MAJOR_TYPE_ARCHIVE' && major.archive && major.archive.cover) {
    out.push(major.archive.cover);
  }
  if (t === 'MAJOR_TYPE_ARTICLE' && major.article) {
    for (const c of major.article.covers || []) if (c) out.push(c);
    // 如果已预取文章详情，收集正文中的图片
    if (major.article._opusDetail || major.article._articleView) {
      for (const u of articleImagesOf(major.article._articleView, major.article._opusDetail)) {
        if (u) out.push(u);
      }
    }
  }
  if (t === 'MAJOR_TYPE_PGC' && major.pgc && major.pgc.cover) {
    out.push(major.pgc.cover);
  }
  if (t === 'MAJOR_TYPE_LIVE_RCMD' && major.live_rcmd) {
    try {
      const info = JSON.parse(major.live_rcmd.content || '{}');
      const cov =
        (info.live_play_info && info.live_play_info.cover) ||
        (info.live_record_info && info.live_record_info.cover);
      if (cov) out.push(cov);
    } catch (_) {}
  }
  if (t === 'MAJOR_TYPE_UGC_SEASON' && major.ugc_season && major.ugc_season.cover) {
    out.push(major.ugc_season.cover);
  }
}

function collectImageUrls(item) {
  const out = [];
  const md = item.modules && item.modules.module_dynamic;
  if (md) {
    collectUrlsFromMajor(md.major, out);
    const add = md.additional;
    if (add && add.ugc && add.ugc.cover) out.push(add.ugc.cover);
  }
  if (item.orig) {
    const omd = item.orig.modules && item.orig.modules.module_dynamic;
    if (omd) collectUrlsFromMajor(omd.major, out);
  }
  // 去重 + https
  const seen = new Set();
  return out
    .map((u) => (u.startsWith('//') ? 'https:' + u : u))
    .filter((u) => {
      if (!u) return false;
      if (seen.has(u)) return false;
      seen.add(u);
      return true;
    });
}

// ----- 文章专栏辅助 -----
function extractCvidFromUrl(url) {
  if (!url) return '';
  const m = /\/(?:read\/)?cv(\d+)/i.exec(String(url));
  return m ? m[1] : '';
}

function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

// 从 opus/detail 响应中提取 paragraphs
function opusParagraphsFromDetail(opusDetail) {
  if (!opusDetail?.data?.item?.modules) return null;
  const modules = opusDetail.data.item.modules;
  const contentMod = Array.isArray(modules)
    ? modules.find((m) => m.module_type === 'MODULE_TYPE_CONTENT')
    : null;
  const paragraphs = contentMod?.module_content?.paragraphs;
  return Array.isArray(paragraphs) && paragraphs.length > 0 ? paragraphs : null;
}

function articleTextOf(articleView, opusDetail) {
  // 优先使用 opus/detail 的数据 (新版专栏)
  const opusParagraphs = opusParagraphsFromDetail(opusDetail);
  if (opusParagraphs) {
    return textOfOpusParagraphs({ paragraphs: opusParagraphs });
  }
  // article/view 里的 opus.paragraphs
  const avOpusParagraphs = articleView?.opus?.content?.paragraphs;
  if (Array.isArray(avOpusParagraphs) && avOpusParagraphs.length > 0) {
    return textOfOpusParagraphs(articleView.opus.content);
  }
  // 老版专栏: content 是 HTML
  if (articleView?.content) {
    return htmlToText(articleView.content);
  }
  return articleView?.summary || '';
}

function articleImagesOf(articleView, opusDetail) {
  const out = [];
  // 优先使用 opus/detail 的 paragraphs 图片
  const opusParagraphs = opusParagraphsFromDetail(opusDetail);
  if (opusParagraphs) {
    for (const p of opusParagraphs) {
      if (p.pic?.pics) {
        for (const pic of p.pic.pics) {
          if (pic.url) out.push(pic.url);
        }
      }
    }
  }
  // article/view 里的 opus paragraphs 图片
  const avOpusParagraphs = articleView?.opus?.content?.paragraphs;
  if (Array.isArray(avOpusParagraphs)) {
    for (const p of avOpusParagraphs) {
      if (p.pic?.pics) {
        for (const pic of p.pic.pics) {
          if (pic.url) out.push(pic.url);
        }
      }
    }
  }
  // 从 image_urls / origin_image_urls 收集
  if (Array.isArray(articleView?.image_urls)) {
    out.push(...articleView.image_urls);
  }
  if (Array.isArray(articleView?.origin_image_urls)) {
    out.push(...articleView.origin_image_urls);
  }
  // 老版专栏 HTML 里的图片
  if (articleView?.content && typeof articleView.content === 'string') {
    const imgRe = /<img[^>]+src=["']([^"']+)["']/gi;
    let m;
    while ((m = imgRe.exec(articleView.content)) !== null) {
      if (m[1]) out.push(m[1]);
    }
  }
  return out;
}

async function prefetchArticleDetails(bili, sessdata, items) {
  if (!bili) return;
  for (const item of items) {
    const md = item.modules?.module_dynamic;
    if (md?.major?.type !== 'MAJOR_TYPE_ARTICLE') continue;
    const cvid = extractCvidFromUrl(md.major.article.jump_url);
    const opusId = item.id_str;

    // 策略: 优先 opus/detail (新版专栏), 回退 article/view (老版专栏)
    let opusDetail = null;
    let articleView = null;

    if (typeof bili.fetchOpusDetail === 'function' && opusId) {
      try {
        opusDetail = await bili.fetchOpusDetail({ sessdata, id: opusId });
        if (opusDetail?.code === 0 && opusParagraphsFromDetail(opusDetail)) {
          md.major.article._opusDetail = opusDetail;
          continue; // opus/detail 成功拿到正文，跳过 article/view
        }
      } catch (_) {
        opusDetail = null;
      }
    }

    if (typeof bili.fetchArticleView === 'function' && cvid) {
      try {
        articleView = await bili.fetchArticleView({ sessdata, cvid });
        if (articleView?.code === 0 && articleView.data) {
          md.major.article._articleView = articleView.data;
        }
      } catch (_) {
        // 静默失败
      }
    }
  }
}

// ----- 文本内容构造 -----
function isTruncatedDesc(desc) {
  if (!desc) return false;
  const text = desc.text || '';
  // B站截断特征: 以 ... 结尾，或纯省略号
  if (text.endsWith('...') || text === '...') return true;
  // rich_text_nodes 拼接后也以 ... 结尾
  if (Array.isArray(desc.rich_text_nodes)) {
    const rich = desc.rich_text_nodes.map((n) => n.text || n.orig_text || '').join('');
    if (rich.endsWith('...') || rich === '...') return true;
  }
  return false;
}

function textOfOpusNode(node) {
  if (!node || typeof node !== 'object') return '';
  if (node.word?.words) return node.word.words;
  if (node.rich?.text) return node.rich.text;
  if (node.user?.name) return `@${node.user.name}`;
  if (node.user?.uname) return `@${node.user.uname}`;
  if (node.formula?.latex) return node.formula.latex;
  return '';
}

function textOfOpusParagraphText(text) {
  if (!Array.isArray(text?.nodes)) return '';
  return text.nodes.map((node) => textOfOpusNode(node)).join('');
}

function textOfOpusListItem(item) {
  if (!item || !Array.isArray(item.children)) return '';
  return item.children
    .map((child) => textOfOpusParagraph(child))
    .filter(Boolean)
    .join('\n');
}

function textOfOpusParagraph(paragraph) {
  if (!paragraph || typeof paragraph !== 'object') return '';
  const lines = [];
  const inlineText = textOfOpusParagraphText(paragraph.text);
  if (inlineText) lines.push(inlineText);
  if (paragraph.code?.content) lines.push(paragraph.code.content);
  if (Array.isArray(paragraph.blockquote?.paragraphs)) {
    for (const child of paragraph.blockquote.paragraphs) {
      const childText = textOfOpusParagraph(child);
      if (childText) lines.push(childText);
    }
  }
  if (Array.isArray(paragraph.list?.children)) {
    for (const item of paragraph.list.children) {
      const itemText = textOfOpusListItem(item);
      if (itemText) lines.push(itemText);
    }
  }
  return lines.join('\n');
}

function textOfOpusParagraphs(opus) {
  if (!Array.isArray(opus?.paragraphs)) return '';
  return opus.paragraphs
    .map((paragraph) => textOfOpusParagraph(paragraph))
    .filter(Boolean)
    .join('\n');
}

function isTruncatedOpus(opus) {
  if (!opus) return false;
  return isTruncatedDesc(opus.summary) && !textOfOpusParagraphs(opus);
}

function needsDynamicDetail(item) {
  const md = item?.modules?.module_dynamic;
  const omd = item?.orig?.modules?.module_dynamic;
  return (
    isTruncatedDesc(md?.desc) ||
    isTruncatedOpus(md?.major?.opus) ||
    isTruncatedDesc(omd?.desc) ||
    isTruncatedOpus(omd?.major?.opus)
  );
}

async function enrichItemWithDetail(bili, sessdata, item) {
  if (!bili || typeof bili.fetchDynamicDetail !== 'function') return item;
  if (!needsDynamicDetail(item)) return item;
  try {
    const detail = await bili.fetchDynamicDetail({ sessdata, id: item.id_str });
    if (detail?.code !== 0 || !detail?.data?.item) return item;
    const fullItem = detail.data.item;
    // 用详情里的 module_dynamic 替换列表里的截断内容
    if (fullItem.modules?.module_dynamic) {
      item.modules.module_dynamic = fullItem.modules.module_dynamic;
    }
    // 转发原动态也一并补全
    if (item.orig && fullItem.orig?.modules?.module_dynamic) {
      item.orig.modules.module_dynamic = fullItem.orig.modules.module_dynamic;
    }
  } catch (_) {
    // 静默失败，保持原样
  }
  return item;
}

function textOfDesc(desc) {
  if (!desc) return '';
  if (desc.text) return desc.text;
  if (Array.isArray(desc.rich_text_nodes)) {
    return desc.rich_text_nodes
      .map((n) => n.text || n.orig_text || '')
      .join('');
  }
  return '';
}

function textOfMajor(major) {
  if (!major) return '';
  const t = major.type;
  const lines = [];
  if (t === 'MAJOR_TYPE_ARCHIVE' && major.archive) {
    lines.push(`[视频] ${major.archive.title || ''}`);
    if (major.archive.desc) lines.push(major.archive.desc);
    if (major.archive.jump_url)
      lines.push(
        major.archive.jump_url.startsWith('//')
          ? 'https:' + major.archive.jump_url
          : major.archive.jump_url
      );
  } else if (t === 'MAJOR_TYPE_OPUS' && major.opus) {
    if (major.opus.title) lines.push(`[图文] ${major.opus.title}`);
    const s = textOfOpusParagraphs(major.opus) || textOfDesc(major.opus.summary);
    if (s) lines.push(s);
  } else if (t === 'MAJOR_TYPE_ARTICLE' && major.article) {
    lines.push(`[专栏] ${major.article.title || ''}`);
    if (major.article._opusDetail || major.article._articleView) {
      const body = articleTextOf(major.article._articleView, major.article._opusDetail);
      if (body) lines.push(body);
    } else if (major.article.desc) {
      lines.push(major.article.desc);
    }
    if (major.article.jump_url) lines.push(major.article.jump_url);
  } else if (t === 'MAJOR_TYPE_LIVE_RCMD' && major.live_rcmd) {
    try {
      const info = JSON.parse(major.live_rcmd.content || '{}');
      const i =
        (info.live_play_info && info.live_play_info) ||
        (info.live_record_info && info.live_record_info) ||
        {};
      lines.push(`[直播] ${i.title || ''}`);
    } catch (_) {}
  } else if (t === 'MAJOR_TYPE_PGC' && major.pgc) {
    lines.push(`[番剧] ${major.pgc.title || ''}`);
    if (major.pgc.jump_url) lines.push(major.pgc.jump_url);
  } else if (t === 'MAJOR_TYPE_UPOWER_COMMON' && major.upower_common) {
    lines.push(`[充电专属] ${major.upower_common.title || ''}`);
  } else if (t === 'MAJOR_TYPE_NONE' && major.none) {
    lines.push(`[动态失效] ${major.none.tips || ''}`);
  } else if (t === 'MAJOR_TYPE_BLOCKED' && major.blocked) {
    const b = major.blocked;
    const hint =
      b.hint_message ||
      (b.bg_img && (b.bg_img.text || b.bg_img.hint_message)) ||
      (b.button && ((b.button.uncheck && b.button.uncheck.text) || (b.button.check && b.button.check.text))) ||
      '';
    lines.push(`[受限动态]${hint ? ' ' + hint : ''}`);
  } else if (t) {
    lines.push(`[${t}]`);
  }
  return lines.join('\n');
}

function buildTextContent(item) {
  const md = item.modules && item.modules.module_dynamic;
  const author = (item.modules && item.modules.module_author) || {};
  const stat = (item.modules && item.modules.module_stat) || {};
  const lines = [];
  lines.push(`作者:    ${author.name || ''} (mid=${author.mid || ''})`);
  lines.push(
    `发布时间: ${author.pub_ts ? fmtTime(author.pub_ts) : author.pub_time || ''}`
  );
  lines.push(`动态ID:  ${item.id_str || ''}`);
  lines.push(`类型:    ${item.type || ''}`);
  lines.push(`原链接:  https://www.bilibili.com/opus/${item.id_str || ''}`);
  lines.push(
    `互动:    👍 ${stat?.like?.count ?? 0}  💬 ${stat?.comment?.count ?? 0}  🔁 ${stat?.forward?.count ?? 0}`
  );
  lines.push('-'.repeat(60));
  const descText = md ? textOfDesc(md.desc) : '';
  if (descText) lines.push(descText);
  const majorText = md ? textOfMajor(md.major) : '';
  if (majorText) {
    if (descText) lines.push('');
    lines.push(majorText);
  }
  if (item.type === 'DYNAMIC_TYPE_FORWARD' && item.orig) {
    const oAuthor =
      (item.orig.modules && item.orig.modules.module_author) || {};
    const omd = item.orig.modules && item.orig.modules.module_dynamic;
    lines.push('');
    lines.push('------ 转发的原动态 ------');
    lines.push(`@${oAuthor.name || ''}`);
    const od = omd ? textOfDesc(omd.desc) : '';
    if (od) lines.push(od);
    const om = omd ? textOfMajor(omd.major) : '';
    if (om) lines.push(om);
  }
  lines.push('');
  return lines.join('\r\n');
}

// ----- 图片下载 -----
const EXT_BY_CT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
};

function guessExt(url, contentType) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (EXT_BY_CT[ct]) return EXT_BY_CT[ct];
  try {
    const u = new URL(url);
    const m = /\.([a-zA-Z0-9]{2,5})$/.exec(u.pathname);
    if (m) return '.' + m[1].toLowerCase();
  } catch (_) {}
  return '.jpg';
}

// 统一处理 B 站图片 URL: 协议升级为 https
function normalizeImgUrl(url) {
  if (!url) return '';
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('http://')) return 'https://' + url.slice(7);
  return url;
}

async function downloadImage(rawUrl, dir, index) {
  const url = normalizeImgUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    // 关键: 不发送 Referer (B 站 CDN 允许空 Referer, 拒绝非白名单域),
    // 这与前端 <meta name="referrer" content="no-referrer"> 行为一致.
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      // Node fetch 默认不带 Referer, 这里显式 "no-referrer" 明确意图
      referrer: '',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const ext = guessExt(url, r.headers.get('content-type'));
    const name = `${String(index).padStart(2, '0')}${ext}`;
    await fsp.writeFile(path.join(dir, name), buf);
    return { name, size: buf.length };
  } finally {
    clearTimeout(timer);
  }
}

// ----- 视频/音频/字幕 -----

// 从一条动态中抽出所有视频 (主体 + 转发原文), 返回 [{bvid, title, source}]
function collectVideoRefs(item) {
  const refs = [];
  const pushIfArchive = (major, source) => {
    if (!major) return;
    if (major.type === 'MAJOR_TYPE_ARCHIVE' && major.archive) {
      const a = major.archive;
      const bvid = a.bvid || '';
      if (bvid) {
        refs.push({
          bvid,
          title: a.title || '',
          aid: a.aid || '',
          source,
        });
      }
    }
  };
  const md = item.modules && item.modules.module_dynamic;
  if (md) pushIfArchive(md.major, 'main');
  if (item.orig) {
    const omd = item.orig.modules && item.orig.modules.module_dynamic;
    if (omd) pushIfArchive(omd.major, 'forward');
  }
  // 去重
  const seen = new Set();
  return refs.filter((r) => {
    if (seen.has(r.bvid)) return false;
    seen.add(r.bvid);
    return true;
  });
}

function singleLine(text, maxLength = 120) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function titleOfLiveRcmd(liveRcmd) {
  if (!liveRcmd) return '';
  try {
    const info = JSON.parse(liveRcmd.content || '{}');
    const liveInfo =
      (info.live_play_info && info.live_play_info) ||
      (info.live_record_info && info.live_record_info) ||
      {};
    return singleLine(liveInfo.title);
  } catch (_) {
    return '';
  }
}

function titleOfAdditional(additional) {
  if (!additional) return '';
  if (additional.ugc && additional.ugc.title) return singleLine(additional.ugc.title);
  if (additional.reserve && additional.reserve.title) return singleLine(additional.reserve.title);
  return '';
}

function titleOfMajor(major) {
  if (!major) return '';
  if (major.type === 'MAJOR_TYPE_ARCHIVE' && major.archive) {
    return singleLine(major.archive.title || major.archive.desc);
  }
  if (major.type === 'MAJOR_TYPE_OPUS' && major.opus) {
    return singleLine(major.opus.title || textOfDesc(major.opus.summary));
  }
  if (major.type === 'MAJOR_TYPE_ARTICLE' && major.article) {
    return singleLine(major.article.title || major.article.desc);
  }
  if (major.type === 'MAJOR_TYPE_LIVE_RCMD') {
    return titleOfLiveRcmd(major.live_rcmd);
  }
  if (major.type === 'MAJOR_TYPE_PGC' && major.pgc) {
    return singleLine(major.pgc.title);
  }
  if (major.type === 'MAJOR_TYPE_UPOWER_COMMON' && major.upower_common) {
    return singleLine(major.upower_common.title || major.upower_common.desc);
  }
  if (major.type === 'MAJOR_TYPE_NONE' && major.none) {
    return singleLine(major.none.tips);
  }
  if (major.type === 'MAJOR_TYPE_BLOCKED' && major.blocked) {
    const b = major.blocked;
    const hint =
      b.hint_message ||
      (b.bg_img && (b.bg_img.text || b.bg_img.hint_message)) ||
      (b.button && ((b.button.uncheck && b.button.uncheck.text) || (b.button.check && b.button.check.text))) ||
      '';
    return singleLine(hint ? `受限动态 ${hint}` : '受限动态');
  }
  return '';
}

function deriveItemTitle(item) {
  const md = item?.modules?.module_dynamic;
  const ownCandidates = [
    titleOfMajor(md?.major),
    titleOfAdditional(md?.additional),
    singleLine(textOfDesc(md?.desc)),
  ];
  const ownTitle = ownCandidates.find(Boolean);
  if (ownTitle) return ownTitle;

  const origMd = item?.orig?.modules?.module_dynamic;
  const origCandidates = [
    titleOfMajor(origMd?.major),
    titleOfAdditional(origMd?.additional),
    singleLine(textOfDesc(origMd?.desc)),
  ];
  return origCandidates.find(Boolean) || '';
}

function normalizeBiliMediaUrl(url) {
  if (!url) return '';
  if (url.startsWith('//')) return 'https:' + url;
  return url;
}

// 从 playurl.dash.audio 中选 bandwidth 最高的一路
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

function mediaUrlsOf(source) {
  if (!source) return [];
  return [
    source.base_url,
    source.baseUrl,
    source.url,
    ...(source.backup_url || []),
    ...(source.backupUrl || []),
  ].filter(Boolean);
}

function pickPreferredMediaSource(playData) {
  const bestAudio = pickBestAudio(playData && playData.dash);
  if (bestAudio) {
    return {
      kind: 'dash_audio',
      fileName: 'audio.m4a',
      urls: mediaUrlsOf(bestAudio),
    };
  }

  const durlList = Array.isArray(playData && playData.durl) ? playData.durl : [];
  const firstProgressive = durlList.find((entry) => mediaUrlsOf(entry).length > 0);
  if (firstProgressive) {
    return {
      kind: 'progressive',
      fileName: 'audio.mp4',
      urls: mediaUrlsOf(firstProgressive),
      segmentCount: durlList.length,
    };
  }

  return null;
}

// 下载 DASH 音频 (m4s), 需要 Referer
async function downloadAudio(rawUrl, filePath, bvid) {
  const url = normalizeBiliMediaUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
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

// 字幕 JSON → 纯文本 (按时间升序拼接, 每行一个句子)
function subtitleJsonToText(data) {
  const body = (data && data.body) || [];
  const lines = [];
  for (const seg of body) {
    const t = (seg.content || '').trim();
    if (t) lines.push(t);
  }
  return lines.join('\n');
}

// 时间格式 (SRT): 00:00:01,234
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
  const body = (data && data.body) || [];
  const out = [];
  body.forEach((seg, i) => {
    out.push(String(i + 1));
    out.push(`${srtTime(seg.from)} --> ${srtTime(seg.to)}`);
    out.push((seg.content || '').trim());
    out.push('');
  });
  return out.join('\n');
}

async function fetchSubtitleFile(subtitleUrl) {
  const url = normalizeBiliMediaUrl(subtitleUrl);
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json,*/*',
      Referer: 'https://www.bilibili.com/',
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

// 调用本地 whisper 命令做 ASR (可选). 用户通过环境变量开启:
//   WHISPER_CMD="whisper \"{input}\" --model small --language zh --output_format txt --output_dir \"{outdir}\""
// 占位符: {input} 输入音频路径, {outdir} 输出目录
function runWhisper(audioPath, outDir) {
  const tmpl = process.env.WHISPER_CMD;
  if (!tmpl) return Promise.resolve({ skipped: true });
  return new Promise((resolve) => {
    const cmd = tmpl
      .replace(/\{input\}/g, audioPath)
      .replace(/\{outdir\}/g, outDir);
    const child = spawn(cmd, {
      shell: true,
      cwd: outDir,
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: `exit ${code}: ${stderr.slice(-400)}` });
    });
  });
}

// 针对单条动态中的所有视频: 下音频 + 字幕 (可选 whisper)
async function handleVideosForItem(task, item, itemDir, bili) {
  const refs = collectVideoRefs(item);
  if (!refs.length) return { videos: 0 };

  const videosDir = path.join(itemDir, 'videos');
  await fsp.mkdir(videosDir, { recursive: true });

  for (const ref of refs) {
    if (task.cancelled) break;
    const subDir = path.join(videosDir, sanitize(ref.bvid));
    await fsp.mkdir(subDir, { recursive: true });

    // 1) cid
    let cid = 0;
    try {
      const info = await bili.fetchVideoView({
        sessdata: task.sessdata,
        bvid: ref.bvid,
      });
      if (info && info.code === 0) {
        cid = info.data?.cid || 0;
        await fsp.writeFile(
          path.join(subDir, 'info.json'),
          JSON.stringify(info.data, null, 2),
          'utf8'
        );
      } else {
        pushEvent(task, {
          type: 'log',
          level: 'warn',
          message: `视频信息失败 ${ref.bvid}: code=${info && info.code} ${info && info.message}`,
        });
        continue;
      }
    } catch (e) {
      pushEvent(task, {
        type: 'log',
        level: 'error',
        message: `视频信息异常 ${ref.bvid}: ${e.message}`,
      });
      continue;
    }

    // 2) 优先获取官方/AI 字幕
    let subtitleOk = false;
    try {
      const pv = await bili.fetchPlayerV2({
        sessdata: task.sessdata,
        bvid: ref.bvid,
        cid,
      });
      const list = pv?.data?.subtitle?.subtitles || [];
      // 优先选中文, 其次任意
      const picked =
        list.find((s) => /^zh/i.test(s.lan || '')) || list[0] || null;
      if (picked && picked.subtitle_url) {
        const subData = await fetchSubtitleFile(picked.subtitle_url);
        await fsp.writeFile(
          path.join(subDir, 'subtitle.json'),
          JSON.stringify(subData, null, 2),
          'utf8'
        );
        await fsp.writeFile(
          path.join(subDir, 'transcript.txt'),
          subtitleJsonToText(subData),
          'utf8'
        );
        await fsp.writeFile(
          path.join(subDir, 'subtitle.srt'),
          subtitleJsonToSrt(subData),
          'utf8'
        );
        subtitleOk = true;
        pushEvent(task, {
          type: 'log',
          level: 'info',
          message: `字幕已保存 ${ref.bvid} (${picked.lan_doc || picked.lan})`,
        });
      } else {
        pushEvent(task, {
          type: 'log',
          level: 'info',
          message: `视频无官方字幕 ${ref.bvid}`,
        });
      }
    } catch (e) {
      pushEvent(task, {
        type: 'log',
        level: 'warn',
        message: `字幕获取失败 ${ref.bvid}: ${e.message}`,
      });
    }

    // 3) 无字幕时才下载音频 + ASR
    if (!subtitleOk && !task.cancelled) {
      try {
        const pu = await bili.fetchPlayUrl({
          sessdata: task.sessdata,
          bvid: ref.bvid,
          cid,
        });
        if (pu && pu.code === 0) {
          // 诊断信息: 落盘 playurl 原始响应的 data 部分 (去掉冗余的分段 URL 不太现实, 全量保留)
          try {
            await fsp.writeFile(
              path.join(subDir, 'playurl.json'),
              JSON.stringify(pu.data, null, 2),
              'utf8'
            );
          } catch (_) {}
          const dash = pu.data && pu.data.dash;
          const mediaSource = pickPreferredMediaSource(pu.data);
          let mediaPath = '';
          if (mediaSource) {
            mediaPath = path.join(subDir, mediaSource.fileName);
            let saved = null;
            let lastErr = null;
            for (const u of mediaSource.urls) {
              try {
                saved = await downloadAudio(u, mediaPath, ref.bvid);
                break;
              } catch (e) {
                lastErr = e;
              }
            }
            if (saved) {
              pushEvent(task, {
                type: 'log',
                level: 'info',
                message:
                  mediaSource.kind === 'dash_audio'
                    ? `音频已保存 ${ref.bvid} (${(saved.size / 1024 / 1024).toFixed(2)} MB)`
                    : `渐进式媒体已保存 ${ref.bvid} (${(saved.size / 1024 / 1024).toFixed(2)} MB)`,
              });
            } else {
              pushEvent(task, {
                type: 'log',
                level: 'error',
                message:
                  `${mediaSource.kind === 'dash_audio' ? '音频' : '渐进式媒体'}下载失败 ` +
                  `${ref.bvid}: ${lastErr && lastErr.message}`,
              });
            }
          } else {
            const hasDurl = Array.isArray(pu.data && pu.data.durl);
            const dashAudioLen = Array.isArray(dash && dash.audio)
              ? dash.audio.length
              : -1;
            const fmt = Array.isArray(pu.data && pu.data.support_formats)
              ? pu.data.support_formats.map((f) => f.quality).join(',')
              : '';
            pushEvent(task, {
              type: 'log',
              level: 'warn',
              message:
                `未找到可用音频流 ${ref.bvid}  ` +
                `dash=${!!dash}, audio[]=${dashAudioLen}, durl=${hasDurl}, quality=${fmt}. ` +
                `playurl.json 已保存, 可自行排查.`,
            });
          }
        } else {
          pushEvent(task, {
            type: 'log',
            level: 'warn',
            message: `playurl 失败 ${ref.bvid}: code=${pu && pu.code} ${pu && pu.message}`,
          });
        }
      } catch (e) {
        pushEvent(task, {
          type: 'log',
          level: 'error',
          message: `音频下载异常 ${ref.bvid}: ${e.message}`,
        });
      }

    // 4) ASR 转录降级链: Qwen > Groq > 本地 WHISPER_CMD
      const transcriptionInputPath = ['audio.m4a', 'audio.mp4']
        .map((name) => path.join(subDir, name))
        .find((candidate) => fs.existsSync(candidate));
      if (transcriptionInputPath) {
        const asrProvider = resolveProvider();
        if (asrProvider) {
          pushEvent(task, {
            type: 'log',
            level: 'info',
            message: `调用 ${asrProvider.toUpperCase()} ASR 转录 ${ref.bvid} ...`,
          });
          try {
            const started = Date.now();
            const r = await transcribeAudioFile(transcriptionInputPath, subDir, {
              provider: asrProvider,
              log: (m) => pushEvent(task, {
                type: 'log',
                level: 'info',
                message: `  [${ref.bvid}] ${m}`,
              }),
            });
            const dur = ((Date.now() - started) / 1000).toFixed(1);
            if (r.skipped) {
              pushEvent(task, {
                type: 'log',
                level: 'info',
                message: `${asrProvider} 跳过 ${ref.bvid}: ${r.reason}`,
              });
            } else {
              pushEvent(task, {
                type: 'log',
                level: 'info',
                message: `${asrProvider} 完成 ${ref.bvid} (${dur}s, ${r.chars} 字)`,
              });
            }
          } catch (e) {
            pushEvent(task, {
              type: 'log',
              level: 'warn',
              message: `${asrProvider} 转录失败 ${ref.bvid}: ${e.message}`,
            });
          }
        } else if (process.env.WHISPER_CMD) {
          pushEvent(task, {
            type: 'log',
            level: 'info',
            message: `调用 whisper 转录 ${ref.bvid} ...`,
          });
          const r = await runWhisper(transcriptionInputPath, subDir);
          if (r.ok) {
            pushEvent(task, {
              type: 'log',
              level: 'info',
              message: `whisper 完成 ${ref.bvid}`,
            });
          } else if (!r.skipped) {
            pushEvent(task, {
              type: 'log',
              level: 'warn',
              message: `whisper 失败 ${ref.bvid}: ${r.error}`,
            });
          }
        }
      }
    }

    task.doneVideos += 1;
    pushEvent(task, {
      type: 'video',
      itemId: item.id_str,
      bvid: ref.bvid,
      title: ref.title,
      doneVideos: task.doneVideos,
      totalVideos: task.totalVideos,
    });
    // 视频间留点间隔, 避免被 playurl 判为高频触发 v_voucher
    await sleep(800);
  }
  return { videos: refs.length };
}

// ----- 下载主流程 -----
async function runDownload(task, rootDir, bili) {
  const fetchSpacePage = bili.fetchSpacePage;
  const baseDir = path.join(rootDir, String(task.host_mid));
  await fsp.mkdir(baseDir, { recursive: true });
  task.outputDir = baseDir;
  pushEvent(task, {
    type: 'start',
    outputDir: baseDir,
    start_ts: task.start_ts,
    end_ts: task.end_ts,
  });

  let offset = '';
  const matched = [];
  let scanned = 0;

  while (!task.cancelled) {
    let page;
    try {
      page = await fetchSpacePage({
        sessdata: task.sessdata,
        host_mid: task.host_mid,
        offset,
      });
    } catch (e) {
      pushEvent(task, { type: 'log', level: 'error', message: `请求失败: ${e.message}` });
      task.status = 'error';
      return;
    }
    if (!page || page.code !== 0) {
      pushEvent(task, {
        type: 'log',
        level: 'error',
        message: `接口错误 code=${page && page.code} msg=${page && page.message}`,
      });
      task.status = 'error';
      return;
    }
    const items = (page.data && page.data.items) || [];
    if (!items.length) break;

    let reachedEarlier = false;
    for (const it of items) {
      scanned += 1;
      const ts = it.modules?.module_author?.pub_ts || 0;
      const pinned = it.modules?.module_tag?.text === '置顶';
      if (!ts) continue;
      if (!pinned && ts < task.start_ts) {
        reachedEarlier = true;
        continue;
      }
      if (ts > task.end_ts) continue;
      if (ts >= task.start_ts && ts <= task.end_ts) matched.push(it);
    }
    pushEvent(task, {
      type: 'collect',
      scanned,
      matched: matched.length,
    });

    if (reachedEarlier) break;
    if (!page.data.has_more) break;
    const nextOffset = page.data.offset;
    if (!nextOffset || nextOffset === offset) break;
    offset = nextOffset;
    await sleep(600); // 温柔一点, 降低风控
  }

  // "仅音频" 模式: 过滤掉没视频的条目, 避免写一堆纯文本空目录
  let effective = matched;
  if (task.skipImages && task.downloadAudio) {
    effective = matched.filter((it) => collectVideoRefs(it).length > 0);
    if (effective.length !== matched.length) {
      pushEvent(task, {
        type: 'log',
        level: 'info',
        message: `仅音频模式: 过滤非视频动态 ${matched.length - effective.length} 条, 剩 ${effective.length} 条`,
      });
    }
  }

  // 按时间升序下载 (老→新)
  effective.sort(
    (a, b) =>
      (a.modules?.module_author?.pub_ts || 0) -
      (b.modules?.module_author?.pub_ts || 0)
  );
  matched.length = 0;
  matched.push(...effective);

  // 预取文章详情，补全专栏正文和图片
  const articleItems = matched.filter(
    (it) => it.modules?.module_dynamic?.major?.type === 'MAJOR_TYPE_ARTICLE'
  );
  if (articleItems.length > 0) {
    pushEvent(task, {
      type: 'log',
      level: 'info',
      message: `发现 ${articleItems.length} 条专栏文章，正在获取正文...`,
    });
    await prefetchArticleDetails(bili, task.sessdata, matched);
  }

  const totalImages = task.skipImages
    ? 0
    : matched.reduce((n, it) => n + collectImageUrls(it).length, 0);
  const totalVideos = task.downloadAudio
    ? matched.reduce((n, it) => n + collectVideoRefs(it).length, 0)
    : 0;
  task.totalItems = matched.length;
  task.totalImages = totalImages;
  task.totalVideos = totalVideos;
  pushEvent(task, {
    type: 'plan',
    totalItems: matched.length,
    totalImages,
    totalVideos,
  });

  for (const it of matched) {
    if (task.cancelled) break;
    const ts = it.modules.module_author.pub_ts;
    const d = dateOf(ts);
    const folderName = sanitize(`${it.id_str}`);
    const itemDir = path.join(baseDir, d, folderName);
    await fsp.mkdir(itemDir, { recursive: true });

    await enrichItemWithDetail(bili, task.sessdata, it);
    const text = buildTextContent(it);
    await fsp.writeFile(path.join(itemDir, 'content.txt'), text, 'utf8');
    await fsp.writeFile(
      path.join(itemDir, 'raw.json'),
      JSON.stringify(it, null, 2),
      'utf8'
    );

    const urls = task.skipImages ? [] : collectImageUrls(it);
    let okCount = 0;
    for (let i = 0; i < urls.length; i++) {
      if (task.cancelled) break;
      const url = urls[i];
      try {
        const { name } = await downloadImage(url, itemDir, i + 1);
        okCount += 1;
        pushEvent(task, {
          type: 'image',
          itemId: it.id_str,
          url,
          file: name,
          ok: true,
        });
      } catch (e) {
        pushEvent(task, {
          type: 'image',
          itemId: it.id_str,
          url,
          ok: false,
          error: String(e.message || e),
        });
      }
      task.doneImages += 1;
      pushEvent(task, {
        type: 'progress',
        doneImages: task.doneImages,
        totalImages: task.totalImages,
      });
    }
    // 可选: 下载视频音频 + 字幕 / ASR
    if (task.downloadAudio && !task.cancelled) {
      try {
        await handleVideosForItem(task, it, itemDir, bili);
      } catch (e) {
        pushEvent(task, {
          type: 'log',
          level: 'error',
          message: `视频处理异常 ${it.id_str}: ${e.message || e}`,
        });
      }
    }

    task.doneItems += 1;
    pushEvent(task, {
      type: 'item',
      id: it.id_str,
      date: d,
      imagesOk: okCount,
      imagesTotal: urls.length,
      doneItems: task.doneItems,
      totalItems: task.totalItems,
    });
  }

  task.status = task.cancelled ? 'cancelled' : 'done';
  pushEvent(task, {
    type: task.status,
    doneItems: task.doneItems,
    totalItems: task.totalItems,
    doneImages: task.doneImages,
    totalImages: task.totalImages,
    doneVideos: task.doneVideos,
    totalVideos: task.totalVideos,
    outputDir: baseDir,
  });
}

// ----- Router -----
function createDownloadRouter({ rootDir, bili }) {
  const router = express.Router();

  router.post('/start', async (req, res) => {
    const {
      sessdata,
      host_mid,
      start_date,
      end_date,
      download_audio,
      skip_images,
    } = req.body || {};
    if (!host_mid) return res.status(400).json({ error: '缺少 host_mid' });

    // 日期边界 (本地时区)
    const startTs = start_date
      ? Math.floor(new Date(start_date + 'T00:00:00').getTime() / 1000)
      : 0;
    const endTs = end_date
      ? Math.floor(new Date(end_date + 'T23:59:59').getTime() / 1000)
      : Math.floor(Date.now() / 1000);
    if (startTs > endTs) {
      return res.status(400).json({ error: '起始日期晚于结束日期' });
    }

    const taskId = newTaskId();
    const task = {
      id: taskId,
      status: 'running',
      sessdata,
      host_mid: String(host_mid),
      start_ts: startTs,
      end_ts: endTs,
      totalItems: 0,
      totalImages: 0,
      totalVideos: 0,
      doneItems: 0,
      doneImages: 0,
      doneVideos: 0,
      downloadAudio: !!download_audio,
      skipImages: !!skip_images,
      cancelled: false,
      outputDir: '',
      subscribers: new Set(),
      events: [],
      createdAt: Date.now(),
    };
    tasks.set(taskId, task);

    runDownload(task, rootDir, bili).catch((e) => {
      pushEvent(task, {
        type: 'log',
        level: 'error',
        message: `未捕获异常: ${e.message || e}`,
      });
      task.status = 'error';
    });

    res.json({ taskId });
  });

  router.post('/cancel', (req, res) => {
    const { taskId } = req.body || {};
    const task = tasks.get(taskId);
    if (!task) return res.status(404).json({ error: '未知任务' });
    task.cancelled = true;
    res.json({ ok: true });
  });

  router.get('/status', (req, res) => {
    const task = tasks.get(req.query.taskId);
    if (!task) return res.status(404).json({ error: '未知任务' });
    const { subscribers, events, sessdata, ...safe } = task;
    res.json({ ...safe, eventCount: events.length });
  });

  router.get('/events', (req, res) => {
    const task = tasks.get(req.query.taskId);
    if (!task) return res.status(404).end();
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // replay
    for (const e of task.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
    if (['done', 'error', 'cancelled'].includes(task.status)) {
      res.end();
      return;
    }

    const sub = (e) => {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (['done', 'error', 'cancelled'].includes(e.type)) {
        task.subscribers.delete(sub);
        res.end();
      }
    };
    task.subscribers.add(sub);

    req.on('close', () => {
      task.subscribers.delete(sub);
    });
  });

  return router;
}

module.exports = {
  createDownloadRouter,
  buildTextContent,
  enrichItemWithDetail,
  prefetchArticleDetails,
  collectImageUrls,
  downloadImage,
  collectVideoRefs,
  deriveItemTitle,
  handleVideosForItem,
  dateOf,
  fmtTime,
  pickPreferredMediaSource,
  sanitize,
};
