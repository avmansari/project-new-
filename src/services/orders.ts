import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { deriveReceiveAddress, isAddressForNetwork } from "../zcash/address.js";
import { COLLECTION_COLS, mapCollection } from "./collections.js";

export type OrderStatus = "pending" | "paid" | "minted" | "expired" | "refund_needed" | "refunded";

export type OrderErrorCode =
  | "COLLECTION_NOT_FOUND"
  | "COLLECTION_NOT_LIVE"
  | "NOT_STARTED"
  | "INVALID_QUANTITY"
  | "INVALID_BUYER_ADDRESS"
  | "SOLD_OUT"
  | "WALLET_LIMIT"
  | "ORDER_NOT_FOUND"
  | "CANNOT_CANCEL";

export class OrderError extends Error {
  constructor(public code: OrderErrorCode, message: string) {
    super(message);
    this.name = "OrderError";
  }
}

export interface Order {
  id: string;
  collectionId: number;
  quantity: number;
  buyerAddress: string;
  payAddress: string;
  addressIndex: number;
  amountZats: bigint;
  status: OrderStatus;
  expiresAt: Date;
  receivedZats: bigint;
  refundDueZats: bigint;
  refundedZats: bigint;
  funded: boolean;
  /** Order banate waqt chain ka tip. null = purana order (koi filter nahi). */
  startHeight: number | null;
  kind: "mint" | "buy";
  listingId: number | null;
}

export const ORDER_COLS = `id, collection_id, quantity, buyer_address, pay_address, address_index,
  amount_zats::text AS amount_zats, status, expires_at,
  received_zats::text AS received_zats, refund_due_zats::text AS refund_due_zats, refunded_zats::text AS refunded_zats, funded, start_height,
  kind, listing_id`;

export function mapOrder(r: any): Order {
  return {
    id: r.id,
    collectionId: r.collection_id,
    quantity: r.quantity,
    buyerAddress: r.buyer_address,
    payAddress: r.pay_address,
    addressIndex: r.address_index,
    amountZats: BigInt(r.amount_zats),
    status: r.status,
    expiresAt: new Date(r.expires_at),
    receivedZats: BigInt(r.received_zats),
    refundDueZats: BigInt(r.refund_due_zats),
    refundedZats: BigInt(r.refunded_zats),
    funded: r.funded,
    startHeight: r.start_height ?? null,
    kind: r.kind,
    listingId: r.listing_id ?? null,
  };
}

/**
 * "Committed" quantity = wo NFTs jo kisi order ke naam pe ruke hue hain:
 *  - paid / minted orders
 *  - pending orders jinka payment window abhi khatam nahi hua
 *  - pending orders jinka poora payment time pe dikh chuka hai (funded), bhale window khatam ho gayi ho
 *    aur bas confirmations ka intezaar ho. (Warna last NFT kisi aur ko bik sakta tha!)
 * Baaki expired pending orders ka supply apne aap free ho jaata hai.
 */
const COMMITTED_FILTER = `(status IN ('paid','minted') OR (status = 'pending' AND (expires_at > $NOW::timestamptz OR funded)))`;

export async function createOrder(
  db: Db,
  cfg: Pick<AppConfig, "network" | "walletXpub" | "orderTtlMinutes">,
  input: { collectionSlug: string; quantity: number; buyerAddress: string; now?: Date; tipHeight?: number }
): Promise<Order> {
  const now = input.now ?? new Date();

  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new OrderError("INVALID_QUANTITY", "quantity >= 1 integer honi chahiye");
  }
  if (!isAddressForNetwork(input.buyerAddress, cfg.network)) {
    throw new OrderError("INVALID_BUYER_ADDRESS", `buyer address ${cfg.network} ka valid t-address nahi hai`);
  }

  return db.transaction(async (tx) => {
    // Collection row lock: ek time pe ek hi order isi collection ka supply check kar sakta hai => oversell impossible
    const cr = await tx.query(`SELECT ${COLLECTION_COLS} FROM collections WHERE slug = $1 FOR UPDATE`, [input.collectionSlug]);
    if (!cr.rows[0]) throw new OrderError("COLLECTION_NOT_FOUND", "collection nahi mili");
    const col = mapCollection(cr.rows[0]);
    if (col.status !== "live") throw new OrderError("COLLECTION_NOT_LIVE", "collection abhi live nahi hai");
    if (col.payoutFrozen) throw new OrderError("COLLECTION_NOT_LIVE", "collection freeze hai (jaanch chal rahi hai), nayi sales band hain");
    if (col.startsAt && now < col.startsAt) {
      throw new OrderError("NOT_STARTED", `Mint abhi shuru nahi hua. Launch time: ${col.startsAt.toISOString()}`);
    }

    if (input.quantity > col.maxPerWallet) {
      throw new OrderError("WALLET_LIMIT", `ek wallet max ${col.maxPerWallet} le sakta hai`);
    }

    const nowIso = now.toISOString();
    const filter = COMMITTED_FILTER.replace("$NOW", "$2");

    const total = await tx.query<{ n: number }>(
      `SELECT COALESCE(SUM(quantity),0)::int AS n FROM orders WHERE collection_id = $1 AND ${filter}`,
      [col.id, nowIso]
    );
    if (total.rows[0].n + input.quantity > col.supply) {
      throw new OrderError("SOLD_OUT", "itna supply bacha nahi hai");
    }

    const mine = await tx.query<{ n: number }>(
      `SELECT COALESCE(SUM(quantity),0)::int AS n FROM orders
       WHERE collection_id = $1 AND buyer_address = $3 AND ${filter}`,
      [col.id, nowIso, input.buyerAddress]
    );
    if (mine.rows[0].n + input.quantity > col.maxPerWallet) {
      throw new OrderError("WALLET_LIMIT", `is wallet ki limit ${col.maxPerWallet} hai (pehle ke orders mila ke)`);
    }

    const idx: number = (await tx.query<{ i: number }>(`SELECT nextval('pay_address_index_seq')::int AS i`)).rows[0].i;
    const payAddress = deriveReceiveAddress(cfg.walletXpub, idx, cfg.network);
    const amount = col.priceZats * BigInt(input.quantity);
    const expiresAt = new Date(now.getTime() + cfg.orderTtlMinutes * 60_000);
    const id = randomUUID();

    const ins = await tx.query(
      `INSERT INTO orders (id, collection_id, quantity, buyer_address, pay_address, address_index,
                           amount_zats, status, expires_at, created_at, start_height)
       VALUES ($1,$2,$3,$4,$5,$6,$7::bigint,'pending',$8::timestamptz,$9::timestamptz,$10)
       RETURNING ${ORDER_COLS}`,
      [id, col.id, input.quantity, input.buyerAddress, payAddress, idx, amount.toString(), expiresAt.toISOString(), nowIso, input.tipHeight ?? null]
    );
    await tx.query(`INSERT INTO order_events (order_id, event, detail) VALUES ($1,'created',$2)`, [
      id,
      `qty=${input.quantity} amount_zats=${amount} pay=${payAddress}`,
    ]);
    return mapOrder(ins.rows[0]);
  });
}

export async function getOrder(db: Db, id: string): Promise<Order | null> {
  const r = await db.query(`SELECT ${ORDER_COLS} FROM orders WHERE id = $1`, [id]);
  return r.rows[0] ? mapOrder(r.rows[0]) : null;
}

export async function listOrders(db: Db, limit = 20): Promise<Order[]> {
  const r = await db.query(`SELECT ${ORDER_COLS} FROM orders ORDER BY created_at DESC, address_index DESC LIMIT $1`, [limit]);
  return r.rows.map(mapOrder);
}


/**
 * User ne wallet popup reject kar diya (ya page band kar diya) => order turant expire, supply free.
 * Sirf 'pending' aur bina-poori-payment-dikhe order cancel ho sakta hai.
 * Agar baad mein payment aa hi jaye, to wo "late" ginti hai aur refund banta hai (NFT nahi milta).
 * Idempotent: dobara cancel karne par bhi error nahi.
 */
export async function cancelPendingOrder(db: Db, id: string, now: Date = new Date()): Promise<Order> {
  return db.transaction(async (tx) => {
    const cur = await tx.query(`SELECT ${ORDER_COLS} FROM orders WHERE id = $1 FOR UPDATE`, [id]);
    if (!cur.rows[0]) throw new OrderError("ORDER_NOT_FOUND", "order nahi mila");
    const o = mapOrder(cur.rows[0]);
    if (o.status === "expired") return o;
    if (o.status !== "pending") throw new OrderError("CANNOT_CANCEL", `order '${o.status}' hai, cancel nahi ho sakta`);
    if (o.funded) throw new OrderError("CANNOT_CANCEL", "payment dikh chuki hai, cancel nahi ho sakta");
    const up = await tx.query(
      `UPDATE orders SET status = 'expired', expires_at = LEAST(expires_at, $2::timestamptz) WHERE id = $1 RETURNING ${ORDER_COLS}`,
      [id, now.toISOString()]
    );
    await tx.query(`INSERT INTO order_events (order_id, event, detail) VALUES ($1,'cancelled_by_user','pending -> expired')`, [id]);
    return mapOrder(up.rows[0]);
  });
}
