// 空间动态查看器 —— 本地后端代理 + 批量下载
// 仅用于本地调试, 请勿部署到公网 (会泄漏 SESSDATA)

const express = require('express');
const path = require('path');
const { createBiliClient } = require('./bili');
const { createDownloadRouter } = require('./download');

const app = express();
const PORT = process.env.PORT || 5173;

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const bili = createBiliClient();

// ---------- 路由 ----------

app.post('/api/verify-login', async (req, res) => {
  const { sessdata } = req.body || {};
  if (!sessdata) return res.status(400).json({ error: '缺少 sessdata' });
  try {
    const buvid = await bili.ensureBuvid();
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: bili.buildHeaders({
        sessdata,
        referer: 'https://www.bilibili.com/',
        buvid,
      }),
    });
    const data = await r.json();
    bili.primeWbiFromNav(data);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

app.post('/api/space-dynamic', async (req, res) => {
  const { sessdata, host_mid, offset } = req.body || {};
  if (!host_mid) return res.status(400).json({ error: '缺少 host_mid' });
  try {
    const data = await bili.fetchSpacePage({ sessdata, host_mid, offset });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// 专栏文章详情 (空间动态列表对文章只给摘要)
app.post('/api/article-view', async (req, res) => {
  const { sessdata, cvid } = req.body || {};
  if (!cvid) return res.status(400).json({ error: '缺少 cvid' });
  try {
    const data = await bili.fetchArticleView({ sessdata, cvid });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// 图文(opus)详情 (新版专栏必须用此接口+htmlNewStyle才能拿到正文)
app.post('/api/opus-detail', async (req, res) => {
  const { sessdata, id } = req.body || {};
  if (!id) return res.status(400).json({ error: '缺少 id' });
  try {
    const data = await bili.fetchOpusDetail({ sessdata, id });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// 批量下载
app.use(
  '/api/download',
  createDownloadRouter({
    rootDir: path.join(__dirname, 'downloads'),
    bili,
  })
);

app.get('/api/_debug', (_req, res) => {
  res.json(bili.debugSnapshot());
});

app.listen(PORT, () => {
  console.log(`\n▶ 空间动态查看器已启动: http://localhost:${PORT}\n`);
  bili
    .ensureBuvid()
    .then((c) => console.log(c ? '[buvid] 已获取' : '[buvid] 未获取 (稍后重试)'));
  bili
    .ensureBiliTicket()
    .then((t) => console.log(t ? '[bili_ticket] 已获取' : '[bili_ticket] 未获取 (稍后重试)'));
});
