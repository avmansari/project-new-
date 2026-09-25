import { randomInt, randomUUID } from "node:crypto";
import { deriveReceiveAddress } from "../zcash/address.js";
import type { Db } from "../db/index.js";
import { logActivity } from "./activity.js";
import { splitSale } from "./ledger.js";
import { mapOrder, ORDER_COLS } from "./orders.js";

export type MintOutcome = "minted" | "already_minted" | "skipped" | "refund_needed";

export interface MintResult {
  orderId: string;
  outcome: MintOutcome;
  tokenNumbers?: number[];
  reason?: string;
}

/**
 * Ek paid order ke liye tokens mint karta hai. Poora kaam EK transaction mein hota hai:
 * ya to sab hota hai (tokens + status), ya kuch nahi. Baar-baar chalane pe double-mint nahi hota.
 *
 * Lock order: pehle collection, phir order (hamesha isi order mein, taaki deadlock na ho).
 */
export async function mintOrder(db: Db, orderId: string): Promise<MintResult> {
  const pre = await db.query<{ collection_id: number }>(`SELECT collection_id FROM orders WHERE id = $1`, [orderId]);
  if (!pre.rows[0]) throw new Error(`order nahi mila: ${orderId}`);
  const collectionId = pre.rows[0].collection_id;

  return db.transaction(async (tx): Promise<MintResult> => {
    const col = await tx.query<{ supply: number; status: string; fee_bps: number }>(
      `SELECT supply, status, fee_bps FROM collections WHERE id = $1 FOR UPDATE`,
      [collectionId]
    );
    const cur = await tx.query(`SELECT ${ORDER_COLS} FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    const order = mapOrder(cur.rows[0]);

    if (order.status === "minted") return { orderId, outcome: "already_minted" };
    if (order.status !== "paid") return { orderId, outcome: "skipped", reason: `status=${order.status}` };

    // Double-check: paid hai to confirmed paisa poora hona chahiye (reorg/drop ke case mein rukna hai)
    if (order.receivedZats < order.amountZats) {
      return { orderId, outcome: "skipped", reason: "confirmed paisa amount se kam hai" };
    }

    // Cancelled collection: NFT nahi, seedha refund
    if (col.rows[0].status === "cancelled") {
      await tx.query(`UPDATE orders SET status = 'refund_needed', refund_due_zats = received_zats WHERE id = $1`, [orderId]);
      await tx.query(`INSERT INTO order_events (order_id, event, detail) VALUES ($1,'collection_cancelled','paid -> refund_needed')`, [orderId]);
      return { orderId, outcome: "refund_needed", reason: "collection cancelled" };
    }

    const supply = col.rows[0].supply;
    const used = await tx.query<{ token_number: number }>(`SELECT token_number FROM tokens WHERE collection_id = $1 AND voided_at IS NULL`, [collectionId]);

    // Safety net: reservation ki wajah se ye hona nahi chahiye, lekin hua to NFT dene ki jagah refund.
    if (used.rows.length + order.quantity > supply) {
      await tx.query(`UPDATE orders SET status = 'refund_needed', refund_due_zats = received_zats WHERE id = $1`, [orderId]);
      await tx.query(`INSERT INTO order_events (order_id, event, detail) VALUES ($1,'ALERT',$2)`, [
        orderId,
        "mint ke waqt supply kam padi => refund_needed",
      ]);
      return { orderId, outcome: "refund_needed", reason: "supply exhausted" };
    }

    // Random tokens (crypto-secure), taaki koi rare token snipe na kar sake
    const usedSet = new Set(used.rows.map((r) => r.token_number));
    const free: number[] = [];
    for (let n = 1; n <= supply; n++) if (!usedSet.has(n)) free.push(n);
    const picked: number[] = [];
    for (let i = 0; i < order.quantity; i++) {
      const j = randomInt(i, free.length); // [i, free.length)
      [free[i], free[j]] = [free[j], free[i]];
      picked.push(free[i]);
    }
    picked.sort((a, b) => a - b);

    const now = new Date().toISOString();
    for (const n of picked) {
      await tx.query(
        `INSERT INTO tokens (collection_id, token_number, owner_address, order_id, minted_at)
         VALUES ($1,$2,$3,$4,$5::timestamptz)`,
        [collectionId, n, order.buyerAddress, orderId, now]
      );
    }
    await tx.query(`UPDATE orders SET status = 'minted', minted_at = $2::timestamptz WHERE id = $1`, [orderId, now]);
    // Sale ka hisaab: platform fee + creator ka hissa (isi transaction mein, atomic)
    const { feeZats, netZats } = splitSale(order.amountZats, col.rows[0].fee_bps);
    await tx.query(
      `INSERT INTO sales (order_id, collection_id, gross_zats, platform_fee_zats, creator_net_zats)
       VALUES ($1,$2,$3::bigint,$4::bigint,$5::bigint)`,
      [orderId, collectionId, order.amountZats.toString(), feeZats.toString(), netZats.toString()]
    );
    await tx.query(`INSERT INTO order_events (order_id, event, detail) VALUES ($1,'minted',$2)`, [
      orderId,
      `tokens=${picked.join(",")} owner=${order.buyerAddress}`,
    ]);
    for (const n of picked) {
      await logActivity(tx as unknown as Db, collectionId, "mint", { tokenNumber: n, amountZats: order.amountZats / BigInt(order.quantity), address: order.buyerAddress });
    }
    return { orderId, outcome: "minted", tokenNumbers: picked };
  });
}

/** Saare 'paid' orders mint karta hai (purane pehle). Ek order fail ho to baaki rukte nahi. */
export async function mintPaidOrders(db: Db): Promise<MintResult[]> {
  const r = await db.query<{ id: string }>(`SELECT id FROM orders WHERE status = 'paid' AND kind = 'mint' ORDER BY paid_at, id`);
  const results: MintResult[] = [];
  for (const row of r.rows) {
    try {
      results.push(await mintOrder(db, row.id));
    } catch (e) {
      console.error(`[mint] ${row.id.slice(0, 8)} fail:`, (e as Error).message);
      results.push({ orderId: row.id, outcome: "skipped", reason: `error: ${(e as Error).message}` });
    }
  }
  return results;
}

/**
 * Free mint: seedha kisi address ko token de do (payment ke bina). Sale/fee nahi banta, sirf activity log.
 * (Ek dummy 'airdrop' kind ka order banta hai taaki tokens.order_id ki FK sant hai -- ismein koi asli payment
 * kabhi expect nahi hoti, watcher ise chhoo tak nahi kyunki status seedha 'minted' se shuru hota hai.)
 */
export async function airdrop(db: Db, cfg: { network: "mainnet" | "testnet"; walletXpub: string }, slug: string, toAddress: string, count = 1): Promise<number[]> {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("count 1..100 integer hona chahiye");
  return db.transaction(async (tx) => {
    const col = await tx.query<{ id: number; supply: number }>(`SELECT id, supply FROM collections WHERE slug = $1 FOR UPDATE`, [slug]);
    if (!col.rows[0]) throw new Error("collection nahi mili");
    const collectionId = col.rows[0].id;
    const used = await tx.query<{ token_number: number }>(`SELECT token_number FROM tokens WHERE collection_id = $1 AND voided_at IS NULL`, [collectionId]);
    const usedSet = new Set(used.rows.map((r) => r.token_number));
    const free: number[] = [];
    for (let n = 1; n <= col.rows[0].supply; n++) if (!usedSet.has(n)) free.push(n);
    if (free.length < count) throw new Error(`sirf ${free.length} tokens bache hain, ${count} nahi`);
    for (let i = 0; i < count; i++) {
      const j = randomInt(i, free.length);
      [free[i], free[j]] = [free[j], free[i]];
    }
    const picked = free.slice(0, count).sort((a, b) => a - b);
    const now = new Date().toISOString();
    const orderId = randomUUID();
    const idx: number = (await tx.query<{ i: number }>(`SELECT nextval('pay_address_index_seq')::int AS i`)).rows[0].i;
    const dummyAddress = deriveReceiveAddress(cfg.walletXpub, idx, cfg.network);
    await tx.query(
      `INSERT INTO orders (id, collection_id, quantity, buyer_address, pay_address, address_index, amount_zats, status, expires_at, created_at, kind, minted_at)
       VALUES ($1,$2,$3,$4,$5,$6,1,'minted',$7::timestamptz,$7::timestamptz,'airdrop',$7::timestamptz)`,
      [orderId, collectionId, picked.length, toAddress, dummyAddress, idx, now]
    );
    for (const n of picked) {
      await tx.query(
        `INSERT INTO tokens (collection_id, token_number, owner_address, order_id, minted_at) VALUES ($1,$2,$3,$4,$5::timestamptz)`,
        [collectionId, n, toAddress, orderId, now]
      );
      await logActivity(tx as unknown as Db, collectionId, "airdrop", { tokenNumber: n, address: toAddress });
    }
    return picked;
  });
}

export interface TokenRow {
  collectionSlug: string;
  tokenNumber: number;
  ownerAddress: string;
  orderId: string;
}

export async function listTokens(db: Db, slug?: string): Promise<TokenRow[]> {
  const r = await db.query(
    `SELECT c.slug, t.token_number, t.owner_address, t.order_id
     FROM tokens t JOIN collections c ON c.id = t.collection_id
     WHERE t.voided_at IS NULL AND ($1::text IS NULL OR c.slug = $1)
     ORDER BY c.slug, t.token_number`,
    [slug ?? null]
  );
  return r.rows.map((x: any) => ({
    collectionSlug: x.slug,
    tokenNumber: x.token_number,
    ownerAddress: x.owner_address,
    orderId: x.order_id,
  }));
}
