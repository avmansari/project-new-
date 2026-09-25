import type { Db } from "../db/index.js";
import type { Attribute } from "./assets.js";

export interface RarityInfo {
  score: number;
  rank: number;
  totalRanked: number;
}

/**
 * "Statistical rarity": har trait value ki frequency (count/total) nikalo, token ka score = sum(1/frequency).
 * Jitna rare trait, utna bada score. Rank 1 = sabse rare. Sirf MINT hue tokens pe (chhupi hui art rank nahi degi).
 */
export async function computeRarity(db: Db, collectionId: number): Promise<Map<number, RarityInfo>> {
  const r = await db.query<{ token_number: number; attributes: string }>(
    `SELECT a.token_number, a.attributes FROM assets a
     JOIN tokens t ON t.collection_id = a.collection_id AND t.token_number = a.token_number
     WHERE a.collection_id = $1 AND a.token_number > 0 AND t.voided_at IS NULL`,
    [collectionId]
  );
  const parsed = r.rows.map((row) => {
    let attrs: Attribute[] = [];
    try {
      attrs = JSON.parse(row.attributes);
    } catch {
      /* khaali */
    }
    return { token: row.token_number, attrs };
  });
  const total = parsed.length;
  if (total === 0) return new Map();

  const freq = new Map<string, number>();
  for (const p of parsed) for (const a of p.attrs) {
    const key = `${a.trait_type}:${a.value}`;
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  const scored = parsed.map((p) => ({
    token: p.token,
    score: p.attrs.reduce((sum, a) => sum + total / (freq.get(`${a.trait_type}:${a.value}`) ?? total), 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  const out = new Map<number, RarityInfo>();
  scored.forEach((s, i) => out.set(s.token, { score: Math.round(s.score * 100) / 100, rank: i + 1, totalRanked: total }));
  return out;
}
