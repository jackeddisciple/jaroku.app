const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu;
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

export const MAX_ERROR_CHARS = 600;

export function cleanText(text: string, max: number): string {
  const stripped = text.replace(ANSI_ESCAPE, "").replace(CONTROL_CHARS, "");
  return stripped.length > max ? `${stripped.slice(0, max)}… (truncated by Jaroku)` : stripped;
}

export function boundedError(text: string): string {
  return cleanText(text, MAX_ERROR_CHARS)
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\s+/g, " ")
    .trim();
}
