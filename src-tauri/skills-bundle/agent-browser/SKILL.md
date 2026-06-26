---
name: agent-browser
description: "Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating any browser task. Supports connecting to the user's native Chrome browser via CDP to bypass anti-scraping detection, persist cookies and login state. This skill supports a default `--offscreen` mode for zero interruption, and a `--visible` mode for a visible window.It is not recommended to use this skill for web searching unless the web_search tool is unavailable. Any screenshots produced using this skill must be deleted after the task is finished. "
triggers: [agent-browser, 浏览器, 操控浏览器, 打开网页, 登录网站, browser, open website, screenshot, browser automation, 网页截图, 自动化浏览器, CDP]
---

# agent-browser skill for AgentVis - Browser Automation Skill
> After starting browser navigation, every interaction must also be followed by a screenshot to observe whether elements changed before proceeding to the next interaction/observation round. It is forbidden to interact based on old tool results without new observation evidence after an interaction. If an interaction does not take effect, flexibly adjust according to the strategies and pitfall-avoidance guidance in this guide.

## Step 1: Start/Reuse the Browser Runtime (Must Be Done First for Every Task)

Run the AgentVis Browser Runtime launcher (timeout must be set to 60 seconds or more):

```bash
cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" <url>
```

> The launcher will not `taskkill chrome.exe` and will not close the Chrome instance the user is using. It first tries to reuse the previous AgentVis CDP Runtime; if none exists, it starts an AgentVis dedicated Chrome profile (by default reusing the old `%LOCALAPPDATA%\ChromeCDP` to preserve historical login state).
> The default window strategy is `--window-state offscreen --viewport 1600x1000`: keep browser work rendered in a normal Chrome window positioned outside all detected displays, while avoiding inheriting a window size the user manually shrank last time. If offscreen placement cannot be verified, the runtime falls back to minimized mode.
> Visibility reminder: offscreen is the zero-interruption default. If the user wants to watch or inspect the agent operating the browser, do not use offscreen for that run; start with `--visible` for a normal window or `--maximized --viewport 1920x1080` for a large observable debugging window.
> If the user later minimizes a visible AgentVis browser while the task is still running, take screenshots through `browser-command.bat`; it can fall back to `Page.startScreencast` and capture the current viewport without restoring the browser to the foreground. Direct `agent-browser ... screenshot` does not have this minimized-window fallback.
> After startup succeeds, non-screenshot `agent-browser` commands must use the `command_prefix` output by the launcher, for example `agent-browser --session agentvis-cdp-9222 --cdp 9222`. This binds both the CDP port and dedicated session, preventing the `agent-browser` default session from caching an old CDP port. Do not blindly assume the port must be `9222`; if the launcher outputs port `49333`, use `agent-browser --session agentvis-cdp-49333 --cdp 49333`.
> In controlled-network mode, `command_prefix` may be `cmd /c "...\\browser-command.bat"` instead of direct `agent-browser --cdp ...`; use it exactly as printed so local CDP control does not inherit broker proxy environment variables.
> For screenshots, prefer `browser-command.bat` when you want timeout cleanup, `Page.startScreencast` fallback for a user-minimized visible window, and one automatic visible retry if offscreen capture fails. In the default offscreen mode, direct `agent-browser ... screenshot` calls should not bring Chrome onscreen. When using `browser-command.bat`, prefer no output path so it saves to TEMP automatically, or use a simple relative filename like `result.png`; avoid paths with spaces, nested quotes, and complicated absolute Windows paths unless necessary.
> Screencast fallback is a resilience path, not a full replacement for normal screenshots: `screenshot --annotate` falls back to an unannotated viewport image with no element overlay/refs, and `screenshot --full` falls back to the current viewport rather than a full-page image. If you truly need annotation refs or a full-page screenshot while the user-minimized visible browser is running, use`ensure --visible` to restore the visible window.
> `browser-command.bat` is only a compatibility wrapper for a single simple command; do not put it into chained commands such as `cmd /c ... && cmd /c ...`, especially do not mix long Chinese text and nested quotes. For complex interactions, prefer using `command_prefix` directly.
> In AgentVis `ControlledNetwork`, this launcher is the only supported browser start path. It receives the AgentVis browser broker proxy through `AGENTVIS_BROWSER_PROXY_SERVER`, starts the dedicated Chrome profile with controlled proxy settings, and refuses direct/bypass proxy Chrome args. Browser sessions use a local one-time proxy endpoint so users should not enter proxy credentials manually. Do not attach to an arbitrary already-running user Chrome from controlled-network mode; use the AgentVis dedicated runtime so login state is reusable while network egress remains broker-audited.
> If `status` reports `controlled_network_mismatch` or does not return `command_prefix`, do not run direct `agent-browser --cdp ...` commands. Run `start-chrome-debug.bat ensure --url <url>` again and use the fresh `command_prefix`.
> At the end of any task where you started or reused the AgentVis dedicated browser runtime, close that runtime before reporting completion unless the user explicitly asks to keep it open, or you stopped because the task is blocked on user login/manual verification in a visible browser. This only closes the AgentVis dedicated runtime, not the user's normal Chrome.

Common Runtime commands:

```bash
# Start/reuse Runtime and optionally open a URL
cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" https://example.com

# View current Runtime status
cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" status

# Start visibly so the user can log in manually
cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" ensure --visible --url https://example.com

# Frontend debugging or wide desktop screenshots: maximize the window and pin it to the desktop test viewport
cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" ensure --maximized --viewport 1920x1080 --url http://localhost:3000

# Low-interruption background mode: offscreen is the default, viewport can be specified explicitly
cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" ensure --window-state offscreen --viewport 1600x1000 --url https://example.com

# For subsequent commands, directly use the command_prefix output by the launcher; do not use agent-browser's default session
agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i
agent-browser --session agentvis-cdp-9222 --cdp 9222 get url

# A single simple command can also use the wrapper, but do not use it for chained/nested cmd commands
cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\browser-command.bat" snapshot -i

# Stop the dedicated AgentVis browser runtime gracefully
# Do this before TASK_COMPLETE unless the user explicitly asked to keep the runtime open.
cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" stop
cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\browser-command.bat" close
```

When calling `agent-browser` directly, you must use the `command_prefix` output by the launcher, shaped like:

```bash
agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i
```

**If the script is unavailable**, fall back in the following priority order:

| Priority | Mode | Command |
|--------|------|------|
| 2️⃣ Fallback | Visible browser | `agent-browser --headed open <url>` |
| 3️⃣ Alternative | Headless mode | `agent-browser open <url>` |

---

## Core Loop (5-Step Iron Rule)

Every browser task follows this loop. **Do not skip any step**. Accurately locating the target element is the key success metric:

```
1. Navigate  ->  2. Snapshot  ->  3. Interact & wait & re-Snapshot
```

**Important cautions**:
- Most webpages must follow this sequence: after `snapshot -i` , find the @element, make sure it is the correct one, then `fill` and then `press Enter`, or find the element and `click`; otherwise the navigation event will not be triggered.
- After opening a new URL, if the first `snapshot -i` or `snapshot -i -C` returns empty/unhelpful output on a dynamic page, run `wait 3000` to `wait 5000` and retry `snapshot -i` before deciding that the page has no interactive elements.
- If you cannot find an @element, immediately try `scroll down && snapshot -i`; scroll and then look for the @element again. Do not keep waiting on the original page load/refresh, because many modern pages lazy-load content.
- Still cannot find it? Use `snapshot -i -C` and add the `-C` parameter. It includes nonstandard but visually clickable elements such as `div[onclick]` (many modern SPA buttons are not native `<button>` elements).
- After every interaction and new element acquisition, immediately determine whether elements changed, because element changes triggered by any interaction are unpredictable. Be especially alert for placeholder fake elements whose real DOM nodes have not yet mounted.
- If any operation finds no element changes between two snapshots or screenshots, immediately adjust strategy. You must pay attention to Ref lifecycle pitfalls and avoid blind operations.
- On platforms such as Xiaohongshu, Instagram, Twitter/X, and Pinterest, modal dialogs (Modal) require `press Escape` to return to the list after getting data inside the modal page before continuing subsequent interactions.
- Input boxes returned by `snapshot -i` are described differently across platforms, generally mainly as `combobox` (for example Gmail recipient input boxes and Google search boxes) and `textbox`; locate them precisely when filling.
- If you have fully followed this skill guide for more than 6 steps and still made no progress, immediately check the deep reference docs to troubleshoot the operation.
- **Multimodal decision-making**: first page entry or result verification after operation -> prefer `screenshot --annotate` (visual confirmation); precise ref interaction needed -> use `snapshot -i`. Using both complementarily works best; text-only snapshot cannot identify icon buttons or visual layout.

### Window Size and Viewport Strategy

- The default offscreen mode keeps Chrome rendered but outside all detected displays, so screenshots can work without popping the browser onto the desktop. If offscreen capture fails, call screenshots through `browser-command.bat` so it can retry once with a visible normal window and then move Chrome back offscreen. For frontend debugging or manual observation, use `--maximized --viewport 1920x1080`.
- `viewport` affects responsive layout, lazy-load exposure, number of initially visible elements, and the visual region annotated by `screenshot --annotate`; therefore similar tasks should pin the viewport and not inherit the window size the user manually adjusted last time.
- The `800` in `scroll down 800` is page CSS pixels. The step length itself does not change with window size; but the taller the viewport, the more content becomes visible/triggers lazy loading after one scroll, and the number of operable elements in `snapshot` and screenshots will differ.
- When a complete page image is needed, prefer `screenshot --full`; when you need to see the current interaction state and button positions, use `screenshot --annotate`, which is closer to the agent's actual clicking field of view.

### Login-state reminder [!IMPORTANT]

> AgentVis Browser uses an AgentVis dedicated Chrome profile, so it may not share the user's normal Chrome login state on first use. If the current page shows a login page, password page, 2FA page, account chooser, or is blocked by a "please sign in" popup, anti-scraping security restrictions or errors, do not keep trying blind operations. Switch the dedicated browser to the foreground with `start-chrome-debug.bat ensure --visible --url <current-url>`, tell the user to log in inside the visible AgentVis dedicated Chrome window, then wait long enough for human action (`wait 120000`, or two `wait 60000` calls if needed) before re-observing.
> After the long login wait, re-check with `get url`, `snapshot -i`, and/or `screenshot --annotate`. If the user completed login, continue the task normally; future offscreen runs can reuse this dedicated profile until the site session expires. If the site is still login-blocked and the task cannot proceed without login, stop operations and report the blocker. In that blocker case, do not close the AgentVis dedicated browser runtime; leave the visible Chrome window open so the user can finish login later. Tell the user: "The account is not logged in yet. I left the AgentVis dedicated Chrome window open in the foreground; please complete login there. After this, future tasks usually will not need login again unless the session expires."


# Example 1: Xiaohongshu Data Collection Flow
```bash
agent-browser --session agentvis-cdp-9222 --cdp 9222 open https://www.xiaohongshu.com/
agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i  # @e7 textbox: find the "Search Xiaohongshu" input box
agent-browser --session agentvis-cdp-9222 --cdp 9222 fill @e7 "1128260666" # After fill, search with press Enter (the search box will show search history, and the page needs time to finish loading before it can search)
agent-browser --session agentvis-cdp-9222 --cdp 9222 press Enter # If there is no progress, must visually find the click button with screenshot to complete the search
agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i  # After search results appear, find the blogger's link [ref=e5]
agent-browser --session agentvis-cdp-9222 --cdp 9222 get attr @e5 href  # Extract the target link address (remove suffixes such as ?xsec_token) and enter the blogger homepage; do not use click because it will create a new tab
agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i  # Get the current homepage list, usually 10 notes, and remember the elements; clicking the rest that have not lazy-loaded can cause page loss due to anti-scraping traps
agent-browser --session agentvis-cdp-9222 --cdp 9222 click @e24 && agent-browser --session agentvis-cdp-9222 --cdp 9222 get text body # Click to get note data without extracting target links; Modal will not create a new tab
agent-browser --session agentvis-cdp-9222 --cdp 9222 press Escape && agent-browser --session agentvis-cdp-9222 --cdp 9222 wait 2000 && agent-browser --session agentvis-cdp-9222 --cdp 9222 click @e28 && agent-browser --session agentvis-cdp-9222 --cdp 9222 wait 3000 && agent-browser --session agentvis-cdp-9222 --cdp 9222 get text body  # Combined command loop for collection
# 👆After 10 notes, scroll down to lazy-load other note lists on the homepage, use `screenshot --annotate`, then continue. ⚠️ For a continuation collection task, you must enter the blogger homepage, scroll to load notes, then click only after the actually rendered element refs appear; otherwise anti-scraping will be triggered
```

# Example 2: Fill and Submit a Form
```bash
agent-browser --session agentvis-cdp-9222 --cdp 9222 open https://mail.google.com
agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i   # Find the compose email button @e1
agent-browser --session agentvis-cdp-9222 --cdp 9222 click @e1 && agent-browser --session agentvis-cdp-9222 --cdp 9222 wait 3000 && agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i  # After clicking the send button and transition, ensure focus finds combobox and textbox
agent-browser --session agentvis-cdp-9222 --cdp 9222 fill @e524 "user@example.com" && agent-browser --session agentvis-cdp-9222 --cdp 9222 wait 1000 # @e524 [combobox] "Send to recipient" (do not click the recipient element in Google Mail; directly fill the combobox element)
agent-browser --session agentvis-cdp-9222 --cdp 9222 fill @e9 "Test email" && agent-browser --session agentvis-cdp-9222 --cdp 9222 wait 1000 # @e9 [textbox] "Subject"
agent-browser --session agentvis-cdp-9222 --cdp 9222 fill @e526 "Hello, world!" && agent-browser --session agentvis-cdp-9222 --cdp 9222 wait 1000  # @e526 [textbox] "Email body"
agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i # Find the send button @e355
agent-browser --session agentvis-cdp-9222 --cdp 9222 click @e355 # Send email
agent-browser --session agentvis-cdp-9222 --cdp 9222 wait --load networkidle && agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i # Wait for page navigation to complete; old refs are invalid; confirm the result
```

### Ref Lifecycle (Most Common Pitfall)

**Refs such as `@e1` are valid only after the last snapshot**. You must run `snapshot -i` again after any of the following:

- Clicking a button/link causes page navigation
- Filling and submitting a form or selecting a button
- Dynamic content such as popups or dropdown menus appears
- AI-generated content finishes

```bash
# ❌ Wrong: using old refs to operate on a changed DOM
agent-browser --session agentvis-cdp-9222 --cdp 9222 click @e3        # Triggered page change
agent-browser --session agentvis-cdp-9222 --cdp 9222 get text @e5     # @e5 is invalid!

# ✅ Correct: after changes, you must re-snapshot
agent-browser --session agentvis-cdp-9222 --cdp 9222 click @e3
agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i      # Get refs again
agent-browser --session agentvis-cdp-9222 --cdp 9222 get text @e6    # Now @e6 is current
```

### 🪟 Same-Tab Navigation (Most Common Pitfall)

Clicking some links directly can cause the browser to open a new tab (for example Xiaohongshu). The judgment criterion is: after clicking, if two consecutive snapshots show no change, treat it as a new tab being opened.
Because the underlying mechanism of the agent-brower tool cannot control the new tab and can never get data from the new tab, you must force navigation in the current page using one of the following two methods:

**Option 1: Get the real link and actively open it (recommended)**
```bash
# 1. Extract the target link address
agent-browser --session agentvis-cdp-9222 --cdp 9222 get attr @e5 href

# 2. Force native loading in this tab
agent-browser --session agentvis-cdp-9222 --cdp 9222 open "https://...extracted URL"
```

**Option 2: Remove the new-tab attribute, then click**
If you know it is a new-tab link, use JS to remove the `target` attribute and make it a normal same-page navigation:
```bash
# Execute JS to remove target="_blank" from a specific element
agent-browser --session agentvis-cdp-9222 --cdp 9222 eval "document.querySelector('a').removeAttribute('target')"
# After this, normal click is safe
agent-browser --session agentvis-cdp-9222 --cdp 9222 click @e5
```

---

## Waiting Strategy Decision Tree

**Choose the correct waiting method according to page type**. The wrong wait can cause infinite loops or missed content:

```
Page type?
  ├─ Normal webpage (static/MPA)
  │     └─ agent-browser --session agentvis-cdp-9222 --cdp 9222 wait --load networkidle
  │
  ├─ SPA (React/Vue/Next.js, URL changes but no refresh)
  │     └─ agent-browser --session agentvis-cdp-9222 --cdp 9222 wait --url "**/target-path"
  │        agent-browser --session agentvis-cdp-9222 --cdp 9222 wait "#target-element"   # Or wait for the target element to appear
  │
  └─ Streaming AI conversation (ChatGPT / Gemini / Claude)
        └─ ⚠️ networkidle is completely ineffective; see the dedicated strategy below
```

## Anti-Scraping Website Scroll Strategy

When first entering pages such as Xiaohongshu, cards outside the viewport may exist in the snapshot structure, but their corresponding real DOM nodes may not yet be mounted, or they may only be placeholders. Directly clicking an @element will trigger **anti-crawler lazy-load detection**.
**You must first scroll to bring the @element into the viewport. For lists, you must prioritize using screenshot --annotate to get the real @element list**, trigger exposure events, then take another screenshot to locate the target element and click.
If a message similar to "the page disappeared" is returned, anti-scraping was definitely triggered. Return to the page, scroll more, and try again.
**On anti-scraping websites, do not use eval, do not use eval to extract data; only use get text body**.

```bash
agent-browser --session agentvis-cdp-9222 --cdp 9222 scroll down 800 && agent-browser --session agentvis-cdp-9222 --cdp 9222 wait 5000
cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\browser-command.bat" screenshot --annotate
agent-browser --session agentvis-cdp-9222 --cdp 9222 click @e24
```

## ⚡ Waiting Strategy for Streaming AI Websites (Gemini, ChatGPT, etc.)

During streaming generation, network requests continue, and `networkidle` will wait forever. Correct approach:

```bash
# Fixed delay (last resort; short replies 3-5 seconds, long replies 10-15 seconds)
agent-browser --session agentvis-cdp-9222 --cdp 9222 wait 10000
```
On this type of AI website, `\n` or `\n\n` will be swallowed directly; only `\\n` can be used for line breaks.
---

## ⏱️ Slow-Loading Page Defense Strategy

**Core principle: `wait --load networkidle` is completely unreliable for SPAs such as Xiaohongshu, Instagram, and Twitter/X that continuously send background requests. In most cases, it either immediately returns a false success (exit code 0 while the page is still loading) or blocks forever.**

### Correct Approach: Fixed Wait + Visual Confirmation

```bash
# ❌ Wrong: using networkidle on an SPA is extremely unreliable
agent-browser --session agentvis-cdp-9222 --cdp 9222 wait --load networkidle

# ✅ Correct: fixed wait + screenshot visual confirmation that the page has loaded
agent-browser --session agentvis-cdp-9222 --cdp 9222 wait 5000
cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\browser-command.bat" screenshot --annotate   # Judge whether loading is complete from the screenshot
# If the screenshot still shows loading (spinner/skeleton screen), wait once more; if it still has not loaded -> report TASK_COMPLETE
```

### When to Give Up Waiting

When 2 consecutive screenshots (3 seconds each) still show that the page has not finished loading:

1. **Do not keep waiting** -- this is usually an anti-scraping mechanism or resource loading failure, and continuing to wait is meaningless
2. First `scroll down 500` once (sometimes this triggers lazy loading to complete), then take a screenshot to confirm
3. If there is still no change: report the blocker, output TASK_COMPLETE, and let MB and the user decide whether to retry

---

## Command Chaining Rules

**When to use `&&` chaining:** when there is no need to read intermediate output (Ref lifecycle does not change)

```bash
# ✅ Suitable for chaining: open page + wait + screenshot
agent-browser --session agentvis-cdp-9222 --cdp 9222 open https://example.com && agent-browser --session agentvis-cdp-9222 --cdp 9222 wait --load networkidle && agent-browser --session agentvis-cdp-9222 --cdp 9222 screenshot result.png

# ✅ Suitable for chaining: fill multiple form fields continuously
agent-browser --session agentvis-cdp-9222 --cdp 9222 fill @e1 "name" && agent-browser --session agentvis-cdp-9222 --cdp 9222 fill @e2 "email@test.com"
```

**When steps must be executed separately:** when you need to first inspect intermediate output before deciding the next step

```bash
# ✅ Must be step-by-step: snapshot first to see refs, then operate with refs
agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i
# -> See the output and confirm @e5 is the input box
agent-browser --session agentvis-cdp-9222 --cdp 9222 fill @e5 "content"

# ✅ Must be step-by-step: after waiting for AI generation, re-snapshot to get new content
agent-browser --session agentvis-cdp-9222 --cdp 9222 wait 10000
agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i       # Re-snapshot
agent-browser --session agentvis-cdp-9222 --cdp 9222 get text @e7     # Read the newly generated content
```

---

## Text Input Strategy (Choose by Input Box Type)

**Before filling any text, first determine the input box type**, then choose the corresponding correct method:

| Input box type | Common scenario | Correct command |
|-----------|---------|---------|
| `<input type="text">` single-line input box | Search boxes, email fields, password boxes, and other textboxes | `fill @eN "text"` |
| `<textarea>` multi-line text box | Simple message boards, old-style email, some comment boxes, and other textboxes | `fill @eN "multi\nline\ntext"` |
| `<div contenteditable>` rich text editor | AI chat boxes (Gemini/ChatGPT), email body, online documents | ⚠️ See below |

### ⚠️ Rich Text Box (contenteditable): Do Not Directly `fill` Multi-Line Text

When `fill` injects long text with line breaks into a rich text box, the editor's content sanitizer will **truncate at the first `\n` and discard all following content**.
Also, when entering text into a rich text box, you must first focus it with click "[contenteditable]", then use fill or type.

```bash
# ❌ Wrong: long text is truncated before the first line break; `\n` will be swallowed directly or preserved literally. Do not use `\n` for line breaks; concatenate the text directly instead
agent-browser --session agentvis-cdp-9222 --cdp 9222 fill @e5 "First paragraph\nSecond paragraph\nThird paragraph"

# ✅ Correct: first click to focus, then fill/type
agent-browser --session agentvis-cdp-9222 --cdp 9222 click @e5 && agent-browser --session agentvis-cdp-9222 --cdp 9222 fill @e5 "First paragraph Second paragraph Third paragraph"
```

---

## Common Command Quick Reference

```bash
# Navigation
agent-browser --session agentvis-cdp-9222 --cdp 9222 open <url>              # Open page
agent-browser --session agentvis-cdp-9222 --cdp 9222 back                    # Go back to previous page
agent-browser --session agentvis-cdp-9222 --cdp 9222 forward                 # Go forward
agent-browser --session agentvis-cdp-9222 --cdp 9222 reload                  # Refresh page
cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\browser-command.bat" close  # Stop the dedicated runtime

# Perceive page
agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i             # Get interactive elements and refs
agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i -C          # Same as above + include nonstandard clickable elements such as div[onclick]
cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\browser-command.bat" screenshot --annotate   # Screenshot + annotate element numbers (visual verification, multimodal recommended)

# Basic interactions
agent-browser --session agentvis-cdp-9222 --cdp 9222 click @e1               # Click
agent-browser --session agentvis-cdp-9222 --cdp 9222 fill @e2 "text"         # Clear and input
agent-browser --session agentvis-cdp-9222 --cdp 9222 type @e2 "text"         # Character-by-character input
agent-browser --session agentvis-cdp-9222 --cdp 9222 press Enter             # Enter key
agent-browser --session agentvis-cdp-9222 --cdp 9222 press Escape            # Exit/cancel key
agent-browser --session agentvis-cdp-9222 --cdp 9222 scroll up/down 500      # Scroll
agent-browser --session agentvis-cdp-9222 --cdp 9222 scrollintoview @e5      # Precisely scroll to the specified element (prefer this on anti-scraping sites instead of blind scrolling)
agent-browser --session agentvis-cdp-9222 --cdp 9222 select @e3 "Option"     # Select dropdown option
agent-browser --session agentvis-cdp-9222 --cdp 9222 check @e4               # Check checkbox
agent-browser --session agentvis-cdp-9222 --cdp 9222 upload @e6 file.pdf     # Upload file

# Read content
agent-browser --session agentvis-cdp-9222 --cdp 9222 get text @e1            # Read element text
agent-browser --session agentvis-cdp-9222 --cdp 9222 get text body           # Read full page text (fallback)
agent-browser --session agentvis-cdp-9222 --cdp 9222 get attr @e5 href       # Read element attribute (commonly used to extract links and image src)
agent-browser --session agentvis-cdp-9222 --cdp 9222 get url                 # Get current page URL
agent-browser --session agentvis-cdp-9222 --cdp 9222 get title               # Get page title

# Wait
agent-browser --session agentvis-cdp-9222 --cdp 9222 wait --load networkidle # Wait for network idle
agent-browser --session agentvis-cdp-9222 --cdp 9222 wait "#selector"        # Wait for element to appear
agent-browser --session agentvis-cdp-9222 --cdp 9222 wait --fn "JS expression"   # Wait for JS condition to become true
agent-browser --session agentvis-cdp-9222 --cdp 9222 wait 3000               # Fixed wait in milliseconds

# Screenshot (when no path is specified, it is automatically saved to a temp directory, and output shows the full path)
agent-browser --session agentvis-cdp-9222 --cdp 9222 screenshot              # Screenshot to temp directory
agent-browser --session agentvis-cdp-9222 --cdp 9222 screenshot "path.png"  # Screenshot to specified path
agent-browser --session agentvis-cdp-9222 --cdp 9222 screenshot --full       # Full-page screenshot

# Download
agent-browser --session agentvis-cdp-9222 --cdp 9222 download @e1 ./file.pdf          # Click element to trigger download
agent-browser --session agentvis-cdp-9222 --cdp 9222 wait --download ./output.zip     # Wait for download to complete
agent-browser --session agentvis-cdp-9222 --cdp 9222 --download-path ./downloads open <url>  # Set default download directory

# Batch execution (reduces process startup overhead; suitable for deterministic flows)
agent-browser --session agentvis-cdp-9222 --cdp 9222 batch --bail "open https://example.com" "snapshot -i" "screenshot"
```

### Snapshot Advanced Options

```bash
agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i -C         # Include div[onclick] and other visually clickable elements
agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -s "#container" -i  # Narrow the scope to a specified container (recommended when content is complex)
```

> When there are too many refs and judgment is difficult, prefer using `-s` to narrow the snapshot scope.

### Semantic Search (Last Resort, Prefer Snapshot)

```bash
# ⚠️ Use only when snapshot -i cannot find the target element
agent-browser --session agentvis-cdp-9222 --cdp 9222 find text "Submit" click
agent-browser --session agentvis-cdp-9222 --cdp 9222 find role button click --name "Cancel"
```

---

## Real-World Scenario Patterns

### Scenario A: AI Chat Website (Gemini / ChatGPT)

```bash
# 1. Start browser (inherit the user's logged-in session)
cmd /c "...start-chrome-debug.bat" https://gemini.google.com/

# 2. Confirm page load and find input box
agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i
# -> See that @e5 is the input box

# 3. Send message
agent-browser --session agentvis-cdp-9222 --cdp 9222 click @e5 && agent-browser --session agentvis-cdp-9222 --cdp 9222 fill @e5 "your question"
agent-browser --session agentvis-cdp-9222 --cdp 9222 press Enter

# 4. ⚡ Wait for streaming generation to complete (do not use networkidle)
agent-browser --session agentvis-cdp-9222 --cdp 9222 wait --fn "document.querySelector('[aria-label*=\"Stop\"]') === null"
# Or if the selector is uncertain, use a fixed delay
agent-browser --session agentvis-cdp-9222 --cdp 9222 wait 10000

# 5. Re-snapshot to get the ref for the reply content
agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i
agent-browser --session agentvis-cdp-9222 --cdp 9222 get text @e7  # Latest generated reply
```

### Scenario B: Website Requiring Login (Reuse Logged-In State)

```bash
# Directly connect to the user's logged-in Chrome; no need to log in again
cmd /c "...start-chrome-debug.bat" https://app.example.com/dashboard
agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i
# It is already logged in at this point; operate directly
```

### Scenario C: Data Extraction
```bash
agent-browser --session agentvis-cdp-9222 --cdp 9222 open https://example.com/data
agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i

# Precise extraction
agent-browser --session agentvis-cdp-9222 --cdp 9222 get text @e5

# Extract after narrowing the scope (recommended for complex pages)
agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -s ".data-table" -i
agent-browser --session agentvis-cdp-9222 --cdp 9222 get text @e1

# Fallback: get full-page text
agent-browser --session agentvis-cdp-9222 --cdp 9222 get text body
```

### Scenario D: Save Images from an AI Image Generation Website
```bash
agent-browser --session agentvis-cdp-9222 --cdp 9222 wait 30000 && agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i  # Wait for image generation to complete
agent-browser --session agentvis-cdp-9222 --cdp 9222 click @e90 && agent-browser --session agentvis-cdp-9222 --cdp 9222 wait 2000 && agent-browser --session agentvis-cdp-9222 --cdp 9222 snapshot -i  # Click/open the generated image if needed, then find the real download/export/full-size button
agent-browser --session agentvis-cdp-9222 --cdp 9222 click @e58 && agent-browser --session agentvis-cdp-9222 --cdp 9222 wait 30000  # Chained commands —— Click the real browser-download button and wait for Chrome to finish writing the file at the same time
python scripts/save_browser_image.py --sync-download --output cute_cat.png --max-age-seconds 180  # Copy the latest recent image from Chrome Downloads to the task workspace
# Parameter notes:
# --sync-download     Does not click anything; it only copies the latest recent image from Chrome Downloads
# --output            Specify output path in the task workspace
# --max-age-seconds   Only accept files modified recently, to avoid copying an old generated image from a previous task
```

> For Gemini/ChatGPT generated images, do not use script-driven clicking as the primary path. Use `agent-browser click @ref` so the action is observable in the same session that produced the ref, wait long enough for Chrome to finish the file download, then run `--sync-download` to copy the recent file into the workspace.
> Use a current `@ref` from the latest `snapshot -i` when possible. If you must use a CSS selector, choose a control whose label clearly means download/export/full-size image. A generic "Save" button on ChatGPT or similar sites may save to the site's own library and may not create a Chrome download.
> If `--sync-download` returns `DOWNLOAD_NOT_FOUND`, do not assume navigation should have changed. Browser downloads often happen silently. Re-check the Downloads directory, wait once more if the download is still writing, and only then try another download/export/full-size button.
## Other Alternative Methods

```bash
# Directly extract a page image element (ordinary webpage image)
python scripts/save_browser_image.py --selector "img.generated" --output cute_cat.png

# Extract canvas content
python scripts/save_browser_image.py --cdp 9222 --selector "canvas" --output chart.png

# Use auto-connect (automatically detect CDP port)
python scripts/save_browser_image.py --auto-connect --selector "#result img" -o result.png

# Legacy fallback only: script-driven clicking can be harder to observe on AI sites
python scripts/save_browser_image.py --session agentvis-cdp-9222 --cdp 9222 --auto-download --click-selector "@e58" --output cute_cat.png --download-timeout 45
```

---

## Correct Usage of eval

`eval` **is only for reading data. Do not use it to operate on the DOM, and do not use eval on anti-scraping websites such as Xiaohongshu**:

```bash
# ✅ Correct: read data
agent-browser --session agentvis-cdp-9222 --cdp 9222 eval "document.title"
agent-browser --session agentvis-cdp-9222 --cdp 9222 eval "document.querySelectorAll('img').length"

# ❌ Wrong: operating on DOM (this is an anti-pattern; class names may be obfuscated/changed at any time)
# agent-browser --session agentvis-cdp-9222 --cdp 9222 eval "document.querySelector('.btn-submit').click()"
# Should be changed to: snapshot -i -> click @ref
```

> **Windows quote rule**: when JS contains quotes, you must use `-b` base64 encoding; do not nest quotes.
> See [references/commands.md](references/commands.md)

```bash
# Example: use -b on Windows to avoid quote hell
agent-browser --session agentvis-cdp-9222 --cdp 9222 eval -b "ZG9jdW1lbnQudGl0bGU="   # base64 of "document.title"
```

---

## 🛡️ Cloudflare / CAPTCHA Handling

**CDP connection to the user's native Chrome = real browser fingerprint + Cookie, and most Cloudflare challenges will pass automatically.**

When a verification popup/page appears, classify it before acting:

- Cookie/consent or ordinary closeable popup: click the clear accept/close button once, then `wait 2000` and re-observe.
- Simple "Verify you are human" button with no puzzle/slider/image challenge: click it once, then `wait 5000` and re-observe.
- Slider puzzle, drag-to-complete puzzle, hCaptcha, reCAPTCHA, graphical CAPTCHA, rotated-image CAPTCHA, or any challenge that asks for human dragging/visual matching: do not drag, do not script around it, and do not repeatedly click. Switch the AgentVis browser to visible mode so the user can help.
- Browser-level permission or security popup that cannot be reliably inspected through page refs: switch to visible mode and ask the user to handle it.

Commands for the simple-button path:
```bash
# 1. Screenshot to confirm verification type
cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\browser-command.bat" screenshot --annotate
# 2. Only if it is a simple button verification, click once
agent-browser --session agentvis-cdp-9222 --cdp 9222 click @eN
agent-browser --session agentvis-cdp-9222 --cdp 9222 wait 5000
cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\browser-command.bat" screenshot --annotate
```

Commands for the human-assist path:
```bash
cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\start-chrome-debug.bat" ensure --visible
agent-browser --session agentvis-cdp-9222 --cdp 9222 wait 30000
cmd /c "%APPDATA%\com.agentvis.app\skills\external\packages\agent-browser\scripts\browser-command.bat" screenshot --annotate
```

After switching to visible mode, tell the user the site requires manual verification and that the browser window was made visible for assistance. If the user does not complete the verification and the challenge remains, try direct navigation to the intended target URL or reload once. If the target content still cannot be reached, stop the loop and report the verification blocker instead of continuing blind automation.

---

## 🔍 Debug Troubleshooting Quick Reference

When an operation has no response or behavior is abnormal, troubleshoot in the following order:

```bash
agent-browser --session agentvis-cdp-9222 --cdp 9222 get url             # 1. Confirm whether the current page is the expected page
agent-browser --session agentvis-cdp-9222 --cdp 9222 screenshot          # 2. Visually confirm the page's actual state
agent-browser --session agentvis-cdp-9222 --cdp 9222 console             # 3. View browser console logs (JS errors, etc.)
agent-browser --session agentvis-cdp-9222 --cdp 9222 errors              # 4. View uncaught JS exceptions
agent-browser --session agentvis-cdp-9222 --cdp 9222 highlight @e5       # 5. Highlight element to confirm the correct one is selected
```

**Common issue diagnosis**:
- "Clicked but no response" -> use `get url` to see whether navigation happened + use `console` to see JS errors
- "Blank page" -> use `screenshot` for visual confirmation + retry after `wait 3000`
- "Ref operation error" -> Ref is invalid and needs `snapshot -i` again
- "Search/submit not triggered" -> after filling, you must `press Enter` or find the submit button and `click`

---

## Deep Reference Docs

| Document | Use Case |
|------|---------|
| [references/streaming-content.md](references/streaming-content.md) | Streaming AI website waiting strategies, dynamic DOM ref acquisition |
| [references/snapshot-refs.md](references/snapshot-refs.md) | Ref lifecycle, invalidation rules, troubleshooting |
| [references/commands.md](references/commands.md) | Complete command reference (including all flags) |
| [references/authentication.md](references/authentication.md) | Login flows, OAuth, 2FA, state reuse |
| [references/session-management.md](references/session-management.md) | Parallel sessions, state persistence |
| [references/video-recording.md](references/video-recording.md) | Recording workflows for debugging |
| [references/proxy-support.md](references/proxy-support.md) | Proxy configuration, geo-testing |

## Dependencies
```bash
npm install -g agent-browser
agent-browser install
```
