import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openDb, type Db } from "../src/db/index.js";
import { parseZec } from "../src/money.js";
import { createCollection } from "../src/services/collections.js";
import { mintPaidOrders } from "../src/services/mint.js";
import { createOrder, getOrder } from "../src/services/orders.js";
import { trackRefunds } from "../src/services/refund-tracker.js";
import { listRefunds, markRefundSent, planRefunds } from "../src/services/refunds.js";
import { scanOnce } from "../src/watcher/scan.js";
import { accountXpubFromMnemonic, deriveReceiveAddress } from "../src/zcash/address.js";
import type { ChainClient, ReceivedOutput, TxState } from "../src/chain/types.js";

const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const xpub = accountXpubFromMnemonic(M);
const buyer = (i: number) => deriveReceiveAddress(xpub, 1000 + i, "testnet");
const TREASURY = deriveReceiveAddress(xpub, 2000, "testnet");
const ocfg = { network: "testnet" as const, walletXpub: xpub, orderTtlMinutes: 30 };
const scfg = { minConfirmations: 10, lateGraceHours: 168 };
const pcfg = {
  network: "testnet" as const, treasuryAddress: TREASURY, minRefundNetZats: 10_000n, minConfirmations: 10,
  feeMarginalZats: 5000n, feeGraceActions: 2,
};
const tcfg = { minConfirmations: 10, refundExpiryMargin: 100, refundStuckMinutes: 15 };
const T = (n: string) => createHash("sha256").update(n).digest("hex");
const T0 = new Date("2026-01-01T00:00:00Z");
const at = (m: number) => new Date(T0.getTime() + m * 60_000);

class TxChain implements ChainClient {
  outs = new Map<string, ReceivedOutput[]>();
  tip = 1000;
  status = new Map<string, TxState>();
  failStatus = false;
  failTip = false;
  n = 0;
  pay(addr: string, zec: string, conf = 10) {
    const l = this.outs.get(addr) ?? [];
    l.push({ txid: T("p" + ++this.n), vout: 0, amountZats: parseZec(zec), confirmations: conf });
    this.outs.set(addr, l);
  }
  async getReceived(a: string) {
    return (this.outs.get(a) ?? []).map((o) => ({ ...o }));
  }
  async tipHeight() {
    if (this.failTip) throw new Error("tip down");
    return this.tip;
  }
  async getTxStatus(txid: string): Promise<TxState> {
    if (this.failStatus) throw new Error("status down");
    return this.status.get(txid) ?? { state: "unknown" };
  }
}

/** overpay wala minted order, refund planned + "sent" (expiry ke saath) */
async function sentRefund(expiry: number | null = 1200) {
  const db = await openDb();
  await createCollection(db, { slug: "demo", name: "Demo", supply: 5, priceZats: parseZec("1"), maxPerWallet: 5 });
  const chain = new TxChain();
  const o = await createOrder(db, ocfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(1), now: T0 });
  chain.pay(o.payAddress, "1.5");
  await scanOnce(db, chain, scfg, at(5));
  await mintPaidOrders(db);
  const plan = (await planRefunds(db, pcfg)).created[0];
  const txid = T("refund-tx-" + plan.refundId);
  await markRefundSent(db, plan.refundId, txid, { expiryHeight: expiry ?? undefined });
  return { db, chain, o, plan, txid };
}
const rstatus = async (db: Db, id = 1) => (await listRefunds(db)).find((r) => r.id === id)!.status;

test("mined + kaafi confirmations => confirmed; idempotent", async () => {
  const { db, chain, txid } = await sentRefund();
  chain.status.set(txid, { state: "mined", height: 991 }); // tip 1000 => 10 conf
  const r = await trackRefunds(db, chain, tcfg, at(10));
  assert.deepEqual(r.confirmed, [1]);
  assert.equal(await rstatus(db), "confirmed");
  const r2 = await trackRefunds(db, chain, tcfg, at(11));
  assert.equal(r2.checked, 0); // ab 'sent' nahi
  const ev = await db.query<{ event: string }>(`SELECT event FROM order_events WHERE event = 'refund_confirmed'`);
  assert.equal(ev.rows.length, 1);
});

test("mined par kam confirmations / mempool => sent hi rehta hai", async () => {
  const { db, chain, txid } = await sentRefund();
  chain.status.set(txid, { state: "mined", height: 998 }); // 3 conf
  assert.equal((await trackRefunds(db, chain, tcfg, at(10))).confirmed.length, 0);
  assert.equal(await rstatus(db), "sent");
  chain.status.set(txid, { state: "mempool" });
  await trackRefunds(db, chain, tcfg, at(10));
  assert.equal(await rstatus(db), "sent");
  chain.tip = 1008; // ab 11 conf
  chain.status.set(txid, { state: "mined", height: 998 });
  assert.equal((await trackRefunds(db, chain, tcfg, at(12))).confirmed.length, 1);
});

test("chain pe nahi dikhti par expiry abhi nahi guzri => WAIT (inputs free NAHI)", async () => {
  const { db, chain } = await sentRefund(1200);
  chain.tip = 1250; // expiry 1200 guzar gayi, lekin margin (100) abhi nahi
  const r = await trackRefunds(db, chain, tcfg, at(5));
  assert.deepEqual(r.failed, []);
  assert.equal(await rstatus(db), "sent");
  // aur dobara plan nahi ban sakta (inputs reserved)
  assert.equal((await planRefunds(db, pcfg)).created.length, 0);
});

test("expiry + margin guzri aur tx mine nahi hui => FAILED, inputs free, refund dobara plan ho sakta hai", async () => {
  const { db, chain, o } = await sentRefund(1200);
  chain.tip = 1301; // 1200 + 100 se aage
  const r = await trackRefunds(db, chain, tcfg, at(5));
  assert.deepEqual(r.failed, [1]);
  assert.equal(await rstatus(db), "failed");
  assert.equal((await getOrder(db, o.id))!.refundedZats, 0n);
  const again = await planRefunds(db, pcfg);
  assert.equal(again.created.length, 1);
  assert.notEqual(again.created[0].refundId, 1);
  const sp = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM payments WHERE spent_txid IS NOT NULL`);
  assert.equal(sp.rows[0].n, 0);
});

test("SAFETY: expiry guzri par tx mined mili => failed NAHI, confirmed (double refund nahi)", async () => {
  const { db, chain, txid } = await sentRefund(1200);
  chain.tip = 1301;
  chain.status.set(txid, { state: "mined", height: 1195 });
  const r = await trackRefunds(db, chain, tcfg, at(5));
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.confirmed, [1]);
  assert.equal((await planRefunds(db, pcfg)).created.length, 0);
});

test("fork pe mined = main chain mein nahi: unknown jaisa (expiry ke baad failed)", async () => {
  const { db, chain, txid } = await sentRefund(1200);
  chain.status.set(txid, { state: "fork" });
  chain.tip = 1301;
  assert.deepEqual((await trackRefunds(db, chain, tcfg, at(5))).failed, [1]);
});

test("chain / tip error => kuch nahi badalta (galti se failed nahi)", async () => {
  const { db, chain } = await sentRefund(1200);
  chain.tip = 5000;
  chain.failStatus = true;
  let r = await trackRefunds(db, chain, tcfg, at(5));
  assert.equal(r.errors, 1);
  assert.equal(await rstatus(db), "sent");
  chain.failStatus = false;
  chain.failTip = true;
  r = await trackRefunds(db, chain, tcfg, at(5));
  assert.equal(r.errors, 1);
  assert.equal(await rstatus(db), "sent");
});

test("stuck ALERT: 15+ minute se nahi dikh rahi => ek hi baar alert", async () => {
  const { db, chain } = await sentRefund(1200);
  const later = new Date(Date.now() + 20 * 60_000);
  let r = await trackRefunds(db, chain, tcfg, later);
  assert.deepEqual(r.alerts, [1]);
  r = await trackRefunds(db, chain, tcfg, new Date(later.getTime() + 60_000));
  assert.deepEqual(r.alerts, []); // dobara nahi
  const ev = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM order_events WHERE event = 'ALERT'`);
  assert.equal(ev.rows[0].n, 1);
  assert.equal(await rstatus(db), "sent");
});

test("expiry na pata ho (purani sent refund) => kabhi auto-failed nahi, sirf alert", async () => {
  const { db, chain } = await sentRefund(null);
  chain.tip = 99999;
  const r = await trackRefunds(db, chain, tcfg, new Date(Date.now() + 60 * 60_000));
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.alerts, [1]);
  assert.equal(await rstatus(db), "sent");
});

test("failed ke baad naya refund confirm bhi ho sakta hai (poora chakra)", async () => {
  const { db, chain } = await sentRefund(1200);
  chain.tip = 1301;
  await trackRefunds(db, chain, tcfg, at(5)); // failed
  const p2 = (await planRefunds(db, pcfg)).created[0];
  const txid2 = T("second-refund");
  await markRefundSent(db, p2.refundId, txid2, { expiryHeight: 1500 });
  chain.status.set(txid2, { state: "mined", height: 1290 });
  const r = await trackRefunds(db, chain, tcfg, at(6));
  assert.deepEqual(r.confirmed, [p2.refundId]);
  assert.deepEqual((await listRefunds(db)).map((x) => x.status), ["failed", "confirmed"]);
});

test("tracking support na ho (nakli chain) => supported=false, kuch nahi badalta", async () => {
  const { db } = await sentRefund();
  const dumb: ChainClient = { getReceived: async () => [] };
  const r = await trackRefunds(db, dumb, tcfg, at(5));
  assert.equal(r.supported, false);
  assert.equal(await rstatus(db), "sent");
});

test("markRefundSent: expiry store hota hai; 0/undefined => NULL", async () => {
  const { db, plan } = await sentRefund(1234);
  const r = await db.query<{ e: number | null }>(`SELECT expiry_height AS e FROM refunds WHERE id = $1`, [plan.refundId]);
  assert.equal(r.rows[0].e, 1234);
});
