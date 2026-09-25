import type { Db } from "../db/index.js";

async function lockCollection(tx: any, slug: string) {
  const r = await tx.query(`SELECT id, status, payout_frozen FROM collections WHERE slug = $1 FOR UPDATE`, [slug]);
  if (!r.rows[0]) throw new Error("collection nahi mili");
  return r.rows[0] as { id: number; status: string; payout_frozen: boolean };
}
const log = (tx: any, id: number, event: string, detail: string) =>
  tx.query(`INSERT INTO collection_events (collection_id, event, detail) VALUES ($1,$2,$3)`, [id, event, detail]);

/** Collection band (nayi sales nahi). Settlement/hold ki ghadi yahin se shuru hoti hai. */
export async function endCollection(db: Db, slug: string, now: Date = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const c = await lockCollection(tx, slug);
    if (c.status !== "live") throw new Error(`collection '${c.status}' hai, sirf 'live' end ho sakti hai`);
    await tx.query(`UPDATE collections SET status = 'ended', ended_at = $2::timestamptz WHERE id = $1`, [c.id, now.toISOString()]);
    await log(tx, c.id, "ended", now.toISOString());
  });
}

/** Kill switch: payouts aur nayi sales dono ruk jaate hain. */
export async function freezeCollection(db: Db, slug: string, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    const c = await lockCollection(tx, slug);
    if (c.status === "cancelled") throw new Error("cancelled collection ko freeze karne ki zaroorat nahi");
    await tx.query(`UPDATE collections SET payout_frozen = true, frozen_reason = $2 WHERE id = $1`, [c.id, reason]);
    await log(tx, c.id, "frozen", reason);
  });
}

export async function unfreezeCollection(db: Db, slug: string): Promise<void> {
  await db.transaction(async (tx) => {
    const c = await lockCollection(tx, slug);
    if (c.status === "cancelled") throw new Error("cancelled collection unfreeze nahi ho sakti");
    await tx.query(`UPDATE collections SET payout_frozen = false, frozen_reason = NULL WHERE id = $1`, [c.id]);
    await log(tx, c.id, "unfrozen", "");
  });
}

export interface ReportCfg {
  reportFreezeMin: number;
  reportFreezePct: number;
}

/**
 * Buyer collection ki report karta hai. Sirf wahi report kar sakta hai jiska is collection mein minted order ho.
 * Threshold = max(reportFreezeMin, buyers ka reportFreezePct %). Threshold paar hote hi AUTO-FREEZE.
 * (API layer ko ye zaroor verify karna hoga ki reporter us address ka malik hai.)
 */
export async function reportCollection(
  db: Db,
  slug: string,
  reporterAddress: string,
  reason: string,
  cfg: ReportCfg
): Promise<{ reports: number; threshold: number; frozen: boolean }> {
  if (!reason.trim()) throw new Error("reason zaroori hai");
  return db.transaction(async (tx) => {
    const c = await lockCollection(tx, slug);
    const owns = await tx.query(
      `SELECT 1 FROM orders WHERE collection_id = $1 AND buyer_address = $2 AND status = 'minted' LIMIT 1`,
      [c.id, reporterAddress]
    );
    if (!owns.rows[0]) throw new Error("sirf is collection ke buyers report kar sakte hain");
    await tx.query(
      `INSERT INTO reports (collection_id, reporter_address, reason) VALUES ($1,$2,$3) ON CONFLICT (collection_id, reporter_address) DO NOTHING`,
      [c.id, reporterAddress, reason]
    );
    const reports = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM reports WHERE collection_id = $1`, [c.id])).rows[0].n;
    const buyers = (
      await tx.query<{ n: number }>(`SELECT count(DISTINCT buyer_address)::int AS n FROM orders WHERE collection_id = $1 AND status = 'minted'`, [c.id])
    ).rows[0].n;
    const threshold = Math.max(cfg.reportFreezeMin, Math.ceil((buyers * cfg.reportFreezePct) / 100));
    let frozen = c.payout_frozen;
    if (!frozen && reports >= threshold && c.status !== "cancelled") {
      frozen = true;
      await tx.query(`UPDATE collections SET payout_frozen = true, frozen_reason = $2 WHERE id = $1`, [c.id, `auto: ${reports} buyer reports`]);
      await log(tx, c.id, "auto_frozen", `${reports} reports >= threshold ${threshold}`);
    }
    return { reports, threshold, frozen };
  });
}

export interface CancelSummary {
  ordersToRefund: number;
  /** Buyers ko wapas dene layak kul confirmed paisa (abhi ke hisaab se) */
  refundZats: bigint;
  /** Creator ko pehle hi bheja ja chuka paisa. Ye wapas nahi aata: yahi risk hai jo hold-time kam karta hai. */
  alreadyPaidToCreatorZats: bigint;
  tokensVoided: number;
}

/**
 * Collection CANCEL: buyers ko poora refund milega (existing refund system se).
 *  - minted/paid orders => refund_needed, refund_due = jitna confirmed paisa aaya
 *  - pending orders: paisa dikh chuka ho to refund_needed, warna expired
 *  - tokens void, sales void, pending payout requests cancel, nayi sales band
 * Refund tab hi ban paate hain jab paisa abhi order-address pe ho. Jo pehle hi treasury mein ja chuka
 * (sweep / excess-refund ka change), uska refund treasury se hoga (payout engine, agla step).
 */
export async function cancelCollection(db: Db, slug: string, reason: string, now: Date = new Date()): Promise<CancelSummary> {
  if (!reason.trim()) throw new Error("reason zaroori hai");
  return db.transaction(async (tx) => {
    const c = await lockCollection(tx, slug);
    if (c.status === "cancelled") throw new Error("collection pehle hi cancel hai");
    await tx.query(
      `UPDATE collections SET status = 'cancelled', payout_frozen = true, frozen_reason = $2, cancelled_at = $3::timestamptz WHERE id = $1`,
      [c.id, reason, now.toISOString()]
    );
    const orders = await tx.query<{ id: string; status: string; funded: boolean; received: string }>(
      `SELECT id, status, funded, received_zats::text AS received FROM orders
       WHERE collection_id = $1 AND status IN ('pending','paid','minted') FOR UPDATE`,
      [c.id]
    );
    let refundZats = 0n;
    let n = 0;
    for (const o of orders.rows) {
      const ev = (d: string) => tx.query(`INSERT INTO order_events (order_id, event, detail) VALUES ($1,'collection_cancelled',$2)`, [o.id, d]);
      if (o.status === "pending" && !o.funded) {
        // expiry abhi ki kar do: iske baad aane wala har payment "late" ganega => seedha refund (kabhi paid/mint nahi)
        await tx.query(`UPDATE orders SET status = 'expired', expires_at = LEAST(expires_at, $2::timestamptz) WHERE id = $1`, [o.id, now.toISOString()]);
        await ev("pending -> expired");
      } else {
        // paid / minted / (pending par funded): full refund
        await tx.query(`UPDATE orders SET status = 'refund_needed', refund_due_zats = received_zats WHERE id = $1`, [o.id]);
        refundZats += BigInt(o.received);
        n++;
        await ev(`${o.status} -> refund_needed`);
      }
    }
    const tv = await tx.query(`UPDATE tokens SET voided_at = $2::timestamptz WHERE collection_id = $1 AND voided_at IS NULL RETURNING id`, [c.id, now.toISOString()]);
    await tx.query(`UPDATE sales SET status = 'void' WHERE collection_id = $1`, [c.id]);
    await tx.query(`UPDATE payout_requests SET status = 'cancelled', updated_at = now() WHERE collection_id = $1 AND status = 'pending'`, [c.id]);
    const paid = BigInt(
      (await tx.query<{ v: string }>(`SELECT COALESCE(SUM(amount_zats),0)::text AS v FROM payout_requests WHERE collection_id = $1 AND status = 'sent'`, [c.id])).rows[0].v
    );
    await log(tx, c.id, "cancelled", `${reason} | refund orders=${n} zats=${refundZats} | already paid to creator=${paid}`);
    return { ordersToRefund: n, refundZats, alreadyPaidToCreatorZats: paid, tokensVoided: tv.rows.length };
  });
}

/** Token ko trade hone se roko (chori/report hui NFT). Owner apne wallet me dekh sakta hai, list/buy nahi kar sakta. */
export async function blockToken(db: Db, slug: string, tokenNumber: number, reason: string): Promise<void> {
  if (!reason.trim()) throw new Error("reason zaroori hai");
  const r = await db.query(
    `UPDATE tokens t SET blocked = true, blocked_reason = $3
     FROM collections c WHERE t.collection_id = c.id AND c.slug = $1 AND t.token_number = $2 AND t.voided_at IS NULL
     RETURNING t.id`,
    [slug, tokenNumber, reason]
  );
  if (!r.rows[0]) throw new Error("token nahi mila");
  // Active listing ho to hata do (blocked NFT bik nahi sakti)
  await db.query(
    `UPDATE listings l SET status = 'cancelled', updated_at = now()
     FROM collections c WHERE l.collection_id = c.id AND c.slug = $1 AND l.token_number = $2 AND l.status = 'active'`,
    [slug, tokenNumber]
  );
}

export async function unblockToken(db: Db, slug: string, tokenNumber: number): Promise<void> {
  const r = await db.query(
    `UPDATE tokens t SET blocked = false, blocked_reason = NULL
     FROM collections c WHERE t.collection_id = c.id AND c.slug = $1 AND t.token_number = $2
     RETURNING t.id`,
    [slug, tokenNumber]
  );
  if (!r.rows[0]) throw new Error("token nahi mila");
}
