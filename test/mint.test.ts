import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/index.js";
import { parseZec } from "../src/money.js";
import { createCollection } from "../src/services/collections.js";
import { createOrder, getOrder } from "../src/services/orders.js";
import { listTokens, mintOrder, mintPaidOrders } from "../src/services/mint.js";
import { scanOnce } from "../src/watcher/scan.js";
import { accountXpubFromMnemonic, deriveReceiveAddress } from "../src/zcash/address.js";
import type { ChainClient, ReceivedOutput } from "../src/chain/types.js";

const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const xpub = accountXpubFromMnemonic(M);
const cfg = { network: "testnet" as const, walletXpub: xpub, orderTtlMinutes: 30 };
const scfg = { minConfirmations: 10, lateGraceHours: 168 };
const buyer = (i: number) => deriveReceiveAddress(xpub, 1000 + i, "testnet");
const T0 = new Date("2026-01-01T00:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

class MemChain implements ChainClient {
  outs = new Map<string, ReceivedOutput[]>();
  n = 0;
  pay(addr: string, zec: string, conf = 0) {
    const l = this.outs.get(addr) ?? [];
    l.push({ txid: `tx${++this.n}`, vout: 0, amountZats: parseZec(zec), confirmations: conf });
    this.outs.set(addr, l);
  }
  async getReceived(a: string) {
    return (this.outs.get(a) ?? []).map((o) => ({ ...o }));
  }
}

async function setup(supply = 10, max = 10) {
  const db = await openDb();
  await createCollection(db, { slug: "demo", name: "Demo", supply, priceZats: parseZec("1"), maxPerWallet: max });
  return { db, chain: new MemChain() };
}

/** order banao, pay karo, scan karo => 'paid' */
async function paidOrder(db: any, chain: MemChain, qty: number, b: number, now = T0) {
  const o = await createOrder(db, cfg, { collectionSlug: "demo", quantity: qty, buyerAddress: buyer(b), now });
  chain.pay(o.payAddress, String(qty), 10);
  await scanOnce(db, chain, scfg, at(5));
  assert.equal((await getOrder(db, o.id))!.status, "paid");
  return o;
}

test("paid order => tokens mint, owner=buyer, status=minted", async () => {
  const { db, chain } = await setup();
  const o = await paidOrder(db, chain, 3, 1);
  const r = await mintOrder(db, o.id);
  assert.equal(r.outcome, "minted");
  assert.equal(r.tokenNumbers!.length, 3);
  assert.equal(new Set(r.tokenNumbers).size, 3);
  assert.ok(r.tokenNumbers!.every((n) => n >= 1 && n <= 10));
  const toks = await listTokens(db, "demo");
  assert.equal(toks.length, 3);
  assert.ok(toks.every((t) => t.ownerAddress === buyer(1) && t.orderId === o.id));
  assert.equal((await getOrder(db, o.id))!.status, "minted");
});

test("dobara mint => double mint nahi", async () => {
  const { db, chain } = await setup();
  const o = await paidOrder(db, chain, 2, 1);
  await mintOrder(db, o.id);
  assert.equal((await mintOrder(db, o.id)).outcome, "already_minted");
  assert.equal((await listTokens(db)).length, 2);
});

test("ek saath 5 baar mint(same order) => sirf ek baar mint", async () => {
  const { db, chain } = await setup();
  const o = await paidOrder(db, chain, 2, 1);
  const rs = await Promise.all(Array.from({ length: 5 }, () => mintOrder(db, o.id)));
  assert.equal(rs.filter((r) => r.outcome === "minted").length, 1);
  assert.equal((await listTokens(db)).length, 2);
});

test("pending order mint nahi hota", async () => {
  const { db } = await setup();
  const o = await createOrder(db, cfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(1), now: T0 });
  const r = await mintOrder(db, o.id);
  assert.equal(r.outcome, "skipped");
  assert.equal((await listTokens(db)).length, 0);
});

test("poori collection bikne pe har token exactly ek baar (1..supply)", async () => {
  const { db, chain } = await setup(10, 5);
  const a = await paidOrder(db, chain, 5, 1);
  const b = await paidOrder(db, chain, 5, 2);
  await mintPaidOrders(db);
  const nums = (await listTokens(db)).map((t) => t.tokenNumber).sort((x, y) => x - y);
  assert.deepEqual(nums, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal((await getOrder(db, a.id))!.status, "minted");
  assert.equal((await getOrder(db, b.id))!.status, "minted");
});

test("token numbers random hain (sequence nahi)", async () => {
  const { db, chain } = await setup(1000, 1);
  const got: number[] = [];
  for (let i = 0; i < 15; i++) {
    const o = await paidOrder(db, chain, 1, 100 + i);
    const r = await mintOrder(db, o.id);
    got.push(r.tokenNumbers![0]);
  }
  assert.notDeepEqual(got, got.map((_, i) => i + 1));
  assert.equal(new Set(got).size, 15);
});

test("safety net: supply khatam ho chuki ho to NFT nahi, refund_needed", async () => {
  const { db, chain } = await setup(2, 2);
  const o = await paidOrder(db, chain, 1, 1);
  // supply ko zabardasti bhar do (aisi galti hona nahi chahiye, lekin hui to?)
  for (const n of [1, 2]) {
    await db.query(
      `INSERT INTO tokens (collection_id, token_number, owner_address, order_id, minted_at) VALUES (1,$1,'x',$2,now())`,
      [n, o.id]
    );
  }
  const r = await mintOrder(db, o.id);
  assert.equal(r.outcome, "refund_needed");
  const a = (await getOrder(db, o.id))!;
  assert.equal(a.status, "refund_needed");
  assert.equal(a.refundDueZats, parseZec("1"));
  // watcher dobara chale to wapas paid nahi hona chahiye
  await scanOnce(db, chain, scfg, at(6));
  assert.equal((await getOrder(db, o.id))!.status, "refund_needed");
  assert.equal((await mintOrder(db, o.id)).outcome, "skipped");
});

test("paid par received < amount (funds gayab) => mint ruk jaata hai", async () => {
  const { db, chain } = await setup();
  const o = await paidOrder(db, chain, 1, 1);
  await db.query(`UPDATE orders SET received_zats = 0 WHERE id = $1`, [o.id]);
  const r = await mintOrder(db, o.id);
  assert.equal(r.outcome, "skipped");
  assert.equal((await listTokens(db)).length, 0);
});

test("end-to-end: order -> payment -> scan -> mint (overpay ka refund_due bhi bacha rehta hai)", async () => {
  const { db, chain } = await setup();
  const o = await createOrder(db, cfg, { collectionSlug: "demo", quantity: 2, buyerAddress: buyer(1), now: T0 });
  chain.pay(o.payAddress, "2.5", 10);
  await scanOnce(db, chain, scfg, at(5));
  const res = await mintPaidOrders(db);
  assert.equal(res[0].outcome, "minted");
  const a = (await getOrder(db, o.id))!;
  assert.equal(a.status, "minted");
  assert.equal(a.refundDueZats, parseZec("0.5"));
  await scanOnce(db, chain, scfg, at(6)); // scan minted order ko wapas nahi badalta
  assert.equal((await getOrder(db, o.id))!.status, "minted");
});
