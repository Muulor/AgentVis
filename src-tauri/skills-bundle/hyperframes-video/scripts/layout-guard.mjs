#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const args = process.argv.slice(2);

function usage(exitCode = 0) {
  console.log(`HyperFrames layout guard

Usage:
  layout-guard.mjs [project-or-html] [--samples N] [--at t1,t2] [--json]
                   [--caption-safe-pct 17] [--max-samples N]

Checks visible text/media geometry in a real browser without requiring the
official heavy group_spec workflow. It flags important text/media leaving the
canvas, likely blank sampled frames, and caption collisions.
`);
  process.exit(exitCode);
}

if (args.includes("--help") || args.includes("-h")) usage(0);

function takeFlag(name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function hasFlag(name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

const json = hasFlag("--json");
const samplesFlag = takeFlag("--samples");
const atFlag = takeFlag("--at");
const captionSafePct = Number(takeFlag("--caption-safe-pct", "17"));
const maxSamples = Math.max(3, Number(takeFlag("--max-samples", "72")));
const target = resolve(args[0] || ".");
const htmlPath =
  existsSync(target) && statSync(target).isFile() ? target : join(target, "index.html");
const projectDir = dirname(htmlPath);

if (!existsSync(htmlPath)) {
  console.error(`layout-guard: HTML file not found: ${htmlPath}`);
  process.exit(2);
}

const html = readFileSync(htmlPath, "utf8").replace(/^\uFEFF/, "");

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? match[1] : "";
}

function numberAttr(tag, name, fallback = null) {
  const value = Number(attr(tag, name));
  return Number.isFinite(value) ? value : fallback;
}

const rootMatch = html.match(/<([a-z0-9-]+)\b[^>]*data-composition-id\s*=\s*["']([^"']+)["'][^>]*>/i);
const rootTag = rootMatch ? rootMatch[0] : "";
const rootId = rootMatch ? rootMatch[2] : "main";
const width = numberAttr(rootTag, "data-width", 1920);
const height = numberAttr(rootTag, "data-height", 1080);
let duration = numberAttr(rootTag, "data-duration", null);

const clipTags = [
  ...html.matchAll(/<(section|div|audio|video)\b[^>]*(?:class\s*=\s*["'][^"']*\bclip\b[^"']*["'][^>]*)>/gim),
].map((match) => match[0]);

if (!duration) {
  duration = clipTags.reduce((max, tag) => {
    const start = numberAttr(tag, "data-start", 0) || 0;
    const dur = numberAttr(tag, "data-duration", 0) || 0;
    return Math.max(max, start + dur);
  }, 0);
}
if (!duration || !Number.isFinite(duration)) duration = 8;

function roundTime(value) {
  return Math.max(0, Math.round(value * 1000) / 1000);
}

function sampledTimes() {
  if (atFlag) {
    return atFlag
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value >= 0 && value <= duration);
  }

  if (samplesFlag) {
    const samples = Math.max(3, Number(samplesFlag));
    return Array.from({ length: samples }, (_, index) =>
      roundTime((duration * (index + 0.5)) / samples),
    ).filter((time) => time > 0.05 && time < duration - 0.03);
  }

  const times = new Set();
  const sceneTags = clipTags.filter((tag) => /\bscene\b/i.test(attr(tag, "class")));
  for (const tag of sceneTags) {
    const start = numberAttr(tag, "data-start", 0) || 0;
    const dur = numberAttr(tag, "data-duration", 0) || 0;
    if (dur <= 0) continue;
    times.add(roundTime(start + Math.min(0.5, dur * 0.2)));
    times.add(roundTime(start + dur * 0.5));
    times.add(roundTime(start + Math.max(0.1, dur - 0.25)));
  }

  const captionsPath = join(projectDir, "captions.json");
  if (existsSync(captionsPath)) {
    try {
      const captions = JSON.parse(readFileSync(captionsPath, "utf8"));
      const items = Array.isArray(captions) ? captions : captions.captions || captions.items || [];
      for (const caption of items) {
        const start = Number(caption.start);
        const end = Number(caption.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        times.add(roundTime(start + Math.min(0.05, (end - start) * 0.25)));
        times.add(roundTime(start + (end - start) * 0.5));
      }
    } catch {
      // Captions are optional; malformed captions are handled by lint/agent review.
    }
  }

  if (times.size === 0) {
    const samples = Math.max(3, Number(samplesFlag || "9"));
    for (let i = 0; i < samples; i++) {
      times.add(roundTime((duration * (i + 0.5)) / samples));
    }
  }

  return [...times]
    .filter((time) => time > 0.05 && time < duration - 0.03)
    .sort((a, b) => a - b)
    .slice(0, maxSamples);
}

function findChromeBinary() {
  const names = process.platform === "win32"
    ? ["chrome-headless-shell.exe", "chrome.exe", "msedge.exe"]
    : ["chrome-headless-shell", "chrome", "google-chrome", "google-chrome-stable", "chromium"];
  const envCandidates = [
    process.env.HYPERFRAMES_CHROME_PATH,
    process.env.PRODUCER_HEADLESS_SHELL_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
  ].filter(Boolean);
  for (const candidate of envCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  const fixed = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      ]
    : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  for (const candidate of fixed) {
    if (existsSync(candidate)) return candidate;
  }

  const roots = [
    join(homedir(), ".cache", "hyperframes", "chrome"),
    join(homedir(), ".cache", "puppeteer"),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "hyperframes") : null,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "puppeteer") : null,
  ].filter(Boolean);

  function scan(root, depth = 0) {
    if (!root || depth > 6 || !existsSync(root)) return null;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = join(root, entry.name);
      if (entry.isFile() && names.includes(entry.name)) return full;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = scan(join(root, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const root of roots) {
    const found = scan(root);
    if (found) return found;
  }
  return null;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForJson(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // Chrome may not have opened the debugging endpoint yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopProcess(child, timeoutMs = 2000) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    child.kill();
  }
  await Promise.race([
    new Promise((resolveStop) => child.once("exit", resolveStop)),
    new Promise((resolveStop) => setTimeout(resolveStop, timeoutMs)),
  ]);
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.seq = 0;
    this.pending = new Map();
  }

  async connect() {
    if (typeof WebSocket === "undefined") {
      throw new Error("Node runtime has no global WebSocket; use Node 22+.");
    }
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: ok, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else ok(msg.result);
      }
    });
    await new Promise((resolveOpen, reject) => {
      this.ws.addEventListener("open", resolveOpen, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
    });
  }

  evaluate(expression, timeoutMs = 30000) {
    const evalPromise = this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }).then((result) => {
      if (result.exceptionDetails) {
        const text = result.exceptionDetails.text || "Runtime.evaluate failed";
        throw new Error(text);
      }
      return result.result?.value;
    });
    return Promise.race([
      evalPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Runtime.evaluate timeout")), timeoutMs)),
    ]);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

function probeScript(time) {
  return `(() => {
    const W = ${JSON.stringify(width)};
    const H = ${JSON.stringify(height)};
    const rootId = ${JSON.stringify(rootId)};
    const t = ${JSON.stringify(time)};
    const captionSafePct = ${JSON.stringify(captionSafePct)};
    const decoRx = /(?:^|[-_\\s])(?:bg|background|deco|decor|decoration|accent|ornament|texture|grain|noise|grid|line|rule|divider|arrow|connector|halo|glow|shadow|shape|blob|circle|ring|stripe|frame|corner|watermark|wallpaper)(?:[-_\\s]|$)/i;
    const out = { time: t, violations: [], warnings: [], atoms: 0, visibleText: 0, visibleMedia: 0, timelineKeys: [], rootId };
    const root = document.querySelector('[data-composition-id="' + rootId + '"]') || document.querySelector('[data-composition-id]') || document.body;
    const timelines = window.__timelines || {};
    out.timelineKeys = Object.keys(timelines);

    function safeSeek(key, localTime) {
      const tl = timelines[key];
      if (!tl || typeof tl.seek !== 'function') return false;
      try { tl.seek(Math.max(0, localTime), false); return true; } catch { return false; }
    }
    safeSeek(rootId, t);
    for (const key of Object.keys(timelines)) {
      if (key === rootId) continue;
      const host = document.querySelector('[data-composition-id="' + key + '"][data-start]');
      const start = host ? Number(host.getAttribute('data-start') || 0) : 0;
      const dur = host ? Number(host.getAttribute('data-duration') || NaN) : NaN;
      if (!host || (!Number.isFinite(dur) || (t >= start && t <= start + dur))) safeSeek(key, t - start);
    }

    for (const el of document.querySelectorAll('[data-start]')) {
      if (el === root) continue;
      const closestRoot = el.closest('[data-composition-id]');
      const rootForEl = closestRoot && closestRoot !== root ? closestRoot : null;
      const rootStart = rootForEl ? Number((document.querySelector('[data-composition-id="' + rootForEl.getAttribute('data-composition-id') + '"][data-start]') || {}).getAttribute?.('data-start') || 0) : 0;
      const localT = Math.max(0, t - rootStart);
      const start = Number(el.getAttribute('data-start') || 0);
      const dur = Number(el.getAttribute('data-duration') || NaN);
      const inWindow = localT >= start && (!Number.isFinite(dur) || localT <= start + dur);
      if (!inWindow) {
        if (!el.dataset.hfLayoutGuardHidden) {
          el.dataset.hfLayoutGuardHidden = '1';
          el.dataset.hfLayoutGuardOldVisibility = el.style.visibility || '';
          el.style.visibility = 'hidden';
        }
      } else if (el.dataset.hfLayoutGuardHidden) {
        el.style.visibility = el.dataset.hfLayoutGuardOldVisibility || '';
        delete el.dataset.hfLayoutGuardHidden;
        delete el.dataset.hfLayoutGuardOldVisibility;
      }
    }

    function chainHas(el, fn) {
      let p = el;
      while (p && p.nodeType === 1 && p !== document.body) {
        if (fn(p)) return true;
        p = p.parentElement;
      }
      return false;
    }
    function isDecor(el) {
      return chainHas(el, (p) =>
        p.hasAttribute('data-layout-decorative') ||
        p.getAttribute('aria-hidden') === 'true' ||
        decoRx.test([p.id, ...Array.from(p.classList || [])].join(' ')));
    }
    function allowOverflow(el) {
      return chainHas(el, (p) => p.hasAttribute('data-layout-allow-overflow'));
    }
    function isCaption(el) {
      return chainHas(el, (p) =>
        /(?:^|[-_\\s])(?:caption|subtitle|subtitles)(?:[-_\\s]|$)/i.test([p.id, ...Array.from(p.classList || [])].join(' ')));
    }
    function effectiveOpacity(el) {
      let opacity = 1;
      let p = el;
      while (p && p.nodeType === 1) {
        const cs = getComputedStyle(p);
        const val = Number(cs.opacity);
        if (Number.isFinite(val)) opacity *= val;
        p = p.parentElement;
      }
      return opacity;
    }
    function visible(el) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || effectiveOpacity(el) < 0.08) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    }
    function selector(el) {
      if (el.id) return '#' + el.id;
      const cls = Array.from(el.classList || []).slice(0, 3);
      return el.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : '');
    }
    function rect(el) {
      const r = el.getBoundingClientRect();
      return {
        left: Math.round(r.left * 10) / 10,
        top: Math.round(r.top * 10) / 10,
        right: Math.round(r.right * 10) / 10,
        bottom: Math.round(r.bottom * 10) / 10,
        width: Math.round(r.width * 10) / 10,
        height: Math.round(r.height * 10) / 10,
      };
    }
    function intersects(a, b, pad = 0) {
      const left = Math.max(a.left, b.left);
      const top = Math.max(a.top, b.top);
      const right = Math.min(a.right, b.right);
      const bottom = Math.min(a.bottom, b.bottom);
      const width = right - left;
      const height = bottom - top;
      return width > pad && height > pad ? { left, top, right, bottom, width, height } : null;
    }
    function addAtom(map, el, kind) {
      if (!visible(el) || isDecor(el)) return;
      const r = rect(el);
      if (r.width >= W * 0.92 && r.height >= H * 0.82) return;
      const key = el.dataset.hfLayoutGuardUid || (el.dataset.hfLayoutGuardUid = String(map.size + 1 + Math.random()));
      if (!map.has(key)) map.set(key, { el, selector: selector(el), kinds: new Set(), rect: r, caption: isCaption(el), allowOverflow: allowOverflow(el) });
      map.get(key).kinds.add(kind);
    }

    const atoms = new Map();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent || !node.textContent.trim()) continue;
      let el = node.parentElement;
      while (el && el !== root && getComputedStyle(el).display.startsWith('inline')) el = el.parentElement;
      if (el && el !== root) addAtom(atoms, el, 'text');
    }
    for (const el of root.querySelectorAll('img, video, canvas, svg')) addAtom(atoms, el, 'media');
    for (const atom of atoms.values()) {
      if (atom.kinds.has('text')) out.visibleText++;
      if (atom.kinds.has('media')) out.visibleMedia++;
      const r = atom.rect;
      const off = {
        left: Math.max(0, -r.left),
        top: Math.max(0, -r.top),
        right: Math.max(0, r.right - W),
        bottom: Math.max(0, r.bottom - H),
      };
      const offBy = Math.max(off.left, off.top, off.right, off.bottom);
      if (offBy > 3 && !atom.allowOverflow) {
        out.violations.push({
          type: 'off_canvas',
          selector: atom.selector,
          kinds: Array.from(atom.kinds),
          rect: r,
          off,
          message: atom.selector + ' leaves the ' + W + 'x' + H + ' canvas',
        });
      }
    }

    const atomList = Array.from(atoms.values());
    const captions = atomList.filter((atom) => atom.caption);
    for (const caption of captions) {
      if (caption.rect.top < H * 0.55) {
        out.warnings.push({ type: 'caption_high', selector: caption.selector, rect: caption.rect, message: 'Caption appears unusually high in the frame.' });
      }
      for (const other of atomList) {
        if (other === caption || other.caption) continue;
        if (caption.el.contains(other.el) || other.el.contains(caption.el)) continue;
        const hit = intersects(caption.rect, other.rect, 4);
        if (hit) {
          out.violations.push({
            type: 'caption_collision',
            selector: caption.selector,
            other: other.selector,
            overlap: hit,
            message: caption.selector + ' overlaps ' + other.selector,
          });
        }
      }
    }

    const safeTop = H * (1 - captionSafePct / 100);
    if (captions.length > 0) {
      for (const atom of atomList) {
        if (atom.caption) continue;
        if (atom.rect.bottom > safeTop && atom.rect.height > 14) {
          out.warnings.push({
            type: 'caption_safe_band',
            selector: atom.selector,
            rect: atom.rect,
            message: atom.selector + ' enters the bottom caption safe band while captions are present.',
          });
        }
      }
    }

    for (let i = 0; i < atomList.length; i++) {
      for (let j = i + 1; j < atomList.length; j++) {
        const a = atomList[i];
        const b = atomList[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        if (a.caption || b.caption) continue;
        const hit = intersects(a.rect, b.rect, 6);
        if (!hit) continue;
        const smaller = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);
        const frac = smaller > 0 ? (hit.width * hit.height) / smaller : 0;
        if (frac > 0.88) continue;
        if (a.kinds.has('text') || b.kinds.has('text')) {
          out.warnings.push({
            type: 'foreground_overlap',
            a: a.selector,
            b: b.selector,
            overlap: hit,
            message: a.selector + ' overlaps ' + b.selector,
          });
        }
      }
    }

    out.atoms = atomList.length;
    if (atomList.length === 0 || (out.visibleText === 0 && out.visibleMedia === 0)) {
      out.violations.push({
        type: 'blank_or_background_only',
        message: 'No visible text or media atoms were found at this sampled frame.',
      });
    }
    return out;
  })()`;
}

async function run() {
  const times = sampledTimes();
  const chrome = findChromeBinary();
  const result = {
    ok: false,
    status: "ok",
    project: projectDir,
    html: htmlPath,
    rootId,
    width,
    height,
    duration,
    sampled_times_s: times,
    violations: [],
    warnings: [],
    samples: [],
  };

  if (!chrome) {
    result.status = "unavailable";
    result.reason =
      "No Chrome/Chrome Headless Shell binary found. Run `npx hyperframes browser ensure` or set HYPERFRAMES_CHROME_PATH.";
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.error(`layout-guard unavailable: ${result.reason}`);
    }
    process.exit(2);
  }

  const port = await freePort();
  const userDataDir = mkdtempSync(join(tmpdir(), "hf-layout-guard-"));
  const fileUrl = pathToFileURL(htmlPath).href;
  const headlessFlag = basename(chrome).toLowerCase().includes("headless-shell")
    ? "--headless"
    : "--headless=new";
  const chromeArgs = [
    headlessFlag,
    "--disable-gpu",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-web-security",
    "--allow-file-access-from-files",
    "--autoplay-policy=no-user-gesture-required",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${Math.round(width)},${Math.round(height)}`,
    fileUrl,
  ];

  const child = spawn(chrome, chromeArgs, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  let cdp;
  try {
    const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`, 12000);
    const pageTarget =
      targets.find((targetInfo) => targetInfo.type === "page" && targetInfo.webSocketDebuggerUrl) ||
      targets.find((targetInfo) => targetInfo.webSocketDebuggerUrl);
    if (!pageTarget) throw new Error("Chrome did not expose a page debugging target.");

    cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.evaluate(`new Promise((resolve) => {
      const done = () => resolve(true);
      if (document.readyState === 'complete' || document.readyState === 'interactive') done();
      else window.addEventListener('DOMContentLoaded', done, { once: true });
    })`);
    await cdp.evaluate(`document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true).catch(() => true) : true`);
    await cdp.evaluate(`new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (window.__timelines && Object.keys(window.__timelines).length > 0) return resolve(true);
        if (Date.now() - started > 5000) return resolve(false);
        setTimeout(tick, 80);
      };
      tick();
    })`, 7000);

    for (const time of times) {
      const sample = await cdp.evaluate(probeScript(time), 20000);
      result.samples.push(sample);
      for (const violation of sample.violations || []) result.violations.push({ time, ...violation });
      for (const warning of sample.warnings || []) result.warnings.push({ time, ...warning });
    }
  } catch (error) {
    result.status = "unavailable";
    result.reason = error.message;
    if (stderr.trim()) result.chrome_stderr_tail = stderr.trim().split("\n").slice(-8).join("\n");
  } finally {
    if (cdp) cdp.close();
    await stopProcess(child);
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      result.cleanup_warning = `Could not remove temporary Chrome profile: ${userDataDir}`;
    }
  }

  result.ok = result.status === "ok" && result.violations.length === 0;

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.status !== "ok") {
    console.error(`layout-guard unavailable: ${result.reason}`);
    if (result.chrome_stderr_tail) console.error(result.chrome_stderr_tail);
  } else {
    console.log(
      `layout-guard: ${times.length} sample(s), ${result.violations.length} violation(s), ${result.warnings.length} warning(s)`,
    );
    for (const violation of result.violations.slice(0, 30)) {
      console.error(`  [${violation.time}s] ${violation.type}: ${violation.message}`);
    }
    if (result.violations.length > 30) {
      console.error(`  ... ${result.violations.length - 30} more violation(s)`);
    }
    for (const warning of result.warnings.slice(0, 20)) {
      console.warn(`  [${warning.time}s] warning ${warning.type}: ${warning.message}`);
    }
    if (result.warnings.length > 20) console.warn(`  ... ${result.warnings.length - 20} more warning(s)`);
  }

  if (result.status !== "ok") process.exit(2);
  if (result.violations.length) process.exit(1);
  process.exit(0);
}

run().catch((error) => {
  console.error(`layout-guard failed: ${error.stack || error.message}`);
  process.exit(2);
});
