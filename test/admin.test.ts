import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app/api.js";
import { openDb, type Db } from "../src/db/index.js";
import { parseZec } from "../src/money.js";
import { createCollection } from "../src/services/collections.js";
import { submitCollection } from "../src/services/creator-submit.js";
import { bufEntry } from "../src/services/assets.js";
import { hashPassword, verifyAdminPassword } from "../src/services/admin-auth.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleArt } from "../src/assets/sample.js";
import { accountXpubFromMnemonic, deriveReceiveAddress } from "../src/zcash/address.js";
import type { ChainClient } from "../src/chain/types.js";

const xpub = accountXpubFromMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
const payout = deriveReceiveAddress(xpub, 3000, "testnet");
const dummyChain: ChainClient = { getReceived: async () => [] };
const PASSWORD = "correct horse battery staple";
const HASH = hashPassword(PASSWORD);
const baseCfg = {
  network: "testnet" as const, walletXpub: xpub, orderTtlMinutes: 30, minConfirmations: 10,
  rateLimitPerMin: 1000, orderRatePerMin: 1000, orderRatePerHour: 10000,
  marketplaceFeeBps: 250, verifiedVolumeZats: parseZec("20"), maxFileBytes: 10 * 1048576, maxSessionBytes: 200 * 1048576,
  adminSessionHours: 24, uploadRatePerMin: 6000, adminPasswordHash: HASH as string | undefined,
};

interface Ctx { base: string; db: Db; assetsRoot: string }
async function withApp(fn: (c: Ctx) => Promise<void>, cfgOverride: Partial<typeof baseCfg> = {}) {
  const db = await openDb();
  const assetsRoot = mkdtempSync(join(tmpdir(), "admin-"));
  const app = createApp({ db, cfg: { ...baseCfg, ...cfgOverride }, chain: dummyChain, assetsDir: assetsRoot });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    await fn({ base, db, assetsRoot });
  } finally {
    await app.close();
    await db.close();
  }
}
function cookieFrom(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0];
}
const login = (base: string, password = PASSWORD) =>
  fetch(base + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
const withCookie = (cookie: string) => ({ headers: { Cookie: cookie } });

test("hashPassword/verifyAdminPassword: sahi password match, galat nahi; hash configured na ho to hamesha false", () => {
  assert.equal(verifyAdminPassword(PASSWORD, HASH), true);
  assert.equal(verifyAdminPassword("wrong", HASH), false);
  assert.equal(verifyAdminPassword(PASSWORD, undefined), false);
  assert.equal(verifyAdminPassword(PASSWORD, "not-a-hash"), false);
  assert.notEqual(HASH, PASSWORD);
});

test("login: galat password => 401; sahi password => 200 + cookie milta hai", async () => {
  await withApp(async ({ base }) => {
    const bad = await login(base, "wrong password");
    assert.equal(bad.status, 401);
    const ok = await login(base);
    assert.equal(ok.status, 200);
    assert.match(cookieFrom(ok), /^admin_session=/);
  });
});

test("bina cookie ke /api/admin/* => 401; sahi cookie se access milta hai", async () => {
  await withApp(async ({ base }) => {
    assert.equal((await fetch(base + "/api/admin/pending")).status, 401);
    const cookie = cookieFrom(await login(base));
    const r = await fetch(base + "/api/admin/pending", withCookie(cookie));
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).items, []);
  });
});

test("logout ke baad cookie invalid ho jaati hai", async () => {
  await withApp(async ({ base }) => {
    const cookie = cookieFrom(await login(base));
    assert.equal((await fetch(base + "/api/admin/pending", withCookie(cookie))).status, 200);
    await fetch(base + "/api/admin/logout", { method: "POST", ...withCookie(cookie) });
    assert.equal((await fetch(base + "/api/admin/pending", withCookie(cookie))).status, 401);
  });
});

test("galat/random cookie value => 401 (session forge nahi ho sakta)", async () => {
  await withApp(async ({ base }) => {
    const r = await fetch(base + "/api/admin/pending", { headers: { Cookie: "admin_session=" + "a".repeat(64) } });
    assert.equal(r.status, 401);
  });
});

test("ADMIN_PASSWORD_HASH configure na ho to login hamesha fail (dashboard band)", async () => {
  await withApp(
    async ({ base }) => {
      const r = await login(base);
      assert.equal(r.status, 401);
    },
    { adminPasswordHash: undefined }
  );
});

test("pending list + approve: collection LIVE ho jaati hai, public list me dikhne lagti hai", async () => {
  await withApp(async ({ base, db }) => {
    const s = await submitCollection(db, {
      network: "testnet", assetsRoot: "/tmp", name: "Review Me", maxPerWallet: 2, priceZats: parseZec("0.01"),
      payoutAddress: payout, feeBps: 100, holdHours: 72, revealMode: "instant",
      entries: [bufEntry("1.png", sampleArt(1, 8)), bufEntry("2.png", sampleArt(2, 8))], maxTotalBytes: 1e9,
    });
    const cookie = cookieFrom(await login(base));
    const pend = await (await fetch(base + "/api/admin/pending", withCookie(cookie))).json();
    assert.equal(pend.items.length, 1);
    assert.equal(pend.items[0].slug, s.slug);
    assert.equal(pend.items[0].supply, 2);

    const approve = await fetch(base + "/api/admin/approve", { method: "POST", ...withCookie(cookie), headers: { ...withCookie(cookie).headers, "Content-Type": "application/json" }, body: JSON.stringify({ slug: s.slug }) });
    assert.equal(approve.status, 200);
    const pub = await (await fetch(base + "/api/collections")).json();
    assert.ok(pub.collections.some((c: any) => c.slug === s.slug));
  });
});

test("reject: collection cancelled ho jaati hai, reason save hota hai, public me kabhi nahi dikhti", async () => {
  await withApp(async ({ base, db }) => {
    const s = await submitCollection(db, {
      network: "testnet", assetsRoot: "/tmp", name: "Reject Me", maxPerWallet: 2, priceZats: parseZec("0.01"),
      payoutAddress: payout, feeBps: 100, holdHours: 72, revealMode: "instant",
      entries: [bufEntry("1.png", sampleArt(1, 8))], maxTotalBytes: 1e9,
    });
    const cookie = cookieFrom(await login(base));
    const r = await fetch(base + "/api/admin/reject", { method: "POST", headers: { ...withCookie(cookie).headers, "Content-Type": "application/json" }, body: JSON.stringify({ slug: s.slug, reason: "low quality art" }) });
    assert.equal(r.status, 200);
    const row = await db.query<{ status: string; reason: string }>(`SELECT status, reject_reason AS reason FROM collections WHERE slug = $1`, [s.slug]);
    assert.equal(row.rows[0].status, "cancelled");
    assert.equal(row.rows[0].reason, "low quality art");
    assert.equal((await fetch(base + "/api/collections/" + s.slug)).status, 404);
  });
});

test("reject bina reason ke => 400", async () => {
  await withApp(async ({ base, db }) => {
    const s = await submitCollection(db, {
      network: "testnet", assetsRoot: "/tmp", name: "No Reason", maxPerWallet: 2, priceZats: parseZec("0.01"),
      payoutAddress: payout, feeBps: 100, holdHours: 72, revealMode: "instant",
      entries: [bufEntry("1.png", sampleArt(1, 8))], maxTotalBytes: 1e9,
    });
    const cookie = cookieFrom(await login(base));
    const r = await fetch(base + "/api/admin/reject", { method: "POST", headers: { ...withCookie(cookie).headers, "Content-Type": "application/json" }, body: JSON.stringify({ slug: s.slug }) });
    assert.equal(r.status, 400);
  });
});

test("freeze/unfreeze via admin route", async () => {
  await withApp(async ({ base, db }) => {
    await createCollection(db, { slug: "live1", name: "Live One", supply: 3, priceZats: parseZec("1"), maxPerWallet: 3 });
    const cookie = cookieFrom(await login(base));
    const freeze = await fetch(base + "/api/admin/freeze", { method: "POST", headers: { ...withCookie(cookie).headers, "Content-Type": "application/json" }, body: JSON.stringify({ slug: "live1", reason: "investigating" }) });
    assert.equal(freeze.status, 200);
    let list = await (await fetch(base + "/api/admin/collections", withCookie(cookie))).json();
    assert.equal(list.items[0].frozen, true);
    const unfreeze = await fetch(base + "/api/admin/unfreeze", { method: "POST", headers: { ...withCookie(cookie).headers, "Content-Type": "application/json" }, body: JSON.stringify({ slug: "live1" }) });
    assert.equal(unfreeze.status, 200);
    list = await (await fetch(base + "/api/admin/collections", withCookie(cookie))).json();
    assert.equal(list.items[0].frozen, false);
  });
});

test("admin preview: pending collection ki images admin ko dikhti hain (public 404 rehta hai)", async () => {
  await withApp(async ({ base, db, assetsRoot }) => {
    const s = await submitCollection(db, {
      network: "testnet", assetsRoot, name: "Preview Test", maxPerWallet: 2, priceZats: parseZec("0.01"),
      payoutAddress: payout, feeBps: 100, holdHours: 72, revealMode: "instant",
      entries: [bufEntry("1.png", sampleArt(1, 8)), bufEntry("2.png", sampleArt(2, 8))], maxTotalBytes: 1e9,
    });
    void db;
    assert.equal((await fetch(base + `/api/collections/${s.slug}/tokens/1/image`)).status, 404); // public: nahi
    const cookie = cookieFrom(await login(base));
    const preview = await (await fetch(base + `/api/admin/collections/${s.slug}/preview`, withCookie(cookie))).json();
    assert.deepEqual(preview.tokenNumbers.sort(), [1, 2]);
    const img = await fetch(base + `/api/admin/collections/${s.slug}/image?n=1`, withCookie(cookie));
    assert.equal(img.status, 200); // admin: haan
  });
});

test("admin/all: har status (pending, live, rejected) ek saath dikhta hai, draft nahi", async () => {
  await withApp(async ({ base, db, assetsRoot }) => {
    const a = await submitCollection(db, {
      network: "testnet", assetsRoot, name: "Pending One", maxPerWallet: 2, priceZats: parseZec("0.01"),
      payoutAddress: payout, feeBps: 100, holdHours: 72, revealMode: "instant",
      entries: [bufEntry("1.png", sampleArt(1, 8))], maxTotalBytes: 1e9,
    });
    const b = await submitCollection(db, {
      network: "testnet", assetsRoot, name: "Live One", maxPerWallet: 2, priceZats: parseZec("0.01"),
      payoutAddress: payout, feeBps: 100, holdHours: 72, revealMode: "instant",
      entries: [bufEntry("1.png", sampleArt(2, 8))], maxTotalBytes: 1e9,
    });
    const c = await submitCollection(db, {
      network: "testnet", assetsRoot, name: "Rejected One", maxPerWallet: 2, priceZats: parseZec("0.01"),
      payoutAddress: payout, feeBps: 100, holdHours: 72, revealMode: "instant",
      entries: [bufEntry("1.png", sampleArt(3, 8))], maxTotalBytes: 1e9,
    });
    const cookie = cookieFrom(await login(base));
    await fetch(base + "/api/admin/approve", { method: "POST", headers: { ...withCookie(cookie).headers, "Content-Type": "application/json" }, body: JSON.stringify({ slug: b.slug }) });
    await fetch(base + "/api/admin/reject", { method: "POST", headers: { ...withCookie(cookie).headers, "Content-Type": "application/json" }, body: JSON.stringify({ slug: c.slug, reason: "spam" }) });

    assert.equal((await fetch(base + "/api/admin/all")).status, 401); // login zaroori
    const r = await (await fetch(base + "/api/admin/all", withCookie(cookie))).json();
    const bySlug = Object.fromEntries(r.items.map((x: any) => [x.slug, x]));
    assert.equal(bySlug[a.slug].status, "pending_review");
    assert.equal(bySlug[b.slug].status, "live");
    assert.equal(bySlug[c.slug].status, "cancelled");
    assert.equal(bySlug[c.slug].rejectReason, "spam");
  });
});
