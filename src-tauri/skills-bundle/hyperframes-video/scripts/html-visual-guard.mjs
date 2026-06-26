#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);

function usage(exitCode = 0) {
  console.log(`Static visual guard for HyperFrames HTML

Usage:
  html-visual-guard.mjs [project-or-html]

Checks common "background plus audio only" failures before browser validation.
`);
  process.exit(exitCode);
}

if (args.includes("--help") || args.includes("-h")) usage(0);

const target = resolve(args[0] || ".");
const htmlPath = existsSync(target) && target.toLowerCase().endsWith(".html") ? target : join(target, "index.html");

if (!existsSync(htmlPath)) {
  console.error(`HTML file not found: ${htmlPath}`);
  process.exit(1);
}

const html = readFileSync(htmlPath, "utf8").replace(/^\uFEFF/, "");
const htmlDir = dirname(htmlPath);
const failures = [];
const warnings = [];

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? match[1] : "";
}

const rootMatch = html.match(/<([a-z0-9-]+)\b[^>]*data-composition-id\s*=\s*["']([^"']+)["'][^>]*>/i);
if (!rootMatch) {
  fail("Missing top-level element with data-composition-id.");
} else {
  const rootTag = rootMatch[0];
  const compositionId = rootMatch[2];
  if (attr(rootTag, "data-start") !== "0") {
    fail(`Root composition "${compositionId}" must include data-start="0".`);
  }
  const timelinePattern = new RegExp(`window\\.__timelines\\s*\\[\\s*["']${compositionId}["']\\s*\\]`, "m");
  if (!timelinePattern.test(html)) {
    fail(`Timeline registry key must match data-composition-id "${compositionId}".`);
  }
}

const sceneClassRules = [
  ...html.matchAll(/\.scene(?:\s|[.#:[,{>+~])[^{}]*\{[^{}]*opacity\s*:\s*0(?:\.0+)?\b[^{}]*\}/gim),
];
for (const match of sceneClassRules) {
  fail(
    `Scene root CSS makes scenes invisible: ${match[0]
      .replace(/\s+/g, " ")
      .slice(0, 140)}. Remove opacity:0 from .scene roots; animate children instead.`,
  );
}

const clipTags = [...html.matchAll(/<(section|div)\b[^>]*class\s*=\s*["'][^"']*\bclip\b[^"']*["'][^>]*>/gim)].map(
  (match) => match[0],
);
const sceneClipTags = clipTags.filter((tag) => /\bscene\b/i.test(attr(tag, "class")));

if (sceneClipTags.length === 0) {
  warn("No scene clip found. Add at least one visible <section class=\"scene clip\" ...> for generated videos.");
}

for (const tag of sceneClipTags) {
  const id = attr(tag, "id") || "(missing id)";
  const style = attr(tag, "style");
  if (/opacity\s*:\s*0(?:\.0+)?\b/i.test(style)) {
    fail(`Scene clip ${id} has inline opacity:0. Remove it or set the scene visible at its data-start.`);
  }
  for (const required of ["data-start", "data-duration", "data-track-index"]) {
    if (!attr(tag, required)) fail(`Scene clip ${id} is missing ${required}.`);
  }
}

if (/\bMath\.random\s*\(/.test(html)) {
  fail("Render path uses unseeded Math.random(). Use fixed data or a seeded helper.");
}
if (/fonts\.(googleapis|gstatic)\.com/i.test(html)) {
  fail(
    "Composition loads Google Fonts at render time. Use system font stacks or bundle local font files with @font-face.",
  );
}
if (/@import\s+(?:url\()?["']?https?:\/\//i.test(html)) {
  fail("Composition uses external CSS @import. Bundle assets locally or inline deterministic CSS.");
}
if (/\b(Date\.now|performance\.now)\s*\(/.test(html)) {
  fail("Render path uses wall-clock time. HyperFrames renders must be deterministic.");
}
if (/repeat\s*:\s*-1\b/.test(html)) {
  fail("Timeline uses repeat:-1. Use finite repeats based on clip duration.");
}

const mountedCompositionTags = [...html.matchAll(/<([a-z0-9-]+)\b[^>]*data-composition-src\s*=\s*["'][^"']+["'][^>]*>/gim)].map(
  (match) => match[0],
);

for (const tag of mountedCompositionTags) {
  const src = attr(tag, "data-composition-src");
  const hostId = attr(tag, "data-composition-id") || "(missing data-composition-id)";
  const subPath = resolve(htmlDir, src);
  if (!existsSync(subPath)) {
    fail(`Mounted sub-composition "${hostId}" points to missing file: ${src}.`);
    continue;
  }

  const subHtml = readFileSync(subPath, "utf8").replace(/^\uFEFF/, "");
  const hasTemplate = /<template\b/i.test(subHtml);
  if (!hasTemplate) {
    fail(
      `Mounted sub-composition "${hostId}" (${src}) is a standalone HTML file, not a <template> sub-composition. Files referenced by data-composition-src must wrap the root composition in <template>; standalone <!doctype>/<html>/<body> files can snapshot but render blank when mounted.`,
    );
  }

  const innerIdMatch = subHtml.match(/data-composition-id\s*=\s*["']([^"']+)["']/i);
  if (!innerIdMatch) {
    fail(`Mounted sub-composition "${hostId}" (${src}) has no inner data-composition-id.`);
  } else if (innerIdMatch[1] !== hostId) {
    fail(
      `Mounted sub-composition id mismatch: host uses "${hostId}" but ${src} contains "${innerIdMatch[1]}". Host id, inner id, and timeline key must match.`,
    );
  }

  const subTimelinePattern = new RegExp(`window\\.__timelines\\s*\\[\\s*["']${hostId}["']\\s*\\]`, "m");
  if (!subTimelinePattern.test(subHtml)) {
    fail(`Mounted sub-composition "${hostId}" (${src}) does not register window.__timelines["${hostId}"].`);
  }

  if (/fonts\.(googleapis|gstatic)\.com/i.test(subHtml)) {
    fail(`Mounted sub-composition "${hostId}" (${src}) loads Google Fonts at render time.`);
  }
  if (/@import\s+(?:url\()?["']?https?:\/\//i.test(subHtml)) {
    fail(`Mounted sub-composition "${hostId}" (${src}) uses external CSS @import.`);
  }
}

for (const message of warnings) console.warn(`Warning: ${message}`);
if (failures.length) {
  console.error(`Visual guard failed for ${htmlPath}`);
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}

console.log(`Visual guard passed: ${htmlPath}`);
