/**
 * PreviewUrlPolicy - allow-list for URLs that may be rendered in project preview iframes.
 *
 * AgentVis owns the Vite preview servers it starts on the managed localhost port
 * range. Other local web servers started by arbitrary exec tasks must not be
 * promoted into the app's main WebView or project preview frame.
 */

const PREVIEW_HOSTS = new Set(['localhost', '127.0.0.1']);

export const PREVIEW_PORT_RANGE_START = 3100;
export const PREVIEW_PORT_RANGE_END = 3199;

export function getManagedPreviewPort(url: string | null | undefined): number | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);

    if (
      parsed.protocol !== 'http:' ||
      !PREVIEW_HOSTS.has(parsed.hostname) ||
      !Number.isInteger(port) ||
      port < PREVIEW_PORT_RANGE_START ||
      port > PREVIEW_PORT_RANGE_END
    ) {
      return null;
    }

    return port;
  } catch {
    return null;
  }
}

export function isManagedPreviewUrl(url: string | null | undefined): url is string {
  return getManagedPreviewPort(url) !== null;
}
