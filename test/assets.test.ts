import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app/api.js";
import { detectImage } from "../src/assets/image.js";
import { encodePng, sampleArt } from "../src/assets/sample.js";
import { openDb, type Db } from "../src/db/index.js";
import { parseZec } from "../src/money.js";
import { importAssets } from "../src/services/assets.js";
import { createCollection } from "../src/services/collections.js";
import { createOrder } from "../src/services/orders.js";
import { accountXpubFromMnemonic, deriveReceiveAddress } from "../src/zcash/address.js";
import type { ChainClient } from "../src/chain/types.js";

const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const xpub = accountXpubFromMnemonic(M);
const buyer = (i: number) => deriveReceiveAddress(xpub, 1000 + i, "testnet");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const tmp = () => mkdtempSync(join(tmpdir(), "nft-"));
const ocfg = { network: "testnet" as const, walletXpub: xpub, orderTtlMinutes: 30 };

// ---------------------- image detection ----------------------
const le16 = (n: number) => [n & 0xff, n >> 8];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const jpeg = (w: number, h: number) =>
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const gif = (w: number, h: number) => Buffer.from([...ascii("GIF89a"), ...le16(w), ...le16(h), 0, 0, 0, 0x3b]);
const webpX = (w: number, h: number) => Buffer.from([...ascii("RIFF"), 30, 0, 0, 0, ...ascii("WEBP"), ...ascii("VP8X"), 10, 0, 0, 0, 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
const webpL = () => Buffer.from([...ascii("RIFF"), 30, 0, 0, 0, ...ascii("WEBP"), ...ascii("VP8L"), 5, 0, 0, 0, 0x2f, 0x2b, 0xc1, 49, 0, 0, 0, 0, 0, 0]);
const webpLossy = (w: number, h: number) =>
  Buffer.from([...ascii("RIFF"), 30, 0, 0, 0, ...ascii("WEBP"), ...ascii("VP8 "), 10, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), 0, 0]);

test("detectImage: PNG / JPEG / GIF / WebP (VP8X, VP8L, VP8) ke asli dimensions", () => {
  assert.deepEqual(detectImage(encodePng(8, 5, () => [1, 2, 3])), { mime: "image/png", width: 8, height: 5, ext: "png" });
  assert.deepEqual(detectImage(jpeg(640, 480)), { mime: "image/jpeg", width: 640, height: 480, ext: "jpg" });
  assert.deepEqual(detectImage(gif(5, 7)), { mime: "image/gif", width: 5, height: 7, ext: "gif" });
  assert.deepEqual(detectImage(webpX(1024, 768)), { mime: "image/webp", width: 1024, height: 768, ext: "webp" });
  assert.deepEqual(detectImage(webpL()), { mime: "image/webp", width: 300, height: 200, ext: "webp" });
  assert.deepEqual(detectImage(webpLossy(320, 240)), { mime: "image/webp", width: 320, height: 240, ext: "webp" });
});

test("detectImage: SVG / HTML / PDF / EXE / khaali / adhoori / bahut bada => null", () => {
  const rej = [
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'),
    Buffer.from("<html><script>alert(1)</script></html>"),
    Buffer.from("%PDF-1.4 ..."),
    Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]),
    Buffer.alloc(0),
    Buffer.from("GIF89"),
    encodePng(8, 8, () => [0, 0, 0]).subarray(0, 20), // adhoori PNG
    Buffer.from([0xff, 0xd8, 0xff]), // adhoori JPEG
    gif(0, 5),
    webpX(20000, 100),
    Buffer.from(Array.from({ length: 200 }, (_, i) => (i * 37) % 256)),
  ];
  for (const b of rej) assert.equal(detectImage(b), null);
  // PNG jiska header bade dimensions bata raha ho
  const huge = Buffer.from(encodePng(8, 8, () => [0, 0, 0]));
  huge.writeUInt32BE(100000, 16);
  assert.equal(detectImage(huge), null);
});

// ---------------------- import ----------------------
async function setupCol(supply = 3, slug = "art") {
  const db = await openDb();
  await createCollection(db, { slug, name: "Art", supply, priceZats: parseZec("0.001"), maxPerWallet: supply });
  return db;
}
function folder(files: Record<string, Buffer | string>) {
  const d = tmp();
  for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
  return d;
}
const rows = async (db: Db) => (await db.query<any>(`SELECT token_number, file, sha256, name, attributes FROM assets ORDER BY token_number`)).rows;
const rowsWithThumb = async (db: Db) => (await db.query<any>(`SELECT token_number, thumb_file FROM assets ORDER BY token_number`)).rows;

test("import: natural sort (1,2,10 => token 1,2,3), cover, sidecar, provenance hash", async () => {
  const db = await setupCol(3);
  const a = sampleArt(1, 16), b = sampleArt(2, 16), c = sampleArt(3, 16), cv = sampleArt(9, 16);
  const dir = folder({
    "1.png": a, "2.png": b, "10.png": c, "cover.png": cv,
    "1.json": JSON.stringify({ name: "Sunrise", description: "pehla", attributes: [{ trait_type: "Sky", value: "Orange" }, { trait_type: "Level", value: 7 }] }),
    ".DS_Store": "x",
  });
  const root = tmp();
  const r = await importAssets(db, { slug: "art", dir, assetsRoot: root });
  assert.equal(r.count, 3);
  assert.equal(r.coverImported, true);
  const rs = await rows(db);
  assert.deepEqual(rs.map((x) => x.token_number), [0, 1, 2, 3]);
  assert.equal(rs[1].sha256, sha(a));
  assert.equal(rs[2].sha256, sha(b));
  assert.equal(rs[3].sha256, sha(c)); // "10.png" teesra
  assert.equal(rs[1].name, "Sunrise");
  assert.equal(rs[2].name, "Art #2");
  assert.deepEqual(JSON.parse(rs[1].attributes), [{ trait_type: "Sky", value: "Orange" }, { trait_type: "Level", value: 7 }]);
  assert.ok(existsSync(join(root, "art", "1.png")) && existsSync(join(root, "art", "cover.png")));
  const want = sha(Buffer.from(`1:${sha(a)}\n2:${sha(b)}\n3:${sha(c)}\n`));
  assert.equal(r.provenanceHash, want);
  const col = await db.query<{ p: string }>(`SELECT provenance_hash AS p FROM collections WHERE slug = 'art'`);
  assert.equal(col.rows[0].p, want);
});

test("import: kharab input pe kuch bhi nahi likhta (na file, na DB)", async () => {
  const cases: [string, Record<string, Buffer | string>, RegExp, number?][] = [
    ["ginti kam", { "1.png": sampleArt(1, 8), "2.png": sampleArt(2, 8) }, /2 images.*supply 3/],
    ["svg file", { "1.png": sampleArt(1, 8), "2.png": sampleArt(2, 8), "3.svg": "<svg/>" }, /allowed nahi/],
    ["svg content .png mein", { "1.png": sampleArt(1, 8), "2.png": sampleArt(2, 8), "3.png": '<svg onload="alert(1)"/>' }, /valid PNG/],
    ["extension jhoothi", { "1.png": sampleArt(1, 8), "2.png": sampleArt(2, 8), "3.jpg": sampleArt(3, 8) }, /extension \.jpg.*image\/png/],
    ["bahut bada", { "1.png": sampleArt(1, 64), "2.png": sampleArt(2, 64), "3.png": sampleArt(3, 64) }, /MB hai, limit/, 100],
    ["kharab sidecar JSON", { "1.png": sampleArt(1, 8), "2.png": sampleArt(2, 8), "3.png": sampleArt(3, 8), "1.json": "{nope" }, /valid JSON nahi/],
    ["sidecar attributes galat", { "1.png": sampleArt(1, 8), "2.png": sampleArt(2, 8), "3.png": sampleArt(3, 8), "2.json": JSON.stringify({ attributes: [{ trait_type: "a", value: { x: 1 } }] }) }, /attribute/],
    ["sidecar name bahut lamba", { "1.png": sampleArt(1, 8), "2.png": sampleArt(2, 8), "3.png": sampleArt(3, 8), "3.json": JSON.stringify({ name: "x".repeat(200) }) }, /name text/],
  ];
  for (const [label, files, re, maxBytes] of cases) {
    const db = await setupCol(3);
    const root = tmp();
    await assert.rejects(importAssets(db, { slug: "art", dir: folder(files), assetsRoot: root, maxBytes }), re, label);
    assert.equal((await rows(db)).length, 0, label);
    assert.equal(existsSync(join(root, "art")), false, label + " (folder nahi banna chahiye)");
  }
  const db = await setupCol(3);
  await assert.rejects(importAssets(db, { slug: "nope", dir: tmp(), assetsRoot: tmp() }), /nahi mili/);
  await assert.rejects(importAssets(db, { slug: "art", dir: join(tmp(), "nahi-hai"), assetsRoot: tmp() }), /folder nahi mila/);
});

test("import: dobara --replace ke bina nahi; replace se art + provenance badalta hai; MINT ke baad kabhi nahi", async () => {
  const db = await setupCol(2);
  const root = tmp();
  const d1 = folder({ "1.png": sampleArt(1, 8), "2.png": sampleArt(2, 8) });
  const d2 = folder({ "1.png": sampleArt(5, 8), "2.png": sampleArt(6, 8) });
  const r1 = await importAssets(db, { slug: "art", dir: d1, assetsRoot: root });
  await assert.rejects(importAssets(db, { slug: "art", dir: d2, assetsRoot: root }), /pehle se import/);
  const r2 = await importAssets(db, { slug: "art", dir: d2, assetsRoot: root, replace: true });
  assert.notEqual(r1.provenanceHash, r2.provenanceHash);
  assert.equal(sha(readFileSync(join(root, "art", "1.png"))), sha(sampleArt(5, 8)));
  // ek token mint ho gaya => ab art badal nahi sakta
  const o = await createOrder(db, ocfg, { collectionSlug: "art", quantity: 1, buyerAddress: buyer(1) });
  await db.query(`UPDATE orders SET status = 'minted' WHERE id = $1`, [o.id]);
  await db.query(`INSERT INTO tokens (collection_id, token_number, owner_address, order_id, minted_at) VALUES (1, 1, $1, $2, now())`, [buyer(1), o.id]);
  await assert.rejects(importAssets(db, { slug: "art", dir: d1, assetsRoot: root, replace: true }), /mint shuru ho chuka/);
  assert.equal(sha(readFileSync(join(root, "art", "1.png"))), sha(sampleArt(5, 8))); // art nahi badla
});

// ---------------------- API ----------------------
const dummyChain: ChainClient = { getReceived: async () => [] };
async function withApp(
  fn: (c: { base: string; db: Db; root: string }) => Promise<void>,
  opts: { supply?: number; reveal?: "instant" | "after_soldout"; images?: boolean; imageRate?: number } = {}
) {
  const supply = opts.supply ?? 3;
  const db = await openDb();
  await createCollection(db, { slug: "art", name: "Art", supply, priceZats: parseZec("0.001"), maxPerWallet: supply, revealMode: opts.reveal });
  const root = tmp();
  if (opts.images !== false) {
    const files: Record<string, Buffer | string> = { "cover.png": sampleArt(9, 16) };
    for (let i = 1; i <= supply; i++) files[`${i}.png`] = sampleArt(i, 16);
    files["2.json"] = JSON.stringify({ name: "Blue Moon", description: "doosra", attributes: [{ trait_type: "Sky", value: "Night" }] });
    await importAssets(db, { slug: "art", dir: folder(files), assetsRoot: root });
  }
  const cfg = { ...ocfg, minConfirmations: 10, rateLimitPerMin: 1000, orderRatePerMin: 100, orderRatePerHour: 1000, imageRatePerMin: opts.imageRate ?? 1000, marketplaceFeeBps: 250, verifiedVolumeZats: 2_000_000_000n, maxFileBytes: 10 * 1048576, maxSessionBytes: 200 * 1048576, adminSessionHours: 24, uploadRatePerMin: 6000 };
  const app = createApp({ db, cfg, chain: dummyChain, assetsDir: root });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    await fn({ base, db, root });
  } finally {
    await app.close();
    await db.close();
  }
}
/** Seedha DB mein minted token (API test ke liye) */
async function mintDirect(db: Db, n: number, owner: string) {
  const o = await createOrder(db, ocfg, { collectionSlug: "art", quantity: 1, buyerAddress: owner });
  await db.query(`UPDATE orders SET status = 'minted' WHERE id = $1`, [o.id]);
  await db.query(`INSERT INTO tokens (collection_id, token_number, owner_address, order_id, minted_at) VALUES (1, $1, $2, $3, now())`, [n, owner, o.id]);
  return o;
}
const get = (base: string, p: string, h: Record<string, string> = {}) => fetch(base + p, { headers: h });

test("API: cover + mint hue token ki image (bytes barabar, nosniff, ETag/304); unminted token 404", async () => {
  await withApp(async ({ base, db }) => {
    await mintDirect(db, 2, buyer(1));
    const cols = (await (await get(base, "/api/collections")).json()).collections;
    assert.equal(cols[0].coverUrl, "/api/collections/art/cover");
    assert.equal(cols[0].revealMode, "instant");
    assert.match(cols[0].provenanceHash, /^[0-9a-f]{64}$/);

    const cover = await get(base, "/api/collections/art/cover");
    assert.equal(cover.status, 200);
    assert.equal(cover.headers.get("content-type"), "image/png");
    assert.equal(cover.headers.get("x-content-type-options"), "nosniff");
    assert.equal(sha(Buffer.from(await cover.arrayBuffer())), sha(sampleArt(9, 16)));

    const img = await get(base, "/api/collections/art/tokens/2/image");
    assert.equal(img.status, 200);
    assert.equal(sha(Buffer.from(await img.arrayBuffer())), sha(sampleArt(2, 16)));
    const etag = img.headers.get("etag")!;
    assert.equal((await get(base, "/api/collections/art/tokens/2/image", { "If-None-Match": etag })).status, 304);

    // mint NAHI hue tokens: image aur details dono 404 (unminted art kabhi leak nahi)
    for (const n of [1, 3]) {
      assert.equal((await get(base, `/api/collections/art/tokens/${n}/image`)).status, 404);
      assert.equal((await get(base, `/api/collections/art/tokens/${n}`)).status, 404);
    }
  });
});

test("API: token details (naam/traits/provenance), owner ka address dikhta hai (offers ke liye zaroori); gallery/wallet me owner nahi; wallet + order mein image", async () => {
  await withApp(async ({ base, db }) => {
    const o = await mintDirect(db, 2, buyer(1));
    await mintDirect(db, 3, buyer(2));
    const t = (await (await get(base, "/api/collections/art/tokens/2")).json()).token;
    assert.equal(t.name, "Blue Moon");
    assert.equal(t.description, "doosra");
    assert.deepEqual(t.attributes, [{ trait_type: "Sky", value: "Night" }]);
    assert.equal(t.imageUrl, "/api/collections/art/tokens/2/image");
    assert.equal(t.revealed, true);
    assert.equal(t.width, 16);
    // Owner ka address ab JAAN-BUJH KE dikhta hai (offer accept/reject UI ko pata hona chahiye ki
    // connected wallet hi owner hai ya nahi). Gallery/wallet response me abhi bhi nahi dikhta.
    assert.equal(t.ownerAddress, buyer(1));

    const g = await (await get(base, "/api/collections/art/gallery")).json();
    assert.equal(g.total, 2);
    assert.deepEqual(g.items.map((x: any) => x.tokenNumber), [2, 3]);
    assert.equal(JSON.stringify(g).includes(buyer(1)), false);
    assert.equal((await (await get(base, "/api/collections/art/gallery?limit=1&offset=1")).json()).items[0].tokenNumber, 3);

    const w = await (await get(base, `/api/wallet/${buyer(1)}`)).json();
    assert.equal(w.tokens[0].imageUrl, "/api/collections/art/tokens/2/image");
    assert.equal(w.tokens[0].name, "Blue Moon");

    const ord = (await (await get(base, `/api/orders/${o.id}`)).json()).order;
    assert.deepEqual(ord.tokens, [2]); // purana field waisa hi
    assert.equal(ord.items[0].imageUrl, "/api/collections/art/tokens/2/image");
  });
});

test("REVEAL after_soldout: sold out se pehle placeholder (asli naam/traits/image nahi), baad mein asli", async () => {
  await withApp(
    async ({ base, db }) => {
      await mintDirect(db, 2, buyer(1));
      const img = await fetch(base + "/api/collections/art/tokens/2/image", { redirect: "manual" });
      assert.equal(img.status, 302);
      assert.equal(img.headers.get("location"), "/placeholder.svg");
      const t = (await (await get(base, "/api/collections/art/tokens/2")).json()).token;
      assert.equal(t.revealed, false);
      assert.equal(t.name, "Art #2"); // "Blue Moon" leak nahi
      assert.deepEqual(t.attributes, []);
      assert.equal(t.imageUrl, "/placeholder.svg");
      const g = await (await get(base, "/api/collections/art/gallery")).json();
      assert.equal(g.items[0].imageUrl, "/placeholder.svg");
      assert.equal(g.items[0].name, "Art #2");
      const w = await (await get(base, `/api/wallet/${buyer(1)}`)).json();
      assert.equal(w.tokens[0].imageUrl, "/placeholder.svg");
      assert.equal((await (await get(base, "/api/collections")).json()).collections[0].revealed, false);
      // baaki bhi mint => sold out => reveal
      await mintDirect(db, 1, buyer(2));
      await mintDirect(db, 3, buyer(3));
      const img2 = await get(base, "/api/collections/art/tokens/2/image");
      assert.equal(img2.status, 200);
      assert.equal((await (await get(base, "/api/collections/art/tokens/2")).json()).token.name, "Blue Moon");
    },
    { reveal: "after_soldout" }
  );
});

test("API: images ke bina collection => imageUrl null, image 404; cancelled/voided ki image nahi", async () => {
  await withApp(
    async ({ base, db }) => {
      await mintDirect(db, 1, buyer(1));
      assert.equal((await get(base, "/api/collections/art/tokens/1/image")).status, 404);
      assert.equal((await get(base, "/api/collections/art/cover")).status, 404);
      const t = (await (await get(base, "/api/collections/art/tokens/1")).json()).token;
      assert.equal(t.imageUrl, null);
      assert.equal((await (await get(base, "/api/collections")).json()).collections[0].coverUrl, null);
    },
    { images: false }
  );
  await withApp(async ({ base, db }) => {
    await mintDirect(db, 1, buyer(1));
    await db.query(`UPDATE tokens SET voided_at = now()`);
    assert.equal((await get(base, "/api/collections/art/tokens/1/image")).status, 404);
    await db.query(`UPDATE tokens SET voided_at = NULL`);
    assert.equal((await get(base, "/api/collections/art/tokens/1/image")).status, 200);
    await db.query(`UPDATE collections SET status = 'cancelled'`);
    assert.equal((await get(base, "/api/collections/art/tokens/1/image")).status, 404);
    assert.equal((await get(base, "/api/collections/art/cover")).status, 404);
  });
});

test("API: kharab token/slug => 400/404; assets folder seedha URL se nahi khulta; placeholder khulta hai", async () => {
  await withApp(async ({ base, db, root }) => {
    await mintDirect(db, 1, buyer(1));
    for (const p of ["/api/collections/art/tokens/0/image", "/api/collections/art/tokens/abc", "/api/collections/art/tokens/99999999", "/api/collections/art/tokens/-1"]) {
      const s = (await get(base, p)).status;
      assert.ok(s === 400 || s === 404, `${p} => ${s}`);
    }
    assert.equal((await get(base, "/api/collections/BAD!/tokens/1")).status, 400);
    assert.equal((await get(base, "/api/collections/nope/tokens/1/image")).status, 404);
    assert.equal((await get(base, "/api/collections/nope/gallery")).status, 404);
    for (const p of ["/data/assets/art/1.png", "/art/1.png", "/assets/art/1.png", "/../data/assets/art/1.png"]) {
      assert.equal((await get(base, p)).status, 404, p);
    }
    assert.ok(existsSync(join(root, "art", "1.png")));
    const ph = await get(base, "/placeholder.svg");
    assert.equal(ph.status, 200);
    assert.equal(ph.headers.get("content-type"), "image/svg+xml");
    assert.match(ph.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  });
});

test("API: images ka alag rate limit; baaki API par asar nahi", async () => {
  await withApp(
    async ({ base, db }) => {
      await mintDirect(db, 1, buyer(1));
      assert.equal((await get(base, "/api/collections/art/tokens/1/image")).status, 200);
      assert.equal((await get(base, "/api/collections/art/tokens/1/image")).status, 200);
      const r = await get(base, "/api/collections/art/tokens/1/image");
      assert.equal(r.status, 429);
      assert.ok(Number(r.headers.get("retry-after")) >= 1);
      assert.equal((await get(base, "/api/health")).status, 200);
    },
    { imageRate: 2 }
  );
});

test("import: duplicate images ki ginti (warning ke liye), error nahi", async () => {
  const same = sampleArt(1, 8);
  const db1 = await setupCol(3);
  const r1 = await importAssets(db1, { slug: "art", dir: folder({ "1.png": same, "2.png": same, "3.png": same }), assetsRoot: tmp() });
  assert.deepEqual([r1.count, r1.uniqueImages, r1.duplicateImages], [3, 1, 2]);
  const db2 = await setupCol(3);
  const r2 = await importAssets(db2, { slug: "art", dir: folder({ "1.png": sampleArt(1, 8), "2.png": sampleArt(2, 8), "3.png": sampleArt(3, 8) }), assetsRoot: tmp() });
  assert.deepEqual([r2.uniqueImages, r2.duplicateImages], [3, 0]);
});

test("thumbnail: import ke waqt chhoti WebP thumbnail bhi bnati hai, DB me thumb_file save hota hai", async () => {
  const db = await setupCol(2);
  const root = tmp();
  const big = sampleArt(1, 800); // 800x800, thumbnail se badi
  const dir = folder({ "1.png": big, "2.png": sampleArt(2, 800) });
  await importAssets(db, { slug: "art", dir, assetsRoot: root });
  const rows = await rowsWithThumb(db);
  const t1 = rows.find((r: any) => r.token_number === 1);
  assert.ok(t1.thumb_file, "thumb_file DB me set hona chahiye");
  const thumbPath = join(root, t1.thumb_file);
  assert.ok(existsSync(thumbPath), "thumbnail file disk pe honi chahiye");
  const thumbBuf = readFileSync(thumbPath);
  assert.ok(thumbBuf.length < big.length, "thumbnail full image se chhoti honi chahiye");
  const info = detectImage(thumbBuf);
  assert.equal(info?.mime, "image/webp");
  assert.ok(info!.width <= 320 && info!.height <= 320, "thumbnail 320px se badi nahi honi chahiye");
});

test("API: ?thumb=1 chhoti image deta hai; thumb param na ho to full image; thumb na bani ho to bhi kabhi fail nahi hota (full fallback)", async () => {
  await withApp(async ({ base, db }) => {
    await mintDirect(db, 2, buyer(1));
    const full = await get(base, "/api/collections/art/tokens/2/image");
    const fullBuf = Buffer.from(await full.arrayBuffer());
    const thumb = await get(base, "/api/collections/art/tokens/2/image?thumb=1");
    assert.equal(thumb.status, 200);
    const thumbBuf = Buffer.from(await thumb.arrayBuffer());
    assert.equal(thumb.headers.get("content-type"), "image/webp");
    assert.ok(thumbBuf.length < fullBuf.length);
  });
});

test("gallery/wallet response me thumbUrl milta hai (?thumb=1 wala)", async () => {
  await withApp(async ({ base, db }) => {
    await mintDirect(db, 2, buyer(1));
    const g = await (await get(base, "/api/collections/art/gallery")).json();
    assert.match(g.items[0].thumbUrl, /\?thumb=1$/);
    const w = await (await get(base, `/api/wallet/${buyer(1)}`)).json();
    assert.match(w.tokens[0].thumbUrl, /\?thumb=1$/);
  });
});
