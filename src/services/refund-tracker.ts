import type { ChainClient } from "../chain/types.js";
import type { Db } from "../db/index.js";

export interface TrackCfg {
  minConfirmations: number;
  /** Tx expire hone ke baad itne blocks aur ruko, tab "failed" maano (reorg safety) */
  refundExpiryMargin: number;
  /** Broadcast ke itne minute baad bhi chain pe na dikhe to ALERT */
  refundStuckMinutes: number;
}

export interface TrackSummary {
  supported: boolean;
  checked: number;
  confirmed: number[];
  failed: number[];
  alerts: number[];
  errors: number;
}

/**
 * 'sent' refunds ko chain se milata hai:
 *   - block mein aur >= minConfirmations  => 'confirmed'
 *   - mempool / kam confirmations        => wait
 *   - chain pe nahi dikhti:
 *        expiry_height + margin nikal gaya => 'failed' (tx ab KABHI mine nahi ho sakti, expiry rule) =>
 *             inputs free, refund dobara plan ho sakta hai (double refund ka khatra nahi)
 *        warna stuck_minutes ke baad ek baar ALERT
 * Chain error pe kuch nahi badalta.
 *
 * Safety: "failed" tabhi jab expiry guzar chuki ho. Sirf "dikh nahi rahi" pe inputs free karna
 * double refund karwa sakta hai (tx baad mein mine ho jaye to).
 */
export async function trackRefunds(db: Db, chain: ChainClient, cfg: TrackCfg, now: Date = new Date()): Promise<TrackSummary> {
  const out: TrackSummary = { supported: true, checked: 0, confirmed: [], failed: [], alerts: [], errors: 0 };
  if (!chain.getTxStatus || !chain.tipHeight) return { ...out, supported: false };

  const sent = await db.query<{ id: number; txid: string }>(`SELECT id, txid FROM refunds WHERE status = 'sent' ORDER BY id`);
  if (sent.rows.length === 0) return out;

  let tip: number;
  try {
    tip = await chain.tipHeight();
  } catch (e) {
    console.error("[refund-tracker] tip nahi mila:", (e as Error).message);
    return { ...out, errors: sent.rows.length };
  }

  for (const r of sent.rows) {
    let st;
    try {
      st = await chain.getTxStatus(r.txid);
    } catch (e) {
      out.errors++;
      console.error(`[refund-tracker] refund#${r.id} status nahi mila:`, (e as Error).message);
      continue;
    }
    out.checked++;
    await db.transaction(async (tx) => {
      const cur = await tx.query<any>(
        `SELECT id, order_id, status, amount_zats::text AS amount, expiry_height, sent_at, alerted FROM refunds WHERE id = $1 FOR UPDATE`,
        [r.id]
      );
      const row = cur.rows[0];
      if (!row || row.status !== "sent") return;
      const log = (event: string, detail: string) =>
        tx.query(`INSERT INTO order_events (order_id, event, detail) VALUES ($1,$2,$3)`, [row.order_id, event, detail]);

      if (st.state === "mined") {
        const conf = Math.max(0, tip - st.height + 1);
        await tx.query(`UPDATE refunds SET confirmed_height = $2 WHERE id = $1`, [r.id, st.height]);
        if (conf >= cfg.minConfirmations) {
          await tx.query(`UPDATE refunds SET status = 'confirmed', updated_at = now() WHERE id = $1`, [r.id]);
          await log("refund_confirmed", `refund#${r.id} block ${st.height} (${conf} confirmations)`);
          out.confirmed.push(r.id);
        }
        return;
      }
      if (st.state === "mempool") return;

      // unknown / fork: chain pe main-chain mein nahi
      if (row.expiry_height !== null && tip > row.expiry_height + cfg.refundExpiryMargin) {
        await tx.query(`UPDATE refunds SET status = 'failed', updated_at = now() WHERE id = $1`, [r.id]);
        await tx.query(`UPDATE payments SET refund_id = NULL, spent_txid = NULL WHERE refund_id = $1`, [r.id]);
        await tx.query(`UPDATE orders SET refunded_zats = refunded_zats - $2::bigint WHERE id = $1`, [row.order_id, row.amount]);
        await log("refund_failed", `refund#${r.id} expire ho gayi (expiry ${row.expiry_height}, tip ${tip}), block mein nahi aayi. Inputs free, dobara plan hoga.`);
        out.failed.push(r.id);
        return;
      }
      const sentAt = row.sent_at ? new Date(row.sent_at).getTime() : now.getTime();
      if (!row.alerted && now.getTime() - sentAt >= cfg.refundStuckMinutes * 60_000) {
        await tx.query(`UPDATE refunds SET alerted = true WHERE id = $1`, [r.id]);
        await log("ALERT", `refund#${r.id} ${cfg.refundStuckMinutes}+ minute se chain pe nahi dikh rahi (status: ${st.state}). Expiry tak intezaar, ya manually dekho.`);
        out.alerts.push(r.id);
      }
    });
  }
  return out;
}
