import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/index.js";
import { parseZec } from "../src/money.js";
import { createCollection } from "../src/services/collections.js";
import { createOrder, getOrder, OrderError } from "../src/services/orders.js";
import { accountXpubFromMnemonic, deriveReceiveAddress, isAddressForNetwork } from "../src/zcash/address.js";

const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const xpub = accountXpubFromMnemonic(M);
const cfg = { network: "testnet" as const, walletXpub: xpub, orderTtlMinutes: 30 };
// alag alag "buyer" addresses (testnet t-addr). Buyer wallets ke liye alag xpub-index use kiye.
const buyer = (i: number) => deriveReceiveAddress(xpub, 1000 + i, "testnet");

async function setup(opts: { supply?: number; max?: number; status?: "draft" | "live" } = {}) {
  const db = await openDb();
  await createCollection(db, {
    slug: "demo",
    name: "Demo",
    supply: opts.supply ?? 10,
    priceZats: parseZec("0.5"),
    maxPerWallet: opts.max ?? 5,
    status: opts.status ?? "live",
  });
  return db;
}

async function expectCode(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof OrderError && e.code === code, `expected ${code}`);
}

test("order banta hai: exact amount, unique address, sahi network", async () => {
  const db = await setup();
  const a = await createOrder(db, cfg, { collectionSlug: "demo", quantity: 2, buyerAddress: buyer(1) });
  const b = await createOrder(db, cfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(2) });
  assert.equal(a.amountZats, parseZec("1")); // 2 x 0.5
  assert.equal(b.amountZats, parseZec("0.5"));
  assert.notEqual(a.payAddress, b.payAddress);
  assert.notEqual(a.addressIndex, b.addressIndex);
  assert.ok(isAddressForNetwork(a.payAddress, "testnet"));
  assert.equal(a.payAddress, deriveReceiveAddress(xpub, a.addressIndex, "testnet"));
  assert.equal(a.status, "pending");
  assert.equal((await getOrder(db, a.id))?.payAddress, a.payAddress);
});

test("galat network ka buyer address reject", async () => {
  const db = await setup();
  const mainAddr = deriveReceiveAddress(xpub, 1, "mainnet");
  await expectCode(createOrder(db, cfg, { collectionSlug: "demo", quantity: 1, buyerAddress: mainAddr }), "INVALID_BUYER_ADDRESS");
  await expectCode(createOrder(db, cfg, { collectionSlug: "demo", quantity: 1, buyerAddress: "garbage" }), "INVALID_BUYER_ADDRESS");
});

test("draft collection pe order nahi", async () => {
  const db = await setup({ status: "draft" });
  await expectCode(createOrder(db, cfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(1) }), "COLLECTION_NOT_LIVE");
  await expectCode(createOrder(db, cfg, { collectionSlug: "nope", quantity: 1, buyerAddress: buyer(1) }), "COLLECTION_NOT_FOUND");
});

test("quantity validation", async () => {
  const db = await setup();
  for (const q of [0, -1, 1.5, NaN]) {
    await expectCode(createOrder(db, cfg, { collectionSlug: "demo", quantity: q, buyerAddress: buyer(1) }), "INVALID_QUANTITY");
  }
});

test("per-wallet limit pichhle orders mila ke lagti hai", async () => {
  const db = await setup({ supply: 100, max: 3 });
  await createOrder(db, cfg, { collectionSlug: "demo", quantity: 2, buyerAddress: buyer(1) });
  await expectCode(createOrder(db, cfg, { collectionSlug: "demo", quantity: 2, buyerAddress: buyer(1) }), "WALLET_LIMIT");
  await createOrder(db, cfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(1) }); // total 3, ok
  await expectCode(createOrder(db, cfg, { collectionSlug: "demo", quantity: 4, buyerAddress: buyer(9) }), "WALLET_LIMIT");
});

test("oversell nahi hota", async () => {
  const db = await setup({ supply: 3, max: 3 });
  await createOrder(db, cfg, { collectionSlug: "demo", quantity: 2, buyerAddress: buyer(1) });
  await expectCode(createOrder(db, cfg, { collectionSlug: "demo", quantity: 2, buyerAddress: buyer(2) }), "SOLD_OUT");
  await createOrder(db, cfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(2) }); // last one
  await expectCode(createOrder(db, cfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(3) }), "SOLD_OUT");
});

test("ek saath 10 buyers, supply 3 => sirf 3 orders bante hain", async () => {
  const db = await setup({ supply: 3, max: 1 });
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      createOrder(db, cfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(50 + i) })
    )
  );
  const ok = results.filter((r) => r.status === "fulfilled");
  assert.equal(ok.length, 3);
  const addrs = new Set(ok.map((r) => (r as PromiseFulfilledResult<any>).value.payAddress));
  assert.equal(addrs.size, 3);
});

test("expired pending order ka supply wapas free ho jaata hai", async () => {
  const db = await setup({ supply: 1, max: 1 });
  const t0 = new Date("2026-01-01T00:00:00Z");
  await createOrder(db, cfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(1), now: t0 });
  // window ke andar: sold out
  await expectCode(
    createOrder(db, cfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(2), now: new Date(t0.getTime() + 10 * 60_000) }),
    "SOLD_OUT"
  );
  // window ke baad: naya buyer le sakta hai
  const later = new Date(t0.getTime() + 31 * 60_000);
  const o2 = await createOrder(db, cfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(2), now: later });
  assert.equal(o2.status, "pending");
});

test("SCHEDULED LAUNCH: startsAt future ho to order nahi banta (NOT_STARTED); waqt aane pe ban jaata hai", async () => {
  const db = await openDb();
  const future = new Date(Date.now() + 3600_000);
  await createCollection(db, { slug: "sched", name: "Scheduled", supply: 5, priceZats: parseZec("0.5"), maxPerWallet: 5, startsAt: future });
  await expectCode(createOrder(db, cfg, { collectionSlug: "sched", quantity: 1, buyerAddress: buyer(1) }), "NOT_STARTED");
  // launch time se pehle 1 minute, abhi bhi nahi
  const almostThere = new Date(future.getTime() - 60_000);
  await expectCode(createOrder(db, cfg, { collectionSlug: "sched", quantity: 1, buyerAddress: buyer(1), now: almostThere }), "NOT_STARTED");
  // launch ho gaya
  const afterLaunch = new Date(future.getTime() + 1000);
  const o = await createOrder(db, cfg, { collectionSlug: "sched", quantity: 1, buyerAddress: buyer(1), now: afterLaunch });
  assert.equal(o.buyerAddress, buyer(1));
});

test("startsAt na diya ho (ya past ho) to turant order ban jaata hai", async () => {
  const db = await openDb();
  await createCollection(db, { slug: "nosched", name: "No Schedule", supply: 5, priceZats: parseZec("0.5"), maxPerWallet: 5 });
  const o1 = await createOrder(db, cfg, { collectionSlug: "nosched", quantity: 1, buyerAddress: buyer(1) });
  assert.ok(o1.id);
  const past = new Date(Date.now() - 3600_000);
  await createCollection(db, { slug: "pastsched", name: "Past Schedule", supply: 5, priceZats: parseZec("0.5"), maxPerWallet: 5, startsAt: past });
  const o2 = await createOrder(db, cfg, { collectionSlug: "pastsched", quantity: 1, buyerAddress: buyer(2) });
  assert.ok(o2.id);
});
