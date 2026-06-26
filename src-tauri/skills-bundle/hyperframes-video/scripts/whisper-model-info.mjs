import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

const MIB = 1024 * 1024;

export function whisperModelFilename(model) {
  return `ggml-${model}.bin`;
}

export function whisperModelPath(model, modelDir) {
  return join(modelDir, whisperModelFilename(model));
}

export function whisperExpectedMinBytes(model) {
  const normalized = model.toLowerCase();
  if (normalized.includes("large")) return 900 * MIB;
  if (normalized.includes("medium")) return normalized.includes("q") ? 450 * MIB : 700 * MIB;
  if (normalized.includes("small")) {
    if (normalized.includes("q5")) return 140 * MIB;
    if (normalized.includes("q8")) return 200 * MIB;
    return 400 * MIB;
  }
  if (normalized.includes("base")) return normalized.includes("q") ? 50 * MIB : 100 * MIB;
  if (normalized.includes("tiny")) return normalized.includes("q") ? 20 * MIB : 50 * MIB;
  return MIB;
}

function isGitLfsPointer(file) {
  const buffer = Buffer.alloc(160);
  let fd = null;
  try {
    fd = openSync(file, "r");
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    return head.includes("version https://git-lfs.github.com/spec/v1");
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function whisperModelStatus(model, modelDir) {
  const path = whisperModelPath(model, modelDir);
  const expectedMinBytes = whisperExpectedMinBytes(model);
  if (!existsSync(path)) {
    return { ok: false, reason: "missing", size: 0, expectedMinBytes, path };
  }
  const size = statSync(path).size;
  if (size < expectedMinBytes) {
    return { ok: false, reason: "too_small", size, expectedMinBytes, path };
  }
  if (isGitLfsPointer(path)) {
    return { ok: false, reason: "git_lfs_pointer", size, expectedMinBytes, path };
  }
  return { ok: true, reason: null, size, expectedMinBytes, path };
}
