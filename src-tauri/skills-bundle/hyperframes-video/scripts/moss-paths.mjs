import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultMossModelDir() {
  const configured = process.env.HYPERFRAMES_VIDEO_MOSS_MODELS_DIR;
  if (configured) return resolve(configured);

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(localAppData, "hyperframes-video", "moss-onnx");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "hyperframes-video", "moss-onnx");
  }

  const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cacheHome, "hyperframes-video", "moss-onnx");
}
