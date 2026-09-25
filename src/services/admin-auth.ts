import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/index.js";

/** Password kabhi plaintext .env/DB me nahi rakhte -- sirf iska SHA-256 hash. */
export function hashPassword(password: string): string {
  return createHash("sha256").update(password, "utf8").digest("hex");
}

/** Timing-attack-safe compare. Hash configured na ho to hamesha false (dashboard band). */
export function verifyAdminPassword(password: string, configuredHash: string | undefined): boolean {
  if (!configuredHash || !/^[0-9a-f]{64}$/i.test(configuredHash)) return false;
  const got = Buffer.from(hashPassword(password), "hex");
  const want = Buffer.from(configuredHash.toLowerCase(), "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function createAdminSession(db: Db, hours: number): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await db.query(`INSERT INTO admin_sessions (token, expires_at) VALUES ($1, now() + ($2 || ' hours')::interval)`, [token, String(hours)]);
  return token;
}

export async function checkAdminSession(db: Db, token: string | undefined): Promise<boolean> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
  const r = await db.query(`SELECT 1 FROM admin_sessions WHERE token = $1 AND expires_at > now()`, [token]);
  return !!r.rows[0];
}

export async function deleteAdminSession(db: Db, token: string): Promise<void> {
  await db.query(`DELETE FROM admin_sessions WHERE token = $1`, [token]);
}

export async function sweepExpiredAdminSessions(db: Db): Promise<void> {
  await db.query(`DELETE FROM admin_sessions WHERE expires_at <= now()`);
}
