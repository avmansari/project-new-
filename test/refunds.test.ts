import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/index.js";
import { loadConfig } from "../src/config.js";
import { parseZec } from "../src/money.js";
import { createCollection } from "../src/services/collections.js";
import { createOrder, getOrder } from "../src/services/orders.js";
import { mintPaidOrders } from "../src/services/mint.js";
import {
  cancelRefund, conventionalFee, exportPlanned, listRefunds, markRefundSent, planRefunds, planToJson,
  type RefundPlanItem,
} from "../src/services/refunds.js";
import { scanOnce } from "../src/watcher/scan.js";
import { accountXpubFromMnemonic, deriveReceiveAddress } from "../src/zcash/address.js";
import type { ChainClient, ReceivedOutput } from "../src/chain/types.js";

const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const xpub = accountXpubFromMnemonic(M);
const buyer = (i: number) => deriveReceiveAddress(xpub, 1000 + i, "testnet");
const TREASURY = deriveReceiveAddress(xpub, 2000, "testnet");
const ocfg = { network: "testnet" as const, walletXpub: xpub, orderTtlMinutes: 30 };
const scfg = { minConfirmations: 10, lateGraceHours: 168 };
const pcfg = {
  network: "testnet" as const,
  treasuryAddress: TREASURY as string | undefined,
  minRefundNetZats: 10_000n,
  minConfirmations: 10,
  feeMarginalZats: 5000n,
  feeGraceActions: 2,
};
const T0 = new Date("2026-01-01T00:00:00Z");
const at = (m: number) => new Date(T0.getTime() + m * 60_000);
const TXID = "a".repeat(64);

class MemChain implements ChainClient {
  outs = new Map<string, ReceivedOutput[]>();
  n = 0;
  pay(addr: string, zec: string, conf = 10) {
    const l = this.outs.get(addr) ?? [];
    l.push({ txid: `tx${++this.n}`, vout: 0, amountZats: parseZec(zec), confirmations: conf });
    this.outs.set(addr, l);
  }
  async getReceived(a: string) {
    return (this.outs.get(a) ?? []).map((o) => ({ ...o }));
  }
}

async function setup(price = "1") {
  const db = await openDb();
  await createCollection(db, { slug: "demo", name: "Demo", supply: 50, priceZats: parseZec(price), maxPerWallet: 50 });
  return { db, chain: new MemChain() };
}
const mk = (db: any, b: number, qty = 1) =>
  createOrder(db, ocfg, { collectionSlug: "demo", quantity: qty, buyerAddress: buyer(b), now: T0 });

const sum = (xs: { amountZats: bigint }[]) => xs.reduce((a, x) => a + x.amountZats, 0n);
/** Sabse zaroori check: paisa na bana, na gayab hua */
function invariant(p: RefundPlanItem) {
  assert.equal(sum(p.inputs), sum(p.outputs) + p.feeZats, `refund#${p.refundId} balance nahi mila`);
  assert.ok(p.outputs.every((o) => o.amountZats > 0n));
}

/** minted order jisme `paid` ZEC bheje gaye */
async function mintedWith(db: any, chain: MemChain, b: number, paid: string) {
  const o = await mk(db, b);
  chain.pay(o.payAddress, paid);
  await scanOnce(db, chain, scfg, at(5));
  await mintPaidOrders(db);
  return o;
}

test("fee: ZIP 317 min 10000, phir har input/output ke 5000", () => {
  const p = { feeMarginalZats: 5000n, feeGraceActions: 2 };
  assert.equal(conventionalFee(1, 1, p), 10000n);
  assert.equal(conventionalFee(1, 2, p), 10000n);
  assert.equal(conventionalFee(2, 2, p), 10000n);
  assert.equal(conventionalFee(3, 1, p), 15000n);
  assert.equal(conventionalFee(10, 2, p), 50000n);
});

test("underpay expire => full refund (fee buyer ke hisse se), koi change nahi", async () => {
  const { db, chain } = await setup();
  const o = await mk(db, 1);
  chain.pay(o.payAddress, "0.4");
  await scanOnce(db, chain, scfg, at(5));
  await scanOnce(db, chain, scfg, at(40));
  assert.equal((await getOrder(db, o.id))!.status, "refund_needed");

  const r = await planRefunds(db, pcfg);
  assert.equal(r.created.length, 1);
  const p = r.created[0];
  invariant(p);
  assert.equal(p.grossZats, parseZec("0.4"));
  assert.equal(p.feeZats, 10_000n);
  assert.equal(p.outputs.length, 1);
  assert.equal(p.outputs[0].address, buyer(1));
  assert.equal(p.outputs[0].amountZats, parseZec("0.4") - 10_000n);
  assert.equal((await getOrder(db, o.id))!.refundedZats, parseZec("0.4"));
});

test("dobara plan => DOUBLE REFUND nahi", async () => {
  const { db, chain } = await setup();
  const o = await mk(db, 1);
  chain.pay(o.payAddress, "0.4");
  await scanOnce(db, chain, scfg, at(5));
  await scanOnce(db, chain, scfg, at(40));
  await planRefunds(db, pcfg);
  const again = await planRefunds(db, pcfg);
  assert.equal(again.created.length, 0);
  assert.equal(again.skipped.length, 0);
  assert.equal((await listRefunds(db)).length, 1);
  // watcher dobara chale => bhi kuch nahi badalta
  await scanOnce(db, chain, scfg, at(60));
  assert.equal((await planRefunds(db, pcfg)).created.length, 0);
});

test("overpay (minted) => excess buyer ko, baaki treasury ko (change), balance milta hai", async () => {
  const { db, chain } = await setup();
  const o = await mintedWith(db, chain, 1, "1.5");
  const r = await planRefunds(db, pcfg);
  assert.equal(r.created.length, 1);
  const p = r.created[0];
  invariant(p);
  assert.equal(p.grossZats, parseZec("0.5"));
  assert.equal(p.outputs.length, 2);
  const refund = p.outputs.find((x) => x.role === "refund")!;
  const change = p.outputs.find((x) => x.role === "change")!;
  assert.equal(refund.address, buyer(1));
  assert.equal(refund.amountZats, parseZec("0.5") - 10_000n);
  assert.equal(change.address, TREASURY);
  assert.equal(change.amountZats, parseZec("1"));
  assert.equal(p.inputs[0].addressIndex, o.addressIndex);
});

test("change ke liye treasury nahi => skip (paisa bina address ke nahi bhejte)", async () => {
  const { db, chain } = await setup();
  await mintedWith(db, chain, 1, "1.5");
  const r = await planRefunds(db, { ...pcfg, treasuryAddress: undefined });
  assert.equal(r.created.length, 0);
  assert.match(r.skipped[0].reason, /TREASURY/);
  assert.equal((await listRefunds(db)).length, 0);
});

test("bahut chhota excess (fee se kam) => skip, uneconomical", async () => {
  const { db, chain } = await setup();
  await mintedWith(db, chain, 1, "1.00005"); // excess 5000 zats < fee 10000
  const r = await planRefunds(db, pcfg);
  assert.equal(r.created.length, 0);
  assert.match(r.skipped[0].reason, /chhota/);
});

test("dust change alag output nahi banta, miner fee mein jaata hai, balance phir bhi milta hai", async () => {
  const { db, chain } = await setup("0.00005"); // price 5000 zats
  await mintedWith(db, chain, 1, "0.0005"); // 50000 zats bheje, excess 45000
  const r = await planRefunds(db, pcfg);
  assert.equal(r.created.length, 1);
  const p = r.created[0];
  invariant(p);
  assert.equal(p.outputs.length, 1); // change (5000) < min => output nahi
  assert.equal(p.outputs[0].amountZats, 45_000n - 10_000n);
  assert.equal(p.feeZats, 10_000n + 5_000n);
});

test("cancel => inputs free, refund dobara plan ho sakta hai, refunded_zats wapas", async () => {
  const { db, chain } = await setup();
  const o = await mintedWith(db, chain, 1, "1.5");
  const first = (await planRefunds(db, pcfg)).created[0];
  await cancelRefund(db, first.refundId);
  assert.equal((await getOrder(db, o.id))!.refundedZats, 0n);
  const second = (await planRefunds(db, pcfg)).created[0];
  assert.notEqual(second.refundId, first.refundId);
  invariant(second);
  assert.equal((await listRefunds(db)).filter((r) => r.status === "planned").length, 1);
});

test("sent hone ke baad: cancel nahi, dobara plan nahi, txid validate", async () => {
  const { db, chain } = await setup();
  await mintedWith(db, chain, 1, "1.5");
  const p = (await planRefunds(db, pcfg)).created[0];
  await assert.rejects(markRefundSent(db, p.refundId, "xyz"), /64 hex/);
  await markRefundSent(db, p.refundId, TXID);
  await assert.rejects(cancelRefund(db, p.refundId), /sent/);
  await assert.rejects(markRefundSent(db, p.refundId, TXID), /planned/);
  assert.equal((await planRefunds(db, pcfg)).created.length, 0);
  const sp = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM payments WHERE spent_txid = $1`, [TXID]);
  assert.equal(sp.rows[0].n, 1);
});

test("mint ke baad extra payments: sirf naya hissa refund, purana kabhi dobara nahi", async () => {
  const { db, chain } = await setup();
  const o = await mintedWith(db, chain, 1, "1");
  assert.equal((await planRefunds(db, pcfg)).created.length, 0); // exact => refund nahi

  chain.pay(o.payAddress, "0.3"); // galti se extra
  await scanOnce(db, chain, scfg, at(6));
  const a = (await planRefunds(db, pcfg)).created[0];
  invariant(a);
  assert.equal(a.grossZats, parseZec("0.3"));
  assert.equal(a.inputs.length, 2);
  assert.equal(a.outputs.find((x) => x.role === "change")!.amountZats, parseZec("1"));
  await markRefundSent(db, a.refundId, TXID);

  chain.pay(o.payAddress, "0.2"); // ek aur extra
  await scanOnce(db, chain, scfg, at(7));
  const b = (await planRefunds(db, pcfg)).created[0];
  invariant(b);
  assert.equal(b.grossZats, parseZec("0.2"));
  assert.equal(b.inputs.length, 1); // purane inputs reserved hain
  assert.equal(b.outputs.length, 1);
  assert.equal(b.outputs[0].amountZats, parseZec("0.2") - 10_000n);
});

test("paid (mint se pehle) order ka refund plan nahi hota, mint ke baad hota hai", async () => {
  const { db, chain } = await setup();
  const o = await mk(db, 1);
  chain.pay(o.payAddress, "1.5");
  await scanOnce(db, chain, scfg, at(5));
  assert.equal((await getOrder(db, o.id))!.status, "paid");
  assert.equal((await planRefunds(db, pcfg)).created.length, 0);
  await mintPaidOrders(db);
  assert.equal((await planRefunds(db, pcfg)).created.length, 1);
});

test("kam confirmations wale inputs skip", async () => {
  const { db, chain } = await setup();
  const o = await mintedWith(db, chain, 1, "1.5");
  await db.query(`UPDATE payments SET confirmations = 3 WHERE order_id = $1`, [o.id]);
  const r = await planRefunds(db, pcfg);
  assert.equal(r.created.length, 0);
  assert.match(r.skipped[0].reason, /inputs kam/);
});

test("kharab buyer address => skip", async () => {
  const { db, chain } = await setup();
  const o = await mintedWith(db, chain, 1, "1.5");
  await db.query(`UPDATE orders SET buyer_address = 'garbage' WHERE id = $1`, [o.id]);
  const r = await planRefunds(db, pcfg);
  assert.equal(r.created.length, 0);
  assert.match(r.skipped[0].reason, /buyer address/);
});

test("exportPlanned DB se bilkul wahi plan wapas banata hai", async () => {
  const { db, chain } = await setup();
  await mintedWith(db, chain, 1, "1.5");
  const r = await planRefunds(db, pcfg);
  const exported = await exportPlanned(db);
  assert.equal(planToJson(exported), planToJson(r.created));
  await markRefundSent(db, exported[0].refundId, TXID);
  assert.equal((await exportPlanned(db)).length, 0); // sent wale export mein nahi
});

test("config: treasury galat network ka => error, sahi => ok", () => {
  const base = { WALLET_XPUB: "x", NETWORK: "testnet" };
  assert.throws(() => loadConfig({ ...base, TREASURY_ADDRESS: deriveReceiveAddress(xpub, 1, "mainnet") } as any), /TREASURY_ADDRESS/);
  assert.equal(loadConfig({ ...base, TREASURY_ADDRESS: TREASURY } as any).treasuryAddress, TREASURY);
  assert.equal(loadConfig(base as any).treasuryAddress, undefined);
});
