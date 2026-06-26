"""
Debug script: print the full statistics structure returned by the Douyin API
to identify the real play-count field name or whether it is not returned at all.

Before running, make sure to set TEST_AWEME_ID to the video ID you want to test.
"""

import asyncio
import json
import sys
import os

# ── Prevent sys.platform checks from triggering redirection ─────────────────
# douyin.py contains `if sys.platform == "win32": sys.stdout = ...`
# The runtime Python stdout buffer has already been closed, and setting it directly will crash;
# here we temporarily spoof platform to another value to skip that code path
_REAL_PLATFORM = sys.platform
sys.platform = "linux"  # Temporary spoof so douyin.py skips the win32 branch

# Switch to the scripts directory so imports in douyin.py can be resolved
SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPTS_DIR)

from douyin import DouyinDataClient, load_cookies_from_cache  # type: ignore

sys.platform = _REAL_PLATFORM  # Restore


# ── Debug target ────────────────────────────────────────────────────────────
# Replace with any video ID you want to test
TEST_AWEME_ID = "7619230770288704497"
# ────────────────────────────────────────────────────────────────────────────


async def main() -> None:
    cookies = load_cookies_from_cache()

    async with DouyinDataClient(cookies=cookies) as client:
        print(f"\n[INFO] Requesting aweme_id={TEST_AWEME_ID} ...")
        detail = await client.get_video_detail(TEST_AWEME_ID)

        if not detail:
            print("[ERROR] Failed to get aweme_detail")
            return

        # Print all statistics fields
        print("\n========== Full statistics fields ==========")
        stats = detail.get("statistics", {}) or {}
        print(json.dumps(stats, ensure_ascii=False, indent=2))

        # Other top-level scalar fields (filtering out dict/list)
        print("\n========== Top-level scalar fields ==========")
        for k, v in detail.items():
            if not isinstance(v, (dict, list)):
                print(f"  {k}: {v}")

        # Dedicated search for play-count-related field names
        print("\n========== Play-count candidate field search ==========")
        for field in ("play_count", "video_view_count", "vv", "view_count",
                      "admire_count", "play_addr", "report_play_count"):
            v1 = detail.get(field)
            v2 = stats.get(field)
            if v1 is not None:
                print(f"  [detail] {field} = {v1}")
            if v2 is not None:
                print(f"  [statistics] {field} = {v2}")

        # Compare whether the user list API returns play_count
        print("\n[INFO] Querying the first 5 items through the list API to inspect statistics ...")
        author = detail.get("author", {}) or {}
        sec_uid = author.get("sec_uid", "")
        if sec_uid:
            page = await client.get_user_post(sec_uid, max_cursor=0, count=5)
            items = page.get("items", [])
            for i, item in enumerate(items):
                item_id = str(item.get("aweme_id", ""))
                item_stats = item.get("statistics", {}) or {}
                marker = " ← target video" if item_id == TEST_AWEME_ID else ""
                print(f"\n  [{i+1}] aweme_id={item_id}{marker}")
                print(f"       statistics.play_count = {item_stats.get('play_count', 'N/A')}")
                print(f"       statistics = {json.dumps(item_stats, ensure_ascii=False)}")


if __name__ == "__main__":
    asyncio.run(main())
