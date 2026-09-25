import { test } from "node:test";
import assert from "node:assert/strict";

// web/noir.js browser module hai; Node mein mock wallet ke saath test hota hai.
const noir: any = await import(new URL("../web/noir.js", import.meta.url).href);

const TM = "tmJ3XjCvYhzm4cQsNH9SpZqHoMEKKS3DUXT";
const PAY = "tmGz7kjD1RsemRMk3pqSzn7jZ5RgfpDqRKK";
const collection = { slug: "real1", priceZats: "100000" };

interface Call { method: string; params?: unknown[] }
function mockProvider(handlers: Record<string, (params?: unknown[]) => unknown> = {}) {
  const calls: Call[] = [];
  return {
    calls,
    async request(a: Call) {
      calls.push(a);
      const h = handlers[a.method];
      if (!h) throw Object.assign(new Error("method not found"), { code: -32601 });
      return h(a.params);
    },
  };
}
const orderFor = (over: object = {}) => ({ id: "o1", payAddress: PAY, amountZats: "100000", amountZec: "0.001", ...over });
function mockApi(order: object | Error) {
  const log = { created: [] as any[], cancelled: [] as string[] };
  return {
    log,
    createOrder: async (b: any) => {
      log.created.push(b);
      if (order instanceof Error) throw order;
      return order;
    },
    cancelOrder: async (id: string) => {
      log.cancelled.push(id);
      return {};
    },
  };
}

test("detectNoir: turant mile; event ke baad mile; kabhi na mile => null", async () => {
  const prov = mockProvider();
  const w1: any = Object.assign(new EventTarget(), { noirwallet: { isNoirWallet: true, zcash: prov } });
  assert.equal(await noir.detectNoir(w1, 50), prov);

  const w2: any = Object.assign(new EventTarget(), {});
  const p = noir.detectNoir(w2, 2000);
  setTimeout(() => {
    w2.noirwallet = { isNoirWallet: true, zcash: prov };
    w2.dispatchEvent(new Event(noir.NOIR_EVENT));
  }, 20);
  assert.equal(await p, prov);

  assert.equal(await noir.detectNoir(Object.assign(new EventTarget(), {}), 30), null);
  // isNoirWallet false / zcash nahi => nahi maana jaata
  assert.equal(noir.getInjected({ noirwallet: { isNoirWallet: false, zcash: prov } }), null);
  assert.equal(noir.getInjected({ noirwallet: { isNoirWallet: true } }), null);
});

test("networkOfAddress + assertSameNetwork", () => {
  assert.equal(noir.networkOfAddress(TM), "testnet");
  assert.equal(noir.networkOfAddress("t1R9NRtic3D9GH7YcA79FvT4oUSbrNfqLFL"), "mainnet");
  assert.equal(noir.networkOfAddress("u1abcdef"), null);
  assert.equal(noir.networkOfAddress(undefined), null);
  assert.doesNotThrow(() => noir.assertSameNetwork(TM, "testnet"));
  assert.throws(() => noir.assertSameNetwork(TM, "mainnet"), /testnet pe hai.*mainnet/);
  assert.throws(() => noir.assertSameNetwork("u1xyz", "testnet"), /transparent/);
});

test("explainError: reject (4001/5000), pending (-32002), unsupported, baaki", () => {
  assert.equal(noir.explainError({ code: 4001 }).kind, "rejected");
  assert.equal(noir.explainError({ code: 5000 }).kind, "rejected");
  assert.equal(noir.explainError({ code: -32002 }).kind, "pending");
  assert.equal(noir.explainError({ code: -32601 }).kind, "unsupported");
  const o = noir.explainError(new Error("boom"));
  assert.equal(o.kind, "other");
  assert.equal(o.message, "boom");
});

test("connectNoir: popup wala method; silent => getAccounts; khaali jawab => error", async () => {
  const p = mockProvider({ zcash_requestAccounts: () => ({ transparent: TM, shielded: "u1xyz" }), zcash_getAccounts: () => null });
  assert.deepEqual(await noir.connectNoir(p), { transparent: TM, shielded: "u1xyz" });
  assert.equal(p.calls[0].method, "zcash_requestAccounts");
  await assert.rejects(noir.connectNoir(p, { silent: true }), /address nahi mila/);
  assert.equal(p.calls[1].method, "zcash_getAccounts");
});

test("sendPayment: popup ko EXACT {to, amount} hi jaata hai; galat input wallet tak jaata hi nahi", async () => {
  const p = mockProvider({ zcash_sendTransaction: () => "ab".repeat(32) });
  assert.equal(await noir.sendPayment(p, { to: PAY, amount: "0.001" }), "ab".repeat(32));
  assert.deepEqual(p.calls[0], { method: "zcash_sendTransaction", params: [{ to: PAY, amount: "0.001" }] });
  for (const bad of [
    { to: "garbage", amount: "0.001" }, { to: PAY, amount: "0" }, { to: PAY, amount: "-1" },
    { to: PAY, amount: "1e-3" }, { to: PAY, amount: "0.123456789" }, { to: PAY, amount: 0.001 }, { to: PAY, amount: "" },
  ]) await assert.rejects(noir.sendPayment(p, bad as any), Error, JSON.stringify(bad));
  assert.equal(p.calls.length, 1);
  const empty = mockProvider({ zcash_sendTransaction: () => "" });
  await assert.rejects(noir.sendPayment(empty, { to: PAY, amount: "0.001" }), /transaction id/);
});

test("fmtZec", () => {
  assert.equal(noir.fmtZec("100000"), "0.001");
  assert.equal(noir.fmtZec("100000000"), "1");
  assert.equal(noir.fmtZec(250000000n), "2.5");
  assert.equal(noir.fmtZec("1"), "0.00000001");
});

test("mintWithWallet: order -> popup (fixed amount) -> approve => txid; cancel nahi", async () => {
  const api = mockApi(orderFor());
  const p = mockProvider({ zcash_sendTransaction: () => "cd".repeat(32) });
  const msgs: string[] = [];
  const r = await noir.mintWithWallet({ provider: p, api, collection, quantity: 1, buyerAddress: TM, onStatus: (m: string) => msgs.push(m) });
  assert.equal(r.txid, "cd".repeat(32));
  assert.deepEqual(api.log.created, [{ collection: "real1", quantity: 1, buyerAddress: TM }]);
  assert.deepEqual(p.calls, [{ method: "zcash_sendTransaction", params: [{ to: PAY, amount: "0.001" }] }]);
  assert.deepEqual(api.log.cancelled, []);
  assert.ok(msgs.some((m) => /approve/.test(m)));
});

test("mintWithWallet: quantity 3 => amount price x 3; galat amount ka order => wallet bulaya hi nahi + cancel", async () => {
  const ok = mockApi(orderFor({ amountZats: "300000", amountZec: "0.003" }));
  const p = mockProvider({ zcash_sendTransaction: () => "ef".repeat(32) });
  await noir.mintWithWallet({ provider: p, api: ok, collection, quantity: 3, buyerAddress: TM });
  assert.deepEqual(p.calls[0].params, [{ to: PAY, amount: "0.003" }]);

  const bad = mockApi(orderFor({ amountZats: "999999", amountZec: "0.00999999" })); // server ne zyada amount bataya
  const p2 = mockProvider({ zcash_sendTransaction: () => "ef".repeat(32) });
  await assert.rejects(noir.mintWithWallet({ provider: p2, api: bad, collection, quantity: 1, buyerAddress: TM }), /alag amount/);
  assert.equal(p2.calls.length, 0);
  assert.deepEqual(bad.log.cancelled, ["o1"]);
});

test("mintWithWallet: user reject => order CANCEL (supply free) + error; pending popup bhi", async () => {
  const api = mockApi(orderFor());
  const rej = mockProvider({ zcash_sendTransaction: () => { throw Object.assign(new Error("User rejected"), { code: 4001 }); } });
  await assert.rejects(noir.mintWithWallet({ provider: rej, api, collection, quantity: 1, buyerAddress: TM }), (e: any) => noir.explainError(e).kind === "rejected");
  assert.deepEqual(api.log.cancelled, ["o1"]);

  const api2 = mockApi(orderFor());
  const pend = mockProvider({ zcash_sendTransaction: () => { throw Object.assign(new Error("pending"), { code: -32002 }); } });
  await assert.rejects(noir.mintWithWallet({ provider: pend, api: api2, collection, quantity: 1, buyerAddress: TM }), (e: any) => noir.explainError(e).kind === "pending");
  assert.deepEqual(api2.log.cancelled, ["o1"]);
});

test("mintWithWallet: order hi na bane (sold out etc.) => wallet bulaya nahi, cancel nahi", async () => {
  const api = mockApi(new Error("itna supply bacha nahi hai"));
  const p = mockProvider({ zcash_sendTransaction: () => "ab".repeat(32) });
  await assert.rejects(noir.mintWithWallet({ provider: p, api, collection, quantity: 1, buyerAddress: TM }), /supply/);
  assert.equal(p.calls.length, 0);
  assert.deepEqual(api.log.cancelled, []);
});
