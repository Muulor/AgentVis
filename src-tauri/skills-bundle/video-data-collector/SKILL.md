---
name: video-data-collector
description: "Collect video data from Bilibili, YouTube, and Douyin/TikTok. Use this skill when the user wants to collect video statistics, channel/creator data, or gather material for self-media creation. Supports extracting views, likes, comments, tags, and descriptions from individual videos, batch videos, or entire channels/user pages. (Notes: YouTube uses a persistent API key file - IMPORTANT: first check if ~/.youtube_config.json exists; if it does, run directly without --api-key; if not, ask user to get an API Key from Google Cloud Console and pass --api-key once to save it automatically. Bilibili Cookie is cached at ~/.bilibili_cookies.json - same rule applies. Douyin Cookie is cached at ~/.douyin_cookies.json - same rule applies.)"
triggers: [video-data-collector, B站数据, bilibili数据, YouTube数据, 油管数据, 抖音数据, douyin数据, 抖音采集, 抖音统计]
---

# Video-Data-Collector skill for AgentVis — Video Platform Data Collection Skill

Fetch video details, channel/user page upload lists, and search results from **Bilibili**, **YouTube**, and **Douyin**. Output Markdown or JSON, suitable for self-media material collection, competitor analysis, and data reports.

## Supported Platforms

| Platform | Script | Authentication | Features |
|------|------|------|------|
| Bilibili | `scripts/bilibili.py` | Not required | Single video / batch videos / all creator uploads |
| YouTube | `scripts/youtube.py` | API Key | Single video / channel videos / keyword search |
| Douyin | `scripts/douyin.py` | Cookie (recommended) | Single video / batch videos / user page / collection |

---

## Bilibili — Quick Usage

```bash
# Single video (BV ID or full URL are both supported)
python scripts/bilibili.py video BV1fecTzKEne -o ./output
python scripts/bilibili.py video "https://www.bilibili.com/video/BV1fecTzKEne/" -o ./output

# Fetch multiple videos together
python scripts/bilibili.py video BV1xxx BV2xxx BV3xxx -o ./output

# All uploads from a creator
python scripts/bilibili.py up 12345678 -o ./output
python scripts/bilibili.py up "https://space.bilibili.com/12345678" -o ./output

# Creator uploads (limit 20 items)
python scripts/bilibili.py up 12345678 --limit 20 -o ./output

# Output JSON
python scripts/bilibili.py video BV1fecTzKEne -f json -o ./output

# Output both Markdown and JSON
python scripts/bilibili.py up 12345678 -f both -o ./output
```

### Bilibili Parameters

| Parameter | Short | Description | Default |
|------|------|------|--------|
| `video <targets...>` | — | Fetch by BV ID/URL (supports multiple) | — |
| `up <target>` | — | Fetch uploads by creator MID/URL | — |
| `--cookie` | | Bilibili login Cookie, supports three formats: plain SESSDATA value, `SESSDATA=xxx`, `{"SESSDATA":"xxx"}` JSON — automatically cached to `~/.bilibili_cookies.json` after first input, can be omitted later | Cache file |
| `--output-dir` | `-o` | Output directory | `./bilibili_output` |
| `--format` | `-f` | Output format `md` / `json` / `both` | `md` |
| `--limit` | `-l` | Maximum fetch count in creator mode | All |
| `--no-tags` | — | Do not fetch tags (reduce requests) | `false` |

### Bilibili Output Fields

Title, BV ID, link, creator, publish time, duration, category, views, likes, coins, favorites, shares, danmaku, comments, description, tags

---

## YouTube — Quick Usage

**⚠️ Before running, first check whether the API Key has been configured**
- Configuration file exists (`~/.youtube_config.json`) -> run directly, **no `--api-key` parameter needed**
- Configuration file does not exist -> first run with `--api-key YOUR_KEY`, it will be cached automatically and can be omitted later

```bash
# ── API Key configuration (first time, only needed once) ─────────────────────────────
python scripts/youtube.py --api-key YOUR_KEY video dQw4w9WgXcQ
# It will be automatically saved to ~/.youtube_config.json afterward

# ── Direct use every time afterward, no need to pass --api-key again ─────────────────
# Single video
python scripts/youtube.py video dQw4w9WgXcQ -o ./output
python scripts/youtube.py video "https://www.youtube.com/watch?v=xxx"

# Multiple videos
python scripts/youtube.py video ID1 ID2 ID3 -o ./output

# All videos from a channel (supports UCxxxx / @handle / URL)
python scripts/youtube.py channel UCxxxx --limit 30
python scripts/youtube.py channel "@channelHandle"

# Search
python scripts/youtube.py search "Python tutorial" --max-results 10

# Output JSON
python scripts/youtube.py video dQw4w9WgXcQ -f json

# Replace API Key (passing it again overwrites the old cache)
python scripts/youtube.py --api-key NEW_KEY video dQw4w9WgXcQ
```

**API Key cache location**: `~/.youtube_config.json` (on Windows: `C:\Users\<UserName>\.youtube_config.json`)

**API Key application**: https://console.cloud.google.com/apis/credentials (free, daily quota of 10,000 units)

### YouTube Parameters

| Parameter | Short | Description | Default |
|------|------|------|--------|
| `video <targets...>` | — | Fetch by video ID/URL | — |
| `channel <target>` | — | Channel ID / @handle / URL | — |
| `search <query>` | — | Search keyword | — |
| `--api-key` | `-k` | YouTube API Key, automatically cached to `~/.youtube_config.json` after first input, can be omitted later | Cache file |
| `--output-dir` | `-o` | Output directory | `./youtube_output` |
| `--format` | `-f` | Output format `md` / `json` / `both` | `md` |
| `--limit` | `-l` | Maximum videos in channel mode | `50` |
| `--max-results` | `-m` | Maximum search results | `20` |

### YouTube Output Fields

Title, video ID, link, channel, publish time, duration, views, likes, comment count, description, tags, thumbnail URL

### YouTube API Key Application

1. Open [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project -> enable "YouTube Data API v3"
3. Credentials -> create API Key
4. Free quota: 10,000 units per day (video.list = 1 unit, search = 100 units)

---

## Output Format

### Markdown (Default)

Generate `bilibili_videos.md` or `youtube_videos.md`, with one table block per video:

```markdown
## Video Title

| Field | Value |
|------|-----|
| BV ID | `BV1xxx` |
| Views | 1,234,567 |
| Likes | 45,678 |
| ...  | ...  |

**Description**: Video description content

**Tags**: Tag1 · Tag2 · Tag3

---
```

### JSON

Generate `bilibili_videos.json` or `youtube_videos.json`; each video is a flattened object in an array, convenient for programmatic processing.

---

## Douyin — Quick Usage

> Douyin Web API requires signature parameters (A-Bogus / X-Bogus) to return data normally.
> It can still work without configured Cookie, but some restricted videos cannot be accessed.

```bash
# Single video (aweme_id or full/short link)
python scripts/douyin.py video 7380308675841297704 -o ./output
python scripts/douyin.py video "https://www.douyin.com/video/7380308675841297704" -o ./output
python scripts/douyin.py video "https://v.douyin.com/iShortXxx" -o ./output

# Share-text parsing (paste the full text shared from the Douyin app directly; the link is extracted automatically)
python scripts/douyin.py video "7.43 pda:/ Remember me in just a few seconds https://v.douyin.com/L5pbfdP/ Copy this link and open Douyin search to watch the video directly!" -o ./output

# Multiple videos (ID / URL / share text can all be mixed)
python scripts/douyin.py video ID1 ID2 ID3 -o ./output

# User page (sec_uid or personal page URL)
python scripts/douyin.py user "https://www.douyin.com/user/MS4wLjABAAAA..." --limit 30 -o ./output
python scripts/douyin.py user MS4wLjABAAAA... -o ./output

# Collection
python scripts/douyin.py mix 7380308675841297704 -o ./output

# First-time Cookie configuration (saved to ~/.douyin_cookies.json and automatically reused later)
python scripts/douyin.py video 7380308675841297704 --cookies "sessionid=xxx; ..." -o ./output

# Output JSON
python scripts/douyin.py user MS4wLjABAAAA... -f json
python scripts/douyin.py user MS4wLjABAAAA... -f both
```

### Douyin Parameters

| Parameter | Short | Description | Default |
|------|------|------|--------|
| `video <targets...>` | — | Fetch by video ID/URL (supports multiple) | — |
| `user <target>` | — | Fetch user page uploads by user sec_uid/URL | — |
| `mix <target>` | — | Fetch by collection ID/URL | — |
| `--cookies` | | Browser Cookie string (first-time configuration) | Cookie cache file |
| `--output-dir` | `-o` | Output directory | `./douyin_output` |
| `--format` | `-f` | Output format `md` / `json` / `both` | `md` |
| `--limit` | `-l` | Maximum fetch count in user/collection mode | All |
| `--proxy` | | HTTP proxy address | None |

### Douyin Output Fields

Video ID, link, type (video/image-text), author nickname, publish time, duration, recommend count, likes, comments, shares, favorites, description, tags

> **Note**: Douyin Web API intentionally hides play count (always returns 0), so `recommend_count` (recommend count) is used as a reference metric for propagation power.

### Cookie Retrieval Method

1. Open and log in to https://www.douyin.com in Chrome/Edge
2. Press F12 -> switch to the Network tab -> press F5 to refresh the page
3. At the top of Developer Tools, switch to: Network
4. In the sub-tabs under Network, select: Fetch/XHR5
5. Refresh the page once from the browser address bar (very important)
6. In the search box at the upper right of Network, enter: list/? (note that it includes /?)
7. Multiple request records will appear. Click any one of them, then switch to Headers on the right
8. Scroll down and find a line in Request Headers: cookie: xxxx. Select and copy the entire content after cookie: from start to end
↑ The above Douyin Cookies retrieval guide must be copied and reported to the user word for word, because this is the latest method for obtaining Douyin Cookies
Pass it through the `--cookies "..."` parameter (the script will automatically cache it to `~/.douyin_cookies.json`)

---

## Troubleshooting

| Problem | Solution |
|------|----------|
| Bilibili 412 / rate limited | The script has built-in random delay and automatic retry (up to 3 times). If it continues to fail, try again later |
| Bilibili Cookie expired | Copy SESSDATA from the browser again and reconfigure it through the `--cookie` parameter (the script will automatically update `~/.bilibili_cookies.json`) |
| YouTube 403 | API Key is invalid or daily quota is exhausted; check in Cloud Console |
| Unable to parse URL | Ensure the URL format is correct, or directly pass a BV ID/video ID |
| Creator uploads are empty | Confirm the MID is correct; some creators may have set privacy |
| Search consumes quota too quickly | Each search consumes 100 units; recommended `--max-results ≤ 50` |
| Douyin returns empty data | Install gmssl (`pip install gmssl`) to enable A-Bogus signing; otherwise configure Cookie to improve success rate |
| Douyin Cookie expired | Copy Cookie from the browser again and reconfigure it through the `--cookies` parameter |

## Dependencies
  ```bash
  pip install httpx
  pip install aiohttp
  pip install gmssl
  ```
