const fs = require('fs');

const lines = fs.readFileSync('.env', 'utf8').split(/\r?\n/);
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const idx = trimmed.indexOf('=');
  if (idx <= 0) continue;
  const key = trimmed.slice(0, idx).trim();
  let value = trimmed.slice(idx + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  process.env[key] = value;
}

const { createBiliClient } = require('./bili');
const bili = createBiliClient();
bili.setCookieOverride(process.env.BILI_COOKIE || '');

async function main() {
  // 1. 先拿列表看第一条
  const page = await bili.fetchSpacePage({
    sessdata: process.env.BILI_SESSDATA || '',
    host_mid: 1420210197,
    offset: ''
  });

  if (page.code !== 0 || !page.data?.items?.length) {
    console.log('列表获取失败:', page.code, page.message);
    return;
  }

  const item = page.data.items[0];
  console.log('=== 列表接口返回的 major.type ===');
  console.log('major.type:', item.modules?.module_dynamic?.major?.type);
  console.log('major.blocked:', JSON.stringify(item.modules?.module_dynamic?.major?.blocked, null, 2));
  console.log('');

  // 2. 拿详情接口
  console.log('=== 详情接口 ===');
  const detail = await bili.fetchDynamicDetail({
    sessdata: process.env.BILI_SESSDATA || '',
    id: item.id_str
  });

  console.log('detail.code:', detail.code);
  console.log('detail.message:', detail.message);

  if (detail.code === 0 && detail.data?.item) {
    const d = detail.data.item;
    console.log('');
    console.log('=== 详情接口的 module_dynamic ===');
    console.log('major.type:', d.modules?.module_dynamic?.major?.type);
    console.log('');
    console.log('major 完整结构:');
    console.log(JSON.stringify(d.modules?.module_dynamic?.major, null, 2));
    console.log('');
    console.log('=== desc ===');
    console.log(JSON.stringify(d.modules?.module_dynamic?.desc, null, 2));
  } else {
    console.log('详情接口失败:', JSON.stringify(detail, null, 2).slice(0, 500));
  }
}

main().catch(e => console.error(e));
