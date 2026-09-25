import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { openDb } from "../src/db/index.js";
import { parseZec } from "../src/money.js";
import { createCollection } from "../src/services/collections.js";
import { createOrder, getOrder, OrderError } from "../src/services/orders.js";
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
  fail = false;
  n = 0;
  pay(addr: string, zec: string, conf = 0) {
    const list = this.outs.get(addr) ?? [];
    list.push({ txid: `tx${++this.n}`, vout: 0, amountZats: parseZec(zec), confirmations: conf });
    this.outs.set(addr, list);
    return `tx${this.n}`;
  }
  setConf(addr: string, conf: number) {
    for (const o of this.outs.get(addr) ?? []) o.confirmations = conf;
  }
  drop(addr: string) {
    this.outs.set(addr, []);
  }
  async getReceived(addr: string) {
    if (this.fail) throw new Error("provider down");
    return (this.outs.get(addr) ?? []).map((o) => ({ ...o }));
  }
}

async function setup(supply = 5, max = 5) {
  const db = await openDb();
  await createCollection(db, { slug: "demo", name: "Demo", supply, priceZats: parseZec("1"), maxPerWallet: max });
  return { db, chain: new MemChain() };
}
const mk = (db: any, q: number, b: number, now = T0) =>
  createOrder(db, cfg, { collectionSlug: "demo", quantity: q, buyerAddress: buyer(b), now });

test("poora flow: pay (0 conf) -> pending -> confirm -> paid; dobara scan safe", async () => {
  const { db, chain } = await setup();
  const o = await mk(db, 1, 1);
  chain.pay(o.payAddress, "1", 0);
  await scanOnce(db, chain, scfg, at(5));
  assert.equal((await getOrder(db, o.id))!.status, "pending");
  assert.equal((await getOrder(db, o.id))!.funded, true);

  chain.setConf(o.payAddress, 10);
  const s = await scanOnce(db, chain, scfg, at(12));
  assert.deepEqual(s.transitions.map((t) => t.to), ["paid"]);
  const s2 = await scanOnce(db, chain, scfg, at(13)); // dobara
  assert.equal(s2.transitions.length, 0);

  const cnt = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM payments`);
  assert.equal(cnt.rows[0].n, 1); // duplicate row nahi bani
  const after = (await getOrder(db, o.id))!;
  assert.equal(after.status, "paid");
  assert.equal(after.refundDueZats, 0n);
});

test("overpay => paid + refund_due", async () => {
  const { db, chain } = await setup();
  const o = await mk(db, 1, 1);
  chain.pay(o.payAddress, "1.5", 10);
  await scanOnce(db, chain, scfg, at(5));
  const a = (await getOrder(db, o.id))!;
  assert.equal(a.status, "paid");
  assert.equal(a.refundDueZats, parseZec("0.5"));
});

test("underpay: window ke baad refund_needed", async () => {
  const { db, chain } = await setup();
  const o = await mk(db, 1, 1);
  chain.pay(o.payAddress, "0.3", 10);
  await scanOnce(db, chain, scfg, at(5));
  assert.equal((await getOrder(db, o.id))!.status, "pending");
  await scanOnce(db, chain, scfg, at(40));
  const a = (await getOrder(db, o.id))!;
  assert.equal(a.status, "refund_needed");
  assert.equal(a.refundDueZats, parseZec("0.3"));
});

test("late payment expired order pe => refund_needed, order kabhi paid nahi", async () => {
  const { db, chain } = await setup();
  const o = await mk(db, 1, 1);
  await scanOnce(db, chain, scfg, at(40)); // koi payment nahi => expired
  assert.equal((await getOrder(db, o.id))!.status, "expired");
  chain.pay(o.payAddress, "1", 10); // late
  await scanOnce(db, chain, scfg, at(50));
  const a = (await getOrder(db, o.id))!;
  assert.equal(a.status, "refund_needed");
  assert.equal(a.refundDueZats, parseZec("1"));
  await scanOnce(db, chain, scfg, at(60)); // repeat => refund double nahi hota
  assert.equal((await getOrder(db, o.id))!.refundDueZats, parseZec("1"));
});

test("chain error pe order ki state nahi badalti", async () => {
  const { db, chain } = await setup();
  const o = await mk(db, 1, 1);
  chain.pay(o.payAddress, "1", 10);
  await scanOnce(db, chain, scfg, at(5)); // paid
  chain.fail = true;
  const s = await scanOnce(db, chain, scfg, at(6));
  assert.equal(s.errors, 1);
  assert.equal((await getOrder(db, o.id))!.status, "paid");
  const p = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM payments WHERE dropped = false`);
  assert.equal(p.rows[0].n, 1); // "dropped" mark nahi hua
});

test("mempool se payment gayab => paid nahi hota", async () => {
  const { db, chain } = await setup();
  const o = await mk(db, 1, 1);
  chain.pay(o.payAddress, "1", 0);
  await scanOnce(db, chain, scfg, at(5));
  assert.equal((await getOrder(db, o.id))!.funded, true);
  chain.drop(o.payAddress);
  await scanOnce(db, chain, scfg, at(10));
  assert.equal((await getOrder(db, o.id))!.funded, false);
  await scanOnce(db, chain, scfg, at(40));
  assert.equal((await getOrder(db, o.id))!.status, "expired");
});

test("funded (bas confirmation baaki) order ka supply expiry ke baad bhi reserved rehta hai", async () => {
  const { db, chain } = await setup(1, 1);
  const a = await mk(db, 1, 1); // last NFT
  chain.pay(a.payAddress, "1", 2); // time pe dikha, confirm baaki
  await scanOnce(db, chain, scfg, at(10));
  // window khatam (at 40) => doosra buyer try kare: SOLD_OUT aana chahiye
  await assert.rejects(mk(db, 1, 2, at(40)), (e: unknown) => e instanceof OrderError && e.code === "SOLD_OUT");
  chain.setConf(a.payAddress, 10);
  await scanOnce(db, chain, scfg, at(41));
  assert.equal((await getOrder(db, a.id))!.status, "paid");
});

test("bina funded order ka supply expiry ke baad free ho jaata hai", async () => {
  const { db, chain } = await setup(1, 1);
  await mk(db, 1, 1);
  await scanOnce(db, chain, scfg, at(10));
  const b = await mk(db, 1, 2, at(40)); // ab mil sakta hai
  assert.equal(b.status, "pending");
});

test("do orders ek saath scan, alag alag address, mix results", async () => {
  const { db, chain } = await setup();
  const a = await mk(db, 1, 1);
  const b = await mk(db, 1, 2);
  chain.pay(a.payAddress, "1", 10);
  chain.pay(b.payAddress, "0.5", 10);
  await scanOnce(db, chain, scfg, at(5));
  assert.equal((await getOrder(db, a.id))!.status, "paid");
  assert.equal((await getOrder(db, b.id))!.status, "pending");
});

test("audit log mein transitions likhe jaate hain", async () => {
  const { db, chain } = await setup();
  const o = await mk(db, 1, 1);
  chain.pay(o.payAddress, "1", 10);
  await scanOnce(db, chain, scfg, at(5));
  const ev = await db.query<{ event: string; detail: string }>(
    `SELECT event, detail FROM order_events WHERE order_id = $1 ORDER BY id`, [o.id]);
  assert.ok(ev.rows.some((r) => r.event === "status" && r.detail === "pending -> paid"));
});

// ---------- start_height guard: order banne se PEHLE mined payments nahi ginte ----------
const T = (n: string) => createHash("sha256").update(n).digest("hex");
class HeightChain implements ChainClient {
  outs = new Map<string, ReceivedOutput[]>();
  tip = 1000;
  put(addr: string, zec: string, height: number | undefined, conf: number, txid = "h" + Math.random()) {
    const l = this.outs.get(addr) ?? [];
    l.push({ txid: T(txid), vout: 0, amountZats: parseZec(zec), confirmations: conf, height });
    this.outs.set(addr, l);
  }
  async getReceived(a: string) {
    return (this.outs.get(a) ?? []).map((o) => ({ ...o }));
  }
  async tipHeight() {
    return this.tip;
  }
}

test("PURANI payment (order se pehle mined) ignore: address ka reuse / naya database", async () => {
  const { db } = await setup();
  const chain = new HeightChain();
  const o = await createOrder(db, cfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(1), now: T0, tipHeight: 1000 });
  assert.equal(o.startHeight, 1000);
  chain.put(o.payAddress, "1", 900, 101); // purani payment, isi address pe
  const s = await scanOnce(db, chain, scfg, at(5));
  assert.equal(s.ignoredOld, 1);
  const x = (await getOrder(db, o.id))!;
  assert.equal(x.status, "pending");
  assert.equal(x.funded, false);
  const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM payments`);
  assert.equal(n.rows[0].n, 0);
});

test("order ke baad mined payment (height >= start) ginti mein aati hai; mempool bhi", async () => {
  const { db } = await setup();
  const chain = new HeightChain();
  const a = await createOrder(db, cfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(1), now: T0, tipHeight: 1000 });
  const b = await createOrder(db, cfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(2), now: T0, tipHeight: 1000 });
  const c = await createOrder(db, cfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(3), now: T0, tipHeight: 1000 });
  chain.put(a.payAddress, "1", 1001, 10);
  chain.put(b.payAddress, "1", 1000, 10); // barabar height: margin ke andar, ginti mein
  chain.put(c.payAddress, "1", undefined, 0); // mempool
  const s = await scanOnce(db, chain, scfg, at(5));
  assert.equal(s.ignoredOld, 0);
  assert.equal((await getOrder(db, a.id))!.status, "paid");
  assert.equal((await getOrder(db, b.id))!.status, "paid");
  assert.equal((await getOrder(db, c.id))!.funded, true);
});

test("do database, ek hi xpub, ek hi index: doosre DB ki purani payment pehle DB ke order ko nahi lagti", async () => {
  const one = await setup();
  const two = await setup();
  const chain = new HeightChain();
  const o1 = await createOrder(one.db, cfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(1), now: T0, tipHeight: 500 });
  chain.put(o1.payAddress, "1", 510, 500); // DB-1 ke order ki asli payment
  await scanOnce(one.db, chain, scfg, at(5));
  assert.equal((await getOrder(one.db, o1.id))!.status, "paid");
  // DB-2 mein naya order, wahi index 0 => wahi payAddress
  const o2 = await createOrder(two.db, cfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(2), now: T0, tipHeight: 1000 });
  assert.equal(o2.payAddress, o1.payAddress);
  await scanOnce(two.db, chain, scfg, at(5));
  assert.equal((await getOrder(two.db, o2.id))!.status, "pending"); // MUFT NFT nahi
});

test("purana order (start_height NULL) pehle jaisa chalta hai; tipHeight na do => NULL", async () => {
  const { db } = await setup();
  const chain = new HeightChain();
  const o = await createOrder(db, cfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(1), now: T0 });
  assert.equal(o.startHeight, null);
  chain.put(o.payAddress, "1", 5, 996);
  await scanOnce(db, chain, scfg, at(5));
  assert.equal((await getOrder(db, o.id))!.status, "paid");
});
