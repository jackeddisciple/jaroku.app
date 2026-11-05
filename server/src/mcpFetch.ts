import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable, Transform } from "node:stream";

export type McpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const REDIRECT_REFUSAL =
  "this server redirected to a different address, which Jaroku does not follow. Give its final URL.";

const MAX_REDIRECTS = 3;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const NO_BODY_STATUS = new Set([204, 205, 304]);
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function byteLimited(res: IncomingMessage): Readable {
  let seen = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen <= MAX_RESPONSE_BYTES) return done(null, chunk);
      res.destroy();
      done(new Error("this server's response was too large, so Jaroku stopped reading it"));
    },
  });
  res.on("error", (err) => limit.destroy(err));
  return res.pipe(limit);
}

function exchange(url: URL, init: RequestInit): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: init.method ?? "GET",
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        agent: false,
        signal: init.signal ?? undefined,
      },
      resolve,
    );
    req.on("error", reject);
    req.end(typeof init.body === "string" ? init.body : undefined);
  });
}

function toResponse(res: IncomingMessage): Response {
  const status = res.statusCode ?? 502;
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  if (NO_BODY_STATUS.has(status)) {
    res.destroy();
    return new Response(null, { status, headers });
  }
  return new Response(Readable.toWeb(byteLimited(res)) as ReadableStream, { status, headers });
}

export interface GuardOptions {
  deadline?: AbortSignal;
}

export const guardedFetchWith = (guard: GuardOptions = {}): McpFetch => async (input, init = {}) => {
  let url = new URL(String(input));
  const origin = url.origin;
  const signals = [init.signal, guard.deadline].filter((s): s is AbortSignal => Boolean(s));
  const bounded: RequestInit = { ...init, signal: signals.length > 0 ? AbortSignal.any(signals) : undefined };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await exchange(url, bounded);
    const location = res.headers.location;
    if (!REDIRECT_STATUS.has(res.statusCode ?? 0) || !location) return toResponse(res);
    res.destroy();
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new Error(REDIRECT_REFUSAL);
    }
    if (next.origin !== origin) throw new Error(REDIRECT_REFUSAL);
    next.username = "";
    next.password = "";
    url = next;
  }
  throw new Error(REDIRECT_REFUSAL);
};

export const guardedFetch = guardedFetchWith();
