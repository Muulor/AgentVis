export function createImageDataUrl(mimeType: string, base64: string): string | null {
  const trimmedBase64 = base64.trim();
  if (!trimmedBase64) {
    return null;
  }

  return `data:${mimeType};base64,${trimmedBase64}`;
}
