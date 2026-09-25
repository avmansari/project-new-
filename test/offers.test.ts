import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openDb, type Db } from "../src/db/index.js";
import { parseZec } from "../src/money.js";
import { createCollection } from "../src/services/collections.js";
import { listActivity } from "../src/services/activity.js";
import { blockToken } from "../src/services/moderation.js";
import { listToken } from "../src/services/marketplace.js";
import {
  acceptOffer, cancelOffer, createOffer, expireStaleOffers, getOffer, listOffersForToken, OfferError, rejectOffer,
  activatePaidOffers,
} from "../src/services/offers.js";
import { createOrder, getOrder } from "../src/services/orders.js";
import { mintPaidOrders } from "../src/services/mint.js";
import { scanOnce } from "../src/watcher/scan.js";
import { accountXpubFromMnemonic, deriveReceiveAddress } from "../src/zcash/address.js";
import type { ChainClient, ReceivedOutput } from "../src/chain/types.js";

const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const xpub = accountXpubFromMnemonic(M);
const buyer = (i: number) => deriveReceiveAddress(xpub, 1000 + i, "testnet");
const T = (n: string) => createHash("sha256").update(n).digest("hex");
const ocfg = { network: "testnet" as const, walletXpub: xpub, orderTtlMinutes: 30 };
const ofcfg = { network: "testnet" as const, walletXpub: xpub, orderTtlMinutes: 30, marketplaceFeeBps: 250 };
const scfg = { minConfirmations: 10, lateGraceHours: 168 };

class MemChain implements ChainClient {
  outs = new Map<string, ReceivedOutput[]>();
  n = 0;
  pay(addr: string, zec: string, conf = 10) {
    const l = this.outs.get(addr) ?? [];
    l.push({ txid: T("tx" + ++this.n), vout: 0, amountZats: parseZec(zec), confirmations: conf });
    this.outs.set(addr, l);
  }
  async getReceived(a: string) {
    return (this.outs.get(a) ?? []).map((o) => ({ ...o }));
  }
}

async function seller(db: Db, chain: MemChain, price = "1"): Promise<{ owner: string; slug: string; token: number }> {
  await createCollection(db, { slug: "art", name: "Art", supply: 5, priceZats: parseZec(price), maxPerWallet: 5 });
  const owner = buyer(1);
  const o = await createOrder(db, ocfg, { collectionSlug: "art", quantity: 1, buyerAddress: owner });
  chain.pay(o.payAddress, price, 10);
  await scanOnce(db, chain, scfg);
  await mintPaidOrders(db);
  const t = await db.query<{ token_number: number }>(`SELECT token_number FROM tokens WHERE collection_id = 1 LIMIT 1`);
  return { owner, slug: "art", token: t.rows[0].token_number };
}

/** Offer banao, pay karo, activate karo -- ready-to-accept state tak le aao. */
async function activeOffer(db: Db, chain: MemChain, slug: string, token: number, buyerAddr: string, price: string) {
  const off = await createOffer(db, ofcfg, { slug, tokenNumber: token, buyerAddress: buyerAddr, priceZats: parseZec(price) });
  chain.pay(off.payAddress, price, 10);
  await scanOnce(db, chain, scfg);
  await activatePaidOffers(db);
  return (await getOffer(db, off.id))!;
}

test("create -> pay -> activate -> accept: ownership badalti hai, seller ko payout, listing cancel ho jaati hai", async () => {
  const db = await openDb();
  const chain = new MemChain();
  const { owner, slug, token } = await seller(db, chain);
  const listing = await listToken(db, ofcfg, { slug, tokenNumber: token, sellerAddress: owner, priceZats: parseZec("5") }); // list bhi kar di
  const buyerAddr = buyer(2);
  const off = await activeOffer(db, chain, slug, token, buyerAddr, "2");
  assert.equal(off.status, "active");

  await acceptOffer(db, off.id, owner);
  const own = await db.query<{ owner_address: string }>(`SELECT owner_address FROM tokens WHERE collection_id = 1 AND token_number = $1`, [token]);
  assert.equal(own.rows[0].owner_address, buyerAddr);
  assert.equal((await getOffer(db, off.id))!.status, "accepted");

  const s = await db.query<any>(`SELECT gross_zats::text AS g, platform_fee_zats::text AS f, creator_net_zats::text AS n FROM sales WHERE order_id = $1`, [off.orderId]);
  assert.deepEqual([s.rows[0].g, s.rows[0].f, s.rows[0].n], [parseZec("2").toString(), parseZec("0.05").toString(), parseZec("1.95").toString()]);
  const pr = await db.query<{ address: string; amt: string }>(`SELECT address, amount_zats::text AS amt FROM payout_requests`);
  assert.deepEqual([pr.rows[0].address, pr.rows[0].amt], [owner, parseZec("1.95").toString()]);

  const l = await db.query<{ status: string }>(`SELECT status FROM listings WHERE id = $1`, [listing.id]);
  assert.equal(l.rows[0].status, "cancelled"); // purani listing ab invalid
});

test("accept: ek offer accept hote hi baaki saare active offers reject + refund_needed", async () => {
  const db = await openDb();
  const chain = new MemChain();
  const { owner, slug, token } = await seller(db, chain);
  const off1 = await activeOffer(db, chain, slug, token, buyer(2), "2");
  const off2 = await activeOffer(db, chain, slug, token, buyer(3), "1.5");
  const off3 = await activeOffer(db, chain, slug, token, buyer(4), "3");

  await acceptOffer(db, off3.id, owner); // sabse zyada wali accept ki
  assert.equal((await getOffer(db, off1.id))!.status, "rejected");
  assert.equal((await getOffer(db, off2.id))!.status, "rejected");
  const o1 = (await getOrder(db, off1.orderId!))!;
  assert.equal(o1.status, "refund_needed");
  assert.equal(o1.refundDueZats, parseZec("2"));
  const o2 = (await getOrder(db, off2.orderId!))!;
  assert.equal(o2.refundDueZats, parseZec("1.5"));
});

test("reject: buyer ko refund_needed milta hai; sirf owner reject kar sakta hai", async () => {
  const db = await openDb();
  const chain = new MemChain();
  const { owner, slug, token } = await seller(db, chain);
  const buyerAddr = buyer(2);
  const off = await activeOffer(db, chain, slug, token, buyerAddr, "1");
  await assert.rejects(rejectOffer(db, off.id, buyer(9)), (e: unknown) => e instanceof OfferError && e.code === "NOT_OWNER");
  await rejectOffer(db, off.id, owner);
  assert.equal((await getOffer(db, off.id))!.status, "rejected");
  const o = (await getOrder(db, off.orderId!))!;
  assert.equal(o.status, "refund_needed");
  assert.equal(o.refundDueZats, parseZec("1"));
  // token owner ke paas hi raha
  const own = await db.query<{ owner_address: string }>(`SELECT owner_address FROM tokens WHERE collection_id = 1 AND token_number = $1`, [token]);
  assert.equal(own.rows[0].owner_address, owner);
});

test("cancel: buyer khud active offer wapas le sakta hai (refund), koi aur nahi", async () => {
  const db = await openDb();
  const chain = new MemChain();
  const { slug, token } = await seller(db, chain);
  const buyerAddr = buyer(2);
  const off = await activeOffer(db, chain, slug, token, buyerAddr, "1");
  await assert.rejects(cancelOffer(db, off.id, buyer(9)), (e: unknown) => e instanceof OfferError && e.code === "NOT_BUYER");
  await cancelOffer(db, off.id, buyerAddr);
  assert.equal((await getOffer(db, off.id))!.status, "cancelled");
  assert.equal((await getOrder(db, off.orderId!))!.status, "refund_needed");
});

test("awaiting_payment (paisa aaya hi nahi) me cancel/reject => order seedha expire, refund_needed NAHI (paisa tha hi nahi)", async () => {
  const db = await openDb();
  const chain = new MemChain();
  const { owner, slug, token } = await seller(db, chain);
  const off = await createOffer(db, ofcfg, { slug, tokenNumber: token, buyerAddress: buyer(2), priceZats: parseZec("1") });
  assert.equal(off.status, "awaiting_payment");
  await rejectOffer(db, off.id, owner);
  assert.equal((await getOffer(db, off.id))!.status, "rejected");
  assert.equal((await getOrder(db, off.orderId!))!.status, "expired");
  assert.equal((await getOrder(db, off.orderId!))!.refundDueZats, 0n);
});

test("payment order expire ho jaye (kabhi pay hi nahi hui) => offer khud 'expired'", async () => {
  const db = await openDb();
  const chain = new MemChain();
  const { slug, token } = await seller(db, chain);
  const past = new Date(Date.now() - 3600_000);
  const off = await createOffer(db, ofcfg, { slug, tokenNumber: token, buyerAddress: buyer(2), priceZats: parseZec("1"), now: past });
  await scanOnce(db, chain, scfg); // order expire
  assert.equal((await getOrder(db, off.orderId!))!.status, "expired");
  const n = await expireStaleOffers(db);
  assert.equal(n, 1);
  assert.equal((await getOffer(db, off.id))!.status, "expired");
});

test("blocked token pe offer nahi ban sakti", async () => {
  const db = await openDb();
  const chain = new MemChain();
  const { slug, token } = await seller(db, chain);
  await blockToken(db, slug, token, "stolen");
  await assert.rejects(
    createOffer(db, ofcfg, { slug, tokenNumber: token, buyerAddress: buyer(2), priceZats: parseZec("1") }),
    (e: unknown) => e instanceof OfferError && e.code === "TOKEN_BLOCKED"
  );
});

test("accept: sirf 'active' offer accept ho sakti hai; kam confirmations wali nahi", async () => {
  const db = await openDb();
  const chain = new MemChain();
  const { owner, slug, token } = await seller(db, chain);
  const off = await createOffer(db, ofcfg, { slug, tokenNumber: token, buyerAddress: buyer(2), priceZats: parseZec("1") });
  chain.pay(off.payAddress, "1", 2); // kam confirmations
  await scanOnce(db, chain, scfg);
  await activatePaidOffers(db);
  assert.equal((await getOffer(db, off.id))!.status, "awaiting_payment"); // abhi tak paid hi nahi
  await assert.rejects(acceptOffer(db, off.id, owner), (e: unknown) => e instanceof OfferError && e.code === "NOT_ACTIVE");
});

test("listOffersForToken: sirf active offers, price ke hisaab se sorted (sabse zyada pehle)", async () => {
  const db = await openDb();
  const chain = new MemChain();
  const { slug, token } = await seller(db, chain);
  await activeOffer(db, chain, slug, token, buyer(2), "1");
  await activeOffer(db, chain, slug, token, buyer(3), "3");
  const off2 = await activeOffer(db, chain, slug, token, buyer(4), "2");
  await cancelOffer(db, off2.id, buyer(4));
  const list = await listOffersForToken(db, slug, token);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((o) => o.priceZats), [parseZec("3"), parseZec("1")]);
});

test("frozen collection pe offer nahi ban sakti; galat address reject", async () => {
  const db = await openDb();
  const chain = new MemChain();
  const { slug, token } = await seller(db, chain);
  await db.query(`UPDATE collections SET payout_frozen = true WHERE slug = $1`, [slug]);
  await assert.rejects(
    createOffer(db, ofcfg, { slug, tokenNumber: token, buyerAddress: buyer(2), priceZats: parseZec("1") }),
    (e: unknown) => e instanceof OfferError && e.code === "COLLECTION_FROZEN"
  );
  await db.query(`UPDATE collections SET payout_frozen = false WHERE slug = $1`, [slug]);
  await assert.rejects(
    createOffer(db, ofcfg, { slug, tokenNumber: token, buyerAddress: deriveReceiveAddress(xpub, 1, "mainnet"), priceZats: parseZec("1") }),
    (e: unknown) => e instanceof OfferError && e.code === "INVALID_ADDRESS"
  );
  await assert.rejects(
    createOffer(db, ofcfg, { slug, tokenNumber: token, buyerAddress: buyer(2), priceZats: 0n }),
    (e: unknown) => e instanceof OfferError && e.code === "INVALID_PRICE"
  );
});

test("activity feed: offer_made aur offer_accepted log hote hain", async () => {
  const db = await openDb();
  const chain = new MemChain();
  const { owner, slug, token } = await seller(db, chain);
  const off = await activeOffer(db, chain, slug, token, buyer(2), "1");
  await acceptOffer(db, off.id, owner);
  const act = await listActivity(db, { slug });
  const kinds = act.items.map((x) => x.kind);
  assert.ok(kinds.includes("offer_made"));
  assert.ok(kinds.includes("offer_accepted"));
});
