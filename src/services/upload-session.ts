import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { IncomingMessage } from "node:http";
import type { Db } from "../db/index.js";
import { bufEntry, readLazyFile, type LazyEntry } from "./assets.js";

export class SessionError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i;
const OK_EXT = /\.(png|jpe?g|webp|gif|json|csv)$/i;

function sessionDir(assetsRoot: string, id: string): string {
  const root = resolve(assetsRoot, "_uploads");
  const dir = resolve(root, id);
  if (!dir.startsWith(root + sep)) throw new SessionError(400, "session id galat hai");
  return dir;
}

export interface SessionFields {
  name: string;
  priceZec: string;
  maxPerWallet: string;
  payoutAddress: string;
  revealMode: string;
  /** ISO datetime string (optional). Khaali = turant launch. */
  launchAt: string;
  description: string;
  websiteUrl: string;
  xUrl: string;
}

/** Naya upload session banao (creator page kholte hi, pehli file bhejne se pehle). */
export async function createSession(db: Db, assetsRoot: string, fields: SessionFields): Promise<string> {
  const id = randomUUID();
  mkdirSync(sessionDir(assetsRoot, id), { recursive: true });
  await db.query(`INSERT INTO upload_sessions (id, fields_json) VALUES ($1,$2)`, [id, JSON.stringify(fields)]);
  return id;
}

/**
 * Ek file ko seedha DISK PE STREAM karta hai -- request ka body kabhi poora memory me nahi aata.
 * Size cap bytes AATE HI check hota hai; limit paar hote hi turant rok diya jaata hai (partial file delete),
 * isliye ek "10 GB ki fake image" se bhi server ka RAM ya disk khatam nahi hota.
 */
export async function receiveSessionFile(
  db: Db,
  req: IncomingMessage,
  assetsRoot: string,
  sessionId: string,
  filename: string,
  maxFileBytes: number,
  maxSessionBytes: number
): Promise<{ bytes: number }> {
  const s = await db.query<{ total_bytes: string }>(`SELECT total_bytes::text AS total_bytes FROM upload_sessions WHERE id = $1`, [sessionId]);
  if (!s.rows[0]) throw new SessionError(404, "session nahi mili ya expire ho gaya");
  const name = basename(filename).trim();
  if (!name || !OK_EXT.test(name)) throw new SessionError(400, `file type allowed nahi: ${name}`);
  if (BigInt(s.rows[0].total_bytes) >= BigInt(maxSessionBytes)) throw new SessionError(413, "collection ki total size limit paar ho gayi");

  const dir = sessionDir(assetsRoot, sessionId);
  if (!existsSync(dir)) throw new SessionError(404, "session nahi mili ya expire ho gaya");
  const dest = resolve(dir, name);
  if (!dest.startsWith(dir + sep)) throw new SessionError(400, "file naam galat hai");

  let bytes = 0;
  let oversize = false;
  const ws = createWriteStream(dest);
  await new Promise<void>((resolvePromise, reject) => {
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxFileBytes) {
        // Client ko cleanly 413 bhejna hai, isliye connection abhi todte nahi -- bas disk pe likhna
        // aur count karna band kar dete hain (extra bytes discard, memory/disk dono bounded rehte hain).
        if (!oversize) {
          oversize = true;
          ws.destroy();
        }
        return;
      }
      if (!ws.write(chunk)) req.pause();
    });
    ws.on("drain", () => req.resume());
    req.on("end", () => {
      if (oversize) resolvePromise();
      else ws.end();
    });
    req.on("error", (e) => {
      ws.destroy();
      reject(e);
    });
    ws.on("close", () => {
      if (!oversize) resolvePromise();
    });
    ws.on("error", (e) => reject(e));
  });
  if (oversize) {
    rmSync(dest, { force: true });
    throw new SessionError(413, `${name}: file bahut badi hai (limit ${(maxFileBytes / 1048576).toFixed(0)} MB)`);
  }

  await db.query(`UPDATE upload_sessions SET total_bytes = total_bytes + $2 WHERE id = $1`, [sessionId, bytes]);
  return { bytes };
}

/** Session ki files ko LAZY entries me badalta hai (disk se, ek-ek karke padhi jaati hain -- memory-bounded). */
export async function sessionEntries(db: Db, assetsRoot: string, sessionId: string): Promise<{ fields: SessionFields; entries: LazyEntry[] }> {
  const s = await db.query<{ fields_json: string }>(`SELECT fields_json FROM upload_sessions WHERE id = $1`, [sessionId]);
  if (!s.rows[0]) throw new SessionError(404, "session nahi mili ya expire ho gaya");
  const dir = sessionDir(assetsRoot, sessionId);
  if (!existsSync(dir)) throw new SessionError(404, "session ki koi file nahi mili (expire ho gaya?)");
  const names = readdirSync(dir);
  const entries = names.map((n) => readLazyFile(join(dir, n), n));
  return { fields: JSON.parse(s.rows[0].fields_json), entries };
}

export async function cleanupSession(db: Db, assetsRoot: string, sessionId: string): Promise<void> {
  rmSync(sessionDir(assetsRoot, sessionId), { recursive: true, force: true });
  await db.query(`DELETE FROM upload_sessions WHERE id = $1`, [sessionId]);
}

/** Purane, kabhi finalize na hue sessions saaf karo (disk aur DB dono se). */
export async function sweepStaleSessions(db: Db, assetsRoot: string, olderThanHours = 48): Promise<number> {
  const r = await db.query<{ id: string }>(`SELECT id FROM upload_sessions WHERE created_at < now() - ($1 || ' hours')::interval`, [String(olderThanHours)]);
  for (const row of r.rows) rmSync(sessionDir(assetsRoot, row.id), { recursive: true, force: true });
  await db.query(`DELETE FROM upload_sessions WHERE created_at < now() - ($1 || ' hours')::interval`, [String(olderThanHours)]);
  return r.rows.length;
}

void IMG_EXT;
