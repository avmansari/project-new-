import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { deriveReceiveAddress, isAddressForNetwork } from "../zcash/address.js";
import { logActivity } from "./activity.js";
import { splitSale } from "./ledger.js";

export type OfferStatus = "awaiting_payment" | "active" | "accepted" | "rejected" | "cancelled" | "expired";

export class OfferError extends Error {
  constructor(
    public code:
      | "COLLECTION_NOT_FOUND"
      | "TOKEN_NOT_MINTED"
      | "TOKEN_BLOCKED"
      | "OFFER_NOT_FOUND"
      | "NOT_ACTIVE"
      | "NOT_OWNER"
      | "NOT_BUYER"
      | "INVALID_PRICE"
      | "INVALID_ADDRESS"
      | "COLLECTION_FROZEN",
    message: string
  ) {
    super(message);
    this.name = "OfferError";
  }
}

export interface Offer {
  id: number;
  collectionId: number;
  slug: string;
  collectionName: string;
  tokenNumber: number;
  buyerAddress: string;
  priceZats: bigint;
  feeBps: number;
  status: OfferStatus;
  orderId: string | null;
}

const OFFER_COLS = `o.id, o.collection_id, c.slug, c.name AS collection_name, o.token_number, o.buyer_address,
  o.price_zats::text AS price_zats, o.fee_bps, o.status, o.order_id`;

function mapOffer(r: any): Offer {
  return {
    id: r.id, collectionId: r.collection_id, slug: r.slug, collectionName: r.collection_name,
    tokenNumber: r.token_number, buyerAddress: r.buyer_address, priceZats: BigInt(r.price_zats),
    feeBps: r.fee_bps, status: r.status, orderId: r.order_id ?? null,
  };
}

type OfCfg = Pick<AppConfig, "network" | "walletXpub" | "orderTtlMinutes" | "marketplaceFeeBps">;

/** Kisi bhi MINTED token pe offer banao (listed ho ya na ho). Payment turant (escrow) mangta hai. */
export async function createOffer(
  db: Db,
  cfg: OfCfg,
  input: { slug: string; tokenNumber: number; buyerAddress: string; priceZats: bigint; now?: Date; tipHeight?: number }
): Promise<Offer & { payAddress: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  if (!isAddressForNetwork(input.buyerAddress, cfg.network)) throw new OfferError("INVALID_ADDRESS", "buyer address galat hai");
  if (input.priceZats <= 0n) throw new OfferError("INVALID_PRICE", "price > 0 honi chahiye");

  return db.transaction(async (tx) => {
    const c = await tx.query<{ id: number; status: string; payout_frozen: boolean }>(`SELECT id, status, payout_frozen FROM collections WHERE slug = $1`, [input.slug]);
    if (!c.rows[0]) throw new OfferError("COLLECTION_NOT_FOUND", "collection nahi mili");
    if (c.rows[0].payout_frozen) throw new OfferError("COLLECTION_FROZEN", "collection freeze hai");
    const colId = c.rows[0].id;

    const t = await tx.query<{ blocked: boolean; blocked_reason: string | null }>(
      `SELECT blocked, blocked_reason FROM tokens WHERE collection_id = $1 AND token_number = $2 AND voided_at IS NULL`,
      [colId, input.tokenNumber]
    );
    if (!t.rows[0]) throw new OfferError("TOKEN_NOT_MINTED", "ye token mint nahi hua");
    if (t.rows[0].blocked) throw new OfferError("TOKEN_BLOCKED", t.rows[0].blocked_reason ?? "ye token blocked hai");

    const idx: number = (await tx.query<{ i: number }>(`SELECT nextval('pay_address_index_seq')::int AS i`)).rows[0].i;
    const payAddress = deriveReceiveAddress(cfg.walletXpub, idx, cfg.network);
    const expiresAt = new Date(now.getTime() + cfg.orderTtlMinutes * 60_000);
    const orderId = randomUUID();

    await tx.query(
      `INSERT INTO orders (id, collection_id, quantity, buyer_address, pay_address, address_index,
                           amount_zats, status, expires_at, created_at, kind)
       VALUES ($1,$2,1,$3,$4,$5,$6::bigint,'pending',$7::timestamptz,$8::timestamptz,'offer')`,
      [orderId, colId, input.buyerAddress, payAddress, idx, input.priceZats.toString(), expiresAt.toISOString(), now.toISOString()]
    );
    const ins = await tx.query<{ id: number }>(
      `INSERT INTO offers (collection_id, token_number, buyer_address, price_zats, fee_bps, order_id)
       VALUES ($1,$2,$3,$4::bigint,$5,$6) RETURNING id`,
      [colId, input.tokenNumber, input.buyerAddress, input.priceZats.toString(), cfg.marketplaceFeeBps, orderId]
    );
    await tx.query(`INSERT INTO order_events (order_id, event, detail) VALUES ($1,'created',$2)`, [orderId, `offer#${ins.rows[0].id} pay=${payAddress}`]);
    await logActivity(tx as unknown as Db, colId, "offer_made", { tokenNumber: input.tokenNumber, amountZats: input.priceZats, address: input.buyerAddress });

    const full = await tx.query(`SELECT ${OFFER_COLS} FROM offers o JOIN collections c ON c.id = o.collection_id WHERE o.id = $1`, [ins.rows[0].id]);
    return { ...mapOffer(full.rows[0]), payAddress, expiresAt };
  });
}

/** Worker: 'offer' order 'paid' ho gaya => offer 'active' (ownership abhi nahi badalti, owner decide karega). */
export async function activatePaidOffers(db: Db): Promise<number> {
  const r = await db.query<{ id: number; order_id: string }>(
    `UPDATE offers o SET status = 'active', updated_at = now()
     FROM orders ord WHERE o.order_id = ord.id AND o.status = 'awaiting_payment' AND ord.status = 'paid' AND ord.received_zats >= ord.amount_zats
     RETURNING o.id, o.order_id`
  );
  return r.rows.length;
}

/** Payment order expire/refund ho gaya to offer bhi khatam maano (paisa kabhi mila hi nahi). */
export async function expireStaleOffers(db: Db): Promise<number> {
  const r = await db.query(
    `UPDATE offers o SET status = 'expired', updated_at = now()
     FROM orders ord WHERE o.order_id = ord.id AND o.status = 'awaiting_payment' AND ord.status IN ('expired','refund_needed','refunded')
     RETURNING o.id`
  );
  return r.rows.length;
}

/** Owner offer accept karta hai: ownership BADALTI hai, seller ko payout, baaki active offers reject+refund. */
export async function acceptOffer(db: Db, offerId: number, ownerAddress: string): Promise<{ tokenNumber: number }> {
  return db.transaction(async (tx) => {
    const o = await tx.query<any>(`SELECT ${OFFER_COLS}, o.order_id FROM offers o JOIN collections c ON c.id = o.collection_id WHERE o.id = $1 FOR UPDATE`, [offerId]);
    if (!o.rows[0]) throw new OfferError("OFFER_NOT_FOUND", "offer nahi mili");
    const offer = mapOffer(o.rows[0]);
    if (offer.status !== "active") throw new OfferError("NOT_ACTIVE", `offer '${offer.status}' hai, accept nahi ho sakti`);

    const tk = await tx.query<{ owner_address: string; blocked: boolean }>(
      `SELECT owner_address, blocked FROM tokens WHERE collection_id = $1 AND token_number = $2 AND voided_at IS NULL FOR UPDATE`,
      [offer.collectionId, offer.tokenNumber]
    );
    if (!tk.rows[0]) throw new OfferError("TOKEN_NOT_MINTED", "token nahi mila");
    if (tk.rows[0].owner_address !== ownerAddress) throw new OfferError("NOT_OWNER", "aap is token ke owner nahi hain");
    if (tk.rows[0].blocked) throw new OfferError("TOKEN_BLOCKED", "ye token blocked hai");

    const ord = await tx.query<{ received_zats: string; amount_zats: string }>(`SELECT received_zats::text AS received_zats, amount_zats::text AS amount_zats FROM orders WHERE id = $1`, [offer.orderId]);
    if (BigInt(ord.rows[0].received_zats) < BigInt(ord.rows[0].amount_zats)) throw new OfferError("NOT_ACTIVE", "offer ka poora paisa confirmed nahi hai");

    const { feeZats, netZats } = splitSale(offer.priceZats, offer.feeBps);
    await tx.query(`UPDATE tokens SET owner_address = $3 WHERE collection_id = $1 AND token_number = $2`, [offer.collectionId, offer.tokenNumber, offer.buyerAddress]);
    await tx.query(`UPDATE offers SET status = 'accepted', updated_at = now() WHERE id = $1`, [offerId]);
    await tx.query(`UPDATE orders SET status = 'minted', minted_at = now() WHERE id = $1`, [offer.orderId]);
    await tx.query(
      `INSERT INTO sales (order_id, collection_id, gross_zats, platform_fee_zats, creator_net_zats, kind) VALUES ($1,$2,$3::bigint,$4::bigint,$5::bigint,'resale')`,
      [offer.orderId, offer.collectionId, offer.priceZats.toString(), feeZats.toString(), netZats.toString()]
    );
    if (netZats > 0n) {
      await tx.query(`INSERT INTO payout_requests (collection_id, address, amount_zats, kind) VALUES ($1,$2,$3::bigint,'final')`, [offer.collectionId, ownerAddress, netZats.toString()]);
    }
    // Active listing (agar thi) ab invalid hai -- token bik chuka
    await tx.query(`UPDATE listings SET status = 'cancelled', updated_at = now() WHERE collection_id = $1 AND token_number = $2 AND status = 'active'`, [offer.collectionId, offer.tokenNumber]);
    // Baaki saare doosre active offers isi token pe: reject + unka paisa refund
    const others = await tx.query<{ id: number; order_id: string; price_zats: string }>(
      `SELECT id, order_id, price_zats::text AS price_zats FROM offers WHERE collection_id = $1 AND token_number = $2 AND status = 'active' AND id != $3`,
      [offer.collectionId, offer.tokenNumber, offerId]
    );
    for (const other of others.rows) {
      await tx.query(`UPDATE offers SET status = 'rejected', updated_at = now() WHERE id = $1`, [other.id]);
      await tx.query(`UPDATE orders SET status = 'refund_needed', refund_due_zats = received_zats WHERE id = $1`, [other.order_id]);
    }
    await logActivity(tx as unknown as Db, offer.collectionId, "offer_accepted", { tokenNumber: offer.tokenNumber, amountZats: offer.priceZats, address: offer.buyerAddress });
    return { tokenNumber: offer.tokenNumber };
  });
}

/** Owner reject kare, ya buyer khud cancel kare (dono ka asar same: buyer ko refund). */
async function closeOffer(db: Db, offerId: number, who: "owner" | "buyer", callerAddress: string, newStatus: "rejected" | "cancelled"): Promise<void> {
  await db.transaction(async (tx) => {
    const o = await tx.query<any>(`SELECT ${OFFER_COLS} FROM offers o JOIN collections c ON c.id = o.collection_id WHERE o.id = $1 FOR UPDATE`, [offerId]);
    if (!o.rows[0]) throw new OfferError("OFFER_NOT_FOUND", "offer nahi mili");
    const offer = mapOffer(o.rows[0]);
    if (who === "buyer" && offer.buyerAddress !== callerAddress) throw new OfferError("NOT_BUYER", "aap is offer ke buyer nahi hain");
    if (who === "owner") {
      const tk = await tx.query<{ owner_address: string }>(`SELECT owner_address FROM tokens WHERE collection_id = $1 AND token_number = $2 AND voided_at IS NULL`, [offer.collectionId, offer.tokenNumber]);
      if (!tk.rows[0] || tk.rows[0].owner_address !== callerAddress) throw new OfferError("NOT_OWNER", "aap is token ke owner nahi hain");
    }
    if (offer.status !== "active" && offer.status !== "awaiting_payment") throw new OfferError("NOT_ACTIVE", `offer '${offer.status}' hai`);

    if (offer.status === "active") {
      // Paisa already aa chuka hai -- refund banao
      await tx.query(`UPDATE orders SET status = 'refund_needed', refund_due_zats = received_zats WHERE id = $1`, [offer.orderId]);
    } else if (offer.orderId) {
      // Abhi paisa aaya hi nahi -- order seedha expire (agar abhi bhi pending hai)
      await tx.query(`UPDATE orders SET status = 'expired', expires_at = LEAST(expires_at, now()) WHERE id = $1 AND status = 'pending'`, [offer.orderId]);
    }
    await tx.query(`UPDATE offers SET status = $2, updated_at = now() WHERE id = $1`, [offerId, newStatus]);
    await logActivity(tx as unknown as Db, offer.collectionId, newStatus === "rejected" ? "offer_rejected" : "offer_rejected", { tokenNumber: offer.tokenNumber, address: offer.buyerAddress, detail: newStatus });
  });
}

export const rejectOffer = (db: Db, offerId: number, ownerAddress: string) => closeOffer(db, offerId, "owner", ownerAddress, "rejected");
export const cancelOffer = (db: Db, offerId: number, buyerAddress: string) => closeOffer(db, offerId, "buyer", buyerAddress, "cancelled");

export async function listOffersForToken(db: Db, slug: string, tokenNumber: number): Promise<Offer[]> {
  const r = await db.query(
    `SELECT ${OFFER_COLS} FROM offers o JOIN collections c ON c.id = o.collection_id
     WHERE c.slug = $1 AND o.token_number = $2 AND o.status = 'active' ORDER BY o.price_zats DESC`,
    [slug, tokenNumber]
  );
  return r.rows.map(mapOffer);
}

export async function listOffersByBuyer(db: Db, buyerAddress: string): Promise<Offer[]> {
  const r = await db.query(
    `SELECT ${OFFER_COLS} FROM offers o JOIN collections c ON c.id = o.collection_id
     WHERE o.buyer_address = $1 AND o.status IN ('awaiting_payment','active') ORDER BY o.created_at DESC`,
    [buyerAddress]
  );
  return r.rows.map(mapOffer);
}

export async function getOffer(db: Db, id: number): Promise<Offer | null> {
  const r = await db.query(`SELECT ${OFFER_COLS} FROM offers o JOIN collections c ON c.id = o.collection_id WHERE o.id = $1`, [id]);
  return r.rows[0] ? mapOffer(r.rows[0]) : null;
}
