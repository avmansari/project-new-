import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { deriveReceiveAddress, isAddressForNetwork } from "../zcash/address.js";
import { logActivity } from "./activity.js";
import { splitSale } from "./ledger.js";
import { mapOrder, ORDER_COLS, type Order } from "./orders.js";

export type ListingErrorCode =
  | "COLLECTION_NOT_FOUND"
  | "TOKEN_NOT_MINTED"
  | "NOT_OWNER"
  | "TOKEN_BLOCKED"
  | "ALREADY_LISTED"
  | "LISTING_NOT_FOUND"
  | "LISTING_NOT_ACTIVE"
  | "INVALID_PRICE"
  | "INVALID_ADDRESS"
  | "COLLECTION_FROZEN";

export class ListingError extends Error {
  constructor(public code: ListingErrorCode, message: string) {
    super(message);
    this.name = "ListingError";
  }
}

export interface Listing {
  id: number;
  collectionId: number;
  slug: string;
  collectionName: string;
  tokenNumber: number;
  sellerAddress: string;
  priceZats: bigint;
  feeBps: number;
  status: "active" | "pending" | "sold" | "cancelled";
  orderId: string | null;
}

const LISTING_COLS = `l.id, l.collection_id, c.slug, c.name AS collection_name, l.token_number, l.seller_address,
  l.price_zats::text AS price_zats, l.fee_bps, l.status, l.order_id`;

function mapListing(r: any): Listing {
  return {
    id: r.id, collectionId: r.collection_id, slug: r.slug, collectionName: r.collection_name,
    tokenNumber: r.token_number, sellerAddress: r.seller_address, priceZats: BigInt(r.price_zats),
    feeBps: r.fee_bps, status: r.status, orderId: r.order_id ?? null,
  };
}

type MpCfg = Pick<AppConfig, "network" | "walletXpub" | "orderTtlMinutes" | "marketplaceFeeBps">;

/** Owner apna token bikri ke liye list karta hai. */
export async function listToken(
  db: Db,
  cfg: Pick<AppConfig, "network" | "marketplaceFeeBps">,
  input: { slug: string; tokenNumber: number; sellerAddress: string; priceZats: bigint }
): Promise<Listing> {
  if (!isAddressForNetwork(input.sellerAddress, cfg.network)) throw new ListingError("INVALID_ADDRESS", "seller address galat hai");
  if (input.priceZats <= 0n) throw new ListingError("INVALID_PRICE", "price > 0 honi chahiye");

  return db.transaction(async (tx) => {
    const c = await tx.query<{ id: number; status: string; payout_frozen: boolean }>(
      `SELECT id, status, payout_frozen FROM collections WHERE slug = $1`,
      [input.slug]
    );
    if (!c.rows[0]) throw new ListingError("COLLECTION_NOT_FOUND", "collection nahi mili");
    if (c.rows[0].payout_frozen) throw new ListingError("COLLECTION_FROZEN", "collection freeze hai");
    const colId = c.rows[0].id;

    const t = await tx.query<{ owner_address: string; blocked: boolean; blocked_reason: string | null }>(
      `SELECT owner_address, blocked, blocked_reason FROM tokens WHERE collection_id = $1 AND token_number = $2 AND voided_at IS NULL FOR UPDATE`,
      [colId, input.tokenNumber]
    );
    if (!t.rows[0]) throw new ListingError("TOKEN_NOT_MINTED", "ye token mint nahi hua");
    if (t.rows[0].owner_address !== input.sellerAddress) throw new ListingError("NOT_OWNER", "aap is token ke owner nahi hain");
    if (t.rows[0].blocked) throw new ListingError("TOKEN_BLOCKED", t.rows[0].blocked_reason ?? "ye token blocked hai");

    let newId: number;
    try {
      const ins = await tx.query<{ id: number }>(
        `INSERT INTO listings (collection_id, token_number, seller_address, price_zats, fee_bps)
         VALUES ($1,$2,$3,$4::bigint,$5) RETURNING id`,
        [colId, input.tokenNumber, input.sellerAddress, input.priceZats.toString(), cfg.marketplaceFeeBps]
      );
      newId = ins.rows[0].id;
    } catch (e) {
      if (String((e as Error).message).includes("listings_one_active_per_token")) throw new ListingError("ALREADY_LISTED", "ye token pehle se list hai");
      throw e;
    }
    await logActivity(tx as unknown as Db, colId, "list", { tokenNumber: input.tokenNumber, amountZats: input.priceZats, address: input.sellerAddress });
    const full = await tx.query(`SELECT ${LISTING_COLS} FROM listings l JOIN collections c ON c.id = l.collection_id WHERE l.id = $1`, [newId]);
    return mapListing(full.rows[0]);
  });
}

export async function cancelListing(db: Db, listingId: number, sellerAddress: string): Promise<void> {
  return db.transaction(async (tx) => {
    const r = await tx.query<{ status: string; seller_address: string; collection_id: number; token_number: number }>(
      `SELECT status, seller_address, collection_id, token_number FROM listings WHERE id = $1 FOR UPDATE`,
      [listingId]
    );
    if (!r.rows[0]) throw new ListingError("LISTING_NOT_FOUND", "listing nahi mili");
    if (r.rows[0].seller_address !== sellerAddress) throw new ListingError("NOT_OWNER", "aap is listing ke seller nahi hain");
    if (r.rows[0].status !== "active") throw new ListingError("LISTING_NOT_ACTIVE", `listing '${r.rows[0].status}' hai, cancel nahi ho sakti`);
    await tx.query(`UPDATE listings SET status = 'cancelled', updated_at = now() WHERE id = $1`, [listingId]);
    await logActivity(tx as unknown as Db, r.rows[0].collection_id, "cancel_list", { tokenNumber: r.rows[0].token_number, address: sellerAddress });
  });
}

/** Buyer listing kharidne ke liye order banata hai (launchpad ke createOrder jaisa, par supply/wallet-limit check nahi). */
export async function createPurchaseOrder(
  db: Db,
  cfg: MpCfg,
  input: { listingId: number; buyerAddress: string; now?: Date; tipHeight?: number }
): Promise<Order> {
  const now = input.now ?? new Date();
  if (!isAddressForNetwork(input.buyerAddress, cfg.network)) throw new ListingError("INVALID_ADDRESS", "buyer address galat hai");

  return db.transaction(async (tx) => {
    const l = await tx.query<{ collection_id: number; token_number: number; seller_address: string; price_zats: string; status: string }>(
      `SELECT collection_id, token_number, seller_address, price_zats::text AS price_zats, status FROM listings WHERE id = $1 FOR UPDATE`,
      [input.listingId]
    );
    if (!l.rows[0]) throw new ListingError("LISTING_NOT_FOUND", "listing nahi mili");
    if (l.rows[0].status !== "active") throw new ListingError("LISTING_NOT_ACTIVE", "ye listing abhi bikne ke liye available nahi hai");
    if (l.rows[0].seller_address === input.buyerAddress) throw new ListingError("NOT_OWNER", "apni hi listing nahi khareed sakte");

    const idx: number = (await tx.query<{ i: number }>(`SELECT nextval('pay_address_index_seq')::int AS i`)).rows[0].i;
    const payAddress = deriveReceiveAddress(cfg.walletXpub, idx, cfg.network);
    const expiresAt = new Date(now.getTime() + cfg.orderTtlMinutes * 60_000);
    const id = randomUUID();

    const ins = await tx.query(
      `INSERT INTO orders (id, collection_id, quantity, buyer_address, pay_address, address_index,
                           amount_zats, status, expires_at, created_at, start_height, kind, listing_id)
       VALUES ($1,$2,1,$3,$4,$5,$6::bigint,'pending',$7::timestamptz,$8::timestamptz,$9,'buy',$10)
       RETURNING ${ORDER_COLS}`,
      [id, l.rows[0].collection_id, input.buyerAddress, payAddress, idx, l.rows[0].price_zats, expiresAt.toISOString(), now.toISOString(), input.tipHeight ?? null, input.listingId]
    );
    await tx.query(`UPDATE listings SET status = 'pending', order_id = $2, updated_at = now() WHERE id = $1`, [input.listingId, id]);
    await tx.query(`INSERT INTO order_events (order_id, event, detail) VALUES ($1,'created',$2)`, [id, `buy listing#${input.listingId} pay=${payAddress}`]);
    return mapOrder(ins.rows[0]);
  });
}

export type PurchaseOutcome = "sold" | "already_sold" | "skipped";

/** Order 'paid' ho gaya => ownership BADAL DO, seller ko payout request bano (turant, koi hold nahi). */
export async function settlePurchase(db: Db, orderId: string): Promise<{ orderId: string; outcome: PurchaseOutcome }> {
  return db.transaction(async (tx) => {
    const or = await tx.query(`SELECT ${ORDER_COLS} FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    if (!or.rows[0]) throw new Error(`order nahi mila: ${orderId}`);
    const order = mapOrder(or.rows[0]);
    if (order.kind !== "buy" || order.listingId === null) throw new Error(`order ${orderId} 'buy' nahi hai`);

    const lr = await tx.query<{ status: string; collection_id: number; token_number: number; seller_address: string; fee_bps: number }>(
      `SELECT status, collection_id, token_number, seller_address, fee_bps FROM listings WHERE id = $1 FOR UPDATE`,
      [order.listingId]
    );
    const listing = lr.rows[0];
    if (order.status === "minted") return { orderId, outcome: "already_sold" };
    if (order.status !== "paid") return { orderId, outcome: "skipped" };
    if (order.receivedZats < order.amountZats) return { orderId, outcome: "skipped" };
    if (!listing || listing.status !== "pending") return { orderId, outcome: "skipped" };

    const tk = await tx.query<{ owner_address: string; voided_at: Date | null }>(
      `SELECT owner_address, voided_at FROM tokens WHERE collection_id = $1 AND token_number = $2 FOR UPDATE`,
      [listing.collection_id, listing.token_number]
    );
    if (!tk.rows[0] || tk.rows[0].voided_at || tk.rows[0].owner_address !== listing.seller_address) {
      // Token kisi wajah se transfer ke layak nahi (voided ho gaya waghera): refund, sale nahi
      await tx.query(`UPDATE orders SET status = 'refund_needed', refund_due_zats = received_zats WHERE id = $1`, [orderId]);
      await tx.query(`UPDATE listings SET status = 'cancelled', updated_at = now() WHERE id = $1`, [order.listingId]);
      return { orderId, outcome: "skipped" };
    }

    const { feeZats, netZats } = splitSale(order.amountZats, listing.fee_bps);
    const now = new Date().toISOString();
    await tx.query(`UPDATE tokens SET owner_address = $3 WHERE collection_id = $1 AND token_number = $2`, [listing.collection_id, listing.token_number, order.buyerAddress]);
    await tx.query(`UPDATE orders SET status = 'minted', minted_at = $2::timestamptz WHERE id = $1`, [orderId, now]);
    await tx.query(`UPDATE listings SET status = 'sold', updated_at = now() WHERE id = $1`, [order.listingId]);
    await tx.query(
      `INSERT INTO sales (order_id, collection_id, gross_zats, platform_fee_zats, creator_net_zats, kind)
       VALUES ($1,$2,$3::bigint,$4::bigint,$5::bigint,'resale')`,
      [orderId, listing.collection_id, order.amountZats.toString(), feeZats.toString(), netZats.toString()]
    );
    if (netZats > 0n) {
      await tx.query(`INSERT INTO payout_requests (collection_id, address, amount_zats, kind) VALUES ($1,$2,$3::bigint,'final')`, [
        listing.collection_id, listing.seller_address, netZats.toString(),
      ]);
    }
    await logActivity(tx as unknown as Db, listing.collection_id, "sale", {
      tokenNumber: listing.token_number, amountZats: order.amountZats, address: order.buyerAddress, detail: `from ${listing.seller_address}`,
    });
    return { orderId, outcome: "sold" };
  });
}

/** Har 'paid' (buy) order ko settle karo. */
export async function settlePaidPurchases(db: Db): Promise<{ orderId: string; outcome: PurchaseOutcome }[]> {
  const r = await db.query<{ id: string }>(`SELECT id FROM orders WHERE kind = 'buy' AND status = 'paid' ORDER BY id`);
  const out: { orderId: string; outcome: PurchaseOutcome }[] = [];
  for (const row of r.rows) out.push(await settlePurchase(db, row.id));
  return out;
}

/** Jin listings ka order expire/refund/refunded ho gaya, unhe wapas 'active' karo (token seller ke paas hi hai). */
export async function releaseStaleListings(db: Db): Promise<number> {
  const r = await db.query(
    `UPDATE listings l SET status = 'active', order_id = NULL, updated_at = now()
     FROM orders o WHERE l.status = 'pending' AND l.order_id = o.id
       AND o.status IN ('expired','refund_needed','refunded')
     RETURNING l.id`
  );
  return r.rows.length;
}

export async function getListing(db: Db, id: number): Promise<Listing | null> {
  const r = await db.query(`SELECT ${LISTING_COLS} FROM listings l JOIN collections c ON c.id = l.collection_id WHERE l.id = $1`, [id]);
  return r.rows[0] ? mapListing(r.rows[0]) : null;
}

export async function listActiveListings(db: Db, opts: { slug?: string; limit?: number; offset?: number } = {}): Promise<{ total: number; items: Listing[] }> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 24));
  const offset = Math.max(0, opts.offset ?? 0);
  const params: unknown[] = [limit, offset];
  if (opts.slug) params.push(opts.slug);
  const total = (
    await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM listings l JOIN collections c ON c.id = l.collection_id WHERE l.status = 'active' ${opts.slug ? "AND c.slug = $1" : ""}`,
      opts.slug ? [opts.slug] : []
    )
  ).rows[0].n;
  const where = opts.slug ? `AND c.slug = $3` : ``;
  const r = await db.query(
    `SELECT ${LISTING_COLS} FROM listings l JOIN collections c ON c.id = l.collection_id WHERE l.status = 'active' ${where}
     ORDER BY l.price_zats ASC LIMIT $1 OFFSET $2`,
    params
  );
  return { total, items: r.rows.map(mapListing) };
}
