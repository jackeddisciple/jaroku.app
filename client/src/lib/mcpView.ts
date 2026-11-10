const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

export interface EndpointProblem {
  message: string;
  suggestion: string | null;
}

function parsed(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

export function endpointHost(endpoint: string): string {
  const text = endpoint.trim();
  return parsed(text)?.host || text;
}

export function endpointProblem(raw: string): EndpointProblem | null {
  const text = raw.trim();
  if (!text) return null;
  if (/\s/.test(text)) return { message: "An address cannot contain a space, so this was not sent.", suggestion: null };
  if (/^stdio:/i.test(text)) {
    return {
      message: "A stdio server is not supported, because it would mean running someone else's program on your machine. Give the server's http(s) address.",
      suggestion: null,
    };
  }
  if (!SCHEME.test(text)) {
    const candidate = `${LOCAL_HOST.test(text) ? "http" : "https"}://${text.replace(/^\/+/, "")}`;
    const url = parsed(candidate);
    return {
      message: "This address has no scheme, so it was not sent. It must start with https:// or http://.",
      suggestion: url && url.hostname ? candidate : null,
    };
  }
  const url = parsed(text);
  if (!url) return { message: "This is not a valid address, so it was not sent. Check it for a typo.", suggestion: null };
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { message: `Only https:// and http:// addresses are supported, not ${url.protocol}//, so this was not sent.`, suggestion: null };
  }
  if (!url.hostname) return { message: "This address has no host, so it was not sent.", suggestion: null };
  return null;
}

export function typingScheme(raw: string): boolean {
  const typed = raw.trim().toLowerCase();
  return typed.length > 0 && ("https://".startsWith(typed) || "http://".startsWith(typed));
}

export function endpointHint(raw: string): EndpointProblem | null {
  const problem = endpointProblem(raw);
  if (!problem) return null;
  const text = raw.trim();
  if (typingScheme(text)) return null;
  return /[.:/\s]/.test(text) ? problem : null;
}
