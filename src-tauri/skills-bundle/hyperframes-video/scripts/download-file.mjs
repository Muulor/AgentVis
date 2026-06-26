#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { get } from "node:https";
import { dirname } from "node:path";

export const DEFAULT_PROGRESS_FIRST_MS = 15_000;
export const DEFAULT_PROGRESS_INTERVAL_MS = 30_000;
const PROGRESS_SUMMARY_MIN_BYTES = 8 * 1024 * 1024;

export function parsePositiveMilliseconds(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number of milliseconds.`);
  }
  return parsed;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return String(bytes);
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function formatDuration(ms) {
  const seconds = Math.max(0.1, ms / 1000);
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60).toString().padStart(2, "0");
  return `${minutes}m${rest}s`;
}

function cleanupPartial(tmp) {
  try {
    unlinkSync(tmp);
  } catch {
    // ignore cleanup errors
  }
}

export function downloadFile(
  url,
  target,
  {
    allowedStatusCodes = [200],
    firstProgressMs = DEFAULT_PROGRESS_FIRST_MS,
    progressIntervalMs = DEFAULT_PROGRESS_INTERVAL_MS,
    progressLabel = target,
    redirects = 5,
    timeoutMs = null,
    userAgent = "hyperframes-video-model-download",
  } = {},
) {
  ensureDir(dirname(target));
  const tmp = `${target}.part`;
  if (existsSync(tmp)) unlinkSync(tmp);

  return new Promise((resolvePromise, reject) => {
    let expectedBytes = 0;
    let firstProgressTimer = null;
    let lastLoggedBytes = 0;
    let progressLogged = false;
    let progressTimer = null;
    let receivedBytes = 0;
    const startedAt = Date.now();

    const clearProgress = () => {
      if (firstProgressTimer) clearTimeout(firstProgressTimer);
      if (progressTimer) clearInterval(progressTimer);
      firstProgressTimer = null;
      progressTimer = null;
    };

    const elapsedMs = () => Math.max(1, Date.now() - startedAt);
    const averageSpeed = () => receivedBytes / Math.max(0.1, elapsedMs() / 1000);
    const totalText = () => (expectedBytes > 0 ? ` / ${formatBytes(expectedBytes)}` : "");

    const logProgress = () => {
      if (receivedBytes === lastLoggedBytes) return;
      lastLoggedBytes = receivedBytes;
      progressLogged = true;
      console.error(
        `Progress: ${progressLabel}: ${formatBytes(receivedBytes)}${totalText()} downloaded, ` +
          `${formatBytes(averageSpeed())}/s, elapsed ${formatDuration(elapsedMs())}`,
      );
    };

    const scheduleProgress = () => {
      const intervalMs = Math.max(1, progressIntervalMs);
      const firstDelayMs = Math.max(1, Math.min(firstProgressMs, intervalMs));
      firstProgressTimer = setTimeout(() => {
        logProgress();
        progressTimer = setInterval(logProgress, intervalMs);
      }, firstDelayMs);
    };

    const logComplete = () => {
      const shouldSummarize =
        progressLogged ||
        receivedBytes >= PROGRESS_SUMMARY_MIN_BYTES ||
        elapsedMs() >= Math.min(firstProgressMs, progressIntervalMs);
      if (!shouldSummarize) return;
      console.error(
        `Downloaded: ${progressLabel}: ${formatBytes(receivedBytes)}${totalText()} in ` +
          `${formatDuration(elapsedMs())}, avg ${formatBytes(averageSpeed())}/s`,
      );
    };

    const fail = (error) => {
      clearProgress();
      cleanupPartial(tmp);
      reject(error);
    };

    const request = get(
      url,
      {
        headers: {
          "user-agent": userAgent,
        },
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          if (redirects <= 0) {
            reject(new Error(`Too many redirects while downloading ${url}`));
            return;
          }
          downloadFile(new URL(response.headers.location, url).toString(), target, {
            allowedStatusCodes,
            firstProgressMs,
            progressIntervalMs,
            progressLabel,
            redirects: redirects - 1,
            timeoutMs,
            userAgent,
          })
            .then(resolvePromise)
            .catch(reject);
          return;
        }

        if (!allowedStatusCodes.includes(response.statusCode)) {
          response.resume();
          reject(new Error(`Download failed (${response.statusCode}) for ${url}`));
          return;
        }

        expectedBytes = Number(response.headers["content-length"] || 0);
        scheduleProgress();
        const file = createWriteStream(tmp);
        response.on("data", (chunk) => {
          receivedBytes += chunk.length;
        });
        response.pipe(file);
        file.on("finish", () => {
          file.close(() => {
            clearProgress();
            if (expectedBytes > 0 && receivedBytes !== expectedBytes) {
              cleanupPartial(tmp);
              reject(
                new Error(
                  `Download incomplete for ${url}: received ${receivedBytes} of ${expectedBytes} bytes`,
                ),
              );
              return;
            }
            logComplete();
            renameSync(tmp, target);
            resolvePromise({
              bytes: receivedBytes,
              elapsedMs: elapsedMs(),
              expectedBytes,
              progressLogged,
            });
          });
        });
        file.on("error", fail);
      },
    );

    if (timeoutMs) {
      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`Download timed out after ${timeoutMs} ms`));
      });
    }
    request.on("error", fail);
  });
}
