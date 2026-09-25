import type { IncomingMessage, ServerResponse } from "node:http";

/** Chhota cookie parser/setter (koi library nahi). */
export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function setCookie(res: ServerResponse, name: string, value: string, opts: { maxAgeSec: number; secure?: boolean }): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${opts.maxAgeSec}`,
  ];
  if (opts.secure) parts.push("Secure");
  const existing = res.getHeader("Set-Cookie");
  const arr = Array.isArray(existing) ? existing.map(String) : existing ? [String(existing)] : [];
  arr.push(parts.join("; "));
  res.setHeader("Set-Cookie", arr);
}

export function clearCookie(res: ServerResponse, name: string): void {
  setCookie(res, name, "", { maxAgeSec: 0 });
}
