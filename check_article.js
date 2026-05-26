const fs = require('fs');

const lines = fs.readFileSync('.env', 'utf8').split(/\r?\n/);
for (const line of lines) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[k] = v;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const COOKIE = process.env.BILI_COOKIE || '';

async function fetchDetailWithDmImg() {
  const params = new URLSearchParams();
  params.set('id', '1203412912524230664');
  params.set('timezone_offset', '-480');
  params.set('platform', 'web');
  params.set('features', 'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,forwardListHidden,decorationCard,commentsNewVersion,onlyfansAssetsV2,ugcDelete,onlyfansQaCard');
  params.set('web_location', '333.1387');
  params.set('dm_img_list', '[]');
  params.set('dm_img_str', 'V2ViR0wgMS4w');
  params.set('dm_cover_img_str', 'QU5HTEUgKEludGVsLCBJbnRlbChSKSBVSEQgR3JhcGhpY3MgNjMwIERpcmVjdDNEMTEgdnNfNV8wIHBzXzVfMCwgRDNEMTEp');
  params.set('dm_img_inter', '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}');

  const url = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?' + params.toString();
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Referer': 'https://www.bilibili.com/opus/1203412912524230664',
      'Cookie': COOKIE
    }
  });
  return await r.json();
}

async function main() {
  console.log('=== fetchDynamicDetail + dm_img 参数 ===');
  const data = await fetchDetailWithDmImg();
  console.log('code:', data.code, 'message:', data.message);

  if (data.code === 0 && data.data?.item) {
    const md = data.data.item.modules?.module_dynamic;
    console.log('major.type:', md?.major?.type);

    if (md?.major?.opus) {
      const opus = md.major.opus;
      console.log('opus.title:', opus.title);
      console.log('opus.summary.has_more:', opus.summary?.has_more);
      console.log('opus.summary.paragraphs count:', opus.summary?.paragraphs?.length);

      if (Array.isArray(opus.summary?.paragraphs)) {
        const text = opus.summary.paragraphs
          .map(p => p.text?.nodes?.map(n => n.word?.words || n.rich?.text || '').join(''))
          .filter(Boolean)
          .join('\n');
        console.log('text length:', text.length);
        console.log('preview:', text.slice(0, 200));
      }
    }
    if (md?.major?.article) {
      console.log('article.desc:', md.major.article.desc);
    }
  }
}

main().catch(e => console.error(e));
