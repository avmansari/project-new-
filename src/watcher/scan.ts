import type { ChainClient } from "../chain/types.js";
import type { Db } from "../db/index.js";
import { formatZec } from "../money.js";
import { mapOrder, ORDER_COLS, type Order, type OrderStatus } from "../services/orders.js";
import { evaluate, type PaymentView } from "./evaluate.js";

export interface ScanConfig {
  minConfirmations: number;
  lateGraceHours: number;
}

export interface Transition {
  orderId: string;
  from: OrderStatus;
  to: OrderStatus;
}

export interface ScanSummary {
  scanned: number;
  errors: number;
  transitions: Transition[];
  /** Order banne se PEHLE mined hone ki wajah se ignore kiye gaye outputs */
  ignoredOld: number;
}

/**
 * Ek round: jitne orders ke address dekhne zaroori hain, sab ko chain se poochta hai
 * aur order ka status update karta hai. Baar-baar chalane se koi nuksaan nahi (idempotent).
 */
export async function scanOnce(db: Db, chain: ChainClient, cfg: ScanConfig, now: Date = new Date()): Promise<ScanSummary> {
  const graceCutoff = new Date(now.getTime() - cfg.lateGraceHours * 3_600_000);
  const res = await db.query(
    `SELECT ${ORDER_COLS} FROM orders
     WHERE status IN ('pending','paid','refund_needed')
        OR (status IN ('expired','minted') AND expires_at > $1::timestamptz)
     ORDER BY created_at`,
    [graceCutoff.toISOString()]
  );
  const orders = res.rows.map(mapOrder);
  const summary: ScanSummary = { scanned: 0, errors: 0, transitions: [], ignoredOld: 0 };

  for (const order of orders) {
    let outputs;
    try {
      outputs = await chain.getReceived(order.payAddress);
    } catch (e) {
      // Chain se data nahi mila => is order ko chhedo mat. "Kuch nahi mila" aur "error" alag baatein hain.
      summary.errors++;
      console.error(`[scan] ${order.id.slice(0, 8)} chain error:`, (e as Error).message);
      continue;
    }
    summary.scanned++;
    // Order banne se PEHLE mined payment is order ki nahi ho sakti (address ka purana istemal / database restore).
    // Address order banne ke baad hi dikhaya jaata hai, isliye payment usse pehle ke block mein aa hi nahi sakti.
    if (order.startHeight !== null) {
      const fresh = outputs.filter((o) => o.height === undefined || o.height >= order.startHeight!);
      summary.ignoredOld += outputs.length - fresh.length;
      outputs = fresh;
    }
    const t = await applyScan(db, order.id, outputs, cfg, now);
    if (t) summary.transitions.push(t);
  }
  return summary;
}

async function applyScan(
  db: Db,
  orderId: string,
  outputs: Awaited<ReturnType<ChainClient["getReceived"]>>,
  cfg: ScanConfig,
  now: Date
): Promise<Transition | null> {
  return db.transaction(async (tx) => {
    const cur = await tx.query(`SELECT ${ORDER_COLS} FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    const order: Order = mapOrder(cur.rows[0]);
    if (order.status === "refunded") return null;
    const nowIso = now.toISOString();

    // 1) payments sync: dikhe hue upsert, jo ab nahi dikhte unhe dropped mark
    for (const o of outputs) {
      if (o.amountZats <= 0n) continue;
      await tx.query(
        `INSERT INTO payments (order_id, txid, vout, amount_zats, confirmations, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,$4::bigint,$5,$6::timestamptz,$6::timestamptz)
         ON CONFLICT (txid, vout) DO UPDATE
           SET confirmations = EXCLUDED.confirmations, last_seen_at = EXCLUDED.last_seen_at, dropped = false`,
        [orderId, o.txid, o.vout, o.amountZats.toString(), o.confirmations, nowIso]
      );
    }
    const seen = new Set(outputs.map((o) => `${o.txid}:${o.vout}`));
    const existing = await tx.query<{ id: number; txid: string; vout: number }>(
      `SELECT id, txid, vout FROM payments WHERE order_id = $1 AND dropped = false`,
      [orderId]
    );
    for (const p of existing.rows) {
      if (!seen.has(`${p.txid}:${p.vout}`)) {
        await tx.query(`UPDATE payments SET dropped = true WHERE id = $1`, [p.id]);
        await tx.query(`INSERT INTO order_events (order_id, event, detail) VALUES ($1,'payment_dropped',$2)`, [
          orderId,
          `${p.txid}:${p.vout}`,
        ]);
      }
    }

    // 2) decision
    const pr = await tx.query(
      `SELECT amount_zats::text AS amount_zats, confirmations, first_seen_at, dropped FROM payments WHERE order_id = $1`,
      [orderId]
    );
    const payments: PaymentView[] = pr.rows.map((r: any) => ({
      amountZats: BigInt(r.amount_zats),
      confirmations: r.confirmations,
      firstSeenAt: new Date(r.first_seen_at),
      dropped: r.dropped,
    }));
    const d = evaluate(order, payments, now, cfg.minConfirmations);

    // 3) sirf change hone pe likho + audit log
    const changed =
      d.status !== order.status ||
      d.receivedZats !== order.receivedZats ||
      d.refundDueZats !== order.refundDueZats ||
      d.funded !== order.funded;
    if (!changed) return null;

    await tx.query(
      `UPDATE orders SET status = $2::text, received_zats = $3::bigint, refund_due_zats = $4::bigint, funded = $5,
         paid_at = CASE WHEN $2::text = 'paid' AND paid_at IS NULL THEN $6::timestamptz ELSE paid_at END
       WHERE id = $1`,
      [orderId, d.status, d.receivedZats.toString(), d.refundDueZats.toString(), d.funded, nowIso]
    );
    const log = async (event: string, detail: string) =>
      tx.query(`INSERT INTO order_events (order_id, event, detail) VALUES ($1,$2,$3)`, [orderId, event, detail]);
    if (d.status !== order.status) await log("status", `${order.status} -> ${d.status}`);
    if (d.receivedZats !== order.receivedZats) await log("received", `${formatZec(d.receivedZats)} ZEC confirmed`);
    if (d.refundDueZats !== order.refundDueZats) await log("refund_due", `${formatZec(d.refundDueZats)} ZEC`);
    if (
      (order.status === "paid" || order.status === "minted") &&
      d.receivedZats < order.amountZats
    ) {
      await log("ALERT", "paid/minted order ka confirmed paisa amount se kam ho gaya (reorg/drop?) -- manually dekho");
    }

    return d.status !== order.status ? { orderId, from: order.status, to: d.status } : null;
  });
}
