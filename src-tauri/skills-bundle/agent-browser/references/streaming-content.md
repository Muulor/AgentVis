# Waiting Strategies for Streaming Content and Dynamic Pages

This document provides precise waiting and content retrieval guidance for sites with **streaming generated content**, such as ChatGPT, Gemini, and Claude, as well as SPAs (single-page applications).

---

## Core Understanding: Why `networkidle` Fails on Streaming AI Pages

Streaming generation works by having the server continuously push tokens through SSE (Server-Sent Events) or WebSocket, which means:

- Network requests **never become idle** during generation
- `wait --load networkidle` keeps waiting until it times out
- The DOM **keeps changing** while the page is generating, and old `@ref`s can become invalid at any time

```bash
# ❌ Wrong approach: generative AI websites
agent-browser wait --load networkidle  # Keeps waiting until timeout!

# ✅ Correct approach: see the strategies below
```

---

## Strategy 1: Detect the "Stop Generating" Button Disappearing (Recommended)

Most AI chat websites show a "Stop" button during generation, and it disappears after generation completes:

```bash
# ChatGPT: wait for the stop button to disappear
agent-browser wait --fn "document.querySelector('[data-testid=\"stop-button\"]') === null"

# Gemini: wait for the stop button to disappear
agent-browser wait --fn "document.querySelector('button[aria-label*=\"Stop\"]') === null"

# Generic fallback: wait for common "generating" indicators to disappear
agent-browser wait --fn "document.querySelector('.loading-indicator, .typing-indicator, [class*=\"generating\"]') === null"
```

> **Tip**: If you are unsure about the selector, first use `snapshot -i` or `screenshot --annotate` to find the stop button's ref,
> then use `wait --fn` to detect whether it is still in the DOM.

---

## Strategy 2: Wait for a Specific Completion Marker to Appear

Some websites add a specific class or element after generation completes:

```bash
# Wait for the copy button to appear (usually appears only after a reply is complete)
agent-browser wait "[data-testid='copy-turn-action-button']"

# Wait for thumbs up/down buttons to appear (ChatGPT completion marker)
agent-browser wait ".flex.justify-between button"

# Wait for a custom completion marker
agent-browser wait --fn "document.querySelectorAll('.message-complete').length > 0"
```

---

## Strategy 3: Fixed Delay (Last Resort)

When you cannot determine a concrete completion marker, use progressive fixed delays:

```bash
# Short text reply (<500 words)
agent-browser wait 3000

# Medium-length reply (500-2000 words)
agent-browser wait 8000

# Long text reply or code generation
agent-browser wait 15000
```

> **Do not immediately assume generation is complete after a fixed delay**. After waiting, you must verify with a screenshot and check whether any generating indicator remains.

---

## Ref Acquisition Strategy for Dynamic DOM

### Core Principle: Re-Snapshot After Every Content Change

```bash
# Send the question
agent-browser fill @e5 "your question"
agent-browser press Enter

# ✅ Wait for generation to complete (using strategy 1)
agent-browser wait --fn "document.querySelector('[data-testid=\"stop-button\"]') === null"

# ✅ Re-snapshot to get refs for the newly generated content
agent-browser snapshot -i
# At this point, @e7 is the newly generated reply; previous @e5 and @e6 may already be invalid
agent-browser get text @e7
```

### Scope Narrowing Method (When the Content Area Is Complex)

Do not blindly guess refs across the whole-page DOM. Narrow the scope first:

```bash
# Narrow the snapshot scope to the conversation container
agent-browser snapshot -s ".conversation-container" -i
# After narrowing, there are fewer elements and the @e1 @e2 @e3 structure is clearer
agent-browser get text @e3  # Usually the last one is the latest message
```

### Full-Text Retrieval Method (Final Fallback)

```bash
# Get full page text, then let the LLM extract the needed part
agent-browser get text body
```

> **Avoid blindly trying multiple refs**:
> ```bash
> # ❌ Wrong: gambling-style retrieval
> agent-browser get text @e66 && agent-browser get text @e67 && agent-browser get text @e68
>
> # ✅ Correct: confirm the structure with snapshot first, then retrieve precisely
> agent-browser snapshot -s ".response-container" -i
> agent-browser get text @e1
> ```

---

## Special Handling for SPA Navigation

Route transitions in SPAs (such as React/Vue apps) do not trigger a full page refresh, so:

```bash
# ❌ Wrong: using networkidle after SPA navigation
agent-browser click @e3           # Triggers SPA routing
agent-browser wait --load networkidle  # Invalid because there is no real page load

# ✅ Correct: wait for URL changes or target elements to appear
agent-browser click @e3
agent-browser wait --url "**/dashboard"  # Wait for the URL to include dashboard
# Or
agent-browser wait "#main-content"       # Wait for the target content to appear

agent-browser snapshot -i  # Must re-snapshot
```

---

## Screenshot Verification Principle

When the page state is uncertain, **prefer observing with screenshots over operating blindly**:

```bash
# Annotated screenshot, directly showing which elements are interactive
agent-browser screenshot --annotate

# Annotated screenshot + immediately usable refs (no extra snapshot needed)
# In the legend after the screenshot, [N] corresponds to @eN and can be used directly
agent-browser click @e3  # Use the [3] seen in the screenshot
```

> Especially after waiting for generation to complete, take a screenshot first to confirm the content is fully rendered before extracting text.
> This avoids extracting truncated streaming content.
