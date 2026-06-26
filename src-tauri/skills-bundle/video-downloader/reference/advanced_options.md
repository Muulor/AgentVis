# yt-dlp Advanced Reference Documentation

> This document contains advanced yt-dlp CLI usage, platform-specific tips, and troubleshooting guidance.
> For core download and subtitle features, see [SKILL.md](../SKILL.md).

## Direct CLI Usage

For advanced scenarios not covered by the script, you can use the yt-dlp CLI directly.

### Quality and Format Selection

```bash
# Best quality (default)
yt-dlp -f "bv+ba/b" "URL"

# Specific resolution
yt-dlp -f "bv[height<=1080]+ba/b[height<=1080]" "URL"
yt-dlp -f "bv[height<=720]+ba/b[height<=720]" "URL"

# Force MP4 output
yt-dlp -f "bv[ext=mp4]+ba[ext=m4a]/b[ext=mp4]" --merge-output-format mp4 "URL"

# List available formats
yt-dlp -F "URL"

# Download specific format IDs
yt-dlp -f "137+140" "URL"
```

### Subtitle Downloads (CLI)

```bash
# List available subtitles
yt-dlp --list-subs "URL"

# Download with all subtitles
yt-dlp --write-subs --sub-langs all "URL"

# Download with specific language subtitles
yt-dlp --write-subs --sub-langs en,zh-CN "URL"

# Download auto-generated subtitles
yt-dlp --write-auto-subs --sub-langs en "URL"

# Download subtitles only (no video)
yt-dlp --write-subs --sub-langs en --skip-download "URL"
```

### Playlist and Batch

```bash
# Download entire playlist
yt-dlp "PLAYLIST_URL"

# Download specific items from playlist
yt-dlp --playlist-items 1-10 "PLAYLIST_URL"
yt-dlp --playlist-items 5,8,13 "PLAYLIST_URL"

# Download from URL list file
yt-dlp -a urls.txt

# Custom filename with playlist index
yt-dlp -o "%(playlist_index)s - %(title)s.%(ext)s" "PLAYLIST_URL"
```

### Output Template Variables

Use these in `-o` to customize filenames:
- `%(title)s` — Video title
- `%(uploader)s` — Channel/uploader name
- `%(upload_date)s` — Upload date (YYYYMMDD)
- `%(id)s` — Video ID
- `%(ext)s` — File extension
- `%(playlist_index)s` — Playlist item index

Example: `yt-dlp -o "%(uploader)s/[%(upload_date)s] %(title)s.%(ext)s" "URL"`

---

## Platform-Specific Tips

### TikTok / Douyin

```bash
# TikTok (downloads without watermark)
yt-dlp "TIKTOK_URL"

# Douyin may need browser cookies
yt-dlp --cookies-from-browser chrome "DOUYIN_URL"
```

### YouTube Members-Only / Age-Restricted

```bash
yt-dlp --cookies-from-browser chrome "MEMBERS_URL"
```

---

## Advanced Options (CLI)

```bash
# Resume interrupted downloads
yt-dlp --continue "URL"

# Limit download speed
yt-dlp -r 1M "URL"

# Download thumbnail
yt-dlp --write-thumbnail "URL"

# Embed metadata and thumbnail into file
yt-dlp --embed-metadata --embed-thumbnail "URL"

# Use proxy
yt-dlp --proxy "http://proxy:8080" "URL"

# Use external downloader (faster)
yt-dlp --downloader aria2c "URL"

# Authentication
yt-dlp -u USERNAME -p PASSWORD "URL"
yt-dlp --cookies-from-browser firefox "URL"
yt-dlp --cookies cookies.txt "URL"

# Geo-bypass
yt-dlp --geo-bypass "URL"

# Multi-threaded fragment downloads (HLS/DASH)
yt-dlp -N 4 "URL"

# Download specific time range (requires ffmpeg)
yt-dlp --download-sections "*10:15-15:00" "URL"
```

---

## download.py Script Options (Complete)

| Option | Short | Description | Example |
|--------|-------|-------------|---------|
| `--output-dir DIR` | `-o` | Save to specific directory | `-o "C:\Videos"` |
| `--audio-only` | `-a` | Extract audio only (MP3) | `-a` |
| `--format FORMAT` | `-f` | Specify format code | `-f "bv[height<=720]+ba"` |
| `--subtitles` | `-s` | Download subtitles | `-s` |
| `--sub-lang LANG` | | Subtitle language(s) | `--sub-lang "en,zh-Hans"` |
| `--playlist` | | Download entire playlist | `--playlist` |
| `--cookies-from BROWSER` | | Use browser cookies | `--cookies-from chrome` |
| `--proxy URL` | | Use HTTP/SOCKS proxy | `--proxy "http://127.0.0.1:7890"` |
| `--rate-limit RATE` | `-r` | Limit download speed | `-r 1M` |
| `--embed-metadata` | | Embed video metadata | `--embed-metadata` |
| `--write-thumbnail` | | Save thumbnail separately | `--write-thumbnail` |
| `--playlist-items RANGE` | | Specific playlist items | `--playlist-items 1-10` |
| `--subs-only` | | Extract subtitles only | `--subs-only` |
| `--info-only` | | Extract video info only | `--info-only` |
| `--convert-subs FMT` | | Convert subtitle format | `--convert-subs srt` |
| `--concurrent-fragments N` | `-N` | Multi-threaded downloads | `-N 4` |
| `--download-sections SPEC` | | Download time range | `--download-sections "*10:15-15:00"` |
| `--cookies FILE` | | Use cookies.txt file | `--cookies cookies.txt` |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| ffmpeg not found | Install ffmpeg and ensure it's in PATH |
| Geo-restricted content | Use `--proxy` or `--geo-bypass` |
| Login-required content | Use `--cookies-from-browser chrome` (or firefox/edge) |
| Slow speed | Try `--downloader aria2c` or `-r` to limit speed |
| Extraction errors | Update yt-dlp: `yt-dlp -U` or `pip install -U yt-dlp` |
| Higher quality locked | Membership content needs `--cookies-from-browser` |
| Bilibili HTTP 412 | **Use `scripts/bilibili_download.py`** (based on yutto), which can fully bypass it |
| Bilibili quality is insufficient | Provide SESSDATA (`-c`); premium membership can reach 4K/8K |
| YouTube 429 rate limit | For `--subs-only`, it is recommended to specify a single `--sub-lang` to avoid requesting multiple languages at the same time |
