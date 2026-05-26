// 极简前端逻辑 —— 调用本地后端 /api/* 代理

const $ = (sel) => document.querySelector(sel);
const feed = $("#feed");
const btnMore = $("#btn-more");
const statusEl = $("#status");

const state = {
  offset: "",
  hostMid: "",
  hasMore: false,
  loading: false,
};

// ---------- 工具 ----------
const fmtTs = (sec) => {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
};

const escapeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const httpsify = (u) => {
  if (!u) return "";
  if (u.startsWith("//")) return "https:" + u;
  return u;
};

async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// ---------- 登录 ----------
function getSessdata() {
  return $("#sessdata").value.trim();
}

function loadSessdata() {
  const saved = localStorage.getItem("sessdata");
  if (saved) $("#sessdata").value = saved;
}
loadSessdata();

async function verifyLogin() {
  const sessdata = getSessdata();
  const stateEl = $("#login-state");
  if (!sessdata) {
    stateEl.className = "login-state err";
    stateEl.textContent = "请粘贴 SESSDATA";
    return;
  }
  stateEl.className = "login-state muted";
  stateEl.textContent = "验证中...";

  const { data } = await postJSON("/api/verify-login", { sessdata });
  if (data && data.code === 0 && data.data && data.data.isLogin) {
    localStorage.setItem("sessdata", sessdata);
    const u = data.data;
    stateEl.className = "login-state ok";
    stateEl.innerHTML = `<img referrerpolicy="no-referrer" src="${httpsify(u.face)}" alt=""> 已登录 · ${escapeHtml(
      u.uname
    )}`;
  } else {
    stateEl.className = "login-state err";
    stateEl.textContent = `登录失败: ${
      (data && data.message) || "SESSDATA 无效"
    }`;
  }
}

$("#btn-login").addEventListener("click", verifyLogin);
$("#sessdata").addEventListener("keydown", (e) => {
  if (e.key === "Enter") verifyLogin();
});

// ---------- 查询 ----------
async function queryDynamic(reset) {
  if (state.loading) return;
  const uid = $("#uid").value.trim();
  if (!uid) {
    alert("请输入 UID");
    return;
  }
  if (reset) {
    state.offset = "";
    state.hostMid = uid;
    feed.innerHTML = "";
    btnMore.hidden = true;
  }

  state.loading = true;
  statusEl.textContent = "加载中...";
  btnMore.disabled = true;

  const { data } = await postJSON("/api/space-dynamic", {
    sessdata: getSessdata(),
    host_mid: state.hostMid,
    offset: state.offset,
  });

  state.loading = false;
  btnMore.disabled = false;

  if (!data || data.code !== 0) {
    statusEl.textContent = "";
    const msg = (data && data.message) || "请求失败";
    feed.insertAdjacentHTML(
      "beforeend",
      `<div class="error">错误: ${escapeHtml(msg)} (code=${
        data && data.code
      })</div>`
    );
    return;
  }

  const items = (data.data && data.data.items) || [];
  items.forEach((it) => feed.insertAdjacentHTML("beforeend", renderItem(it)));
  loadArticleBodies();

  state.offset = (data.data && data.data.offset) || "";
  state.hasMore = !!(data.data && data.data.has_more);
  btnMore.hidden = !state.hasMore;
  statusEl.textContent = state.hasMore
    ? `已加载 ${feed.children.length} 条`
    : `已加载 ${feed.children.length} 条 · 没有更多了`;
}

$("#btn-query").addEventListener("click", () => queryDynamic(true));
$("#uid").addEventListener("keydown", (e) => {
  if (e.key === "Enter") queryDynamic(true);
});
btnMore.addEventListener("click", () => queryDynamic(false));

// ---------- 批量下载 ----------
const dl = {
  es: null,
  taskId: null,
  totalItems: 0,
  totalImages: 0,
  totalVideos: 0,
  doneItems: 0,
  doneImages: 0,
  doneVideos: 0,
  matched: 0,
  scanned: 0,
};

function dlLog(line, cls = "") {
  const el = $("#dl-log");
  const time = new Date().toLocaleTimeString();
  el.insertAdjacentHTML(
    "beforeend",
    `<span class="${cls}">[${time}] ${escapeHtml(line)}</span>\n`
  );
  el.scrollTop = el.scrollHeight;
}

function setProgress() {
  // 两阶段: 收集阶段(没有 total) 按匹配条数显示；下载阶段按 图片+条目 进度
  const stageEl = $("#dl-stage");
  const pctEl = $("#dl-percent");
  const barEl = $("#dl-bar-inner");
  const itemProg = $("#dl-item-prog");
  const imgProg = $("#dl-img-prog");

  itemProg.textContent = `条目 ${dl.doneItems} / ${dl.totalItems || dl.matched}`;
  imgProg.textContent = `图片 ${dl.doneImages} / ${dl.totalImages}`;
  const vidEl = document.getElementById("dl-vid-prog");
  if (vidEl) vidEl.textContent = `视频 ${dl.doneVideos} / ${dl.totalVideos}`;

  if (!dl.totalItems) {
    // 收集阶段
    stageEl.textContent = `收集中... 已扫描 ${dl.scanned} 条, 命中 ${dl.matched} 条`;
    pctEl.textContent = "...";
    barEl.style.width = "3%";
  } else {
    const totalUnits = dl.totalItems + dl.totalImages + dl.totalVideos;
    const doneUnits = dl.doneItems + dl.doneImages + dl.doneVideos;
    const pct = totalUnits
      ? Math.min(100, Math.round((doneUnits / totalUnits) * 100))
      : 0;
    stageEl.textContent = `下载中 (${dl.doneItems}/${dl.totalItems} 条目)`;
    pctEl.textContent = `${pct}%`;
    barEl.style.width = `${pct}%`;
  }
}

function resetDlUI() {
  dl.totalItems = 0;
  dl.totalImages = 0;
  dl.totalVideos = 0;
  dl.doneItems = 0;
  dl.doneImages = 0;
  dl.doneVideos = 0;
  dl.matched = 0;
  dl.scanned = 0;
  $("#dl-log").textContent = "";
  $("#dl-bar-inner").style.width = "0%";
  $("#dl-percent").textContent = "0%";
  $("#dl-item-prog").textContent = "条目 0 / 0";
  $("#dl-img-prog").textContent = "图片 0 / 0";
  const vidEl = document.getElementById("dl-vid-prog");
  if (vidEl) vidEl.textContent = "视频 0 / 0";
  $("#dl-output").textContent = "";
  $("#dl-stage").textContent = "准备中...";
}

function closeEventSource() {
  if (dl.es) {
    try {
      dl.es.close();
    } catch (_) {}
    dl.es = null;
  }
}

async function startDownload() {
  const uid = $("#uid").value.trim();
  if (!uid) {
    alert("请输入 UID");
    return;
  }
  const startDate = $("#start-date").value || "";
  const endDate = $("#end-date").value || "";

  resetDlUI();
  $("#dl-panel").hidden = false;
  $("#btn-download").disabled = true;
  $("#btn-cancel").hidden = false;

  dlLog(
    `开始下载任务: UID=${uid}, 范围=[${startDate || "不限"} ~ ${
      endDate || "至今"
    }]`,
    "info"
  );

  const skipImages = !!($("#dl-skip-images") && $("#dl-skip-images").checked);
  // 跳过图片时若未勾音频, 自动启用, 避免什么都不下
  let downloadAudio = !!($("#dl-audio") && $("#dl-audio").checked);
  if (skipImages && !downloadAudio) {
    downloadAudio = true;
    const cb = $("#dl-audio");
    if (cb) cb.checked = true;
  }
  const { data, ok } = await postJSON("/api/download/start", {
    sessdata: getSessdata(),
    host_mid: uid,
    start_date: startDate,
    end_date: endDate,
    download_audio: downloadAudio,
    skip_images: skipImages,
  });
  if (!ok || !data || !data.taskId) {
    dlLog(`启动失败: ${(data && data.error) || "未知"}`, "err");
    $("#btn-download").disabled = false;
    $("#btn-cancel").hidden = true;
    return;
  }
  dl.taskId = data.taskId;
  dlLog(`任务 ID: ${dl.taskId}`, "info");

  const es = new EventSource(
    `/api/download/events?taskId=${encodeURIComponent(dl.taskId)}`
  );
  dl.es = es;
  es.onmessage = (msg) => {
    let e;
    try {
      e = JSON.parse(msg.data);
    } catch (_) {
      return;
    }
    handleDownloadEvent(e);
  };
  es.onerror = () => {
    // 有可能是服务端主动 end, 不一定是错误
    closeEventSource();
    $("#btn-download").disabled = false;
    $("#btn-cancel").hidden = true;
  };
}

function handleDownloadEvent(e) {
  switch (e.type) {
    case "start":
      dl.outputDir = e.outputDir;
      $("#dl-output").textContent = `输出: ${e.outputDir}`;
      dlLog(`开始抓取, 输出目录: ${e.outputDir}`, "info");
      break;
    case "collect":
      dl.scanned = e.scanned;
      dl.matched = e.matched;
      setProgress();
      break;
    case "plan":
      dl.totalItems = e.totalItems;
      dl.totalImages = e.totalImages;
      dl.totalVideos = e.totalVideos || 0;
      setProgress();
      dlLog(
        `共命中 ${e.totalItems} 条动态, 需要下载 ${e.totalImages} 张图片` +
          (dl.totalVideos ? `, ${dl.totalVideos} 个视频音频` : ""),
        "info"
      );
      break;
    case "video":
      dl.doneVideos = e.doneVideos;
      dl.totalVideos = e.totalVideos;
      dlLog(`🎵 ${e.bvid}  ${e.title || ""}`, "ok");
      setProgress();
      break;
    case "image":
      if (e.ok) {
        dlLog(`✓ ${e.file}   ←   ${e.url}`, "ok");
      } else {
        dlLog(`✗ 失败 ${e.url} (${e.error})`, "err");
      }
      break;
    case "progress":
      dl.doneImages = e.doneImages;
      dl.totalImages = e.totalImages;
      setProgress();
      break;
    case "item":
      dl.doneItems = e.doneItems;
      dlLog(
        `[${e.date}] ${e.id}  图片 ${e.imagesOk}/${e.imagesTotal}`,
        "info"
      );
      setProgress();
      break;
    case "log":
      dlLog(e.message, e.level === "error" ? "err" : "warn");
      break;
    case "done":
      dlLog(
        `✅ 完成: ${e.doneItems} 条动态, ${e.doneImages} 张图片 → ${e.outputDir}`,
        "ok"
      );
      $("#dl-stage").textContent = "已完成";
      $("#dl-percent").textContent = "100%";
      $("#dl-bar-inner").style.width = "100%";
      $("#btn-download").disabled = false;
      $("#btn-cancel").hidden = true;
      closeEventSource();
      break;
    case "cancelled":
      dlLog(`⏹ 已取消 (已完成 ${e.doneItems} 条)`, "warn");
      $("#dl-stage").textContent = "已取消";
      $("#btn-download").disabled = false;
      $("#btn-cancel").hidden = true;
      closeEventSource();
      break;
    case "error":
      dlLog(`任务出错`, "err");
      $("#dl-stage").textContent = "出错";
      $("#btn-download").disabled = false;
      $("#btn-cancel").hidden = true;
      closeEventSource();
      break;
  }
}

$("#btn-download").addEventListener("click", startDownload);
$("#btn-cancel").addEventListener("click", async () => {
  if (!dl.taskId) return;
  await postJSON("/api/download/cancel", { taskId: dl.taskId });
  dlLog("已发送取消请求...", "warn");
});

// ---------- 渲染 ----------
// 富文本节点渲染 (参见 docs/opus/rich_text_nodes.md)
function renderRichText(desc) {
  if (!desc) return "";
  if (!Array.isArray(desc.rich_text_nodes)) {
    return escapeHtml(desc.text || "");
  }
  const ICON = {
    RICH_TEXT_NODE_TYPE_BV: "\uD83C\uDFAC", // 🎬
    RICH_TEXT_NODE_TYPE_AV: "\uD83C\uDFAC",
    RICH_TEXT_NODE_TYPE_CV: "\uD83D\uDCDD", // 📝
    RICH_TEXT_NODE_TYPE_WEB: "\uD83D\uDD17", // 🔗
    RICH_TEXT_NODE_TYPE_GOODS: "\uD83D\uDED2", // 🛒
    RICH_TEXT_NODE_TYPE_LOTTERY: "\uD83C\uDF81", // 🎁
    RICH_TEXT_NODE_TYPE_VOTE: "\uD83D\uDCCA", // 📊
    RICH_TEXT_NODE_TYPE_MAIL: "\u2709\uFE0F", // ✉️
    RICH_TEXT_NODE_TYPE_VIEW_PICTURE: "\uD83D\uDDBC\uFE0F", // 🖼️
    RICH_TEXT_NODE_TYPE_OGV_SEASON: "\uD83D\uDCFA", // 📺
    RICH_TEXT_NODE_TYPE_OGV_EP: "\uD83D\uDCFA",
    RICH_TEXT_NODE_TYPE_TAOBAO: "\uD83D\uDED2",
  };
  const linkLike = (n) => {
    const label = n.text || n.orig_text || n.jump_url || "链接";
    const icon = ICON[n.type] || "\uD83D\uDD17";
    const href = httpsify(n.jump_url || "");
    if (!href) return `<span class="link">${icon} ${escapeHtml(label)}</span>`;
    return `<a class="link" href="${href}" target="_blank" rel="noopener">${icon} ${escapeHtml(
      label
    )}</a>`;
  };
  return desc.rich_text_nodes
    .map((n) => {
      switch (n.type) {
        case "RICH_TEXT_NODE_TYPE_EMOJI":
          if (n.emoji && n.emoji.icon_url) {
            return `<img class="emoji" referrerpolicy="no-referrer" src="${httpsify(
              n.emoji.icon_url
            )}" alt="${escapeHtml(n.text)}" title="${escapeHtml(n.text)}">`;
          }
          return escapeHtml(n.text);
        case "RICH_TEXT_NODE_TYPE_AT":
          if (n.jump_url || n.rid) {
            const href = n.jump_url
              ? httpsify(n.jump_url)
              : `https://space.bilibili.com/${n.rid}`;
            return `<a class="at" href="${href}" target="_blank" rel="noopener">${escapeHtml(
              n.text || "@"
            )}</a>`;
          }
          return `<span class="at">${escapeHtml(n.text)}</span>`;
        case "RICH_TEXT_NODE_TYPE_TOPIC":
          if (n.jump_url) {
            return `<a class="topic" href="${httpsify(
              n.jump_url
            )}" target="_blank" rel="noopener">${escapeHtml(n.text)}</a>`;
          }
          return `<span class="topic">${escapeHtml(n.text)}</span>`;
        case "RICH_TEXT_NODE_TYPE_WEB":
        case "RICH_TEXT_NODE_TYPE_BV":
        case "RICH_TEXT_NODE_TYPE_AV":
        case "RICH_TEXT_NODE_TYPE_CV":
        case "RICH_TEXT_NODE_TYPE_LOTTERY":
        case "RICH_TEXT_NODE_TYPE_VOTE":
        case "RICH_TEXT_NODE_TYPE_GOODS":
        case "RICH_TEXT_NODE_TYPE_TAOBAO":
        case "RICH_TEXT_NODE_TYPE_MAIL":
        case "RICH_TEXT_NODE_TYPE_VIEW_PICTURE":
        case "RICH_TEXT_NODE_TYPE_OGV_SEASON":
        case "RICH_TEXT_NODE_TYPE_OGV_EP":
          return linkLike(n);
        case "RICH_TEXT_NODE_TYPE_TEXT":
        case "RICH_TEXT_NODE_TYPE_NONE":
        default:
          return escapeHtml(n.text || n.orig_text || "");
      }
    })
    .join("");
}

function renderMajor(major, itemId) {
  if (!major) return "";
  const t = major.type;
  if (t === "MAJOR_TYPE_ARCHIVE" && major.archive) {
    const a = major.archive;
    return `<a class="major" href="${httpsify(
      a.jump_url
    )}" target="_blank" rel="noopener">
      <div class="title">🎞 ${escapeHtml(a.title || "")}</div>
      <div class="muted">${escapeHtml(a.desc || "")}</div>
      ${
        a.cover
          ? `<img class="cover" referrerpolicy="no-referrer" src="${httpsify(a.cover)}" alt="">`
          : ""
      }
    </a>`;
  }
  if (t === "MAJOR_TYPE_OPUS" && major.opus) {
    const o = major.opus;
    const pics = (o.pics || [])
      .map(
        (p) =>
          `<img referrerpolicy="no-referrer" src="${httpsify(p.url)}" alt="" loading="lazy">`
      )
      .join("");
    return `<div class="major">
      ${o.title ? `<div class="title">${escapeHtml(o.title)}</div>` : ""}
      <div class="desc">${renderRichText(o.summary)}</div>
      ${pics ? `<div class="draw-grid">${pics}</div>` : ""}
    </div>`;
  }
  if (t === "MAJOR_TYPE_DRAW" && major.draw) {
    const pics = (major.draw.items || [])
      .map(
        (p) =>
          `<img referrerpolicy="no-referrer" src="${httpsify(p.src)}" alt="" loading="lazy">`
      )
      .join("");
    return `<div class="major"><div class="draw-grid">${pics}</div></div>`;
  }
  if (t === "MAJOR_TYPE_ARTICLE" && major.article) {
    const a = major.article;
    const cvMatch = /\/(?:read\/)?cv(\d+)/i.exec(a.jump_url || "");
    const cvid = cvMatch ? cvMatch[1] : "";
    return `<a class="major" href="${httpsify(
      a.jump_url
    )}" target="_blank" rel="noopener">
      <div class="title">📝 ${escapeHtml(a.title || "")}</div>
      <div class="muted">${escapeHtml(a.desc || "")}</div>
      ${
        (a.covers || [])[0]
          ? `<img class="cover" referrerpolicy="no-referrer" src="${httpsify(a.covers[0])}" alt="">`
          : ""
      }
      ${cvid ? `<div class="article-body" data-cv="${cvid}" data-opus-id="${itemId || ""}"><span class="muted">正在加载正文...</span></div>` : ""}
    </a>`;
  }
  if (t === "MAJOR_TYPE_LIVE_RCMD" && major.live_rcmd) {
    let content = {};
    try {
      content = JSON.parse(major.live_rcmd.content || "{}");
    } catch (_) {}
    const info =
      (content.live_play_info && content.live_play_info) ||
      (content.live_record_info && content.live_record_info) ||
      {};
    return `<div class="major">
      <div class="title">🔴 直播: ${escapeHtml(info.title || "")}</div>
      ${
        info.cover
          ? `<img class="cover" referrerpolicy="no-referrer" src="${httpsify(info.cover)}" alt="">`
          : ""
      }
    </div>`;
  }
  if (t === "MAJOR_TYPE_PGC" && major.pgc) {
    const p = major.pgc;
    return `<a class="major" href="${httpsify(
      p.jump_url
    )}" target="_blank" rel="noopener">
      <div class="title">📺 ${escapeHtml(p.title || "")}</div>
      ${
        p.cover
          ? `<img class="cover" referrerpolicy="no-referrer" src="${httpsify(p.cover)}" alt="">`
          : ""
      }
    </a>`;
  }
  if (t === "MAJOR_TYPE_UPOWER_COMMON" && major.upower_common) {
    const u = major.upower_common;
    return `<div class="major upower">
      <div class="title">⚡ ${escapeHtml(u.title || "充电专属")}</div>
      <div class="muted">${escapeHtml(u.title_prefix || "")}</div>
    </div>`;
  }
  if (t === "MAJOR_TYPE_NONE" && major.none) {
    return `<div class="major muted">⚠ ${escapeHtml(
      major.none.tips || "动态已失效"
    )}</div>`;
  }
  if (t === "MAJOR_TYPE_BLOCKED" && major.blocked) {
    const b = major.blocked;
    const hint =
      b.hint_message ||
      (b.bg_img && (b.bg_img.text || b.bg_img.hint_message)) ||
      (b.button &&
        ((b.button.uncheck && b.button.uncheck.text) ||
          (b.button.check && b.button.check.text))) ||
      "内容受限";
    return `<div class="major muted">🔒 受限动态: ${escapeHtml(hint)}</div>`;
  }
  // fallback
  return `<div class="major muted">[未处理类型: ${escapeHtml(t || "")}]</div>`;
}

// 渲染 opus paragraphs (新版专栏正文)
function renderOpusParagraphsToHtml(content) {
  if (!content || !Array.isArray(content.paragraphs)) return "";
  const out = [];
  for (const p of content.paragraphs) {
    const type = p.para_type;
    // 标题/正文段落
    if ((type === 1 || type === 6) && p.text?.nodes) {
      const text = p.text.nodes
        .map((n) => {
          if (n.type === "TEXT_NODE_TYPE_WORD" && n.word?.words) {
            return escapeHtml(n.word.words);
          }
          if (n.type === "TEXT_NODE_TYPE_RICH" && n.rich?.text) {
            return escapeHtml(n.rich.text);
          }
          return "";
        })
        .join("");
      if (text) out.push(`<p>${text}</p>`);
    }
    // 图片段落
    if (type === 2 && p.pic?.pics) {
      for (const pic of p.pic.pics) {
        if (pic.url) {
          out.push(
            `<img referrerpolicy="no-referrer" src="${httpsify(pic.url)}" alt="" loading="lazy" style="max-width:100%;border-radius:4px;margin:4px 0;">`
          );
        }
      }
    }
    // 引用段落
    if (type === 4 && p.text?.nodes) {
      const text = p.text.nodes
        .map((n) => {
          if (n.type === "TEXT_NODE_TYPE_WORD" && n.word?.words)
            return escapeHtml(n.word.words);
          return "";
        })
        .join("");
      if (text) out.push(`<blockquote style="border-left:3px solid #ccc;padding-left:8px;color:#666;">${text}</blockquote>`);
    }
    // 代码段落
    if (type === 7 && p.code?.content) {
      out.push(
        `<pre style="background:#f5f5f5;padding:8px;border-radius:4px;overflow:auto;"><code>${escapeHtml(p.code.content)}</code></pre>`
      );
    }
    // 列表段落
    if (type === 5 && p.list?.items) {
      const lis = p.list.items
        .map((item) => {
          const text = item.nodes
            ?.map((n) => {
              if (n.type === "TEXT_NODE_TYPE_WORD" && n.word?.words)
                return escapeHtml(n.word.words);
              return "";
            })
            .join("") || "";
          return `<li>${text}</li>`;
        })
        .join("");
      if (lis) out.push(`<ul>${lis}</ul>`);
    }
  }
  return out.join("");
}

async function loadArticleBodies() {
  const targets = document.querySelectorAll(".article-body[data-cv]");
  console.log("[article loader] found", targets.length, "article(s) to load");
  for (const el of targets) {
    const cvid = el.dataset.cv;
    const opusId = el.dataset.opusId;
    console.log("[article loader] cvid=", cvid, "opusId=", opusId, "loaded=", el.dataset.loaded);
    if (!cvid || el.dataset.loaded) continue;
    el.dataset.loaded = "1";
    try {
      // 策略: 优先 opus/detail (新版专栏), 回退 article/view (老版专栏)
      let rendered = false;

      if (opusId) {
        console.log("[article loader] calling /api/opus-detail id=", opusId);
        const { data: opusData } = await postJSON("/api/opus-detail", {
          sessdata: getSessdata(),
          id: opusId,
        });
        console.log("[article loader] opus/detail response code=", opusData?.code);
        if (opusData?.code === 0 && opusData.data?.item?.modules) {
          const modules = opusData.data.item.modules;
          const contentMod = modules.find(
            (m) => m.module_type === "MODULE_TYPE_CONTENT"
          );
          const paragraphs = contentMod?.module_content?.paragraphs;
          console.log("[article loader] paragraphs count=", paragraphs?.length);
          if (Array.isArray(paragraphs) && paragraphs.length > 0) {
            el.innerHTML = renderOpusParagraphsToHtml({ paragraphs });
            rendered = true;
            console.log("[article loader] rendered from opus/detail");
          }
        }
      }

      if (!rendered) {
        const { data } = await postJSON("/api/article-view", {
          sessdata: getSessdata(),
          cvid,
        });
        if (data && data.code === 0 && data.data) {
          const articleView = data.data;
          // 新版专栏: opus.paragraphs
          const opusParagraphs = articleView.opus?.content?.paragraphs;
          if (Array.isArray(opusParagraphs) && opusParagraphs.length > 0) {
            el.innerHTML = renderOpusParagraphsToHtml(articleView.opus.content);
          } else if (articleView.content) {
            // 老版专栏: HTML → 简单文本
            let html = articleView.content
              .replace(/<br\s*\/?>/gi, "\n")
              .replace(/<\/p>/gi, "\n")
              .replace(/<[^>]+>/g, "");
            el.innerHTML = `<div class="article-text" style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(
              html
            )}</div>`;
          } else {
            el.innerHTML = `<span class="muted">暂无正文</span>`;
          }
        } else {
          el.innerHTML = `<span class="muted">正文加载失败: ${escapeHtml(
            (data && data.message) || ""
          )}</span>`;
        }
      }
    } catch (e) {
      console.error("[article loader] error:", e);
      el.innerHTML = `<span class="muted">正文加载异常: ${escapeHtml(String(e.message || e))}</span>`;
    }
  }
}

function renderAdditional(add) {
  if (!add) return "";
  if (add.type === "ADDITIONAL_TYPE_UPOWER_LOTTERY" && add.upower_lottery) {
    const u = add.upower_lottery;
    return `<div class="major upower">
      <div class="title">🎁 充电专属抽奖 · ${escapeHtml(u.title || "")}</div>
      <div class="muted">${escapeHtml(
        (u.hint && u.hint.text) || (u.desc && u.desc.text) || ""
      )}</div>
    </div>`;
  }
  if (add.type === "ADDITIONAL_TYPE_UGC" && add.ugc) {
    return `<a class="major" href="${httpsify(
      add.ugc.jump_url
    )}" target="_blank" rel="noopener">
      <div class="title">🎞 相关视频: ${escapeHtml(add.ugc.title || "")}</div>
      ${
        add.ugc.cover
          ? `<img class="cover" referrerpolicy="no-referrer" src="${httpsify(add.ugc.cover)}" alt="">`
          : ""
      }
    </a>`;
  }
  if (add.type === "ADDITIONAL_TYPE_RESERVE" && add.reserve) {
    return `<div class="major">
      <div class="title">📅 预约: ${escapeHtml(add.reserve.title || "")}</div>
      <div class="muted">${escapeHtml(
        (add.reserve.desc1 && add.reserve.desc1.text) || ""
      )}</div>
    </div>`;
  }
  return "";
}

function detectUpower(item) {
  const md = item.modules && item.modules.module_dynamic;
  if (!md) return false;
  if (md.major && md.major.type === "MAJOR_TYPE_UPOWER_COMMON") return true;
  if (
    md.additional &&
    md.additional.type === "ADDITIONAL_TYPE_UPOWER_LOTTERY"
  )
    return true;
  const text = (md.desc && md.desc.text) || "";
  if (/\[UPOWER_\d+_/.test(text)) return true;
  return false;
}

function renderAuthor(author) {
  if (!author) return "";
  return `<div class="card-head">
    <img class="avatar" referrerpolicy="no-referrer" src="${httpsify(author.face)}" alt="">
    <div class="meta">
      <div class="name"><a href="https://space.bilibili.com/${
        author.mid
      }" target="_blank" rel="noopener">${escapeHtml(author.name || "")}</a></div>
      <div class="sub">${escapeHtml(author.pub_time || "")}${
    author.pub_ts ? " · " + fmtTs(author.pub_ts) : ""
  }</div>
    </div>
    <div class="badges" data-placeholder></div>
  </div>`;
}

function renderItem(item) {
  const md = (item.modules && item.modules.module_dynamic) || {};
  const author = (item.modules && item.modules.module_author) || {};
  const stat = (item.modules && item.modules.module_stat) || {};
  const isForward = item.type === "DYNAMIC_TYPE_FORWARD";
  const isPinned =
    item.modules &&
    item.modules.module_tag &&
    item.modules.module_tag.text === "置顶";
  const isUpower = detectUpower(item);

  const badges = [];
  if (isPinned) badges.push('<span class="badge pinned">置顶</span>');
  if (isUpower) badges.push('<span class="badge upower">充电专属</span>');
  if (isForward) badges.push('<span class="badge forward">转发</span>');
  badges.push(`<span class="badge">${escapeHtml(item.type || "")}</span>`);

  const descHtml = md.desc
    ? `<div class="desc">${renderRichText(md.desc)}</div>`
    : "";
  const majorHtml = renderMajor(md.major, item.id_str);
  const addHtml = renderAdditional(md.additional);

  let origHtml = "";
  if (isForward && item.orig) {
    const orig = item.orig;
    const oAuthor = (orig.modules && orig.modules.module_author) || {};
    const oMd = (orig.modules && orig.modules.module_dynamic) || {};
    origHtml = `<div class="orig">
      <div class="muted">@${escapeHtml(oAuthor.name || "")}</div>
      ${oMd.desc ? `<div class="desc">${renderRichText(oMd.desc)}</div>` : ""}
      ${renderMajor(oMd.major)}
    </div>`;
  }

  const statsHtml = `<div class="stats">
    <span>👍 ${escapeHtml((stat.like && stat.like.count) ?? 0)}</span>
    <span>💬 ${escapeHtml((stat.comment && stat.comment.count) ?? 0)}</span>
    <span>🔁 ${escapeHtml((stat.forward && stat.forward.count) ?? 0)}</span>
    <a href="https://www.bilibili.com/opus/${
      item.id_str
    }" target="_blank" rel="noopener">打开原动态</a>
  </div>`;

  const rawHtml = $("#raw-toggle").checked
    ? `<pre class="raw">${escapeHtml(JSON.stringify(item, null, 2))}</pre>`
    : "";

  const head = renderAuthor(author).replace(
    '<div class="badges" data-placeholder></div>',
    `<div class="badges">${badges.join("")}</div>`
  );

  return `<article class="card">
    ${head}
    ${descHtml}
    ${majorHtml}
    ${addHtml}
    ${origHtml}
    ${statsHtml}
    ${rawHtml}
  </article>`;
}
