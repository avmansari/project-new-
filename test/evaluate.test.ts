import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type PaymentView } from "../src/watcher/evaluate.js";
import { parseZec } from "../src/money.js";

const T0 = new Date("2026-01-01T00:00:00Z");
const EXP = new Date(T0.getTime() + 30 * 60_000); // 30 min window
const before = new Date(T0.getTime() + 10 * 60_000);
const after = new Date(T0.getTime() + 60 * 60_000);
const MIN = 10;
const order = (status: any = "pending") => ({ status, amountZats: parseZec("1"), expiresAt: EXP });
const pay = (zec: string, conf: number, seenAt: Date = before, dropped = false): PaymentView => ({
  amountZats: parseZec(zec),
  confirmations: conf,
  firstSeenAt: seenAt,
  dropped,
});

test("exact + confirmed => paid", () => {
  const d = evaluate(order(), [pay("1", 10)], before, MIN);
  assert.equal(d.status, "paid");
  assert.equal(d.refundDueZats, 0n);
});

test("exact lekin kam confirmations => pending (funded)", () => {
  const d = evaluate(order(), [pay("1", 3)], before, MIN);
  assert.equal(d.status, "pending");
  assert.equal(d.funded, true);
});

test("overpay => paid + excess refund", () => {
  const d = evaluate(order(), [pay("1.25", 10)], before, MIN);
  assert.equal(d.status, "paid");
  assert.equal(d.refundDueZats, parseZec("0.25"));
});

test("underpay window ke andar => pending, refund nahi", () => {
  const d = evaluate(order(), [pay("0.4", 10)], before, MIN);
  assert.equal(d.status, "pending");
  assert.equal(d.refundDueZats, 0n);
  assert.equal(d.funded, false);
});

test("do chhote payments milke poora => paid", () => {
  const d = evaluate(order(), [pay("0.4", 10), pay("0.6", 10)], before, MIN);
  assert.equal(d.status, "paid");
});

test("underpay + expiry => refund_needed (jitna confirmed aaya)", () => {
  const d = evaluate(order(), [pay("0.4", 10)], after, MIN);
  assert.equal(d.status, "refund_needed");
  assert.equal(d.refundDueZats, parseZec("0.4"));
});

test("kuch nahi aaya + expiry => expired", () => {
  assert.equal(evaluate(order(), [], after, MIN).status, "expired");
});

test("LATE payment (expiry ke baad dikha) => kabhi paid nahi, seedha refund", () => {
  const d = evaluate(order("expired"), [pay("1", 10, after)], after, MIN);
  assert.equal(d.status, "refund_needed");
  assert.equal(d.refundDueZats, parseZec("1"));
});

test("time pe poora payment dikha, expiry ke baad confirm hua => paid", () => {
  const stillPending = evaluate(order(), [pay("1", 4, before)], after, MIN);
  assert.equal(stillPending.status, "pending"); // confirmations ka intezaar
  assert.equal(stillPending.funded, true); // supply reserved rahega
  const done = evaluate(order(), [pay("1", 10, before)], after, MIN);
  assert.equal(done.status, "paid");
});

test("dropped payment gina nahi jaata", () => {
  const d = evaluate(order(), [pay("1", 10, before, true)], before, MIN);
  assert.equal(d.status, "pending");
  assert.equal(d.funded, false);
});

test("funded payment baad mein dropped + expiry => expired", () => {
  const d = evaluate(order(), [pay("1", 0, before, true)], after, MIN);
  assert.equal(d.status, "expired");
});

test("paid order pe extra payment => sirf extra refund_due, status wahi", () => {
  const d = evaluate(order("paid"), [pay("1", 10), pay("0.3", 10, after)], after, MIN);
  assert.equal(d.status, "paid");
  assert.equal(d.refundDueZats, parseZec("0.3"));
});

test("minted order status kabhi peeche nahi jaata", () => {
  const d = evaluate(order("minted"), [pay("1", 10)], after, MIN);
  assert.equal(d.status, "minted");
});

test("refund_needed sticky hai: full confirmed payment ho tab bhi wapas paid nahi hota", () => {
  const d = evaluate(order("refund_needed"), [pay("1", 10)], before, MIN);
  assert.equal(d.status, "refund_needed");
  assert.equal(d.refundDueZats, parseZec("1"));
});
