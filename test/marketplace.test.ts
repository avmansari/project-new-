import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openDb, type Db } from "../src/db/index.js";
import { parseZec } from "../src/money.js";
import { createCollection } from "../src/services/collections.js";
import { listActivity } from "../src/services/activity.js";
import { blockToken } from "../src/services/moderation.js";
import {
  cancelListing, createPurchaseOrder, getListing, listActiveListings, listToken, ListingError,
  releaseStaleListings, settlePaidPurchases, settlePurchase,
} from "../src/services/marketplace.js";
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
const mcfg = { network: "testnet" as const, walletXpub: xpub, orderTtlMinutes: 30, marketplaceFeeBps: 250 };
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

async function seller(db: Db, chain: MemChain, tokenPrice = "1"): Promise<{ owner: string; slug: string; token: number }> {
  await createCollection(db, { slug: "art", name: "Art", supply: 3, priceZats: parseZec(tokenPrice), maxPerWallet: 3 });
  const owner = buyer(1);
  const o = await createOrder(db, ocfg, { collectionSlug: "art", quantity: 1, buyerAddress: owner });
  chain.pay(o.payAddress, tokenPrice, 10);
  await scanOnce(db, chain, scfg);
  await mintPaidOrders(db);
  const t = await db.query<{ token_number: number }>(`SELECT token_number FROM tokens WHERE collection_id = 1 LIMIT 1`);
  return { owner, slug: "art", token: t.rows[0].token_number };
}

test("list -> buy -> settle: ownership badalta hai, fee split sahi, listing 'sold', payout_request banti hai", async () => {
  const db = await openDb();
  const chain = new MemChain();
  const { owner, slug, token } = await seller(db, chain);
  const l = await listToken(db, mcfg, { slug, tokenNumber: token, sellerAddress: owner, priceZats: parseZec("2") });
  assert.equal(l.status, "active");
  const buyerAddr = buyer(2);
  const po = await createPurchaseOrder(db, mcfg, { listingId: l.id, buyerAddress: buyerAddr });
  assert.equal(po.kind, "buy");
  assert.equal(po.amountZats, parseZec("2"));
  chain.pay(po.payAddress, "2", 10);
  await scanOnce(db, chain, scfg);
  assert.equal((await getOrder(db, po.id))!.status, "paid");
  const settled = await settlePaidPurchases(db);
  assert.equal(settled[0].outcome, "sold");
  const owner2 = await db.query<{ owner_address: string }>(`SELECT owner_address FROM tokens WHERE collection_id = 1 AND token_number = $1`, [token]);
  assert.equal(owner2.rows[0].owner_address, buyerAddr);
  assert.equal((await getListing(db, l.id))!.status, "sold");
  const s = await db.query<any>(`SELECT gross_zats::text AS g, platform_fee_zats::text AS f, creator_net_zats::text AS n, kind FROM sales WHERE order_id = $1`, [po.id]);
  assert.deepEqual([s.rows[0].g, s.rows[0].f, s.rows[0].n, s.rows[0].kind], [parseZec("2").toString(), parseZec("0.05").toString(), parseZec("1.95").toString(), "resale"]);
  const pr = await db.query<any>(`SELECT address, amount_zats::text AS amt, status FROM payout_requests`);
  assert.deepEqual([pr.rows[0].address, pr.rows[0].amt, pr.rows[0].status], [owner, parseZec("1.95").toString(), "pending"]);
  // dobara settle => already_sold, double payout nahi
  assert.equal((await settlePurchase(db, po.id)).outcome, "already_sold");
  assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM payout_requests`)).rows[0].n, 1);
});

test("SAME token: 2 buyers race, sirf EK order ban paata hai (listing lock)", async () => {
  const db = await openDb();
  const chain = new MemChain();
  const { owner, slug, token } = await seller(db, chain);
  const l = await listToken(db, mcfg, { slug, tokenNumber: token, sellerAddress: owner, priceZats: parseZec("1") });
  const results = await Promise.allSettled([
    createPurchaseOrder(db, mcfg, { listingId: l.id, buyerAddress: buyer(2) }),
    createPurchaseOrder(db, mcfg, { listingId: l.id, buyerAddress: buyer(3) }),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const bad = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(bad.length, 1);
  assert.match((bad[0] as PromiseRejectedResult).reason.message, /available nahi/);
});

test("listing: dusra token dobara list nahi (unique constraint); non-owner list/cancel nahi kar sakta", async () => {
  const db = await openDb();
  const chain = new MemChain();
  const { owner, slug, token } = await seller(db, chain);
  const l = await listToken(db, mcfg, { slug, tokenNumber: token, sellerAddress: owner, priceZats: parseZec("1") });
  await assert.rejects(
    listToken(db, mcfg, { slug, tokenNumber: token, sellerAddress: owner, priceZats: parseZec("2") }),
    (e: unknown) => e instanceof ListingError && e.code === "ALREADY_LISTED"
  );
  await assert.rejects(
    listToken(db, mcfg, { slug, tokenNumber: token, sellerAddress: buyer(9), priceZats: parseZec("1") }),
    (e: unknown) => e instanceof ListingError && e.code === "NOT_OWNER"
  );
  await assert.rejects(
    cancelListing(db, l.id, buyer(9)),
    (e: unknown) => e instanceof ListingError && e.code === "NOT_OWNER"
  );
  await cancelListing(db, l.id, owner);
  assert.equal((await getListing(db, l.id))!.status, "cancelled");
  // ab dobara list ho sakta hai
  const l2 = await listToken(db, mcfg, { slug, tokenNumber: token, sellerAddress: owner, priceZats: parseZec("1") });
  assert.equal(l2.status, "active");
});

test("purchase order EXPIRE ho jaye (payment nahi aayi) => listing wapas 'active', token seller ke paas hi", async () => {
  const db = await openDb();
  const chain = new MemChain();
  const { owner, slug, token } = await seller(db, chain);
  const l = await listToken(db, mcfg, { slug, tokenNumber: token, sellerAddress: owner, priceZats: parseZec("1") });
  const past = new Date(Date.now() - 3600_000);
  const po = await createPurchaseOrder(db, mcfg, { listingId: l.id, buyerAddress: buyer(2), now: past });
  await scanOnce(db, chain, scfg); // expire ho jaayega
  assert.equal((await getOrder(db, po.id))!.status, "expired");
  const n = await releaseStaleListings(db);
  assert.equal(n, 1);
  const l2 = await getListing(db, l.id);
  assert.equal(l2!.status, "active");
  assert.equal(l2!.orderId, null);
  const owner2 = await db.query<{ owner_address: string }>(`SELECT owner_address FROM tokens WHERE collection_id = 1 AND token_number = $1`, [token]);
  assert.equal(owner2.rows[0].owner_address, owner); // transfer NAHI hua
  // ab koi aur khareed sakta hai
  const po2 = await createPurchaseOrder(db, mcfg, { listingId: l.id, buyerAddress: buyer(3) });
  assert.equal(po2.status, "pending");
});

test("BLOCKED token list nahi ho sakta; blocked hote hi active listing cancel ho jaati hai", async () => {
  const db = await openDb();
  const chain = new MemChain();
  const { owner, slug, token } = await seller(db, chain);
  const l = await listToken(db, mcfg, { slug, tokenNumber: token, sellerAddress: owner, priceZats: parseZec("1") });
  await blockToken(db, slug, token, "reported stolen");
  assert.equal((await getListing(db, l.id))!.status, "cancelled");
  await assert.rejects(
    listToken(db, mcfg, { slug, tokenNumber: token, sellerAddress: owner, priceZats: parseZec("1") }),
    (e: unknown) => e instanceof ListingError && e.code === "TOKEN_BLOCKED"
  );
});

test("apni hi listing khud nahi khareed sakta; galat network address reject", async () => {
  const db = await openDb();
  const chain = new MemChain();
  const { owner, slug, token } = await seller(db, chain);
  const l = await listToken(db, mcfg, { slug, tokenNumber: token, sellerAddress: owner, priceZats: parseZec("1") });
  await assert.rejects(createPurchaseOrder(db, mcfg, { listingId: l.id, buyerAddress: owner }), /apni hi listing/);
  const mainnetAddr = deriveReceiveAddress(xpub, 1, "mainnet");
  await assert.rejects(createPurchaseOrder(db, mcfg, { listingId: l.id, buyerAddress: mainnetAddr }), /galat hai/);
  await assert.rejects(listToken(db, mcfg, { slug, tokenNumber: token, sellerAddress: mainnetAddr, priceZats: parseZec("1") }), /galat hai/);
  await assert.rejects(listToken(db, mcfg, { slug, tokenNumber: token, sellerAddress: owner, priceZats: 0n }), /price/);
});

test("listActiveListings: sirf active, price ke hisaab se sorted", async () => {
  const db = await openDb();
  const chain = new MemChain();
  await createCollection(db, { slug: "art", name: "Art", supply: 3, priceZats: parseZec("1"), maxPerWallet: 3 });
  const owner = buyer(1);
  const tokens: number[] = [];
  for (let i = 0; i < 3; i++) {
    const o = await createOrder(db, ocfg, { collectionSlug: "art", quantity: 1, buyerAddress: owner });
    chain.pay(o.payAddress, "1", 10);
    await scanOnce(db, chain, scfg);
    await mintPaidOrders(db);
  }
  const all = await db.query<{ token_number: number }>(`SELECT token_number FROM tokens WHERE collection_id = 1 ORDER BY token_number`);
  for (const t of all.rows) tokens.push(t.token_number);
  await listToken(db, mcfg, { slug: "art", tokenNumber: tokens[0], sellerAddress: owner, priceZats: parseZec("3") });
  await listToken(db, mcfg, { slug: "art", tokenNumber: tokens[1], sellerAddress: owner, priceZats: parseZec("1") });
  const l3 = await listToken(db, mcfg, { slug: "art", tokenNumber: tokens[2], sellerAddress: owner, priceZats: parseZec("2") });
  await cancelListing(db, l3.id, owner);
  const r = await listActiveListings(db, { slug: "art" });
  assert.equal(r.total, 2);
  assert.deepEqual(r.items.map((x) => x.priceZats), [parseZec("1"), parseZec("3")]);
});

test("activity feed: list/cancel/sale/mint sab log hote hain", async () => {
  const db = await openDb();
  const chain = new MemChain();
  const { owner, slug, token } = await seller(db, chain);
  const l = await listToken(db, mcfg, { slug, tokenNumber: token, sellerAddress: owner, priceZats: parseZec("1") });
  const po = await createPurchaseOrder(db, mcfg, { listingId: l.id, buyerAddress: buyer(2) });
  chain.pay(po.payAddress, "1", 10);
  await scanOnce(db, chain, scfg);
  await settlePaidPurchases(db);
  const act = await listActivity(db, { slug });
  const kinds = act.items.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ["list", "mint", "sale"]);
});
