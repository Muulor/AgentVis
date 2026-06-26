#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);

function usage(exitCode = 0) {
  console.log(`Generate script-derived captions for MOSS narrated HyperFrames videos

Usage:
  moss-captions.mjs [project] [options]

Inputs:
  project/narrator_scripts.json
  project/audio_meta.json

Options:
  --audio-meta <file>       Defaults to <project>/audio_meta.json
  --narrator-scripts <file> Defaults to <project>/narrator_scripts.json
  --out <file>              Defaults to <project>/captions.json
  --language <code>         Defaults to audio_meta.language or narrator language
  --gap-s <n>               Scene gap used when sequencing scenes (default: 0.01)
  --caption-gap-s <n>       Shorten adjacent caption ends by this gap (default: 0.01)
  --max-chars <n>           Preferred caption chunk length (default: 20 zh, 42 otherwise)
  --min-chars <n>           Merge shorter orphan chunks when possible (default: 4 zh, 10 otherwise)
  --hard-max-chars <n>      Absolute chunk length before balanced splitting (default: soft + margin)
  --track-index <n>         Suggested caption track index (default: 20)
`);
  process.exit(exitCode);
}

function takeFlag(name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  args.splice(index, value && !value.startsWith("--") ? 2 : 1);
  return value && !value.startsWith("--") ? value : fallback;
}

function hasFlag(name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function ensureParent(path) {
  const parent = dirname(resolve(path));
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
}

function stripCaptionTags(text) {
  return String(text || "").replace(/<\/?(em|brand|emph|cta)\b[^>]*>/gi, "");
}

function sceneIdFor(scene, index) {
  const number = scene.sceneNumber ?? index + 1;
  const raw = scene.sceneId || `scene_${number}`;
  return String(raw).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function normalizeText(text) {
  return stripCaptionTags(text).replace(/\s+/g, " ").trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function visibleLength(text) {
  return Array.from(String(text || "").replace(/\s/g, "")).length;
}

function isCjkLanguage(language) {
  return /^(zh|ja|ko)\b/i.test(String(language || ""));
}

function joinCaptionChunks(left, right, separator = "") {
  if (!left) return right;
  if (!right) return left;
  const glue = separator && left && right ? separator : "";
  return `${left}${glue}${right}`;
}

function splitLongText(text, hardMaxChars) {
  const chars = Array.from(text.trim());
  if (!chars.length) return [];
  if (visibleLength(text) <= hardMaxChars) return [text.trim()];

  const chunkCount = Math.ceil(visibleLength(text) / hardMaxChars);
  const chunkSize = Math.ceil(chars.length / chunkCount);
  const chunks = [];
  for (let index = 0; index < chars.length; index += chunkSize) {
    const chunk = chars.slice(index, index + chunkSize).join("").trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

function mergeShortChunks(chunks, minChars, hardMaxChars, separator = "") {
  const cleaned = chunks.map((chunk) => chunk.trim()).filter(Boolean);
  if (cleaned.length < 2) return cleaned;

  const result = [];
  for (let index = 0; index < cleaned.length; index += 1) {
    const chunk = cleaned[index];
    const isOrphan = visibleLength(chunk) <= minChars;

    if (isOrphan && result.length) {
      const merged = joinCaptionChunks(result[result.length - 1], chunk, separator);
      if (visibleLength(merged) <= hardMaxChars || index === cleaned.length - 1) {
        result[result.length - 1] = merged;
        continue;
      }
    }

    if (isOrphan && index + 1 < cleaned.length) {
      cleaned[index + 1] = joinCaptionChunks(chunk, cleaned[index + 1], separator);
      continue;
    }

    result.push(chunk);
  }

  return result;
}

function splitCjkPhrases(text) {
  const breakPattern = /[\u3002\uff01\uff1f\uff1b\uff1a\uff0c\u3001,.!?;:]/u;
  const phrases = [];
  let current = "";

  for (const char of Array.from(text)) {
    current += char;
    if (breakPattern.test(char)) {
      const phrase = current.trim();
      if (phrase) phrases.push(phrase);
      current = "";
    }
  }

  const tail = current.trim();
  if (tail) phrases.push(tail);
  return phrases.length ? phrases : [text];
}

function cjkChunks(text, maxChars, minChars, hardMaxChars) {
  const parts = splitCjkPhrases(text);
  const chunks = [];
  const shortTailLimit = Math.max(minChars, Math.ceil(maxChars * 0.35));
  let current = "";

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;

    if (visibleLength(part) > hardMaxChars) {
      if (current) chunks.push(current);
      chunks.push(...splitLongText(part, hardMaxChars));
      current = "";
      continue;
    }

    const candidate = joinCaptionChunks(current, part);
    const candidateLength = visibleLength(candidate);
    const partLength = visibleLength(part);
    if (!current || candidateLength <= maxChars || (partLength <= shortTailLimit && candidateLength <= hardMaxChars)) {
      current = candidate;
    } else {
      chunks.push(current);
      current = part;
    }
  }

  if (current) chunks.push(current);
  const normalized = chunks.length ? chunks : splitLongText(text, hardMaxChars);
  return mergeShortChunks(normalized, minChars, hardMaxChars);
}

function wordChunks(text, maxChars, minChars, hardMaxChars) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = "";

  for (const word of words) {
    if (visibleLength(word) > hardMaxChars) {
      if (current) chunks.push(current);
      chunks.push(...splitLongText(word, hardMaxChars));
      current = "";
      continue;
    }

    const candidate = joinCaptionChunks(current, word, " ");
    if (!current || visibleLength(candidate) <= maxChars) {
      current = candidate;
    } else {
      chunks.push(current);
      current = word;
    }
  }

  if (current) chunks.push(current);
  return mergeShortChunks(chunks, minChars, hardMaxChars, " ");
}

function splitCaptionText(text, language, maxChars, minChars, hardMaxChars) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  if (isCjkLanguage(language) || /[\u3400-\u9fff]/.test(normalized)) {
    return cjkChunks(normalized, maxChars, minChars, hardMaxChars);
  }
  return wordChunks(normalized, maxChars, minChars, hardMaxChars);
}

function roundTime(value) {
  return Number(value.toFixed(3));
}

function durationFor(meta) {
  const parsed = Number(meta?.voiceDuration);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

if (hasFlag("--help") || hasFlag("-h")) usage(0);

const positionalProject = args[0] && !args[0].startsWith("--") ? args.shift() : null;
const project = resolve(positionalProject || ".");
const audioMetaPath = resolve(takeFlag("--audio-meta", join(project, "audio_meta.json")));
const narratorPath = resolve(takeFlag("--narrator-scripts", join(project, "narrator_scripts.json")));
const outPath = resolve(takeFlag("--out", join(project, "captions.json")));

if (!existsSync(audioMetaPath)) {
  console.error(`audio_meta.json not found: ${audioMetaPath}`);
  process.exit(1);
}
if (!existsSync(narratorPath)) {
  console.error(`narrator_scripts.json not found: ${narratorPath}`);
  process.exit(1);
}

const audioMeta = readJson(audioMetaPath);
const narrator = readJson(narratorPath);
const language = takeFlag("--language", audioMeta.language || narrator.language || "zh");
const defaultMaxChars = isCjkLanguage(language) ? "20" : "42";
const maxChars = Number(takeFlag("--max-chars", defaultMaxChars));

if (!Number.isFinite(maxChars) || maxChars < 4) {
  console.error("--max-chars must be a number >= 4.");
  process.exit(1);
}

const defaultMinChars = isCjkLanguage(language) ? "4" : "10";
const minChars = Number(takeFlag("--min-chars", defaultMinChars));
const defaultHardMaxChars = isCjkLanguage(language)
  ? String(maxChars + Math.max(6, Math.ceil(maxChars * 0.35)))
  : String(maxChars + 16);
const hardMaxChars = Number(takeFlag("--hard-max-chars", defaultHardMaxChars));
const gapS = Number(takeFlag("--gap-s", "0.01"));
const captionGapS = Number(takeFlag("--caption-gap-s", "0.01"));
const trackIndex = Number(takeFlag("--track-index", "20"));

if (!Number.isFinite(minChars) || minChars < 1 || minChars >= hardMaxChars) {
  console.error("--min-chars must be a number >= 1 and smaller than --hard-max-chars.");
  process.exit(1);
}
if (!Number.isFinite(hardMaxChars) || hardMaxChars < maxChars) {
  console.error("--hard-max-chars must be a number >= --max-chars.");
  process.exit(1);
}
if (!Number.isFinite(gapS) || gapS < 0) {
  console.error("--gap-s must be a non-negative number.");
  process.exit(1);
}
if (!Number.isFinite(captionGapS) || captionGapS < 0) {
  console.error("--caption-gap-s must be a non-negative number.");
  process.exit(1);
}

const scriptScenes = (narrator.scenes || []).map((scene, index) => ({
  sceneId: sceneIdFor(scene, index),
  sceneNumber: Number(scene.sceneNumber) || index + 1,
  sceneName: scene.sceneName || scene.title || "",
  script: scene.script || scene.narration || scene.text || scene.voiceover || "",
}));

let cursor = 0;
const captions = [];
const scenes = {};
const padStart = Number(audioMeta.audio_pad_start_ms || 0) / 1000;
const padEnd = Number(audioMeta.audio_pad_end_ms || 0) / 1000;

for (const scene of scriptScenes) {
  const meta = audioMeta.scenes?.[scene.sceneId];
  const voiceDuration = durationFor(meta);
  if (!meta || voiceDuration <= 0) continue;

  const sceneStart = cursor;
  const sceneEnd = sceneStart + voiceDuration;
  const activeStart = Math.min(sceneEnd, sceneStart + padStart);
  const activeEnd = Math.max(activeStart, sceneEnd - padEnd);
  const activeDuration = Math.max(0.2, activeEnd - activeStart);
  const chunks = splitCaptionText(scene.script, language, maxChars, minChars, hardMaxChars);
  const weights = chunks.map((chunk) => Math.max(1, visibleLength(chunk)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || chunks.length || 1;
  let captionCursor = activeStart;

  chunks.forEach((text, index) => {
    const remaining = chunks.length - index;
    const duration =
      index === chunks.length - 1
        ? activeEnd - captionCursor
        : Math.min(
            activeEnd - captionCursor - (remaining - 1) * 0.2,
            (activeDuration * weights[index]) / totalWeight,
          );
    const start = roundTime(captionCursor);
    const end = roundTime(Math.max(captionCursor + 0.2, captionCursor + duration));
    const rawEnd = Math.min(roundTime(activeEnd), end);
    const safeEnd =
      index < chunks.length - 1 && rawEnd - start > captionGapS + 0.2
        ? roundTime(rawEnd - captionGapS)
        : rawEnd;
    captions.push({
      id: `${scene.sceneId}_caption_${index + 1}`,
      sceneId: scene.sceneId,
      sceneNumber: scene.sceneNumber,
      start,
      end: safeEnd,
      text,
      trackIndex,
    });
    captionCursor = Math.min(activeEnd, end);
  });

  scenes[scene.sceneId] = {
    start: roundTime(sceneStart),
    end: roundTime(sceneEnd),
    voicePath: meta.voicePath || "",
    scriptPath: meta.scriptPath || "",
    captionCount: chunks.length,
  };
  cursor = sceneEnd + gapS;
}

const output = {
  source: "narrator_scripts+audio_meta",
  mode: "script-derived-captions",
  language,
  max_chars: maxChars,
  min_chars: minChars,
  hard_max_chars: hardMaxChars,
  caption_gap_s: captionGapS,
  safe_zone: "bottom",
  style_hint: "plain-readable",
  total_duration_s: roundTime(Math.max(0, cursor - gapS)),
  audio_pad_start_ms: audioMeta.audio_pad_start_ms || 0,
  audio_pad_end_ms: audioMeta.audio_pad_end_ms || 0,
  scenes,
  captions,
};

ensureParent(outPath);
writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

console.log(`Wrote ${outPath}`);
console.log(`Captions: ${captions.length}`);
