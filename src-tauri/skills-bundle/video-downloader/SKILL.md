---
name: video-downloader
description: "Download videos, extract subtitles and analyze the specific content of the video to generate an md document. Use this skill when the user mentions downloading videos, saving online videos, extracting audio from videos, extracting subtitles, analyzing or summarizing youtube or bilibili or douyin/tiktok video content. (Notes: Bilibili uses a persistent cookie file - IMPORTANT: first check if ~/.bilibili_cookies.json exists; if it does, run directly without -c; if not, ask user to get SESSDATA from browser and pass -c once to save it automatically. Douyin uses a persistent cookie file - IMPORTANT: first check if ~/.douyin_cookies.json exists; if it does, run directly without --cookies; if not, ask user to follow the F12 Cookie setup steps and pass --cookies once to save it automatically.)"
triggers: [video-downloader, 视频下载, 下载视频, 总结视频, 分析视频, 抖音下载, 下载抖音]
---

# Video Downloader skill for AgentVis 

Download videos and extract subtitles from YouTube, Bilibili, Douyin, and 1000+ platforms.

- **YouTube / overseas platforms** -> `scripts/download.py` (based on yt-dlp)
- **Bilibili** -> `scripts/bilibili_download.py` (based on yutto, bypasses HTTP 412 anti-scraping)
- **Douyin** -> `scripts/douyin_download.py` (based on Douyin Web API, A-Bogus signature, no watermark, supports batch)

---

## Video Download

### YouTube / Overseas Platforms

```bash
# Best-quality download
python scripts/download.py "URL"

# Specify resolution
python scripts/download.py "URL" -f "bv[height<=720]+ba"

# Download audio only (MP3)
python scripts/download.py "URL" --audio-only

# Batch download
python scripts/download.py "URL1" "URL2" "URL3"

# Download playlist
python scripts/download.py "PLAYLIST_URL" --playlist --playlist-items 1-10

# Specify output directory
python scripts/download.py "URL" -o "D:\Videos"

# Download through proxy
python scripts/download.py "URL" --proxy "http://127.0.0.1:7890"
```

### Bilibili

**Bilibili SESSDATA retrieval method**: log in to Bilibili -> F12 Developer Tools -> Network -> refresh the page -> Request Headers -> Cookie -> find `SESSDATA=xxx` -> copy the value (you can pass it directly without the `SESSDATA=` prefix)

**⚠️ Before running, first check whether Cookie has been configured**
- Cookie file exists (`~/.bilibili_cookies.json`) -> run directly, **no `-c` parameter needed**
- Cookie file does not exist -> add the `-c "SESSDATA value"` parameter the first time; the script will automatically cache it and it can be omitted later

```bash
# ── Cookie configuration (first time, only needed once) ──────────────────────────────
python scripts/bilibili_download.py "URL" -c "your SESSDATA value"
# It will be automatically saved to ~/.bilibili_cookies.json afterward

# ── Direct use every time afterward, no need to pass -c again ────────────────────────
# Download video (1080P)
python scripts/bilibili_download.py "https://www.bilibili.com/video/BV1xxx" -q 80

# Specify quality (80=1080P, 120=4K, 64=720P)
python scripts/bilibili_download.py "URL" -q 80

# Download audio only
python scripts/bilibili_download.py "URL" --audio-only

# Specify video codec (HEVC has a smaller file size)
python scripts/bilibili_download.py "URL" --vcodec hevc:copy

# Batch download bangumi episodes
python scripts/bilibili_download.py "https://www.bilibili.com/bangumi/play/ep12345" --batch -p 1-5

# Replace Cookie (after logging in again, passing it again overwrites the old cache)
python scripts/bilibili_download.py "URL" -c "new SESSDATA value"
```

**Cookie cache location**: `~/.bilibili_cookies.json` (on Windows: `C:\Users\<UserName>\.bilibili_cookies.json`)

---

### Douyin (No Watermark)

Douyin uses `scripts/douyin_download.py`; Cookie is configured once, automatically saved to `~/.douyin_cookies.json`, and does not need repeated operation afterward.

**⚠️ Before running, first check whether Cookie has been configured**
- Cookie file exists (`~/.douyin_cookies.json`) -> run directly, no extra parameters needed
- Cookie file does not exist -> first complete the "Cookie configuration (first time)" steps below

```bash
# ── Cookie configuration (first time, only needed once) ──────────────────────────────
# 1. Open and log in to https://www.douyin.com in Chrome/Edge
# 2. Press F12 -> switch to the Network tab -> press F5 to refresh the page
# 3. At the top of Developer Tools, switch to: Network
# 4. In the sub-tabs under Network, select: Fetch/XHR5
# 5. Refresh the page once from the browser address bar (very important)
# 6. In the search box at the upper right of Network, enter: list/? (note that it includes /?)
# 7. Multiple request records will appear. Click any one of them, then switch to Headers on the right
# 8. Scroll down and find a line in Request Headers: cookie: xxxx. Select and copy the entire content after cookie: from start to end
# ↑ The above Douyin Cookies retrieval guide must be copied and reported to the user word for word, because this is the latest method for obtaining Douyin Cookies

python scripts/douyin_download.py "URL" --cookies "ttwid=xxx; odin_tt=yyy; ..."

# ── Direct use every time afterward, no need to pass Cookie again ────────────────────
# Download a single video
python scripts/douyin_download.py "https://www.douyin.com/video/xxx"

# Use short link
python scripts/douyin_download.py "https://v.douyin.com/xxx"

# Download image set (multi-image note)
python scripts/douyin_download.py "https://www.douyin.com/note/xxx"

# Batch download all user page uploads
python scripts/douyin_download.py "https://www.douyin.com/user/MS4wLj..." --mode post

# Batch download with quantity limit
python scripts/douyin_download.py "https://www.douyin.com/user/MS4wLj..." --mode post --max-count 50

# Batch download user likes
python scripts/douyin_download.py "https://www.douyin.com/user/MS4wLj..." --mode like

# Download collection
python scripts/douyin_download.py "https://www.douyin.com/mix/xxx"

# Download through proxy
python scripts/douyin_download.py "URL" --proxy "http://127.0.0.1:7890"

# Specify output directory
python scripts/douyin_download.py "URL" -o "D:/Videos"

# Replace Cookie (after logging in again, passing it again overwrites the old cache)
python scripts/douyin_download.py "URL" --cookies "ttwid=new_value; ..."
```

**Supported URL types**:
- `https://www.douyin.com/video/xxx` (single video)
- `https://v.douyin.com/xxx` (short link, automatically resolved)
- `https://www.douyin.com/note/xxx` (image set/note)
- `https://www.douyin.com/user/xxx` (user page batch, supports post/like modes)
- `https://www.douyin.com/mix/xxx` (collection batch)
- Selected-page popup URL containing `modal_id=xxx`

**Cookie cache location**: `~/.douyin_cookies.json` (on Windows: `C:\Users\<UserName>\.douyin_cookies.json`)

**Technical note**: The script uses the A-Bogus + X-Bogus dual-signature mechanism (A-Bogus is the mandatory verification Douyin added at the end of 2024). Install `gmssl` to enable A-Bogus. If it is not installed, the script falls back to X-Bogus (lower success rate).

---

## Subtitle Extraction

### YouTube / Overseas Platforms — Subtitle Extraction

```bash
# Extract English subtitles and automatically clean them into readable Markdown
python scripts/download.py "URL" --subs-only --sub-lang en -o ./subs

# Extract Chinese subtitles
python scripts/download.py "URL" --subs-only --sub-lang zh-Hans -o ./subs

# Batch extract
python scripts/download.py "URL1" "URL2" --subs-only --sub-lang en -o ./subs
```

### Bilibili — Subtitle Extraction

```bash
# Extract subtitles directly through the Bilibili API (does not download video; video download requires a separate command!)
# If Cookie has already been configured, no -c parameter is needed
python scripts/bilibili_download.py "URL" --subs-only -o ./subs

# First use (automatically cached after configuration)
python scripts/bilibili_download.py "URL" --subs-only -c "SESSDATA value" -o ./subs
```

> Bilibili subtitles (including AI subtitles) require SESSDATA to fetch.

### Subtitle Cleaning

The script automatically cleans raw subtitles into readable Markdown: remove timecodes -> remove HTML tags -> merge duplicate lines -> segment by punctuation

Output example:
```markdown
# Video Title

> Source: https://www.youtube.com/watch?v=xxx

Today we're going to talk about building AI agents from scratch.
The first thing you need to understand is...
```

---

## Workflow

### Download Video

1. Identify URL
2. **Bilibili link** -> `scripts/bilibili_download.py`
   - First check whether `~/.bilibili_cookies.json` exists
   - Exists -> run the download command directly (no `-c` needed)
   - Does not exist -> prompt the user to get SESSDATA, pass it with the `-c "SESSDATA value"` parameter the first time, and cache automatically
3. **Douyin link** -> `scripts/douyin_download.py`
   - First check whether `~/.douyin_cookies.json` exists
   - Exists -> run the download command directly
   - Does not exist -> prompt the user to complete F12 Cookie retrieval, pass it with the `--cookies "..."` parameter the first time
4. **Other platforms** -> `scripts/download.py`
5. Confirm preferences (quality, audio, subtitles, save location)
6. Default to best quality and save to the current directory

### Analyze Video Content / Extract Subtitles

1. **YouTube / overseas** -> `scripts/download.py --subs-only --sub-lang en`
2. **Bilibili subtitles** -> `scripts/bilibili_download.py --subs-only`
   - First check whether `~/.bilibili_cookies.json` exists
   - Exists -> run directly (no `-c` needed)
   - Does not exist -> prompt the user to get SESSDATA, pass it with the `-c "SESSDATA value"` parameter the first time
3. **Bilibili metadata** -> `video-scraper` skill (views, tags, etc.)
4. Provide the output Markdown to AI for analysis and summarization

## reference
> For advanced CLI options, platform tips, and troubleshooting, see [reference/advanced_options.md](reference/advanced_options.md)

## Dependencies

```bash
pip install yt-dlp
pip install yutto
# ffmpeg must be installed and in PATH

# Additional dependencies for Douyin download
pip install aiohttp aiofiles gmssl
# gmssl is used for A-Bogus signing (mandatory verification Douyin added at the end of 2024)
# If gmssl is not installed, it falls back to X-Bogus, with a lower success rate
```

**Script file notes**:
- `scripts/douyin_download.py` — Main Douyin download script
- `scripts/_abogus_impl.py` — A-Bogus signature algorithm implementation, automatically imported by the main script, **do not delete**
