import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { formatZec } from "../money.js";
import { mapOrder, ORDER_COLS } from "./orders.js";
import { isAddressForNetwork } from "../zcash/address.js";

/**
 * ZIP 317 conventional fee, CONSERVATIVE version:
 * har input aur output ko ek logical action gino (asli formula thoda kam ho sakta hai, zyada kabhi nahi).
 * Zyada fee dena safe hai, kam dena nahi (tx reject/deprioritize ho jaati hai).
 */
export function conventionalFee(
  nIn: number,
  nOut: number,
  p: { feeMarginalZats: bigint; feeGraceActions: number }
): bigint {
  const actions = Math.max(p.feeGraceActions, nIn, nOut);
  return p.feeMarginalZats * BigInt(actions);
}

export interface PlanInput {
  txid: string;
  vout: number;
  amountZats: bigint;
  /** Is input ki private key m/44'/133'/0'/0/<addressIndex> se nikalti hai (signer ke liye) */
  addressIndex: number;
}
export interface PlanOutput {
  address: string;
  amountZats: bigint;
  role: "refund" | "change";
}
export interface RefundPlanItem {
  refundId: number;
  orderId: string;
  toAddress: string;
  grossZats: bigint;
  feeZats: bigint;
  inputs: PlanInput[];
  outputs: PlanOutput[];
}
export interface SkippedRefund {
  orderId: string;
  reason: string;
}
export interface PlanResult {
  created: RefundPlanItem[];
  skipped: SkippedRefund[];
}

type PlanCfg = Pick<
  AppConfig,
  "network" | "treasuryAddress" | "minRefundNetZats" | "minConfirmations" | "feeMarginalZats" | "feeGraceActions"
>;

const sum = (xs: { amountZats: bigint }[]) => xs.reduce((a, x) => a + x.amountZats, 0n);

/**
 * Jin orders ka refund baaki hai unke liye refund transactions PLAN karta hai (sign/broadcast nahi).
 *
 * Rules:
 *  - Sirf 'minted' (overpay ka excess) aur 'refund_needed' orders.
 *  - outstanding = refund_due - refunded (pehle se plan ho chuka hissa dobara nahi).
 *  - Inputs = us order ke saare confirmed, unreserved payments. Ye reserve ho jaate hain
 *    (ek input do refunds mein nahi ja sakta).
 *  - Outputs: buyer ko (outstanding - fee); baaki (inputs - outstanding) 'change' treasury ko.
 *  - Hamesha: sum(inputs) == sum(outputs) + fee.
 *  - Idempotent: dobara chalane pe jo plan ho chuka wo dobara nahi banta.
 */
export async function planRefunds(db: Db, cfg: PlanCfg): Promise<PlanResult> {
  const ids = await db.query<{ id: string }>(
    `SELECT id FROM orders
     WHERE status IN ('minted','refund_needed') AND refund_due_zats > refunded_zats
     ORDER BY created_at, id`
  );
  const result: PlanResult = { created: [], skipped: [] };
  for (const { id } of ids.rows) {
    const r = await planOne(db, cfg, id);
    if (!r) continue;
    if ("reason" in r) result.skipped.push(r);
    else result.created.push(r);
  }
  return result;
}

async function planOne(db: Db, cfg: PlanCfg, orderId: string): Promise<RefundPlanItem | SkippedRefund | null> {
  return db.transaction(async (tx) => {
    const cur = await tx.query(`SELECT ${ORDER_COLS}, address_index FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    const order = mapOrder(cur.rows[0]);
    const skip = (reason: string): SkippedRefund => ({ orderId, reason });

    if (order.status !== "minted" && order.status !== "refund_needed") return null;
    const outstanding = order.refundDueZats - order.refundedZats;
    if (outstanding <= 0n) return null;

    if (!isAddressForNetwork(order.buyerAddress, cfg.network)) return skip("buyer address is network ka valid nahi hai");

    const pr = await tx.query<{ id: number; txid: string; vout: number; amount_zats: string }>(
      `SELECT id, txid, vout, amount_zats::text AS amount_zats FROM payments
       WHERE order_id = $1 AND dropped = false AND confirmations >= $2 AND refund_id IS NULL AND spent_txid IS NULL
       ORDER BY id`,
      [orderId, cfg.minConfirmations]
    );
    const inputs: PlanInput[] = pr.rows.map((p) => ({
      txid: p.txid,
      vout: p.vout,
      amountZats: BigInt(p.amount_zats),
      addressIndex: order.addressIndex,
    }));
    const total = sum(inputs);
    if (inputs.length === 0 || total < outstanding) {
      return skip(`inputs kam hain (confirmed unreserved ${formatZec(total)} < chahiye ${formatZec(outstanding)} ZEC)`);
    }

    // change / fee
    // rawChange chhota (dust) ho to alag output nahi banega, wo miner fee mein chala jaayega.
    const rawChange = total - outstanding;
    const hasChange = rawChange >= cfg.minRefundNetZats;
    const baseFee = conventionalFee(inputs.length, hasChange ? 2 : 1, cfg);
    const change = hasChange ? rawChange : 0n;
    const fee = baseFee + (hasChange ? 0n : rawChange); // miners ko jaane wali kul fee
    const net = outstanding - baseFee; // buyer ko milne wala
    if (net < cfg.minRefundNetZats) {
      return skip(`refund bahut chhota hai (net ${formatZec(net < 0n ? 0n : net)} ZEC < min ${formatZec(cfg.minRefundNetZats)}, fee ${formatZec(baseFee)})`);
    }
    if (hasChange) {
      if (!cfg.treasuryAddress) return skip("TREASURY_ADDRESS set nahi hai (change kahan bhejein?)");
      if (!isAddressForNetwork(cfg.treasuryAddress, cfg.network)) return skip("TREASURY_ADDRESS network ka valid nahi hai");
    }

    const outputs: PlanOutput[] = [{ address: order.buyerAddress, amountZats: net, role: "refund" }];
    if (hasChange) outputs.push({ address: cfg.treasuryAddress!, amountZats: change, role: "change" });

    // invariant: paisa na banta hai na gayab hota hai
    if (total !== sum(outputs) + fee) throw new Error(`BUG: plan invariant toota (order ${orderId})`);

    const ins = await tx.query<{ id: number }>(
      `INSERT INTO refunds (order_id, to_address, amount_zats, fee_zats, outputs_json)
       VALUES ($1,$2,$3::bigint,$4::bigint,$5) RETURNING id`,
      [
        orderId,
        order.buyerAddress,
        outstanding.toString(),
        fee.toString(),
        JSON.stringify(outputs.map((o) => ({ ...o, amountZats: o.amountZats.toString() }))),
      ]
    );
    const refundId = ins.rows[0].id;
    for (const p of pr.rows) await tx.query(`UPDATE payments SET refund_id = $1 WHERE id = $2`, [refundId, p.id]);
    await tx.query(`UPDATE orders SET refunded_zats = refunded_zats + $2::bigint WHERE id = $1`, [orderId, outstanding.toString()]);
    await tx.query(`INSERT INTO order_events (order_id, event, detail) VALUES ($1,'refund_planned',$2)`, [
      orderId,
      `refund#${refundId} gross=${formatZec(outstanding)} fee=${formatZec(fee)} net=${formatZec(net)}`,
    ]);
    return { refundId, orderId, toAddress: order.buyerAddress, grossZats: outstanding, feeZats: fee, inputs, outputs };
  });
}

/** DB se saare 'planned' refunds ka plan wapas banata hai (file kho jaaye to dobara export ho sakta hai). */
export async function exportPlanned(db: Db): Promise<RefundPlanItem[]> {
  const rs = await db.query(
    `SELECT r.id, r.order_id, r.to_address, r.amount_zats::text AS amount, r.fee_zats::text AS fee, r.outputs_json, o.address_index
     FROM refunds r JOIN orders o ON o.id = r.order_id
     WHERE r.status = 'planned' ORDER BY r.id`
  );
  const items: RefundPlanItem[] = [];
  for (const r of rs.rows as any[]) {
    const ps = await db.query<{ txid: string; vout: number; amount_zats: string }>(
      `SELECT txid, vout, amount_zats::text AS amount_zats FROM payments WHERE refund_id = $1 ORDER BY id`,
      [r.id]
    );
    items.push({
      refundId: r.id,
      orderId: r.order_id,
      toAddress: r.to_address,
      grossZats: BigInt(r.amount),
      feeZats: BigInt(r.fee),
      inputs: ps.rows.map((p) => ({ txid: p.txid, vout: p.vout, amountZats: BigInt(p.amount_zats), addressIndex: r.address_index })),
      outputs: (JSON.parse(r.outputs_json) as any[]).map((o) => ({ address: o.address, amountZats: BigInt(o.amountZats), role: o.role })),
    });
  }
  return items;
}

export function planToJson(items: RefundPlanItem[]): string {
  return JSON.stringify(
    items.map((i) => ({
      refundId: i.refundId,
      orderId: i.orderId,
      toAddress: i.toAddress,
      grossZats: i.grossZats.toString(),
      feeZats: i.feeZats.toString(),
      inputs: i.inputs.map((x) => ({ ...x, amountZats: x.amountZats.toString() })),
      outputs: i.outputs.map((x) => ({ ...x, amountZats: x.amountZats.toString() })),
    })),
    null,
    2
  );
}

/** Refund transaction broadcast ho gayi => txid record karo. Ab ye cancel nahi ho sakta. */
export async function markRefundSent(db: Db, refundId: number, txid: string, opts: { expiryHeight?: number } = {}): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("txid 64 hex characters ka hona chahiye");
  await db.transaction(async (tx) => {
    const r = await tx.query<{ status: string; order_id: string }>(`SELECT status, order_id FROM refunds WHERE id = $1 FOR UPDATE`, [refundId]);
    if (!r.rows[0]) throw new Error(`refund#${refundId} nahi mila`);
    if (r.rows[0].status !== "planned") throw new Error(`refund#${refundId} ka status '${r.rows[0].status}' hai, sirf 'planned' sent ho sakta hai`);
    await tx.query(
      `UPDATE refunds SET status = 'sent', txid = $2, updated_at = now(), sent_at = now(), expiry_height = $3 WHERE id = $1`,
      [refundId, txid, opts.expiryHeight && opts.expiryHeight > 0 ? opts.expiryHeight : null]
    );
    await tx.query(`UPDATE payments SET spent_txid = $2 WHERE refund_id = $1`, [refundId, txid]);
    await tx.query(`INSERT INTO order_events (order_id, event, detail) VALUES ($1,'refund_sent',$2)`, [
      r.rows[0].order_id,
      `refund#${refundId} txid=${txid}`,
    ]);
  });
}

/** Plan discard karo (sign/broadcast nahi hua). Inputs free ho jaate hain, refund dobara plan ho sakta hai. */
export async function cancelRefund(db: Db, refundId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const r = await tx.query<{ status: string; order_id: string; amount: string }>(
      `SELECT status, order_id, amount_zats::text AS amount FROM refunds WHERE id = $1 FOR UPDATE`,
      [refundId]
    );
    if (!r.rows[0]) throw new Error(`refund#${refundId} nahi mila`);
    if (r.rows[0].status !== "planned") {
      throw new Error(`refund#${refundId} ka status '${r.rows[0].status}' hai. Sirf 'planned' cancel ho sakta hai (sent tx chain pe ho sakti hai).`);
    }
    await tx.query(`UPDATE refunds SET status = 'cancelled', updated_at = now() WHERE id = $1`, [refundId]);
    await tx.query(`UPDATE payments SET refund_id = NULL WHERE refund_id = $1`, [refundId]);
    await tx.query(`UPDATE orders SET refunded_zats = refunded_zats - $2::bigint WHERE id = $1`, [r.rows[0].order_id, r.rows[0].amount]);
    await tx.query(`INSERT INTO order_events (order_id, event, detail) VALUES ($1,'refund_cancelled',$2)`, [r.rows[0].order_id, `refund#${refundId}`]);
  });
}

export async function listRefunds(db: Db): Promise<
  { id: number; orderId: string; status: string; grossZats: bigint; feeZats: bigint; toAddress: string; txid: string | null }[]
> {
  const rs = await db.query(
    `SELECT id, order_id, status, amount_zats::text AS amount, fee_zats::text AS fee, to_address, txid FROM refunds ORDER BY id`
  );
  return (rs.rows as any[]).map((r) => ({
    id: r.id,
    orderId: r.order_id,
    status: r.status,
    grossZats: BigInt(r.amount),
    feeZats: BigInt(r.fee),
    toAddress: r.to_address,
    txid: r.txid,
  }));
}
