# space-dynamic-viewer 部署教程

> 仅用于本地或可信服务器。不要公开部署 Web 页面，不要提交 `.env`、Cookie、SESSDATA、PushPlus token、ASR API key。

## 1. 环境要求

- Node.js 18 或更高版本
- npm
- 可选: `ffmpeg`，用于音频降采样、分片和视频音频转写
- 可选: `tesseract` + `chi_sim` 语言包，默认图片 OCR 会用到

Windows 安装 `ffmpeg` 示例:

```powershell
winget install Gyan.FFmpeg
```

Debian / Ubuntu 安装可选依赖:

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg tesseract-ocr tesseract-ocr-chi-sim
```

## 2. 本地部署

进入项目目录并安装依赖:

```bash
npm install
```

复制环境变量模板:

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，至少填写下面几项:

```bash
BILI_HOST_MIDS=目标UP主UID
BILI_COOKIE=从浏览器复制的整段 B 站 Cookie
PUSHPLUS_TOKEN=你的 PushPlus token
```

如果暂时没有整段 Cookie，也可以只填:

```bash
BILI_SESSDATA=你的 SESSDATA
```

优先推荐 `BILI_COOKIE`。遇到 B 站风控、充电专属动态、登录态刷新时，整段 Cookie 更稳定。

启动本地 Web 页面:

```bash
npm start
```

打开:

```text
http://localhost:5173
```

启动增量轮询服务:

```bash
npm run service
```

## 3. .env 配置说明

### 必填

```bash
BILI_HOST_MIDS=
```

要监控的 UP 主 UID。多个 UID 用英文逗号分隔:

```bash
BILI_HOST_MIDS=1420210197,123456
```

下面两项至少填一项:

```bash
BILI_COOKIE=
BILI_SESSDATA=
```

`BILI_COOKIE` 是从浏览器开发者工具 Network 请求里复制的整段 Cookie。`BILI_SESSDATA` 是 Cookie 里的单个 `SESSDATA` 值。

推送通知推荐填写:

```bash
PUSHPLUS_TOKEN=
```

不填时服务仍会下载动态，但不会发送 PushPlus 通知。

### 常用服务配置

```bash
SERVICE_INTERVAL_SECONDS=60
SERVICE_MAX_PAGES_PER_POLL=3
SERVICE_INITIAL_SINCE=now
SERVICE_BAN_BACKOFF_MINUTES=30
DOWNLOAD_ROOT=./downloads
```

`SERVICE_INITIAL_SINCE` 可选值:

- `now`: 首次启动只监控启动之后的新动态
- `today`: 首次启动从当天 00:00 开始
- `all`: 尽量从接口可翻到的范围开始回扫

`SERVICE_BAN_BACKOFF_MINUTES` 用于 B 站风控暂停。`code=-352 verification failed` 和 `code=-412 request was banned` 都按风控处理。

### 登录刷新和扫码恢复

```bash
BILI_AUTH_FILE=
BILI_QR_TIMEOUT_MS=180000
BILI_QR_RETRY_DELAY_MS=60000
LOGIN_CHECK_DYNAMIC_ID=
```

`BILI_AUTH_FILE` 默认在 `DOWNLOAD_ROOT` 下保存刷新后的登录态。登录态过期时，服务会先尝试自动刷新 Cookie；刷新失败时，会通过 PushPlus 或 webhook 推送扫码登录二维码。

`LOGIN_CHECK_DYNAMIC_ID` 可填一条充电专属动态 ID，用来检查当前登录账号是否仍能看到受限内容。留空时回退到 B 站 nav 接口检查。

### PushPlus

```bash
PUSHPLUS_URL=https://www.pushplus.plus/send/
PUSHPLUS_TITLE=Bilibili dynamic update
PUSHPLUS_TEMPLATE=html
PUSHPLUS_TOPIC=
PUSHPLUS_MAX_CONTENT_CHARS=20000
```

`PUSHPLUS_TITLE` 只是兜底标题。正常情况下，推送标题会优先使用动态标题或视频标题。

### Webhook

```bash
WEBHOOK_URL=
WEBHOOK_HEADERS_JSON={}
WEBHOOK_TIMEOUT_MS=15000
```

示例:

```bash
WEBHOOK_URL=https://example.com/webhook
WEBHOOK_HEADERS_JSON={"Authorization":"Bearer your-token"}
```

不要把真实 token 写进仓库，只写在本机 `.env` 或服务器环境文件。

### 图片 OCR

默认使用本地 `tesseract`:

```bash
SERVICE_IMAGE_OCR=1
IMAGE_OCR_PROVIDER=tesseract
OCR_LANG=chi_sim+eng
```

使用自定义 OCR 命令:

```bash
IMAGE_OCR_CMD=tesseract "{input}" stdout -l chi_sim+eng
```

使用阿里云百炼 Qwen VL:

```bash
IMAGE_OCR_PROVIDER=qwen-vl
IMAGE_OCR_MODEL=qwen3-vl-flash
DASHSCOPE_API_KEY=你的百炼 API Key
```

如需国际站或自定义接入点:

```bash
DASHSCOPE_VL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

### 音频转写 ASR

自动优先级:

1. `DASHSCOPE_API_KEY`: Qwen3-ASR-Flash-Filetrans
2. `GROQ_API_KEY`: Groq whisper-large-v3-turbo
3. `WHISPER_CMD`: 本地 whisper 命令

配置 Qwen ASR:

```bash
DASHSCOPE_API_KEY=
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

配置 Groq ASR:

```bash
GROQ_API_KEY=
```

配置本地 whisper:

```bash
WHISPER_CMD=whisper "{input}" --model small --language zh --output_format txt --output_dir "{outdir}"
```

单独批量转写已下载音频:

```bash
npm run transcribe
```

指定目录和 provider:

```bash
node transcribe.js --dir downloads/1420210197 --provider qwen --concurrency 2
```

## 4. Linux systemd 部署

以下示例把项目部署到 `/opt/space-dynamic-viewer`，环境文件放到 `/etc/space-dynamic-viewer.env`。

创建运行用户:

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin space-dynamic
```

创建部署目录:

```bash
sudo mkdir -p /opt/space-dynamic-viewer
```

复制项目文件。请在项目父目录执行，并按实际目录名调整源路径:

```bash
sudo rsync -a --delete \
  --exclude '.git' \
  --exclude '.beads' \
  --exclude '.env' \
  --exclude 'downloads' \
  --exclude 'node_modules' \
  ./ /opt/space-dynamic-viewer/
```

安装生产依赖:

```bash
cd /opt/space-dynamic-viewer
sudo npm ci --omit=dev
```

创建环境文件:

```bash
sudo cp /opt/space-dynamic-viewer/.env.example /etc/space-dynamic-viewer.env
sudo nano /etc/space-dynamic-viewer.env
```

设置权限:

```bash
sudo chown -R space-dynamic:space-dynamic /opt/space-dynamic-viewer
sudo chmod 600 /etc/space-dynamic-viewer.env
```

安装 systemd 服务:

```bash
sudo cp /opt/space-dynamic-viewer/systemd/space-dynamic-ingest.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now space-dynamic-ingest.service
```

查看状态:

```bash
sudo systemctl status space-dynamic-ingest.service
```

查看实时日志:

```bash
sudo journalctl -u space-dynamic-ingest.service -f
```

重启服务:

```bash
sudo systemctl restart space-dynamic-ingest.service
```

停止服务:

```bash
sudo systemctl stop space-dynamic-ingest.service
```

## 5. 更新部署

在项目目录拉取或复制新代码后:

```bash
cd /opt/space-dynamic-viewer
sudo npm ci --omit=dev
sudo chown -R space-dynamic:space-dynamic /opt/space-dynamic-viewer
sudo systemctl restart space-dynamic-ingest.service
sudo journalctl -u space-dynamic-ingest.service -n 100 --no-pager
```

如果 `.env.example` 新增了变量，手动合并到:

```bash
/etc/space-dynamic-viewer.env
```

不要直接覆盖已有环境文件，避免丢失 Cookie 和 API key。

## 6. 部署验证

本地语法检查:

```bash
Get-ChildItem -Filter *.js | ForEach-Object { node --check $_.FullName }
Get-ChildItem public -Filter *.js | ForEach-Object { node --check $_.FullName }
```

Linux:

```bash
find . -maxdepth 1 -name '*.js' -print0 | xargs -0 -n1 node --check
find public -maxdepth 1 -name '*.js' -print0 | xargs -0 -n1 node --check
```

检查服务配置能否被加载:

```bash
node -e "const { loadEnvFile, parseConfig } = require('./service'); loadEnvFile(); console.log(parseConfig())"
```

如果配置正确，应能看到 `hostMids`、`downloadRoot`、`intervalMs` 等字段；不要把输出里的 Cookie 或 token 发给别人。

## 7. 常见问题

### 提示 `BILI_SESSDATA/SESSDATA or BILI_COOKIE is required`

环境文件没有被加载，或没有填写 `BILI_COOKIE` / `BILI_SESSDATA`。

本地默认读取:

```text
.env
```

systemd 默认读取:

```text
/etc/space-dynamic-viewer.env
```

也可以显式指定:

```bash
SERVICE_ENV_FILE=/etc/space-dynamic-viewer.env npm run service
```

### 提示 `BILI_HOST_MIDS or BILI_HOST_MID is required`

填写:

```bash
BILI_HOST_MIDS=目标UP主UID
```

### 触发 `code=-352` 或 `code=-412`

这是 B 站风控。建议:

- 暂停服务一段时间
- 在浏览器打开 `https://space.bilibili.com/<UID>/dynamic`
- 从同域请求复制整段 Cookie 到 `BILI_COOKIE`
- 适当调大 `SERVICE_INTERVAL_SECONDS` 和 `SERVICE_BAN_BACKOFF_MINUTES`

### 没有收到 PushPlus

检查:

```bash
PUSHPLUS_TOKEN=
PUSHPLUS_URL=https://www.pushplus.plus/send/
```

然后查看服务日志:

```bash
sudo journalctl -u space-dynamic-ingest.service -n 100 --no-pager
```

### 没有生成转写文本

至少配置一种 ASR:

```bash
DASHSCOPE_API_KEY=
GROQ_API_KEY=
WHISPER_CMD=
```

如果使用云 ASR，需要服务器能访问对应 API。如果使用本地 whisper，需要确认命令可在服务用户下执行。
