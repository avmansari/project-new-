import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app/api.js";
import { runTick } from "../src/app/worker.js";
import { openDb, type Db } from "../src/db/index.js";
import { formatZec, parseZec } from "../src/money.js";
import { createCollection } from "../src/services/collections.js";
import { blockToken, freezeCollection } from "../src/services/moderation.js";
import { setSetting } from "../src/services/settings.js";
import { createOrder } from "../src/services/orders.js";
import { mintPaidOrders } from "../src/services/mint.js";
import { sampleArt } from "../src/assets/sample.js";
import { bufEntry, importAssetsFromEntries } from "../src/services/assets.js";
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

interface Ctx { base: string; db: Db; chain: FakeChain; assetsRoot: string }
async function withApp(fn: (c: Ctx) => Promise<void>) {
  const db = await openDb();
  const chain = new FakeChain();
  const assetsRoot = mkdtempSync(join(tmpdir(), "mkt-"));
  const app = createApp({ db, cfg: baseCfg, chain, assetsDir: assetsRoot });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    await fn({ base, db, chain, assetsRoot });
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

test("marketplace HTTP: list -> GET listings -> buy -> pay -> tick -> token owner badla, listing gayab", async () => {
  await withApp(async ({ base, db, chain }) => {
    await createCollection(db, { slug: "art", name: "Art", supply: 5, priceZats: parseZec("1"), maxPerWallet: 5 });
    const owner = buyer(1);
    const token = await mintDirect(db, chain, "art", owner);

    let w0 = await (await get(base, `/api/wallet/${owner}`)).json();
    assert.equal(w0.tokens[0].priceZec, "1"); // abhi sirf mint price
    assert.equal(w0.tokens[0].priceSource, "mint");

    const lr = await post(base, "/api/marketplace/listings", { collection: "art", tokenNumber: token, sellerAddress: owner, priceZec: "2" });
    assert.equal(lr.status, 201);
    const { listing } = await lr.json();
    assert.equal(listing.priceZec, "2");
    w0 = await (await get(base, `/api/wallet/${owner}`)).json();
    assert.equal(w0.tokens[0].priceZec, "2"); // list hote hi listing price
    assert.equal(w0.tokens[0].priceSource, "listed");

    let g = await (await get(base, "/api/marketplace/listings?collection=art")).json();
    assert.equal(g.total, 1);
    assert.equal(g.items[0].tokenNumber, token);

    const buyerAddr = buyer(2);
    const br = await post(base, `/api/marketplace/listings/${listing.id}/buy`, { buyerAddress: buyerAddr });
    assert.equal(br.status, 201);
    const { order } = await br.json();
    chain.pay(order.payAddress, "2", 10);
    await runTick(db, chain, baseCfg);

    const own = await db.query<{ owner_address: string }>(`SELECT owner_address FROM tokens WHERE collection_id = 1 AND token_number = $1`, [token]);
    assert.equal(own.rows[0].owner_address, buyerAddr);
    g = await (await get(base, "/api/marketplace/listings?collection=art")).json();
    assert.equal(g.total, 0);
    const w = await (await get(base, `/api/wallet/${buyerAddr}`)).json();
    assert.equal(w.tokens[0].tokenNumber, token);
    assert.equal(w.tokens[0].priceZec, "2"); // naye owner ke liye aakhri resale price
    assert.equal(w.tokens[0].priceSource, "last_sale");
  });
});

test("marketplace HTTP: non-owner list/cancel => 403; blocked token => 409; galat listing id => 404/400", async () => {
  await withApp(async ({ base, db, chain }) => {
    await createCollection(db, { slug: "art", name: "Art", supply: 3, priceZats: parseZec("1"), maxPerWallet: 3 });
    const owner = buyer(1);
    const token = await mintDirect(db, chain, "art", owner);
    const notOwner = await post(base, "/api/marketplace/listings", { collection: "art", tokenNumber: token, sellerAddress: buyer(9), priceZec: "1" });
    assert.equal(notOwner.status, 403);

    const lr = await post(base, "/api/marketplace/listings", { collection: "art", tokenNumber: token, sellerAddress: owner, priceZec: "1" });
    const { listing } = await lr.json();
    const cancelBad = await post(base, `/api/marketplace/listings/${listing.id}/cancel`, { sellerAddress: buyer(9) });
    assert.equal(cancelBad.status, 403);
    const cancelOk = await post(base, `/api/marketplace/listings/${listing.id}/cancel`, { sellerAddress: owner });
    assert.equal(cancelOk.status, 200);

    await blockToken(db, "art", token, "stolen");
    const listBlocked = await post(base, "/api/marketplace/listings", { collection: "art", tokenNumber: token, sellerAddress: owner, priceZec: "1" });
    assert.equal(listBlocked.status, 409);
    assert.equal((await listBlocked.json()).error.code, "TOKEN_BLOCKED");

    assert.equal((await post(base, "/api/marketplace/listings/999999/buy", { buyerAddress: buyer(2) })).status, 404);
    assert.equal((await post(base, "/api/marketplace/listings/abc/buy", { buyerAddress: buyer(2) })).status, 400);
  });
});

test("marketplace HTTP: frozen collection => list nahi ho sakta", async () => {
  await withApp(async ({ base, db, chain }) => {
    await createCollection(db, { slug: "art", name: "Art", supply: 3, priceZats: parseZec("1"), maxPerWallet: 3 });
    const owner = buyer(1);
    const token = await mintDirect(db, chain, "art", owner);
    await freezeCollection(db, "art", "investigation");
    const r = await post(base, "/api/marketplace/listings", { collection: "art", tokenNumber: token, sellerAddress: owner, priceZec: "1" });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error.code, "COLLECTION_FROZEN");
  });
});

async function uploadSession(
  base: string,
  fields: { name: string; priceZec: string; maxPerWallet: string; payoutAddress: string; revealMode?: string },
  files: { name: string; data: Buffer; type: string }[]
): Promise<{ status: number; json: any }> {
  const s = await post(base, "/api/creator/sessions", fields);
  if (s.status !== 201) return { status: s.status, json: await s.json() };
  const { sessionId } = await s.json();
  for (const f of files) {
    const r = await fetch(`${base}/api/creator/sessions/${sessionId}/files?name=${encodeURIComponent(f.name)}`, {
      method: "POST", headers: { "Content-Type": f.type }, body: f.data as unknown as BodyInit,
    });
    if (r.status !== 200) return { status: r.status, json: await r.json() };
  }
  const fin = await fetch(`${base}/api/creator/sessions/${sessionId}/finalize`, { method: "POST" });
  return { status: fin.status, json: await fin.json() };
}

test("creator upload HTTP (session flow): poora 'folder' (images+cover+per-file json), file-by-file stream -> pending_review", async () => {
  await withApp(async ({ base }) => {
    const r = await uploadSession(
      base,
      { name: "My Upload Test", priceZec: "0.01", maxPerWallet: "3", payoutAddress: buyer(50) },
      [
        { name: "1.png", data: sampleArt(1, 8), type: "image/png" },
        { name: "2.png", data: sampleArt(2, 8), type: "image/png" },
        { name: "cover.png", data: sampleArt(9, 8), type: "image/png" },
        { name: "1.json", data: Buffer.from(JSON.stringify({ name: "First One" })), type: "application/json" },
      ]
    );
    assert.equal(r.status, 201);
    assert.equal(r.json.supply, 2); // cover ginti me nahi
    assert.equal(r.json.status, "pending_review");
    const list = await (await get(base, "/api/collections")).json();
    assert.equal(list.collections.find((c: any) => c.slug === r.json.slug), undefined);
    assert.equal((await get(base, `/api/collections/${r.json.slug}`)).status, 404);
  });
});

test("creator upload HTTP: collection PFP/banner persist separately, do not count as NFTs, and are served after approval", async () => {
  await withApp(async ({ base, db }) => {
    const profile = sampleArt(7, 8), banner = sampleArt(8, 8);
    const r = await uploadSession(
      base,
      { name: "Branding Upload Test", priceZec: "0.01", maxPerWallet: "3", payoutAddress: buyer(50) },
      [
        { name: "1.png", data: sampleArt(1, 8), type: "image/png" },
        { name: "__collection_profile__.png", data: profile, type: "image/png" },
        { name: "__collection_banner__.png", data: banner, type: "image/png" },
      ]
    );
    assert.equal(r.status, 201);
    assert.equal(r.json.supply, 1);
    assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM assets WHERE collection_id = (SELECT id FROM collections WHERE slug = $1)`, [r.json.slug])).rows[0].n, 1);
    await db.query(`UPDATE collections SET status = 'live' WHERE slug = $1`, [r.json.slug]);
    const { collection } = await (await get(base, `/api/collections/${r.json.slug}`)).json();
    assert.equal(collection.profileUrl, `/api/collections/${r.json.slug}/profile`);
    assert.equal(collection.bannerUrl, `/api/collections/${r.json.slug}/banner`);
    const fetchedProfile = await get(base, collection.profileUrl);
    const fetchedBanner = await get(base, collection.bannerUrl);
    assert.equal(fetchedProfile.headers.get("content-type"), "image/png");
    assert.equal(fetchedBanner.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await fetchedProfile.arrayBuffer()), profile);
    assert.deepEqual(Buffer.from(await fetchedBanner.arrayBuffer()), banner);
  });
});

test("creator upload HTTP (session flow): metadata.csv se naam/traits milte hain", async () => {
  await withApp(async ({ base }) => {
    const r = await uploadSession(
      base,
      { name: "CSV Upload Test", priceZec: "0.01", maxPerWallet: "3", payoutAddress: buyer(50) },
      [
        { name: "1.png", data: sampleArt(1, 8), type: "image/png" },
        { name: "2.png", data: sampleArt(2, 8), type: "image/png" },
        { name: "metadata.csv", data: Buffer.from("filename,name\n1.png,Fire Monkey #1\n2.png,Fire Monkey #2\n"), type: "text/csv" },
      ]
    );
    assert.equal(r.status, 201);
    assert.equal(r.json.csvMatched, 2);
  });
});

test("creator upload HTTP (session flow): allowed extension par bhi bytes kharab hon to finalize pe 400, koi collection nahi banti", async () => {
  await withApp(async ({ base, db }) => {
    const r = await uploadSession(base, { name: "Bad Bytes", priceZec: "0.01", maxPerWallet: "1", payoutAddress: buyer(50) }, [
      { name: "1.png", data: Buffer.from("<svg/>"), type: "image/png" }, // .png extension, par andar SVG text hai
    ]);
    assert.equal(r.status, 400);
    assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM collections`)).rows[0].n, 0);
  });
});

test("creator upload HTTP (session flow): galat extension (.svg) file-upload step pe hi reject; khaali session finalize => 404; ek file bahut badi => 413", async () => {
  await withApp(async ({ base, db }) => {
    const bad = await uploadSession(base, { name: "Bad Upload", priceZec: "0.01", maxPerWallet: "1", payoutAddress: buyer(50) }, [
      { name: "a.svg", data: Buffer.from("<svg/>"), type: "image/svg+xml" },
    ]);
    assert.equal(bad.status, 400);
    assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM collections`)).rows[0].n, 0);

    const s = await post(base, "/api/creator/sessions", { name: "Empty", priceZec: "0.01", maxPerWallet: "1", payoutAddress: buyer(50) });
    const { sessionId } = await s.json();
    const fin = await fetch(`${base}/api/creator/sessions/${sessionId}/finalize`, { method: "POST" });
    assert.equal(fin.status, 400); // "1 se 20000 images honi chahiye (mila: 0)"

    const oversized = await uploadSession(base, { name: "Huge File", priceZec: "0.01", maxPerWallet: "1", payoutAddress: buyer(50) }, [
      { name: "1.png", data: Buffer.alloc(baseCfg.maxFileBytes + 1), type: "image/png" },
    ]);
    assert.equal(oversized.status, 413);
  });
});

test("activity feed HTTP: mint aur sale dikhte hain, newest first", async () => {
  await withApp(async ({ base, db, chain }) => {
    await createCollection(db, { slug: "art", name: "Art", supply: 3, priceZats: parseZec("1"), maxPerWallet: 3 });
    const owner = buyer(1);
    const token = await mintDirect(db, chain, "art", owner);
    const lr = await post(base, "/api/marketplace/listings", { collection: "art", tokenNumber: token, sellerAddress: owner, priceZec: "1" });
    const { listing } = await lr.json();
    const br = await post(base, `/api/marketplace/listings/${listing.id}/buy`, { buyerAddress: buyer(2) });
    const { order } = await br.json();
    chain.pay(order.payAddress, "1", 10);
    await runTick(db, chain, baseCfg);
    const act = await (await get(base, "/api/activity?collection=art")).json();
    assert.deepEqual(act.items.map((x: any) => x.kind), ["sale", "list", "mint"]);
  });
});

test("search + trending: naam se milta hai, volume se sort hota hai", async () => {
  await withApp(async ({ base, db, chain }) => {
    await createCollection(db, { slug: "cheap", name: "Cheap Drop", supply: 5, priceZats: parseZec("0.1"), maxPerWallet: 5 });
    await createCollection(db, { slug: "costly", name: "Costly Drop", supply: 5, priceZats: parseZec("5"), maxPerWallet: 5 });
    await mintDirect(db, chain, "cheap", buyer(1));
    await mintDirect(db, chain, "costly", buyer(1));
    const s = await (await get(base, "/api/search?q=costly")).json();
    assert.equal(s.collections.length, 1);
    assert.equal(s.collections[0].slug, "costly");
    const t = await (await get(base, "/api/collections?sort=trending")).json();
    assert.equal(t.collections[0].slug, "costly"); // zyada volume pehle
  });
});

test("verified badge: threshold cross hote hi automatic true; override kaam karta hai", async () => {
  await withApp(async ({ base, db, chain }) => {
    await createCollection(db, { slug: "art", name: "Art", supply: 30, priceZats: parseZec("1"), maxPerWallet: 30 });
    for (let i = 0; i < 19; i++) await mintDirect(db, chain, "art", buyer(i));
    let c = (await (await get(base, "/api/collections")).json()).collections[0];
    assert.equal(c.verified, false); // 19 ZEC < 20
    await mintDirect(db, chain, "art", buyer(50));
    c = (await (await get(base, "/api/collections")).json()).collections[0];
    assert.equal(c.verified, true); // 20 ZEC >= threshold
    await db.query(`UPDATE collections SET verified_override = false`);
    c = (await (await get(base, "/api/collections")).json()).collections[0];
    assert.equal(c.verified, false); // override jeetta hai
  });
});

test("multi-currency: admin rate set na ho to null; set ho to convert hota hai", async () => {
  await withApp(async ({ base, db }) => {
    await createCollection(db, { slug: "art", name: "Art", supply: 1, priceZats: parseZec("1"), maxPerWallet: 1 });
    let c = (await (await get(base, "/api/collections")).json()).collections[0];
    assert.equal(c.priceUsd, null);
    await setSetting(db, "rate_usd", "45");
    c = (await (await get(base, "/api/collections")).json()).collections[0];
    assert.equal(c.priceUsd, "45.00");
  });
});

test("gallery trait filter aur rarity sort", async () => {
  await withApp(async ({ base, db, chain, assetsRoot }) => {
    await createCollection(db, { slug: "art", name: "Art", supply: 3, priceZats: parseZec("1"), maxPerWallet: 3 });
    await importAssetsFromEntries(db, {
      slug: "art", assetsRoot,
      entries: [
        bufEntry("1.png", sampleArt(1, 8)), bufEntry("2.png", sampleArt(2, 8)), bufEntry("3.png", sampleArt(3, 8)),
        bufEntry("1.json", Buffer.from(JSON.stringify({ attributes: [{ trait_type: "Bg", value: "Red" }] }))),
        bufEntry("2.json", Buffer.from(JSON.stringify({ attributes: [{ trait_type: "Bg", value: "Red" }] }))),
        bufEntry("3.json", Buffer.from(JSON.stringify({ attributes: [{ trait_type: "Bg", value: "Blue" }] }))),
      ],
    });
    for (let i = 0; i < 3; i++) await mintDirect(db, chain, "art", buyer(i));
    const blue = await (await get(base, "/api/collections/art/gallery?trait_type=Bg&value=Blue")).json();
    assert.equal(blue.total, 1);
    const rar = await (await get(base, "/api/collections/art/gallery?sort=rarity")).json();
    assert.equal(rar.items[0].tokenNumber, 3); // Blue rarest (1/3 vs 2/3)
    const t = await (await get(base, "/api/collections/art/tokens/3")).json();
    assert.equal(t.token.rarity.rank, 1);
  });
});

test("collections list: listingCount aur floor sahi milte hain (marketplace collection-browser ke liye)", async () => {
  await withApp(async ({ base, db, chain }) => {
    await createCollection(db, { slug: "art", name: "Art", supply: 5, priceZats: parseZec("1"), maxPerWallet: 5 });
    let c = (await (await get(base, "/api/collections")).json()).collections[0];
    assert.equal(c.listingCount, 0);
    assert.equal(c.floorZec, null);
    const owner = buyer(1);
    const t1 = await mintDirect(db, chain, "art", owner);
    const t2 = await mintDirect(db, chain, "art", owner);
    await post(base, "/api/marketplace/listings", { collection: "art", tokenNumber: t1, sellerAddress: owner, priceZec: "3" });
    await post(base, "/api/marketplace/listings", { collection: "art", tokenNumber: t2, sellerAddress: owner, priceZec: "1" });
    c = (await (await get(base, "/api/collections")).json()).collections[0];
    assert.equal(c.listingCount, 2);
    assert.equal(c.floorZec, "1"); // sabse sasti wali

    const forSale = await (await get(base, `/api/marketplace/listings?collection=art`)).json();
    assert.equal(forSale.total, 2);
  });
});

test("rate limit: session file uploads apne ALAG (bade) bucket me hain, general API limit se bahar", async () => {
  const db = await openDb();
  const assetsRoot = mkdtempSync(join(tmpdir(), "ratelimit-"));
  const app = createApp({ db, cfg: { ...baseCfg, rateLimitPerMin: 3, uploadRatePerMin: 50 }, chain: new FakeChain(), assetsDir: assetsRoot });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    const s = await post(base, "/api/creator/sessions", { name: "Rate Test", priceZec: "0.01", maxPerWallet: "1", payoutAddress: buyer(50) });
    const { sessionId } = await s.json();
    // general limit sirf 3/min hai, par 20 file-uploads sab pass hone chahiye (alag bucket)
    for (let i = 1; i <= 20; i++) {
      const r = await fetch(`${base}/api/creator/sessions/${sessionId}/files?name=${i}.png`, {
        method: "POST", headers: { "Content-Type": "image/png" }, body: sampleArt(i, 8) as unknown as BodyInit,
      });
      assert.equal(r.status, 200, `file ${i} rate-limited ho gayi (galat)`);
    }
    // lekin general API (jaise /api/collections) abhi bhi apni chhoti limit follow karti hai
    let sawLimited = false;
    for (let i = 0; i < 6; i++) {
      const r = await get(base, "/api/collections");
      if (r.status === 429) sawLimited = true;
    }
    assert.equal(sawLimited, true, "general API ka apna rate limit kaam karna chahiye");
  } finally {
    await app.close();
    await db.close();
  }
});

test("scheduled launch (session flow, real HTTP): launchAt se pehle mint 409 deta hai, collections list me startsAt dikhta hai", async () => {
  await withApp(async ({ base, db }) => {
    const future = new Date(Date.now() + 3600_000);
    const r = await uploadSession(
      base, { name: "Scheduled Test", priceZec: "0.01", maxPerWallet: "3", payoutAddress: buyer(50), revealMode: "instant" },
      [{ name: "1.png", data: Buffer.from(sampleArt(1, 8)), type: "image/png" }]
    );
    // launchAt uploadSession helper me nahi hai, seedha session create karke bhejte hain
    const s = await post(base, "/api/creator/sessions", { name: "Scheduled Test 2", priceZec: "0.01", maxPerWallet: "3", payoutAddress: buyer(50), launchAt: future.toISOString() });
    const { sessionId } = await s.json();
    await fetch(`${base}/api/creator/sessions/${sessionId}/files?name=1.png`, { method: "POST", headers: { "Content-Type": "image/png" }, body: Buffer.from(sampleArt(1, 8)) as unknown as BodyInit });
    const fin = await fetch(`${base}/api/creator/sessions/${sessionId}/finalize`, { method: "POST" });
    const j = await fin.json();
    await db.query(`UPDATE collections SET status = 'live' WHERE slug = $1`, [j.slug]); // seedha approve (test)

    const list = await (await get(base, "/api/collections")).json();
    const c = list.collections.find((x: any) => x.slug === j.slug);
    assert.equal(new Date(c.startsAt).getTime(), future.getTime());

    const orderTry = await post(base, "/api/orders", { collection: j.slug, quantity: 1, buyerAddress: buyer(1) });
    assert.equal(orderTry.status, 409);
    assert.equal((await orderTry.json()).error.code, "NOT_STARTED");
    void r;
  });
});
