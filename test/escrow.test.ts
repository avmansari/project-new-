import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate, openDb, type Db } from "../src/db/index.js";
import { parseZec } from "../src/money.js";
import { createCollection } from "../src/services/collections.js";
import { cancelPayoutRequest, collectionStats, listPayoutRequests, markPayoutSent, runReleases, splitSale } from "../src/services/ledger.js";
import { mintOrder, mintPaidOrders } from "../src/services/mint.js";
import { cancelCollection, endCollection, freezeCollection, reportCollection, unfreezeCollection } from "../src/services/moderation.js";
import { createOrder, getOrder, OrderError } from "../src/services/orders.js";
import { planRefunds } from "../src/services/refunds.js";
import { scanOnce } from "../src/watcher/scan.js";
import { accountXpubFromMnemonic, deriveReceiveAddress } from "../src/zcash/address.js";
import type { ChainClient, ReceivedOutput } from "../src/chain/types.js";
import { createHash } from "node:crypto";

const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const xpub = accountXpubFromMnemonic(M);
const buyer = (i: number) => deriveReceiveAddress(xpub, 1000 + i, "testnet");
const CREATOR = deriveReceiveAddress(xpub, 3000, "testnet");
const TREASURY = deriveReceiveAddress(xpub, 2000, "testnet");
const ocfg = { network: "testnet" as const, walletXpub: xpub, orderTtlMinutes: 30 };
const scfg = { minConfirmations: 10, lateGraceHours: 168 };
const rcfg = { minPayoutZats: 1_000_000n, dustZats: 10_000n };
const rep = { reportFreezeMin: 3, reportFreezePct: 10 };
const pcfg = {
  network: "testnet" as const, treasuryAddress: TREASURY as string | undefined, minRefundNetZats: 10_000n,
  minConfirmations: 10, feeMarginalZats: 5000n, feeGraceActions: 2,
};
const T = (n: string) => createHash("sha256").update(n).digest("hex");
const HOUR = 3_600_000;
const later = (h: number) => new Date(Date.now() + h * HOUR);

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

async function setup(opts: { supply?: number; price?: string; holdHours?: number; advanceBps?: number; feeBps?: number; creator?: boolean } = {}) {
  const db = await openDb();
  await createCollection(db, {
    slug: "demo", name: "Demo", supply: opts.supply ?? 3, priceZats: parseZec(opts.price ?? "1"), maxPerWallet: 100,
    creatorAddress: opts.creator === false ? undefined : CREATOR, network: "testnet",
    holdHours: opts.holdHours ?? 24, advanceBps: opts.advanceBps ?? 0, feeBps: opts.feeBps,
  });
  return { db, chain: new MemChain() };
}

/** buyer b ke liye order banao, exact price bharo, scan, mint */
async function sell(db: Db, chain: MemChain, b: number, qty = 1, paid?: string) {
  const o = await createOrder(db, ocfg, { collectionSlug: "demo", quantity: qty, buyerAddress: buyer(b) });
  chain.pay(o.payAddress, paid ?? String(qty));
  await scanOnce(db, chain, scfg);
  await mintPaidOrders(db);
  assert.equal((await getOrder(db, o.id))!.status, "minted");
  return o;
}

test("splitSale: fee + net hamesha gross, floor rounding", () => {
  assert.deepEqual(splitSale(parseZec("1"), 100), { feeZats: 1_000_000n, netZats: 99_000_000n });
  const a = splitSale(99n, 100); // 0.99 -> fee 0
  assert.equal(a.feeZats, 0n);
  assert.equal(a.feeZats + a.netZats, 99n);
  for (const g of [1n, 7n, 199n, 12345678901n]) for (const bps of [0, 1, 100, 250, 1000, 10000]) {
    const r = splitSale(g, bps);
    assert.equal(r.feeZats + r.netZats, g);
    assert.ok(r.feeZats >= 0n && r.netZats >= 0n);
  }
  assert.throws(() => splitSale(0n, 100));
  assert.throws(() => splitSale(10n, 10001));
});

test("mint pe sale ledger: 1% platform fee + creator hissa, koi duplicate nahi", async () => {
  const { db, chain } = await setup();
  const o = await sell(db, chain, 1, 2); // 2 ZEC
  const st = await collectionStats(db, "demo");
  assert.equal(st.salesCount, 1);
  assert.equal(st.grossZats, parseZec("2"));
  assert.equal(st.platformFeeZats, parseZec("0.02"));
  assert.equal(st.creatorNetZats, parseZec("1.98"));
  assert.equal(st.grossZats, st.platformFeeZats + st.creatorNetZats);
  await mintOrder(db, o.id); // dobara => already_minted, sale dobara nahi
  assert.equal((await collectionStats(db, "demo")).salesCount, 1);
});

test("RELEASE: sold out ke baad bhi hold_hours tak paisa ruka rehta hai, phir poora net", async () => {
  const { db, chain } = await setup({ supply: 2, holdHours: 24 });
  await sell(db, chain, 1);
  let r = await runReleases(db, rcfg, later(100));
  assert.equal(r.created.length, 0); // abhi sold out nahi, settlement nahi
  await sell(db, chain, 2); // sold out
  r = await runReleases(db, rcfg, later(1));
  assert.deepEqual(r.settled, ["demo"]);
  assert.equal(r.created.length, 0); // hold chal raha hai
  r = await runReleases(db, rcfg, later(25)); // hold khatam
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].kind, "final");
  assert.equal(r.created[0].address, CREATOR);
  assert.equal(r.created[0].amountZats, parseZec("1.98")); // 2 x 0.99
  // dobara chalao => double payout nahi
  assert.equal((await runReleases(db, rcfg, later(26))).created.length, 0);
  const st = await collectionStats(db, "demo");
  assert.equal(st.heldZats, 0n);
  assert.equal(st.requestedZats, parseZec("1.98"));
});

test("ENDED collection (sold out nahi) bhi hold ke baad settle hoti hai", async () => {
  const { db, chain } = await setup({ supply: 10, holdHours: 12 });
  await sell(db, chain, 1);
  assert.equal((await runReleases(db, rcfg, later(500))).created.length, 0); // live + sold out nahi
  await endCollection(db, "demo");
  assert.equal((await runReleases(db, rcfg, later(1))).created.length, 0);
  const r = await runReleases(db, rcfg, later(13));
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].amountZats, parseZec("0.99"));
});

test("paid-par-mint-nahi hua order settlement rokta hai", async () => {
  const { db, chain } = await setup({ supply: 1, holdHours: 0 });
  const o = await createOrder(db, ocfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(1) });
  chain.pay(o.payAddress, "1");
  await scanOnce(db, chain, scfg); // paid, mint nahi hua
  await endCollection(db, "demo");
  assert.equal((await runReleases(db, rcfg, later(1))).settled.length, 0);
  await mintPaidOrders(db);
  const r = await runReleases(db, rcfg, later(1));
  assert.deepEqual(r.settled, ["demo"]);
  assert.equal(r.created.length, 1);
});

test("ADVANCE (trusted creator): net ka % turant, baaki hold ke baad, kul == net (zyada nahi)", async () => {
  const { db, chain } = await setup({ supply: 2, price: "1", holdHours: 24, advanceBps: 5000 });
  await sell(db, chain, 1);
  const a = await runReleases(db, rcfg, later(0));
  assert.equal(a.created.length, 1);
  assert.equal(a.created[0].kind, "advance");
  assert.equal(a.created[0].amountZats, parseZec("0.495")); // 50% of 0.99
  assert.equal((await runReleases(db, rcfg, later(0))).created.length, 0);
  await sell(db, chain, 2);
  const b = await runReleases(db, rcfg, later(0)); // naya advance sirf naye hisse pe
  assert.equal(b.created[0].amountZats, parseZec("0.495"));
  const c = await runReleases(db, rcfg, later(30)); // final: baaki
  assert.equal(c.created.length, 1);
  assert.equal(c.created[0].kind, "final");
  const st = await collectionStats(db, "demo");
  assert.equal(st.requestedZats, st.creatorNetZats); // exactly net, na kam na zyada
  assert.equal(st.heldZats, 0n);
});

test("advance chhota ho (minPayout se kam) to nahi banta, par final chhota bhi banta hai", async () => {
  const { db, chain } = await setup({ supply: 1, price: "0.001", holdHours: 0, advanceBps: 5000 });
  await sell(db, chain, 1); // net 0.00099; advance 0.000495 < 0.01
  let r = await runReleases(db, rcfg, later(0));
  // supply 1 => sold out, hold 0 => final turant
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].kind, "final");
  assert.equal(r.created[0].amountZats, parseZec("0.00099"));
  r = await runReleases(db, rcfg, later(1));
  assert.equal(r.created.length, 0);
});

test("FREEZE: payout ruk jaata hai + nayi sales band; unfreeze pe wapas", async () => {
  const { db, chain } = await setup({ supply: 1, holdHours: 0 });
  await sell(db, chain, 1);
  await freezeCollection(db, "demo", "suspicious");
  const r = await runReleases(db, rcfg, later(5));
  assert.equal(r.created.length, 0);
  assert.equal(r.skipped[0].reason, "freeze hai");
  await assert.rejects(
    createOrder(db, ocfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(9) }),
    (e: unknown) => e instanceof OrderError && /freeze/.test(e.message)
  );
  await unfreezeCollection(db, "demo");
  assert.equal((await runReleases(db, rcfg, later(5))).created.length, 1);
});

test("creator ka payout address nahi => skip (paisa kahin nahi jaata)", async () => {
  const { db, chain } = await setup({ supply: 1, holdHours: 0, creator: false });
  await sell(db, chain, 1);
  const r = await runReleases(db, rcfg, later(1));
  assert.equal(r.created.length, 0);
  assert.match(r.skipped[0].reason, /address/);
});

test("payout request: sent mark, cancel = paisa wapas held", async () => {
  const { db, chain } = await setup({ supply: 1, holdHours: 0 });
  await sell(db, chain, 1);
  const r = await runReleases(db, rcfg, later(1));
  const id = r.created[0].id;
  await cancelPayoutRequest(db, id);
  assert.equal((await collectionStats(db, "demo")).heldZats, parseZec("0.99"));
  const r2 = await runReleases(db, rcfg, later(2)); // dobara ban sakta hai
  assert.equal(r2.created.length, 1);
  await assert.rejects(markPayoutSent(db, r2.created[0].id, "zz"), /64 hex/);
  await markPayoutSent(db, r2.created[0].id, "a".repeat(64));
  await assert.rejects(cancelPayoutRequest(db, r2.created[0].id), /pending/);
  const all = await listPayoutRequests(db);
  assert.deepEqual(all.map((x) => x.status), ["cancelled", "sent"]);
  assert.equal((await collectionStats(db, "demo")).paidZats, parseZec("0.99"));
});

test("REPORTS: sirf buyers; threshold par auto-freeze; duplicate ek hi gino", async () => {
  const { db, chain } = await setup({ supply: 20 });
  for (let i = 1; i <= 4; i++) await sell(db, chain, i);
  await assert.rejects(reportCollection(db, "demo", buyer(99), "scam", rep), /buyers/); // buyer nahi
  await assert.rejects(reportCollection(db, "demo", buyer(1), "  ", rep), /reason/);
  let r = await reportCollection(db, "demo", buyer(1), "no art", rep);
  assert.deepEqual([r.reports, r.threshold, r.frozen], [1, 3, false]);
  r = await reportCollection(db, "demo", buyer(1), "again", rep); // same reporter
  assert.equal(r.reports, 1);
  r = await reportCollection(db, "demo", buyer(2), "rug", rep);
  assert.equal(r.frozen, false);
  r = await reportCollection(db, "demo", buyer(3), "rug", rep);
  assert.equal(r.frozen, true); // 3 >= max(3, 10% of 4)
  const st = await collectionStats(db, "demo");
  assert.equal(st.frozen, true);
  assert.match(st.frozenReason!, /auto/);
});

test("report threshold buyers ke % se badhta hai (bade collection mein 3 kaafi nahi)", async () => {
  const { db, chain } = await setup({ supply: 100 });
  for (let i = 1; i <= 40; i++) await sell(db, chain, i);
  const r = await reportCollection(db, "demo", buyer(1), "x", rep);
  assert.equal(r.threshold, 4); // max(3, ceil(40*10%)=4)
});

test("CANCEL: buyers ko refund, tokens/sales void, payout requests cancel, nayi sales band", async () => {
  const { db, chain } = await setup({ supply: 5, holdHours: 24 });
  const a = await sell(db, chain, 1);
  const b = await sell(db, chain, 2);
  await runReleases(db, { ...rcfg, minPayoutZats: 1n }, later(0));
  const s = await cancelCollection(db, "demo", "creator ne art nahi diya");
  assert.equal(s.ordersToRefund, 2);
  assert.equal(s.refundZats, parseZec("2"));
  assert.equal(s.tokensVoided, 2);
  assert.equal(s.alreadyPaidToCreatorZats, 0n);
  for (const o of [a, b]) {
    const x = (await getOrder(db, o.id))!;
    assert.equal(x.status, "refund_needed");
    assert.equal(x.refundDueZats, parseZec("1"));
  }
  const st = await collectionStats(db, "demo");
  assert.equal(st.status, "cancelled");
  assert.equal(st.salesCount, 0);
  assert.equal(st.creatorNetZats, 0n);
  assert.equal(st.minted, 0);
  await assert.rejects(createOrder(db, ocfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(9) }), (e: unknown) => e instanceof OrderError);
  await assert.rejects(cancelCollection(db, "demo", "dobara"), /pehle hi/);
  assert.equal((await runReleases(db, rcfg, later(1000))).created.length, 0);
  // watcher dobara chale => refund_needed wapas paid/minted nahi hota
  await scanOnce(db, chain, scfg);
  assert.equal((await getOrder(db, a.id))!.status, "refund_needed");
  await mintPaidOrders(db);
  assert.equal((await collectionStats(db, "demo")).minted, 0);
});

test("CANCEL ke baad existing refund system se buyers ko paisa wapas plan hota hai", async () => {
  const { db, chain } = await setup({ supply: 5 });
  await sell(db, chain, 1);
  await sell(db, chain, 2);
  await cancelCollection(db, "demo", "rug");
  const r = await planRefunds(db, pcfg);
  assert.equal(r.created.length, 2);
  for (const p of r.created) {
    assert.equal(p.grossZats, parseZec("1"));
    assert.equal(p.outputs.length, 1);
    assert.equal(p.outputs[0].amountZats, parseZec("1") - 10_000n);
    assert.equal(p.inputs.reduce((a, i) => a + i.amountZats, 0n), p.outputs[0].amountZats + p.feeZats);
  }
});

test("CANCEL: creator ko pehle bheja gaya paisa alag report hota hai", async () => {
  const { db, chain } = await setup({ supply: 1, holdHours: 0 });
  await sell(db, chain, 1);
  const r = await runReleases(db, rcfg, later(1));
  await markPayoutSent(db, r.created[0].id, "b".repeat(64));
  const s = await cancelCollection(db, "demo", "late rug");
  assert.equal(s.alreadyPaidToCreatorZats, parseZec("0.99")); // ye loss hai: isi liye hold_hours zaroori
});

test("CANCEL: pending (unpaid) order expired, baad mein aaya paisa refund hota hai, mint nahi", async () => {
  const { db, chain } = await setup({ supply: 5 });
  const o = await createOrder(db, ocfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(1) });
  await cancelCollection(db, "demo", "rug");
  assert.equal((await getOrder(db, o.id))!.status, "expired");
  chain.pay(o.payAddress, "1"); // buyer ne baad mein bhej diya
  await scanOnce(db, chain, scfg);
  assert.equal((await getOrder(db, o.id))!.status, "refund_needed");
  assert.equal((await getOrder(db, o.id))!.refundDueZats, parseZec("1"));
  await mintPaidOrders(db);
  assert.equal((await collectionStats(db, "demo")).minted, 0);
});

test("CANCEL: paid (mint se pehle) order bhi refund", async () => {
  const { db, chain } = await setup({ supply: 5 });
  const o = await createOrder(db, ocfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(1) });
  chain.pay(o.payAddress, "1");
  await scanOnce(db, chain, scfg); // paid, mint nahi hua
  await cancelCollection(db, "demo", "rug");
  const x = (await getOrder(db, o.id))!;
  assert.equal(x.status, "refund_needed");
  assert.equal(x.refundDueZats, parseZec("1"));
});

test("createCollection validation: fee/hold/advance range, creator address network", async () => {
  const db = await openDb();
  const base = { slug: "x1", name: "X", supply: 1, priceZats: 1000n, maxPerWallet: 1 };
  await assert.rejects(createCollection(db, { ...base, feeBps: 1001 }), /feeBps/);
  await assert.rejects(createCollection(db, { ...base, feeBps: -1 }), /feeBps/);
  await assert.rejects(createCollection(db, { ...base, holdHours: 99999 }), /holdHours/);
  await assert.rejects(createCollection(db, { ...base, advanceBps: 10001 }), /advanceBps/);
  await assert.rejects(createCollection(db, { ...base, creatorAddress: CREATOR }), /network/);
  await assert.rejects(createCollection(db, { ...base, creatorAddress: deriveReceiveAddress(xpub, 5, "mainnet"), network: "testnet" }), /valid/);
  const c = await createCollection(db, { ...base, creatorAddress: CREATOR, network: "testnet" });
  assert.equal(c.feeBps, 100);
  assert.equal(c.holdHours, 72);
  assert.equal(c.advanceBps, 0);
});

test("migration: purane minted orders ka sales ledger backfill hota hai (idempotent)", async () => {
  const { db, chain } = await setup({ supply: 3 });
  await sell(db, chain, 1);
  await sell(db, chain, 2);
  await db.query(`DELETE FROM sales`);
  assert.equal((await collectionStats(db, "demo")).salesCount, 0);
  await migrate(db);
  await migrate(db); // dobara => duplicate nahi
  const st = await collectionStats(db, "demo");
  assert.equal(st.salesCount, 2);
  assert.equal(st.platformFeeZats, parseZec("0.02"));
});

test("CONSERVATION: kai sales ke baad gross == platform fee + creator net == payouts + held", async () => {
  const { db, chain } = await setup({ supply: 7, price: "0.37", holdHours: 0, feeBps: 250 });
  for (let i = 1; i <= 7; i++) await sell(db, chain, i);
  await runReleases(db, rcfg, later(1));
  const st = await collectionStats(db, "demo");
  assert.equal(st.grossZats, st.platformFeeZats + st.creatorNetZats);
  assert.equal(st.creatorNetZats, st.requestedZats + st.heldZats);
  assert.equal(st.grossZats, parseZec("0.37") * 7n);
});
