import type { Db } from "../db/index.js";

/**
 * Sale ka batwara: gross = platform fee + creator ka hissa.
 * Fee neeche (floor) round hoti hai, creator ko baaki milta hai => fee + net HAMESHA gross ke barabar.
 */
export function splitSale(grossZats: bigint, feeBps: number): { feeZats: bigint; netZats: bigint } {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) throw new Error("feeBps 0..10000 hona chahiye");
  if (grossZats <= 0n) throw new Error("gross > 0 hona chahiye");
  const feeZats = (grossZats * BigInt(feeBps)) / 10000n;
  return { feeZats, netZats: grossZats - feeZats };
}

export interface ReleaseCfg {
  /** Advance payout is se chhota ho to nahi banta */
  minPayoutZats: bigint;
  /** Final payout ke liye minimum (dust se upar) */
  dustZats: bigint;
}

export interface PayoutRequest {
  id: number;
  collectionId: number;
  slug: string;
  address: string;
  amountZats: bigint;
  kind: "advance" | "final";
  status: "pending" | "sent" | "cancelled";
  txid: string | null;
}

export interface ReleaseResult {
  created: PayoutRequest[];
  skipped: { slug: string; reason: string }[];
  /** Jin collections ka settlement is round mein detect hua */
  settled: string[];
}

const HOUR = 3_600_000;

/**
 * ESCROW RELEASE RULES (bilkul automatic):
 *  1. Creator ka paisa turant nahi milta. Settlement ka intezaar hota hai:
 *       - collection SOLD OUT (saare tokens mint) ya
 *       - collection ENDED (band kar di gayi)
 *     aur koi order beech mein atka na ho (paid par abhi mint nahi hua).
 *  2. Settlement ke baad `hold_hours` ruko (is dauran buyers report/cancel kar sakte hain).
 *  3. Uske baad creator ko poora hissa (sales ka net) milta hai.
 *  4. Trusted creator ke liye `advance_bps`: net ka itna % pehle hi mil sakta hai.
 *  5. Freeze ho to kuch nahi milta.
 * Har round sirf farak (delta) ka request banata hai, isliye baar-baar chalane se double payout nahi hota.
 */
export async function runReleases(db: Db, cfg: ReleaseCfg, now: Date = new Date()): Promise<ReleaseResult> {
  const ids = await db.query<{ id: number }>(
    `SELECT id FROM collections c
     WHERE c.status IN ('live','ended')
       AND EXISTS (SELECT 1 FROM sales s WHERE s.collection_id = c.id AND s.status = 'active')
     ORDER BY id`
  );
  const result: ReleaseResult = { created: [], skipped: [], settled: [] };
  for (const { id } of ids.rows) {
    const r = await releaseOne(db, id, cfg, now);
    if (r.settledNow) result.settled.push(r.slug);
    if (r.created) result.created.push(r.created);
    if (r.skipped) result.skipped.push({ slug: r.slug, reason: r.skipped });
  }
  return result;
}

async function releaseOne(
  db: Db,
  collectionId: number,
  cfg: ReleaseCfg,
  now: Date
): Promise<{ slug: string; settledNow: boolean; created?: PayoutRequest; skipped?: string }> {
  return db.transaction(async (tx) => {
    const cq = await tx.query<any>(
      `SELECT id, slug, supply, status, hold_hours, advance_bps, payout_frozen, creator_address, settled_at, ended_at
       FROM collections WHERE id = $1 FOR UPDATE`,
      [collectionId]
    );
    const c = cq.rows[0];
    const out: { slug: string; settledNow: boolean; created?: PayoutRequest; skipped?: string } = { slug: c.slug, settledNow: false };
    if (c.status !== "live" && c.status !== "ended") return out;
    if (c.payout_frozen) return { ...out, skipped: "freeze hai" };

    // --- settlement detect ---
    let settledAt: Date | null = c.settled_at ? new Date(c.settled_at) : null;
    if (!settledAt) {
      const blocking = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM orders WHERE collection_id = $1 AND (status = 'paid' OR (status = 'pending' AND funded))`,
        [collectionId]
      );
      if (blocking.rows[0].n === 0) {
        const tk = await tx.query<{ n: number; m: Date | null }>(
          `SELECT count(*)::int AS n, max(minted_at) AS m FROM tokens WHERE collection_id = $1 AND voided_at IS NULL`,
          [collectionId]
        );
        if (tk.rows[0].n >= c.supply && tk.rows[0].m) settledAt = new Date(tk.rows[0].m);
        else if (c.status === "ended") settledAt = c.ended_at ? new Date(c.ended_at) : now;
        if (settledAt) {
          await tx.query(`UPDATE collections SET settled_at = $2::timestamptz WHERE id = $1`, [collectionId, settledAt.toISOString()]);
          await tx.query(`INSERT INTO collection_events (collection_id, event, detail) VALUES ($1,'settled',$2)`, [
            collectionId,
            settledAt.toISOString(),
          ]);
          out.settledNow = true;
        }
      }
    }

    // --- kitna dena banta hai ---
    const net = BigInt(
      (await tx.query<{ v: string }>(`SELECT COALESCE(SUM(creator_net_zats),0)::text AS v FROM sales WHERE collection_id = $1 AND status = 'active'`, [collectionId])).rows[0].v
    );
    const requested = BigInt(
      (await tx.query<{ v: string }>(`SELECT COALESCE(SUM(amount_zats),0)::text AS v FROM payout_requests WHERE collection_id = $1 AND status IN ('pending','sent')`, [collectionId])).rows[0].v
    );
    const releaseAt = settledAt ? new Date(settledAt.getTime() + c.hold_hours * HOUR) : null;
    const isFinal = !!releaseAt && now.getTime() >= releaseAt.getTime();
    const target = isFinal ? net : (net * BigInt(c.advance_bps)) / 10000n;
    const delta = target - requested;
    if (delta <= 0n) return out;

    if (!c.creator_address) return { ...out, skipped: "creator payout address set nahi hai" };
    const min = isFinal ? cfg.dustZats : cfg.minPayoutZats;
    if (delta < min) return { ...out, skipped: `payout bahut chhota (${delta} zats < ${min})` };

    const ins = await tx.query<{ id: number }>(
      `INSERT INTO payout_requests (collection_id, address, amount_zats, kind) VALUES ($1,$2,$3::bigint,$4) RETURNING id`,
      [collectionId, c.creator_address, delta.toString(), isFinal ? "final" : "advance"]
    );
    await tx.query(`INSERT INTO collection_events (collection_id, event, detail) VALUES ($1,'payout_requested',$2)`, [
      collectionId,
      `#${ins.rows[0].id} ${delta} zats (${isFinal ? "final" : "advance"})`,
    ]);
    return {
      ...out,
      created: {
        id: ins.rows[0].id,
        collectionId,
        slug: c.slug,
        address: c.creator_address,
        amountZats: delta,
        kind: isFinal ? "final" : "advance",
        status: "pending",
        txid: null,
      },
    };
  });
}

/** Payout transaction bhej di gayi => txid record karo */
export async function markPayoutSent(db: Db, id: number, txid: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("txid 64 hex characters ka hona chahiye");
  const r = await db.query<{ id: number }>(
    `UPDATE payout_requests SET status = 'sent', txid = $2, updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING id`,
    [id, txid]
  );
  if (!r.rows[0]) throw new Error(`payout#${id} nahi mila ya 'pending' nahi hai`);
}

/** Request wapas lo (bheji nahi gayi). Paisa dobara "held" mein chala jaata hai. */
export async function cancelPayoutRequest(db: Db, id: number): Promise<void> {
  const r = await db.query<{ id: number }>(
    `UPDATE payout_requests SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING id`,
    [id]
  );
  if (!r.rows[0]) throw new Error(`payout#${id} nahi mila ya 'pending' nahi hai`);
}

export async function listPayoutRequests(db: Db): Promise<PayoutRequest[]> {
  const r = await db.query<any>(
    `SELECT p.id, p.collection_id, c.slug, p.address, p.amount_zats::text AS amount, p.kind, p.status, p.txid
     FROM payout_requests p JOIN collections c ON c.id = p.collection_id ORDER BY p.id`
  );
  return r.rows.map((x) => ({
    id: x.id, collectionId: x.collection_id, slug: x.slug, address: x.address,
    amountZats: BigInt(x.amount), kind: x.kind, status: x.status, txid: x.txid,
  }));
}

export interface CollectionStats {
  slug: string;
  status: string;
  frozen: boolean;
  frozenReason: string | null;
  supply: number;
  minted: number;
  salesCount: number;
  grossZats: bigint;
  platformFeeZats: bigint;
  creatorNetZats: bigint;
  /** Creator ka jo hissa abhi ruka hua hai (release nahi hua) */
  heldZats: bigint;
  requestedZats: bigint;
  paidZats: bigint;
  settledAt: Date | null;
  releaseAt: Date | null;
  payoutAddress: string | null;
}

export async function collectionStats(db: Db, slug: string): Promise<CollectionStats> {
  const c = await db.query<any>(
    `SELECT id, slug, status, supply, payout_frozen, frozen_reason, hold_hours, settled_at, creator_address FROM collections WHERE slug = $1`,
    [slug]
  );
  if (!c.rows[0]) throw new Error("collection nahi mili");
  const col = c.rows[0];
  const s = await db.query<any>(
    `SELECT count(*)::int AS n, COALESCE(SUM(gross_zats),0)::text AS g, COALESCE(SUM(platform_fee_zats),0)::text AS f, COALESCE(SUM(creator_net_zats),0)::text AS c
     FROM sales WHERE collection_id = $1 AND status = 'active'`,
    [col.id]
  );
  const p = await db.query<any>(
    `SELECT COALESCE(SUM(amount_zats) FILTER (WHERE status IN ('pending','sent')),0)::text AS req,
            COALESCE(SUM(amount_zats) FILTER (WHERE status = 'sent'),0)::text AS paid
     FROM payout_requests WHERE collection_id = $1`,
    [col.id]
  );
  const t = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM tokens WHERE collection_id = $1 AND voided_at IS NULL`, [col.id]);
  const settledAt = col.settled_at ? new Date(col.settled_at) : null;
  const net = BigInt(s.rows[0].c);
  const requested = BigInt(p.rows[0].req);
  return {
    slug: col.slug,
    status: col.status,
    frozen: col.payout_frozen,
    frozenReason: col.frozen_reason ?? null,
    supply: col.supply,
    minted: t.rows[0].n,
    salesCount: s.rows[0].n,
    grossZats: BigInt(s.rows[0].g),
    platformFeeZats: BigInt(s.rows[0].f),
    creatorNetZats: net,
    heldZats: net > requested ? net - requested : 0n,
    requestedZats: requested,
    paidZats: BigInt(p.rows[0].paid),
    settledAt,
    releaseAt: settledAt ? new Date(settledAt.getTime() + col.hold_hours * HOUR) : null,
    payoutAddress: col.creator_address ?? null,
  };
}
