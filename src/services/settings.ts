import type { Db } from "../db/index.js";

/** Runtime settings (jaise currency rate) -- admin CLI se badalte hain, restart ki zaroorat nahi. */
export async function getSetting(db: Db, key: string): Promise<string | null> {
  const r = await db.query<{ value: string }>(`SELECT value FROM settings WHERE key = $1`, [key]);
  return r.rows[0]?.value ?? null;
}

export async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db.query(`INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = $2`, [key, value]);
}

export interface Rates {
  usd?: number;
  inr?: number;
}

/** DB me admin ne set kiya ho to wahi, warna .env ka default. */
export async function getRates(db: Db, envDefaults: Rates): Promise<Rates> {
  const [usd, inr] = await Promise.all([getSetting(db, "rate_usd"), getSetting(db, "rate_inr")]);
  return {
    usd: usd !== null ? Number(usd) : envDefaults.usd,
    inr: inr !== null ? Number(inr) : envDefaults.inr,
  };
}

export function convert(zec: string, rate: number | undefined): string | null {
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return null;
  return (Number(zec) * rate).toFixed(2);
}
