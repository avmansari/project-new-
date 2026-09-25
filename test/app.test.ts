import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { createApp } from "../src/app/api.js";
import { runTick } from "../src/app/worker.js";
import { openDb, type Db } from "../src/db/index.js";
import { parseZec } from "../src/money.js";
import { createCollection } from "../src/services/collections.js";
import { freezeCollection } from "../src/services/moderation.js";
import { createOrder } from "../src/services/orders.js";
import { accountXpubFromMnemonic, deriveReceiveAddress } from "../src/zcash/address.js";
import type { ChainClient, ReceivedOutput } from "../src/chain/types.js";

const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const xpub = accountXpubFromMnemonic(M);
const buyer = (i: number) => deriveReceiveAddress(xpub, 1000 + i, "testnet");
const T = (n: string) => createHash("sha256").update(n).digest("hex");

const baseCfg = {
  network: "testnet" as const, walletXpub: xpub, orderTtlMinutes: 30, minConfirmations: 10,
  rateLimitPerMin: 1000, orderRatePerMin: 100, orderRatePerHour: 1000, marketplaceFeeBps: 250, verifiedVolumeZats: 2_000_000_000n, maxFileBytes: 10 * 1048576, maxSessionBytes: 200 * 1048576, adminSessionHours: 24, uploadRatePerMin: 6000,
  lateGraceHours: 168, minPayoutZats: 1_000_000n, minRefundNetZats: 10_000n, refundExpiryMargin: 100, refundStuckMinutes: 15,
};

class FakeChain implements ChainClient {
  outs = new Map<string, ReceivedOutput[]>();
  tip = 1000;
  tipFails = false;
  n = 0;
  /** Payment agle block (tip+1) mein mined, phir tip = us block + conf - 1. Order banne ke BAAD ki payment. */
  pay(addr: string, zec: string, conf = 10) {
    const l = this.outs.get(addr) ?? [];
    const h = this.tip + 1;
    this.tip = h + conf - 1;
    l.push({ txid: T("p" + ++this.n), vout: 0, amountZats: parseZec(zec), confirmations: conf, height: h });
    this.outs.set(addr, l);
  }
  /** Sabse naye output ko `conf` confirmations dilao */
  confirm(conf: number) {
    const top = Math.max(...[...this.outs.values()].flat().map((o) => o.height ?? 0));
    this.tip = top + conf - 1;
    for (const l of this.outs.values()) for (const o of l) o.confirmations = this.tip - (o.height ?? 0) + 1;
  }
  async getReceived(a: string) {
    return (this.outs.get(a) ?? []).map((o) => ({ ...o }));
  }
  async tipHeight() {
    if (this.tipFails) throw new Error("down");
    return this.tip;
  }
}

interface Ctx { base: string; db: Db; chain: FakeChain }
async function withApp(fn: (c: Ctx) => Promise<void>, over: Partial<typeof baseCfg> = {}) {
  const db = await openDb();
  await createCollection(db, { slug: "demo", name: "Demo", supply: 3, priceZats: parseZec("0.001"), maxPerWallet: 2 });
  const chain = new FakeChain();
  const app = createApp({ db, cfg: { ...baseCfg, ...over }, chain });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    await fn({ base, db, chain });
  } finally {
    await app.close();
    await db.close();
  }
}
const post = (base: string, path: string, body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
  fetch(base + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const order = (base: string, over: object = {}) =>
  post(base, "/api/orders", { collection: "demo", quantity: 1, buyerAddress: buyer(1), ...over });
/** raw request (URL normalise hue bina): path traversal test ke liye */
function raw(base: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const r = request({ host: u.hostname, port: u.port, path, method: "GET" }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject);
    r.end();
  });
}

test("health + config", async () => {
  await withApp(async ({ base }) => {
    assert.deepEqual(await (await fetch(base + "/api/health")).json(), { ok: true });
    const c = await (await fetch(base + "/api/config")).json();
    assert.equal(c.network, "testnet");
    assert.equal(c.minConfirmations, 10);
    assert.equal(Object.keys(c).includes("walletXpub"), false); // koi secret/internal nahi
  });
});

test("collections: sahi fields, available ginti (pending order supply rokta hai), draft/cancelled hidden", async () => {
  await withApp(async ({ base, db }) => {
    await createCollection(db, { slug: "hidden", name: "Hidden", supply: 1, priceZats: 1000n, maxPerWallet: 1, status: "draft" });
    let j = await (await fetch(base + "/api/collections")).json();
    assert.equal(j.collections.length, 1);
    assert.deepEqual(
      { s: j.collections[0].slug, sup: j.collections[0].supply, av: j.collections[0].available, z: j.collections[0].priceZec, m: j.collections[0].maxPerWallet },
      { s: "demo", sup: 3, av: 3, z: "0.001", m: 2 }
    );
    assert.equal(Object.keys(j.collections[0]).includes("creatorAddress"), false);
    assert.equal((await order(base, { quantity: 2 })).status, 201);
    j = await (await fetch(base + "/api/collections")).json();
    assert.equal(j.collections[0].available, 1);
    const one = await (await fetch(base + "/api/collections/demo")).json();
    assert.equal(one.collection.slug, "demo");
    assert.equal((await fetch(base + "/api/collections/nope")).status, 404);
    assert.equal((await fetch(base + "/api/collections/BAD SLUG!")).status, 400);
  });
});

test("POST /api/orders: 201, exact amount, unique payAddress, payment URI, koi internal field nahi", async () => {
  await withApp(async ({ base, db }) => {
    const r = await order(base, { quantity: 2 });
    assert.equal(r.status, 201);
    const { order: o } = await r.json();
    assert.equal(o.amountZats, "200000");
    assert.equal(o.amountZec, "0.002");
    assert.equal(o.paymentUri, `zcash:${o.payAddress}?amount=0.002`);
    assert.equal(o.stage, "awaiting_payment");
    assert.equal(o.buyerAddress, buyer(1));
    for (const k of ["addressIndex", "address_index", "xpub", "walletXpub", "collectionId"]) assert.equal(k in o, false);
    const o2 = (await (await order(base, { buyerAddress: buyer(2) })).json()).order;
    assert.notEqual(o2.payAddress, o.payAddress);
    const row = await db.query<{ start_height: number }>(`SELECT start_height FROM orders WHERE id = $1`, [o.id]);
    assert.equal(row.rows[0].start_height, 1000); // chain tip store hua
  });
});

test("POST /api/orders: kharab input pe 4xx, order nahi banta", async () => {
  await withApp(async ({ base, db }) => {
    const bad: [object, number, string][] = [
      [{ collection: "demo", quantity: 0, buyerAddress: buyer(1) }, 400, "BAD_QUANTITY"],
      [{ collection: "demo", quantity: 1.5, buyerAddress: buyer(1) }, 400, "BAD_QUANTITY"],
      [{ collection: "demo", quantity: "2", buyerAddress: buyer(1) }, 400, "BAD_QUANTITY"],
      [{ collection: "demo", quantity: 5000, buyerAddress: buyer(1) }, 400, "BAD_QUANTITY"],
      [{ collection: "demo", quantity: 1, buyerAddress: "garbage" }, 400, "BAD_ADDRESS"],
      [{ collection: "demo", quantity: 1, buyerAddress: deriveReceiveAddress(xpub, 1, "mainnet") }, 400, "BAD_ADDRESS"],
      [{ collection: "demo", quantity: 1, buyerAddress: "t".repeat(500) }, 400, "BAD_ADDRESS"],
      [{ collection: "DEMO!!", quantity: 1, buyerAddress: buyer(1) }, 400, "BAD_COLLECTION"],
      [{ quantity: 1, buyerAddress: buyer(1) }, 400, "BAD_COLLECTION"],
      [{ collection: "nope", quantity: 1, buyerAddress: buyer(1) }, 404, "COLLECTION_NOT_FOUND"],
    ];
    for (const [body, status, code] of bad) {
      const r = await post(base, "/api/orders", body);
      assert.equal(r.status, status, JSON.stringify(body));
      assert.equal((await r.json()).error.code, code);
    }
    assert.equal((await post(base, "/api/orders", "not json")).status, 400);
    assert.equal((await post(base, "/api/orders", "[1,2]")).status, 400);
    assert.equal((await post(base, "/api/orders", "{}", { "Content-Type": "text/plain" })).status, 415);
    const big = await post(base, "/api/orders", { collection: "demo", quantity: 1, buyerAddress: "x".repeat(10_000) });
    assert.equal(big.status, 413);
    const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders`);
    assert.equal(n.rows[0].n, 0);
  });
});

test("business rules: wallet limit, sold out, frozen => 409", async () => {
  await withApp(async ({ base, db }) => {
    assert.equal((await order(base, { quantity: 2 })).status, 201);
    const lim = await order(base, { quantity: 1 }); // wahi buyer, limit 2
    assert.equal(lim.status, 409);
    assert.equal((await lim.json()).error.code, "WALLET_LIMIT");
    assert.equal((await order(base, { buyerAddress: buyer(2), quantity: 1 })).status, 201); // total 3 = sold out
    const so = await order(base, { buyerAddress: buyer(3), quantity: 1 });
    assert.equal(so.status, 409);
    assert.equal((await so.json()).error.code, "SOLD_OUT");
    await createCollection(db, { slug: "fz", name: "Fz", supply: 5, priceZats: 1000n, maxPerWallet: 5 });
    await freezeCollection(db, "fz", "test");
    const fz = await post(base, "/api/orders", { collection: "fz", quantity: 1, buyerAddress: buyer(4) });
    assert.equal(fz.status, 409);
  });
});

test("chain server na mile => 503 aur order NAHI banta", async () => {
  await withApp(async ({ base, db, chain }) => {
    chain.tipFails = true;
    const r = await order(base);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, "CHAIN_UNAVAILABLE");
    const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders`);
    assert.equal(n.rows[0].n, 0);
  });
});

test("poora flow: order -> payment -> worker tick -> API mein minted + tokens; wallet endpoint", async () => {
  await withApp(async ({ base, chain, db }) => {
    const { order: o } = await (await order(base)).json();
    let s = (await (await fetch(`${base}/api/orders/${o.id}`)).json()).order;
    assert.equal(s.stage, "awaiting_payment");
    chain.pay(o.payAddress, "0.001", 3); // 3 conf, abhi kaafi nahi
    await runTick(db, chain, baseCfg);
    s = (await (await fetch(`${base}/api/orders/${o.id}`)).json()).order;
    assert.equal(s.stage, "payment_seen");
    chain.confirm(10);
    await runTick(db, chain, baseCfg);
    s = (await (await fetch(`${base}/api/orders/${o.id}`)).json()).order;
    assert.equal(s.stage, "done");
    assert.equal(s.status, "minted");
    assert.equal(s.tokens.length, 1);
    const w = await (await fetch(`${base}/api/wallet/${buyer(1)}`)).json();
    assert.equal(w.tokens.length, 1);
    assert.equal(w.tokens[0].collection, "demo");
    assert.equal(w.tokens[0].tokenNumber, s.tokens[0]);
    assert.equal((await (await fetch(`${base}/api/wallet/${buyer(2)}`)).json()).tokens.length, 0);
  });
});

test("overpay: minted + refund_due dikhta hai; order 404 / bad id", async () => {
  await withApp(async ({ base, chain, db }) => {
    const { order: o } = await (await order(base)).json();
    chain.pay(o.payAddress, "0.003", 10);
    await runTick(db, chain, baseCfg);
    const s = (await (await fetch(`${base}/api/orders/${o.id}`)).json()).order;
    assert.equal(s.stage, "done");
    assert.equal(s.refundDueZats, "200000");
    assert.equal((await fetch(`${base}/api/orders/00000000-0000-4000-8000-000000000000`)).status, 404);
    assert.equal((await fetch(`${base}/api/orders/not-a-uuid`)).status, 400);
    assert.equal((await fetch(`${base}/api/wallet/garbage`)).status, 400);
  });
});

test("expired order ka stage 'expired'", async () => {
  await withApp(async ({ base, db }) => {
    const past = new Date(Date.now() - 2 * 3600_000);
    const o = await createOrder(db, baseCfg, { collectionSlug: "demo", quantity: 1, buyerAddress: buyer(1), now: past });
    const s = (await (await fetch(`${base}/api/orders/${o.id}`)).json()).order;
    assert.equal(s.stage, "expired");
  });
});

test("RATE LIMIT: orders/min aur global/min => 429 + Retry-After", async () => {
  await withApp(
    async ({ base }) => {
      assert.equal((await order(base, { buyerAddress: buyer(1) })).status, 201);
      assert.equal((await order(base, { buyerAddress: buyer(2) })).status, 201);
      const r = await order(base, { buyerAddress: buyer(3) });
      assert.equal(r.status, 429);
      assert.ok(Number(r.headers.get("retry-after")) >= 1);
      assert.equal((await r.json()).error.code, "RATE_LIMITED");
    },
    { orderRatePerMin: 2 }
  );
  await withApp(
    async ({ base }) => {
      for (let i = 0; i < 3; i++) assert.equal((await fetch(base + "/api/health")).status, 200);
      assert.equal((await fetch(base + "/api/health")).status, 429);
    },
    { rateLimitPerMin: 3 }
  );
});

test("static pages + security headers (API par bhi); traversal band; allow-list", async () => {
  await withApp(async ({ base }) => {
    for (const p of ["/", "/index.html", "/mint.html", "/order.html", "/wallet.html", "/style.css", "/app.js"]) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get("content-security-policy") ?? "", /script-src 'self'/);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.equal(r.headers.get("x-frame-options"), "DENY");
    }
    assert.match(await (await fetch(base + "/")).text(), /Zcash NFT Launchpad/);
    const api = await fetch(base + "/api/health");
    assert.match(api.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal(api.headers.get("cache-control"), "no-store");
    for (const p of ["/../package.json", "/..%2fpackage.json", "/%2e%2e/package.json", "/../../etc/passwd", "/..\\package.json", "/app.js%00.png"]) {
      const r = await raw(base, p);
      assert.notEqual(r.status, 200, p);
      assert.equal(r.body.includes("zec-nft-marketplace"), false, p);
    }
    assert.equal((await fetch(base + "/proto/service.proto")).status, 404);
    assert.equal((await fetch(base + "/.env")).status, 404);
    assert.equal((await fetch(base + "/nope.html")).status, 404);
    assert.equal((await fetch(base + "/api/unknown")).status, 404);
    assert.equal((await fetch(base + "/api/orders", { method: "DELETE" })).status, 405);
    assert.equal((await fetch(base + "/", { method: "POST" })).status, 405);
  });
});

test("frontend guard: innerHTML/eval nahi, inline script/handler nahi, saari pages same script", () => {
  const js = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), false);
  assert.equal(/setAttribute\(\s*["']style["']/.test(js), false);
  const pages = readdirSync(new URL("../web/", import.meta.url)).filter((f) => f.endsWith(".html"));
  assert.ok(pages.length >= 4);
  for (const f of pages) {
    const html = readFileSync(new URL(`../web/${f}`, import.meta.url), "utf8");
    assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false, f + " mein inline script");
    assert.equal(/\son[a-z]+\s*=/i.test(html), false, f + " mein inline handler");
    assert.equal(/style\s*=/i.test(html), false, f + " mein inline style");
  }
});

test("XSS: collection ka naam <script> ho to API use plain string deti hai (page textContent se dikhata hai)", async () => {
  await withApp(async ({ base, db }) => {
    await createCollection(db, { slug: "xss", name: "<img src=x onerror=alert(1)>", supply: 1, priceZats: 1000n, maxPerWallet: 1 });
    const r = await fetch(base + "/api/collections");
    assert.match(r.headers.get("content-type") ?? "", /application\/json/);
    const j = await r.json();
    assert.equal(j.collections.find((c: any) => c.slug === "xss").name, "<img src=x onerror=alert(1)>");
  });
});

// ======================= cancel (wallet popup reject) =======================
const cancel = (base: string, id: string) => fetch(`${base}/api/orders/${id}/cancel`, { method: "POST" });

test("CANCEL: pending order turant expire, supply free, dobara cancel bhi theek; baad ki payment = refund, NFT nahi", async () => {
  await withApp(async ({ base, chain, db }) => {
    const { order: o } = await (await order(base, { quantity: 2 })).json();
    let cols = await (await fetch(base + "/api/collections")).json();
    assert.equal(cols.collections[0].available, 1);
    const r = await cancel(base, o.id);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).order.stage, "expired");
    cols = await (await fetch(base + "/api/collections")).json();
    assert.equal(cols.collections[0].available, 3); // supply wapas
    assert.equal((await cancel(base, o.id)).status, 200); // idempotent
    // koi baad mein bhej de to refund banta hai, NFT nahi
    chain.pay(o.payAddress, "0.002", 10);
    await runTick(db, chain, baseCfg);
    const s = (await (await fetch(`${base}/api/orders/${o.id}`)).json()).order;
    assert.equal(s.status, "refund_needed");
    assert.equal(s.tokens.length, 0);
  });
});

test("CANCEL nahi ho sakta: payment dikh chuki (funded) / minted; 404 / bad id", async () => {
  await withApp(async ({ base, chain, db }) => {
    const { order: a } = await (await order(base)).json();
    chain.pay(a.payAddress, "0.001", 3);
    await runTick(db, chain, baseCfg); // payment_seen
    const r = await cancel(base, a.id);
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error.code, "CANNOT_CANCEL");

    const { order: b } = await (await order(base, { buyerAddress: buyer(2) })).json();
    chain.pay(b.payAddress, "0.001", 10);
    await runTick(db, chain, baseCfg); // minted
    assert.equal((await cancel(base, b.id)).status, 409);

    assert.equal((await cancel(base, "00000000-0000-4000-8000-000000000000")).status, 404);
    assert.equal((await cancel(base, "bad-id")).status, 400);
  });
});

test("noir.js + wallet pages serve hote hain; app.js module hai", async () => {
  await withApp(async ({ base }) => {
    const j = await fetch(base + "/noir.js");
    assert.equal(j.status, 200);
    assert.match(j.headers.get("content-type") ?? "", /text\/javascript/);
    const html = await (await fetch(base + "/mint.html")).text();
    assert.match(html, /<script type="module" src="\/app\.js">/);
    assert.match(await (await fetch(base + "/app.js")).text(), /from "\/noir\.js"/);
  });
});

test("frontend guard: noir.js mein bhi innerHTML/eval nahi", () => {
  const js = readFileSync(new URL("../web/noir.js", import.meta.url), "utf8");
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), false);
});

test("frontend guard: admin.js mein bhi innerHTML/eval/inline-style-attr nahi", () => {
  const js = readFileSync(new URL("../web/admin.js", import.meta.url), "utf8");
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), false);
  assert.equal(/setAttribute\(\s*["']style["']/.test(js), false);
});

test("frontend guard: wallet-state.js mein bhi innerHTML/eval nahi", () => {
  const js = readFileSync(new URL("../web/wallet-state.js", import.meta.url), "utf8");
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), false);
});
