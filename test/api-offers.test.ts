import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app/api.js";
import { runTick } from "../src/app/worker.js";
import { openDb, type Db } from "../src/db/index.js";
import { formatZec, parseZec } from "../src/money.js";
import { createCollection } from "../src/services/collections.js";
import { createOrder } from "../src/services/orders.js";
import { mintPaidOrders } from "../src/services/mint.js";
import { accountXpubFromMnemonic, deriveReceiveAddress } from "../src/zcash/address.js";
import type { ChainClient, ReceivedOutput } from "../src/chain/types.js";

const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const xpub = accountXpubFromMnemonic(M);
const buyer = (i: number) => deriveReceiveAddress(xpub, 1000 + i, "testnet");
const ocfg = { network: "testnet" as const, walletXpub: xpub, orderTtlMinutes: 30 };
const baseCfg = {
  network: "testnet" as const, walletXpub: xpub, orderTtlMinutes: 30, minConfirmations: 10,
  rateLimitPerMin: 1000, orderRatePerMin: 1000, orderRatePerHour: 10000,
  marketplaceFeeBps: 250, verifiedVolumeZats: parseZec("20"), maxFileBytes: 10 * 1048576, maxSessionBytes: 50 * 1048576, adminSessionHours: 24, uploadRatePerMin: 6000,
  lateGraceHours: 168, minPayoutZats: 1_000_000n, minRefundNetZats: 10_000n, refundExpiryMargin: 100, refundStuckMinutes: 15,
};

class FakeChain implements ChainClient {
  outs = new Map<string, ReceivedOutput[]>();
  tip = 1000;
  n = 0;
  pay(addr: string, zec: string, conf = 10) {
    const l = this.outs.get(addr) ?? [];
    const h = this.tip + 1;
    this.tip = h + conf - 1;
    l.push({ txid: `p${++this.n}`.padStart(64, "0"), vout: 0, amountZats: parseZec(zec), confirmations: conf, height: h });
    this.outs.set(addr, l);
  }
  async getReceived(a: string) {
    return (this.outs.get(a) ?? []).map((o) => ({ ...o }));
  }
  async tipHeight() {
    return this.tip;
  }
}

interface Ctx { base: string; db: Db; chain: FakeChain }
async function withApp(fn: (c: Ctx) => Promise<void>) {
  const db = await openDb();
  const chain = new FakeChain();
  const app = createApp({ db, cfg: baseCfg, chain });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    await fn({ base, db, chain });
  } finally {
    await app.close();
    await db.close();
  }
}
const post = (base: string, path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = (base: string, path: string) => fetch(base + path);

async function mintDirect(db: Db, chain: FakeChain, slug: string, owner: string): Promise<number> {
  const o = await createOrder(db, ocfg, { collectionSlug: slug, quantity: 1, buyerAddress: owner });
  chain.pay(o.payAddress, formatZec(o.amountZats), 10);
  await runTick(db, chain, baseCfg);
  const t = await db.query<{ token_number: number }>(`SELECT token_number FROM tokens WHERE order_id = $1`, [o.id]);
  return t.rows[0].token_number;
}

test("offers HTTP: create -> pay -> tick(activate) -> owner accept -> ownership badalti hai", async () => {
  await withApp(async ({ base, db, chain }) => {
    await createCollection(db, { slug: "art", name: "Art", supply: 3, priceZats: parseZec("1"), maxPerWallet: 3 });
    const owner = buyer(1);
    const token = await mintDirect(db, chain, "art", owner);

    const buyerAddr = buyer(2);
    const or = await post(base, "/api/offers", { collection: "art", tokenNumber: token, buyerAddress: buyerAddr, priceZec: "0.5" });
    assert.equal(or.status, 201);
    const oj = await or.json();
    assert.equal(oj.offer.status, "awaiting_payment");
    chain.pay(oj.payAddress, "0.5", 10);
    await runTick(db, chain, baseCfg); // activate hona chahiye

    let list = await (await get(base, `/api/collections/art/tokens/${token}/offers`)).json();
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].status, "active");
    assert.equal(list.items[0].buyerAddress, buyerAddr);

    const t1 = await (await get(base, `/api/collections/art/tokens/${token}`)).json();
    assert.equal(t1.token.ownerAddress, owner);
    assert.equal(t1.token.offers.length, 1);

    const acc = await post(base, `/api/offers/${oj.offer.id}/accept`, { address: owner });
    assert.equal(acc.status, 200);
    const t2 = await (await get(base, `/api/collections/art/tokens/${token}`)).json();
    assert.equal(t2.token.ownerAddress, buyerAddr);

    const w = await (await get(base, `/api/wallet/${buyerAddr}`)).json();
    assert.equal(w.tokens[0].tokenNumber, token);
  });
});

test("offers HTTP: non-owner accept => 403; galat offer id => 404/400; reject => refund_needed", async () => {
  await withApp(async ({ base, db, chain }) => {
    await createCollection(db, { slug: "art", name: "Art", supply: 3, priceZats: parseZec("1"), maxPerWallet: 3 });
    const owner = buyer(1);
    const token = await mintDirect(db, chain, "art", owner);
    const buyerAddr = buyer(2);
    const or = await post(base, "/api/offers", { collection: "art", tokenNumber: token, buyerAddress: buyerAddr, priceZec: "0.5" });
    const oj = await or.json();
    chain.pay(oj.payAddress, "0.5", 10);
    await runTick(db, chain, baseCfg);

    const badAccept = await post(base, `/api/offers/${oj.offer.id}/accept`, { address: buyer(9) });
    assert.equal(badAccept.status, 403);

    assert.equal((await post(base, "/api/offers/999999/accept", { address: owner })).status, 404);
    assert.equal((await post(base, "/api/offers/abc/accept", { address: owner })).status, 400);

    const rej = await post(base, `/api/offers/${oj.offer.id}/reject`, { address: owner });
    assert.equal(rej.status, 200);
    const o = await db.query<{ status: string; refund_due: string }>(`SELECT status, refund_due_zats::text AS refund_due FROM orders WHERE id = (SELECT order_id FROM offers WHERE id = $1)`, [oj.offer.id]);
    assert.equal(o.rows[0].status, "refund_needed");
    assert.equal(o.rows[0].refund_due, parseZec("0.5").toString());
  });
});

test("offers HTTP: buyer cancel; non-buyer cancel => 403", async () => {
  await withApp(async ({ base, db, chain }) => {
    await createCollection(db, { slug: "art", name: "Art", supply: 3, priceZats: parseZec("1"), maxPerWallet: 3 });
    const owner = buyer(1);
    const token = await mintDirect(db, chain, "art", owner);
    const buyerAddr = buyer(2);
    const or = await post(base, "/api/offers", { collection: "art", tokenNumber: token, buyerAddress: buyerAddr, priceZec: "0.5" });
    const oj = await or.json();
    chain.pay(oj.payAddress, "0.5", 10);
    await runTick(db, chain, baseCfg);

    assert.equal((await post(base, `/api/offers/${oj.offer.id}/cancel`, { address: buyer(9) })).status, 403);
    const cancel = await post(base, `/api/offers/${oj.offer.id}/cancel`, { address: buyerAddr });
    assert.equal(cancel.status, 200);
    const list = await (await get(base, `/api/collections/art/tokens/${token}/offers`)).json();
    assert.equal(list.items.length, 0);
  });
});

test("offers HTTP: validation (galat price/token/collection) => 400/404", async () => {
  await withApp(async ({ base, db, chain }) => {
    await createCollection(db, { slug: "art", name: "Art", supply: 3, priceZats: parseZec("1"), maxPerWallet: 3 });
    const token = await mintDirect(db, chain, "art", buyer(1));
    assert.equal((await post(base, "/api/offers", { collection: "art", tokenNumber: token, buyerAddress: buyer(2), priceZec: "0" })).status, 400);
    assert.equal((await post(base, "/api/offers", { collection: "art", tokenNumber: 999, buyerAddress: buyer(2), priceZec: "1" })).status, 409);
    assert.equal((await post(base, "/api/offers", { collection: "nope", tokenNumber: token, buyerAddress: buyer(2), priceZec: "1" })).status, 404);
    assert.equal((await post(base, "/api/offers", { collection: "art", tokenNumber: token, buyerAddress: buyer(2), priceZec: "1" })).status, 201);
  });
});
