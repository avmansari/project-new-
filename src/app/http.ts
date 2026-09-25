import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public headers: Record<string, string> = {}
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Har response pe lagne wale security headers. Scripts sirf apni ('self'), inline script nahi => XSS ka asar kam. */
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...extra,
  });
  res.end(data);
}

/** JSON body padho: Content-Type check, size limit, valid JSON. */
export async function readJson(req: IncomingMessage, limitBytes = 4096): Promise<unknown> {
  const ct = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (ct !== "application/json") throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type: application/json chahiye");
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limitBytes) throw new HttpError(413, "BODY_TOO_LARGE", "Body bahut bada hai", { Connection: "close" });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limitBytes) throw new HttpError(413, "BODY_TOO_LARGE", "Body bahut bada hai", { Connection: "close" });
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "BAD_JSON", "Body valid JSON nahi hai");
  }
}

/** Raw body padho (koi JSON parse nahi), size limit ke saath. Multipart uploads ke liye. */
export async function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limitBytes) throw new HttpError(413, "BODY_TOO_LARGE", "Body bahut bada hai", { Connection: "close" });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limitBytes) throw new HttpError(413, "BODY_TOO_LARGE", "Body bahut bada hai", { Connection: "close" });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Simple sliding-window rate limiter (memory mein, per key). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private windowMs: number,
    private max: number
  ) {}

  check(key: string, now: number = Date.now()): { ok: boolean; retryAfterSec: number } {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((arr[0] + this.windowMs - now) / 1000)) };
    }
    arr.push(now);
    this.hits.set(key, arr);
    return { ok: true, retryAfterSec: 0 };
  }

  sweep(now: number = Date.now()): void {
    for (const [k, arr] of this.hits) {
      if (arr.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** web/ folder se file dena. Sirf allow-listed extensions, aur folder ke bahar kuch nahi (path traversal band). */
export async function serveStatic(webDir: string, urlPath: string, res: ServerResponse): Promise<boolean> {
  let p: string;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return false;
  }
  if (p === "/") p = "/index.html";
  if (p.includes("\0") || p.includes("\\")) return false;
  const root = resolve(webDir);
  const full = resolve(root, "." + p);
  if (full !== root && !full.startsWith(root + sep)) return false;
  const type = MIME[extname(full).toLowerCase()];
  if (!type) return false;
  try {
    const data = await readFile(full);
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": data.length,
      "Cache-Control": "no-cache",
      ...SECURITY_HEADERS,
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

/** Ek file (image) bhejo: ETag + 304, nosniff, sirf hamare origin ko. `abs` hamesha hamara banaya hua path hai. */
export async function sendFile(req: IncomingMessage, res: ServerResponse, abs: string, mime: string, etag: string): Promise<void> {
  const quoted = `"${etag}"`;
  const base = {
    "Content-Type": mime,
    ETag: quoted,
    "Cache-Control": "no-cache",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Disposition": "inline",
    ...SECURITY_HEADERS,
  };
  if (req.headers["if-none-match"] === quoted) {
    res.writeHead(304, base);
    res.end();
    return;
  }
  let data: Buffer;
  try {
    data = await readFile(abs);
  } catch {
    throw new HttpError(404, "FILE_MISSING", "file nahi mili");
  }
  res.writeHead(200, { ...base, "Content-Length": data.length });
  res.end(req.method === "HEAD" ? undefined : data);
}
