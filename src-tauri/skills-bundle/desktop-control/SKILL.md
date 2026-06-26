---
name: desktop-control
description: Control the desktop via mouse, keyboard, screenshots, window management, and clipboard. Use this skill whenever the user wants to automate GUI interactions, click buttons, type text into applications, take screenshots, switch windows, fill forms, or perform any desktop automation task. It should trigger whenever the user mentions opening applications, mouse clicking, keyboard typing, taking screenshots, or any type of desktop/GUI operations. Use this skill must comply with the principles of Program Launch Principles and Mandatory Rules for Large Displays. Any screenshots produced using this skill must be deleted after the task is finished.
triggers: [desktop-control, desktop control, desktop automation, mouse operation, keyboard operation, open desktop, screen operation, window management, mouse click, keyboard input, GUI automation,打开桌面, 鼠标操作, 键盘操作, 屏幕操作, 键盘输入]
---

# Desktop Control skill for AgentVis - Desktop Automation Skill

Automate desktop GUI operations through mouse, keyboard, screenshots, window management, and clipboard control. All operations are invoked through CLI subcommands and output JSON results.

This skill assists in controlling the computer and should be **flexibly combined with exec commands** to complete tasks. For example, when sending a file to a WeChat window, using a command such as `"powershell -NoProfile -Command "Set-Clipboard -Path"` to put the file into the system clipboard and then pressing Enter in the window is **much more efficient** than directly dragging the file into the window, finding a button, and clicking send. However, when using this skill, you must follow the skill guidance and flexibly advance the task. All screenshots produced must be cleaned up when the task is complete.

Standard workflows must comply with the principles of **Program Launch Principles** and **Mandatory Rules for Large Displays**. These are the two most critical traps to avoid—no blind maneuvers are allowed.

0. **Launch Application** - if the task requires interaction with a specific application, follow the **Program Launch Principles** to initiate or activate it.
1. **`observe --profile hybrid --mark --grid 200`** - get screen size, DPI, active window, screenshot path, OCR text, and coordinates in one pass, when necessary, supplement separately with **`info`** or **`screenshot --ocr`**.
2. **Decide the operation based on observations** - if it's a large display(2K resolution or above), strictly follow the **Mandatory Rules for Large Displays** to capture a local area to lock the coordinates and then execute the operation. Do not perform clicks based solely on the initial results from step 1 directly. 
3. **Briefly state the basis before operating** - state "I identified [some element] based on the screenshot position, and now I am moving the mouse to the corresponding position".
4. **Execute the operation and verify with screenshot** - click / type / hotkey / drag, etc., while using `observe` or `screenshot` to verify.
5. **If the result is not as expected, adjust strategy to get coordinates** - Blind command-line operations, searches, or coordinate guesses without observation verification are forbidden. When problems occur, quickly check the 5 major failure traps and do not act blindly.

## Program Launch Principles

**Use application-level activation by default** - When opening, switching, or waking an application, you must first use `app activate --name "application display name"`. It combines desktop/Start Menu shortcuts, Windows Start Apps/UWP entries, App Execution Aliases such as `notepad.exe`/`calc.exe`, real exe, running processes, process/shortcut-verified windows, cautious title fallback, and URI wake-up strategies, avoiding guessing window titles or process names and saving the observation-and-click startup step.

**Do not treat Start Menu search + Enter as the default launch method**. For some resident/single-instance applications, re-running a shortcut or opening from search may trigger a logged-out instance, updater, blank shell window, or repeated login flow. Special applications such as WeChat should preferably be restored internally by `app activate` through URI/visible-window strategies. Start Menu (win/win+r → type "name" → Enter)search is more suitable for searching Windows settings or as a fallback for searching and opening programs.

`ensure_window --title`, `process activate --name`, and `window activate --title` are low-level/advanced tools: use them for debugging, precise window targeting, or as fallbacks when `app activate` cannot determine the target. Daily automation flows should not rely on them first. `window activate --title` matches window titles, not application names; for apps whose titles are page names, file names, song names, or document names, run `window list` first and prefer `--process` or a specific content title.

Windows built-in/modern apps such as Notepad, Calculator, and Settings may not have traditional `.lnk` shortcuts. `app activate` handles these through Start Apps/App Execution Alias fallbacks, so prefer `app activate --name "Notepad"` or `app activate --name "Calculator"` before trying Win+R or Start Menu search manually.

## Mandatory Rules for Large Displays

Visual coordinates on large displays (2K resolution or above) are highly error-prone. In full-screen screenshots, element IDs/numbers often become illegible, and graphical regions lacking text OCR are prone to "focus loss" or positioning drift. Therefore, you **must** strictly adhere to the following protocol:

1. **Regional Locking**: Based on the initial results from `observe --profile hybrid --mark --grid 200`, use `screenshot --region` to capture a local area of approximately 600px (W) x 400px (H), combined with `--ocr --mark --grid 100` to lock the coordinates. Don't skip this step.
2. **Precise Execution**: Execute clicks using the precise OCR results from the regional screenshot or via `click_relative`. 
3. **Mandatory Grid Verification**: All subsequent screenshots must include the `grid` parameter to assist in visual judgment. If the task requires interacting with a different area of the application, you must repeat Step 1 to re-acquire local coordinates.

## Observation Principle

The core principle of desktop operation is **look before acting**.
- Use `observe --profile hybrid --mark --gird` to save screenshots; use the screenshot together with text and coordinates returned by OCR to assist visual judgment. On high-resolution screens, visually estimated coordinates can be biased. Prefer OCR coordinates or template matching, and only use visual estimation for textless graphical buttons or input-box regions.
- `observe` / `screenshot` return only line-level OCR JSON by default, keeping terminal output cleaner; add `--ocr-detail full` when full word/phrase candidates are needed. `find_text` / `click_text` still use full OCR candidates internally to ensure click accuracy.

## Popup Interruption Handling

The most common reason operations fail is that **unexpected popups** (WeChat messages, system update prompts, ad popups, UAC confirmation dialogs) interrupt the flow.

During `screenshot` verification, if an unexpected popup is found:
1. First interrupt the original plan
2. Clear the popup with `hotkey esc` or by clicking "Close/Cancel/X" on the popup
3. Run `screenshot` again to confirm the popup has disappeared
4. Resume the original plan and continue

## Waiting Between Operations

- After opening an application: use `wait_window` to wait for the window to appear, or `wait_stable` to wait for the interface to finish loading
- `wait_stable` defaults to `--consecutive 2` for safer verification. Use `--consecutive 1` only for simple/lightweight windows; use `2-3` for Electron, browsers, settings pages, or animated interfaces.
- After switching windows: wait **0.3-0.5 seconds**
- After clicking a menu: wait **0.3 seconds**
- Before typing text: make sure the target input box has focus
- **Cursor detection**: `info` returns `cursor_type`; if it is `busy`, the system is still loading and you should keep waiting

## Program/File or Settings Fallback Strategy

- When the standard flow cannot find an application, file, or related setting in Windows, `hotkey win` - open the Run dialog to search, `type "application name or path"` -> `press enter` is the final fallback.

## Quick Usage

```bash
# Get screen information (size, DPI, mouse position, active window)
python scripts/desktop_control.py info

# Recommended: observe the screen in one pass (info + screenshot + OCR + annotations)
python scripts/desktop_control.py observe -o "observe.png" --profile hybrid --mark
python scripts/desktop_control.py observe -o "observe.png" --profile hybrid --mark --grid 200  # Coordinate aid for large screens; 4K automatically enlarges grid labels

# Multimodal model: only save screenshot and let the model judge visually
python scripts/desktop_control.py observe -o "observe.png" --profile vision

# Non-multimodal model: force OCR and rely on text and coordinates
python scripts/desktop_control.py observe -o "observe.png" --profile ocr --mark
python scripts/desktop_control.py observe -o "observe.png" --profile ocr --mark --ocr-detail full  # Debug fine OCR candidates

# Mouse click
python scripts/desktop_control.py click 500 300
python scripts/desktop_control.py click 500.0 300.0  # OCR-returned floating-point coordinates can be used directly
python scripts/desktop_control.py click 500 300 --button right --clicks 2
python scripts/desktop_control.py click_relative 450 930 --region 1500,600,900,1100 --dry-run  # Local coordinates are automatically converted to screen absolute coordinates

# Find/click directly by text to avoid calculating coordinates yourself
python scripts/desktop_control.py find_text "Send" --match contains --mark
python scripts/desktop_control.py click_text "Send" --verify "WeChat"
python scripts/desktop_control.py click_text "Send" --anchor left --offset -220 -45 --dry-run  # Use "Send" as an anchor to locate the input area on the left

# Recommended: application-level activation/wake-up (desktop/Start Menu shortcuts + Start Apps/UWP + execution aliases + process + visible window + URI)
python scripts/desktop_control.py app activate --name "WeChat"
python scripts/desktop_control.py app activate --name "Visual Studio Code"
python scripts/desktop_control.py app activate --name "Notepad"
python scripts/desktop_control.py app check --name "OBS Studio"
python scripts/desktop_control.py app list --name "Chrome"

# Move mouse
python scripts/desktop_control.py move 1000 500 --duration 0.5 --smooth

# Type text (automatically handles Chinese/Unicode - Chinese uses clipboard paste)
python scripts/desktop_control.py type "Hello World"
python scripts/desktop_control.py type "Hello in Chinese"
python scripts/desktop_control.py type "Hello" --wpm 60

# Keys / hotkeys
python scripts/desktop_control.py press enter
python scripts/desktop_control.py hotkey ctrl c
python scripts/desktop_control.py hotkey ctrl shift s

# Drag
python scripts/desktop_control.py drag 100 100 500 500 --duration 1.0

# Scroll
python scripts/desktop_control.py scroll -5
python scripts/desktop_control.py scroll 3 --direction horizontal

# Screenshot
python scripts/desktop_control.py screenshot --output "capture.png"
python scripts/desktop_control.py screenshot --region 100,100,800,600 -o "region.png"
python scripts/desktop_control.py screenshot --region 1500,600,900,1100 -o "region_grid.png" --grid 100 --grid-label-size 24

# Screenshot + OCR text recognition (Windows native OCR, returns text coordinates)
python scripts/desktop_control.py screenshot -o "cap.png" --ocr
python scripts/desktop_control.py screenshot -o "cap.png" --profile hybrid --mark
python scripts/desktop_control.py screenshot -o "cap.png" --ocr --filter "Play,Pause"
python scripts/desktop_control.py screenshot -o "cap.png" --ocr --lang en-US
python scripts/desktop_control.py screenshot --region 100,100,800,600 -o "region.png" --ocr --mark

# Process detection and activation (low-level debugging/fallback; daily use should prefer app activate)
python scripts/desktop_control.py process check --name "WeChat"
python scripts/desktop_control.py process activate --name "WeChat"
python scripts/desktop_control.py process check --name "chrome.exe"

# Window management (low-level debugging/precise window-title operations)
python scripts/desktop_control.py window list
python scripts/desktop_control.py window activate --title "Chrome"
python scripts/desktop_control.py window activate --title "小半" --process "cloudmusic.exe"
python scripts/desktop_control.py window active

# Clipboard
python scripts/desktop_control.py clipboard get
python scripts/desktop_control.py clipboard set --text "content to copy"
python scripts/desktop_control.py paste_and_verify --text "content to paste" --ocr-verify

# Image template localization (suitable for pure icons and textless buttons)
python scripts/desktop_control.py locate_image "button.png" --confidence 0.85
python scripts/desktop_control.py click_image "button.png" --confidence 0.85

# Wait for a window to appear (suitable for waiting for app startup)
python scripts/desktop_control.py wait_window --title "NetEase Cloud Music" --timeout 15

# Wait for GUI interface to stabilize (suitable for waiting for page loading to complete)
python scripts/desktop_control.py wait_stable --timeout 10 --threshold 0.98
python scripts/desktop_control.py wait_stable --timeout 10 --threshold 0.98 --consecutive 2
```

## Command Parameter Tables

### click - Mouse Click

| Parameter | Description | Default |
|------|------|--------|
| `x` | X coordinate (omit to click current position) | Current position |
| `y` | Y coordinate | Current position |
| `--button` | left / right / middle | `left` |
| `--clicks` | Number of clicks (2=double-click) | `1` |

### click_relative - Relative Click Within Region

| Parameter | Description | Default |
|------|------|--------|
| `x` `y` | Local coordinates inside `--region` | - |
| `--region` | Region that the local coordinates belong to, `x,y,width,height` | Required |
| `--button` | left / right / middle | `left` |
| `--clicks` | Number of clicks | `1` |
| `--dry-run` | Only return the converted screen absolute coordinates; do not actually click | Disabled |

First use `observe --region ... --grid 100` to view the local screenshot, then use `click_relative` to click local coordinates. It adds the region origin to the local coordinates before clicking, avoiding manual conversion mistakes by the agent. It is suitable as a fallback when OCR cannot find blank input boxes or gray button text.

### find_text / click_text - OCR Text Localization and Click

| Parameter | Description | Default |
|------|------|--------|
| `text` | Text to find or click | - |
| `--match` | `contains`/`exact`/`regex`/`fuzzy` | `contains` |
| `--index` | Select which candidate | `0` |
| `--region` | Search region `x,y,width,height` | Full screen |
| `--mark` | Save screenshot with OCR annotations | Disabled |
| `--mark-level` | `smart`/`line`/`word`/`phrase`/`all`; `smart` is recommended for weaker models | `smart` |
| `--anchor` | Which direction from the OCR text box `click_text` uses to compute the click point: `center`/`left`/`right`/`top`/`bottom`/corners | `center` |
| `--offset DX DY` | Relative pixel offset based on `--anchor`, suitable for clicking a blank input box near an anchor | `0 0` |
| `--verify` | Verify active window title before `click_text` clicks | No verification |
| `--dry-run` | `click_text` only returns coordinates and does not actually click | Disabled |
| `--stop-on-popup` | `click_text` refuses to click when a high-confidence popup is detected | Disabled |

`find_text` returns `matches` and `selected`. `click_text` automatically screenshots, OCRs, matches, and clicks, suitable for non-multimodal use. OCR results include `kind=line/word/phrase`; when a line contains multiple buttons, prefer `phrase` or `word` candidates to avoid clicking the center of the whole line. `--mark-level smart` splits long lines into finer annotations, avoiding misleading long boxes in screenshots.

For targets without OCR text, such as blank input boxes or regions next to icons, prefer using nearby stable text as an anchor with `--anchor`/`--offset`. If the anchor text itself is not recognized by OCR (common with gray disabled buttons, low-contrast text, thin text after large-screen scaling), `--offset` cannot take effect; switch to `observe --region ... --grid 100` + `click_relative`.

### app -- Application-Level Find and Activate

| Subaction | Description |
|--------|------|
| `list --name "app name"` | List matching shortcuts and Windows Start Apps entries |
| `check --name "app name"` | Check shortcuts, Start Apps, launchers, real exe, and running processes |
| `activate --name "app name"` | Activate or start the application; prioritizes matched process windows, shortcuts, Start Apps/UWP entries, App Execution Aliases, URI, and cautious title fallback |

| Parameter | Description | Default |
|------|------|--------|
| `--name` | Application display name or keyword (for example WeChat, Visual Studio Code, OBS Studio) | Can be omitted for `list`, required for others |
| `--timeout` | activate timeout | `8` |
| `--interval` | activate retry interval | `0.5` |
| `--settle` | Wait time after activation/startup | `0.5` |
| `--limit` | Maximum number of shortcuts returned by list/check | `20` |
| `--hidden-fallback` | Allow forced activation of hidden hwnd as a final fallback, which may cause blank screens in Chromium/WeChat-like apps | Disabled |

**Recommended scenarios**: Prefer `app activate` when opening, switching, or waking applications. It first resolves desktop/Start Menu `.lnk`, Windows Start Apps/UWP entries, and known App Execution Alias commands, then uses the real exe and running process to locate the application; when already running, it prioritizes activating the matched process window; when hidden to tray, it prioritizes using URI or the application's own restore method; when not running, it starts the matched shortcut or launcher. Title-only fallback is deliberately conservative: an existing window title is not accepted unless the process identity also matches, which avoids treating browser/editor/player/document titles as application windows.

**Windows built-in app note**: Notepad/Calculator/Settings on Windows 10/11 may be packaged apps without traditional shortcuts. `app activate --name "Notepad"` and `app activate --name "Calculator"` should work through Start Apps/App Execution Alias fallbacks. If activation still fails, use `app check --name "..."` to inspect `start_apps` and `launchers`, then verify with `observe`.

**Note**: Hidden hwnd is not forcibly activated by default, because some Chromium/Electron/WeChat-like applications may show a blank screen after hidden windows are restored with `ShowWindow`. Only consider adding `--hidden-fallback` when troubleshooting ordinary applications.

### process -- Process Detection and Activation

| Subaction | Description |
|--------|------|
| `check --name "app name"` | Check whether the process is running (including tray-hidden programs) |
| `activate --name "app name"` | Find the process and activate its window (can wake tray-hidden windows) |

| Parameter | Description | Default |
|------|------|--------|
| `--name` | Process-name keyword (for example WeChat, chrome.exe), case-insensitive | Required |
| `--settle` | Wait time after activate (seconds) | `0.3` |

**Core scenarios**: Low-level troubleshooting to see whether a process exists, or precise activation when the real process name is known. For daily opening/waking applications, prefer `app activate`; use `process activate` only when you need to operate directly by process name.

### ensure_window -- Activate and Verify Window

| Parameter | Description | Default |
|------|------|--------|
| `--title` | Window-title keyword | Required |
| `--timeout` | Timeout | `8` |
| `--interval` | Retry interval | `0.5` |
| `--settle` | Wait time after activation | `0.3` |
| `--exact` | Title must match exactly | Disabled |

`ensure_window` is suitable for precise verification scenarios where "the current foreground must be a window with a certain title", such as confirming focus before typing or clicking. For daily opening/waking applications, prefer `app activate`; applications with dynamically changing titles (browsers, VS Code, document editors) should not rely only on `--title`.

### paste_and_verify - Paste and Verify

| Parameter | Description | Default |
|------|------|--------|
| `--text` | Write to clipboard then paste; omit to paste current clipboard | Current clipboard |
| `--verify-text` | Text used for OCR verification | `--text` or current clipboard |
| `--ocr-verify` | After pasting, screenshot and OCR verify whether the text is visible | Disabled |
| `--region` | OCR verification region `x,y,width,height` | Full screen |
| `--restore-clipboard` | Restore original clipboard after pasting | Disabled |

### locate_image / click_image - Image Template Localization

| Parameter | Description | Default |
|------|------|--------|
| `template` | Template image path | - |
| `--region` | Localization region `x,y,width,height` | Full screen |
| `--confidence` | Match confidence; automatically falls back to exact matching when OpenCV is unavailable | `0.85` |
| `--grayscale` | Grayscale matching | Disabled |
| `--timeout` | Timeout | `3` |
| `--dry-run` | `click_image` only returns coordinates and does not actually click | Disabled |

Template localization is suitable for pure icons or textless buttons that OCR cannot find; the template screenshot should be as small and clear as possible and come from the same DPI/scaling environment.

### move - Move Mouse

| Parameter | Description | Default |
|------|------|--------|
| `x` | Target X coordinate (required) | - |
| `y` | Target Y coordinate (required) | - |
| `--duration` | Movement duration (seconds, 0=instant jump) | `0` |
| `--smooth` | Use Bezier curve for smooth movement | `false` |

### type - Type Text

| Parameter | Description | Default |
|------|------|--------|
| `text` | Text to type (required) | - |
| `--wpm` | Words per minute (only valid for ASCII) | Instant |

### press - Press Key

| Parameter | Description | Default |
|------|------|--------|
| `key` | Key name (enter/tab/space/f1-f24/up/down, etc.) | - |
| `--presses` | Number of presses | `1` |

### hotkey - Hotkey Combination

| Parameter | Description |
|------|------|
| `keys` | Space-separated key list (such as `ctrl c` or `alt tab`) |

### drag - Mouse Drag

| Parameter | Description | Default |
|------|------|--------|
| `x1 y1` | Start coordinates (required) | - |
| `x2 y2` | End coordinates (required) | - |
| `--duration` | Drag duration (seconds) | `0.5` |
| `--button` | left / right / middle | `left` |

### scroll - Scroll

| Parameter | Description | Default |
|------|------|--------|
| `amount` | Scroll amount (positive=up, negative=down) | - |
| `--direction` | vertical / horizontal | `vertical` |
| `--x` `--y` | Scroll position coordinates | Current position |

### screenshot - Screenshot

| Parameter | Description | Default |
|------|------|--------|
| `--region` | Capture region `x,y,width,height` | Full screen |
| `--output` `-o` | Output path | Temp directory |
| `--ocr` | Enable Windows native OCR text recognition | Disabled |
| `--profile` | `vision` screenshot only, `ocr` force OCR, `hybrid` screenshot+OCR | `vision` |
| `--mark` | Draw prominent red boxes and numeric labels on the screenshot to precisely identify element coordinates and prevent alignment drift | Disabled |
| `--mark-level` | `smart`/`line`/`word`/`phrase`/`all`; `smart` is recommended for weaker models | `smart` |
| `--grid` | Draw a coordinate grid on the screenshot; value is a pixel interval no smaller than `20`; labels auto-rotate/skip when dense; large full-screen screenshots recommend `200`, local screenshots recommend `100` | Disabled |
| `--grid-label-size` | Grid coordinate label font size (`10`-`96`); default auto-adapts, about `32` for 4K full screen | Automatic |
| `--ocr-detail` | OCR JSON output granularity: `line` / `line_word` / `full`; default `line`, default `full` when `--filter` is used | Automatic |
| `--lang` | OCR language (`zh-Hans`/`en-US`/`ja-JP`) | `zh-Hans` |
| `--filter` | Only return OCR results matching keywords (comma-separated) | Return all |

> When using `--region`, observation-style commands (`screenshot`, `observe`, `find_text`, `click_text`, `locate_image`, `click_image`, `wait_stable`, and paste OCR verification) automatically clip slightly oversized regions to the screen bounds and return the actual region used. `x,y` in OCR results are still converted to screen absolute coordinates and can be used directly for `click`; `image_x,image_y` are also returned as local coordinates within the region screenshot. `--grid` tick labels also show screen absolute coordinates. Dense grids automatically rotate X labels vertically and skip overlapping labels. JSON only returns `grid` metadata and does not expand all grid lines. If 4K full-screen labels are still unclear, add `--grid-label-size 36`.

### observe - One-Pass Screen Observation

| Parameter | Description | Default |
|------|------|--------|
| `--region` | Capture region `x,y,width,height` | Full screen |
| `--output` `-o` | Output path | Temp directory |
| `--ocr` | Enable Windows native OCR text recognition | Disabled |
| `--profile` | `vision` screenshot only, `ocr` force OCR, `hybrid` screenshot+OCR | `vision` |
| `--mark` | Draw red boxes and numeric labels on the screenshot | Disabled |
| `--mark-level` | `smart`/`line`/`word`/`phrase`/`all`; `smart` is recommended for weaker models | `smart` |
| `--grid` | Draw a coordinate grid on the screenshot; value is a pixel interval no smaller than `20`; labels auto-rotate/skip when dense; large full-screen screenshots recommend `200`, local screenshots recommend `50`/`100` | Disabled |
| `--grid-label-size` | Grid coordinate label font size (`10`-`96`); default auto-adapts, about `32` for 4K full screen | Automatic |
| `--lang` | OCR language (`zh-Hans`/`en-US`/`ja-JP`) | `zh-Hans` |
| `--filter` | Only return OCR results matching keywords (comma-separated) | Return all |

### window - Window Management

| Subaction | Description |
|--------|------|
| `list` | List all window titles and structured `window_details` with process information |
| `activate --title "keyword"` | Activate matching-title window (with retries); filters common content-title hosts by default |
| `active` | Get current active window information |

| Parameter | Description | Default |
|------|------|--------|
| `--title` | Window-title keyword for `activate` | Required for `activate` |
| `--exact` | Require exact title match | Disabled |
| `--index` | Activate which sorted candidate | `0` |
| `--process` | Filter by process name or exe path, such as `cloudmusic.exe` | Disabled |
| `--allow-content-title` | Allow browser/editor/document page or file-title matches | Disabled |

Use `window activate --title` only when the target title is specific enough. Do not pass an application display name such as `网易云音乐` if the same text may appear in a browser tab, editor file name, or document title; use `app activate --name "网易云音乐"` first, or inspect `window list` and then activate by a specific title plus `--process`.

### clipboard - Clipboard

| Subaction | Description |
|--------|------|
| `get` | Read clipboard text |
| `set --text "content"` | Write to clipboard |

### wait_window - Wait for Window to Appear

| Parameter | Description | Default |
|------|------|--------|
| `--title` | Window-title keyword to wait for (required) | - |
| `--timeout` | Timeout (seconds) | `15` |
| `--interval` | Poll interval (seconds) | `0.5` |

### wait_stable - Wait for GUI to Stabilize

| Parameter | Description | Default |
|------|------|--------|
| `--timeout` | Timeout (seconds) | `10` |
| `--interval` | Screenshot interval (seconds) | `1.0` |
| `--threshold` | SSIM stability threshold (0-1, higher is stricter) | `0.98` |
| `--consecutive` | Consecutive stable frame requirement; use 1 for lightweight apps and 2-3 for complex animations | `2` |
| `--region` | Only wait for specified region to stabilize, `x,y,width,height` | Full screen |

## Output Format

All commands only output JSON with a unified format; if warning or abnormal text appears, it should be treated as a tool defect rather than normal output.

`observe` and `screenshot` return an `analysis` field to guide the agent in choosing a path:

- `analysis.vision.screenshot_path`: multimodal models should prioritize reading this image to judge layout, icons, occlusion, state, and buttons.
- `analysis.ocr.enabled` and `ocr_elements`: non-multimodal models should rely on OCR text and center coordinates to execute.
- `analysis.coordinate_system`: coordinates are screen absolute coordinates and can be used directly for `click`.

Observation commands with OCR enabled also return `popup_detection`:

- `possible_popup`: high-confidence suspected popup; recommended to handle the popup before continuing the original plan.
- `popup_candidates`: matched candidate words for buttons/permissions/updates, etc.; low-confidence candidates are only hints.
- Popup detection is computed from the full OCR result before `--filter` is applied, so a text filter for the target element will not hide unrelated popup buttons from `popup_detection`.

```json
// Success
{"success": true, "data": {"action": "click", "x": 500, "y": 300, "button": "left", "clicks": 1}}

// Screenshot + OCR (x,y in ocr_elements are center coordinates and can be used directly for click)
{"success": true, "data": {"action": "screenshot", "path": "...", "ocr_elements": [{"text": "Play", "x": 960, "y": 1620, "width": 48, "height": 24}], "ocr_count": 1}}

// Failure
{"success": false, "error": "Coordinates (9999, 0) are outside screen bounds (0-1919, 0-1079)", "code": "COORDINATES_OUT_OF_BOUNDS"}
```

Common error codes: `COORDINATES_OUT_OF_BOUNDS`, `DEPENDENCY_MISSING`, `WINDOW_NOT_FOUND`, `CLICK_FAILED`, `TYPE_FAILED`, `SCREENSHOT_FAILED`.


## Safety Constraints and Notes

- **Failsafe**: pyautogui automatically aborts when the mouse is moved to a screen corner (enabled by default)
- **DPI scaling**: the tool is DPI-aware and uses physical screen pixels for screenshots, OCR, clicks, and regions. `info`/`observe` return `dpi_scale`; if coordinates come from an external logical/UI-scaled source, convert with `physical = logical * dpi_scale`. OCR and screenshot coordinates returned by this tool are already physical pixels and should not be multiplied again.
- **Unicode/Chinese input**: the `type` command automatically detects non-ASCII characters and switches to a clipboard paste strategy (Ctrl+V), ensuring correct Chinese input
- **Delay between operations**: there is a 50ms automatic delay after every operation to prevent races caused by the GUI not responding in time. Complex flows should add an extra wait of 0.3-0.5 seconds between steps
- **Coordinate validation**: click coordinates remain strict and out-of-bounds returns `COORDINATES_OUT_OF_BOUNDS`. Observation/image-region commands clip partially oversized regions to screen bounds, but a region completely outside the screen still returns `COORDINATES_OUT_OF_BOUNDS`.
- **Some applications may intercept simulated input** (such as games and security software), in which case the tool cannot operate them

## Troubleshooting

| Issue | Solution |
|------|----------|
| `DEPENDENCY_MISSING` | Follow the prompt and run `pip install` to install the missing dependency |
| Mouse click position is offset | Use coordinates returned by OCR/screenshot directly. If coordinates came from a logical UI source, run `info` and convert with `physical = logical * dpi_scale` |
| Keyboard input goes to the wrong window | First use `window activate` to activate the target window, wait, then type |
| Chinese input is garbled | The `type` command already automatically uses the clipboard strategy; ensure pyperclip is installed |
| Screenshot is black | Some applications (such as games) have anti-screenshot protection; try using `--region` to capture a specific region |
| Window activation failed | Check whether the `--title` keyword is correct; the tool automatically retries 3 times |
| `wait_window` times out and exits with an error | Modern applications such as Electron may be unresponsive; immediately run `screenshot --ocr` to confirm |
| `APP_ACTIVATE_FAILED` for a built-in Windows app | Run `app check --name "Notepad"` or `app check --name "Calculator"` and inspect `start_apps`/`launchers`; if those are empty, use Win+R only as the final fallback |
| `COORDINATES_OUT_OF_BOUNDS` on screenshot/template capture | For observation commands, slightly oversized regions are clipped automatically; if it still fails, the region does not overlap the screen, so run `observe --profile hybrid --mark --grid 200` and recalculate from the returned bounds |

### Standard Failure Recovery Loop

When a command fails, do not immediately repeat the same action. Use this sequence:

1. Observe: run `observe --profile hybrid --mark` (add `--grid 200` on 2K or above screens).
2. Classify: check `code`, `active_window`, `cursor_type`, `popup_detection`, and coordinate bounds.
3. Adjust: choose one concrete fix, such as clearing a popup, activating the intended app, clipping/recomputing a region, increasing `wait_stable --consecutive`, or switching from OCR to template matching.
4. Retry once, then verify with another `observe`/`screenshot`.


## 5 Major Failure Trap Quick Reference

### Trap 1: Focus Loss (Popup/Notification Steals Window Focus)

**Symptoms**: typed text goes into another window, or clicks have no effect.

```bash
# Defense: verify focus before operation with --verify (optional but recommended)
python scripts/desktop_control.py click 500 300 --verify "Chrome"
# -> If the active window does not contain "Chrome", return FOCUS_MISMATCH error and refuse blind clicking

# Defense: actively activate target window before important operations
python scripts/desktop_control.py window activate --title "Notepad"
python scripts/desktop_control.py screenshot -o "verify.png"  # Confirm the window is in foreground
python scripts/desktop_control.py type "content to input"
```

### Trap 2: Animation Delay (Transition Animation Causes Blurred Screenshot/Recognition Failure)

**Symptoms**: after clicking the Start Menu and immediately taking a screenshot, OCR cannot find the target button.

```bash
# Defense: use wait_stable and wait until the screen stops changing before screenshot
python scripts/desktop_control.py click 500 300           # Trigger menu/popup
python scripts/desktop_control.py wait_stable --timeout 5 --consecutive 2  # Wait for animation to finish
python scripts/desktop_control.py screenshot -o "cap.png" --ocr  # Now the screen is stable
```

### Trap 3: Chinese/Unicode Input Method Conflict

**Symptoms**: intending to input Chinese, but strange letter combinations appear.

```bash
# No special handling is needed; the script automatically detects non-ASCII characters and switches to clipboard paste
python scripts/desktop_control.py type "Hello in Chinese"
# -> Automatically uses the clipboard+Ctrl+V strategy, method: clipboard_paste
```

> **Note**: the clipboard paste strategy temporarily overwrites clipboard content (it will be automatically restored after the operation).

### Trap 4: Unexpected Popup Interrupts Operation

**Symptoms**: just before clicking the target button, a system update/antivirus software/WeChat message popup suddenly blocks it.

```bash
# Defense flow (when an unexpected popup is found in screenshot):
# 1. Interrupt the original plan
# 2. Clear the popup
python scripts/desktop_control.py press escape            # Try ESC to close
python scripts/desktop_control.py screenshot -o "check.png"  # Verify whether popup disappeared
# 3. If ESC is ineffective, use OCR to find the "Close/Cancel/X" button on the popup
python scripts/desktop_control.py screenshot -o "popup.png" --ocr --filter "Close,Cancel,X"
python scripts/desktop_control.py click <x> <y>           # Click close button
# 4. Resume original plan
python scripts/desktop_control.py screenshot -o "clean.png"  # Confirm the screen is clean
```

### Trap 5: Permission Barrier (UAC / Security Control / Anti-Cheat)

**Symptoms**: screenshot is fully black, or clicking/typing has no effect at all.

> This is not a "vision" problem, but a "permission" problem. **When 2 consecutive operations are ineffective, you should immediately ask the user for help**,
> instead of continuing to click randomly on a black screen. Common scenarios: UAC dialogs, online banking security controls, game anti-cheat.

---

## Dependencies

- `pip install pyautogui`
- `pip install Pillow`
- `pip install pyperclip`
- `pip install winocr` (Windows native OCR)
- `pip install pygetwindow` (window management + click --verify focus verification)
- `pip install psutil` (process detection + tray-window activation)
