import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.js";
import { parseZec } from "../src/money.js";
import { getCollectionBySlug } from "../src/services/collections.js";
import { approveSubmission, listPendingReview, rejectSubmission, setCollectionMedia, SubmissionError, submitCollection } from "../src/services/creator-submit.js";
import { bufEntry } from "../src/services/assets.js";
import { sampleArt } from "../src/assets/sample.js";
import { accountXpubFromMnemonic, deriveReceiveAddress } from "../src/zcash/address.js";

const xpub = accountXpubFromMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
const payout = deriveReceiveAddress(xpub, 3000, "testnet");
const tmp = () => mkdtempSync(join(tmpdir(), "sub-"));
const img = (name: string, i: number) => bufEntry(name, sampleArt(i, 8));
const json = (name: string, obj: unknown) => bufEntry(name, Buffer.from(JSON.stringify(obj)));
const csv = (name: string, text: string) => bufEntry(name, Buffer.from(text));

const base = { network: "testnet" as const, maxPerWallet: 2, priceZats: parseZec("0.001"), payoutAddress: payout, feeBps: 100, holdHours: 72, revealMode: "instant" as const, maxTotalBytes: 100 * 1048576 };

test("submitCollection: folder-jaisa upload (1.png,2.png,3.png) -> 'pending_review', supply = image count", async () => {
  const db = await openDb();
  const r = await submitCollection(db, { ...base, name: "Cool Cats!", entries: [img("1.png", 1), img("2.png", 2), img("3.png", 3)], assetsRoot: tmp() });
  assert.equal(r.supply, 3);
  assert.match(r.slug, /^cool-cats/);
  const c = await getCollectionBySlug(db, r.slug);
  assert.equal(c!.status, "pending_review");
  assert.equal(c!.supply, 3);
  assert.equal(c!.creatorAddress, payout);
  const pend = await listPendingReview(db);
  assert.equal(pend.length, 1);
  assert.equal(pend[0].slug, r.slug);
});

test("PER-FILE metadata: <naam>.json sidecar file se hi milta hai, filename se koi lena-dena nahi", async () => {
  const db = await openDb();
  const r = await submitCollection(db, {
    ...base, name: "Sidecar Test", assetsRoot: tmp(),
    entries: [
      img("1.png", 1), img("2.png", 2),
      json("1.json", { name: "First One", attributes: [{ trait_type: "X", value: "A" }] }),
    ],
  });
  assert.equal(r.supply, 2);
  const a = await db.query<{ name: string; attributes: string }>(
    `SELECT name, attributes FROM assets WHERE token_number = 1 AND collection_id = (SELECT id FROM collections WHERE slug = $1)`,
    [r.slug]
  );
  assert.equal(a.rows[0].name, "First One");
  assert.deepEqual(JSON.parse(a.rows[0].attributes), [{ trait_type: "X", value: "A" }]);
  const b = await db.query<{ name: string }>(
    `SELECT name FROM assets WHERE token_number = 2 AND collection_id = (SELECT id FROM collections WHERE slug = $1)`,
    [r.slug]
  );
  assert.equal(b.rows[0].name, "Sidecar Test #2"); // koi sidecar nahi -> generic naam
});

test("CSV metadata (OpenSea-jaisi sheet): filename column se match, trait: columns se attributes", async () => {
  const db = await openDb();
  const sheet = csv(
    "metadata.csv",
    `filename,name,description,trait:Background,trait:Eyes\n1.png,Fire Monkey #1,First edition,Red,Laser\n2.png,Fire Monkey #2,,Blue,Normal\n`
  );
  const r = await submitCollection(db, { ...base, name: "CSV Test", assetsRoot: tmp(), entries: [img("1.png", 1), img("2.png", 2), sheet] });
  assert.equal(r.csvMatched, 2);
  assert.deepEqual(r.csvUnmatched, []);
  const a = await db.query<{ name: string; description: string; attributes: string }>(
    `SELECT name, description, attributes FROM assets WHERE token_number = 1 AND collection_id = (SELECT id FROM collections WHERE slug = $1)`,
    [r.slug]
  );
  assert.equal(a.rows[0].name, "Fire Monkey #1");
  assert.equal(a.rows[0].description, "First edition");
  assert.deepEqual(JSON.parse(a.rows[0].attributes), [{ trait_type: "Background", value: "Red" }, { trait_type: "Eyes", value: "Laser" }]);
  const b = await db.query<{ description: string }>(
    `SELECT description FROM assets WHERE token_number = 2 AND collection_id = (SELECT id FROM collections WHERE slug = $1)`,
    [r.slug]
  );
  assert.equal(b.rows[0].description, ""); // khaali cell -> khaali
});

test("CSV + apna sidecar JSON saath ho to JSON JEETTA hai (explicit hamesha priority)", async () => {
  const db = await openDb();
  const sheet = csv("metadata.csv", `filename,name\n1.png,From CSV\n`);
  const r = await submitCollection(db, {
    ...base, name: "Priority Test", assetsRoot: tmp(),
    entries: [img("1.png", 1), json("1.json", { name: "From Sidecar" }), sheet],
  });
  const a = await db.query<{ name: string }>(`SELECT name FROM assets WHERE token_number = 1 AND collection_id = (SELECT id FROM collections WHERE slug = $1)`, [r.slug]);
  assert.equal(a.rows[0].name, "From Sidecar");
});

test("CSV me galat filename (image match nahi) => csvUnmatched me dikhta hai, error nahi", async () => {
  const db = await openDb();
  const sheet = csv("metadata.csv", `filename,name\n1.png,Ok\n99.png,Ghost row\n`);
  const r = await submitCollection(db, { ...base, name: "Unmatched", assetsRoot: tmp(), entries: [img("1.png", 1), sheet] });
  assert.equal(r.csvMatched, 1);
  assert.deepEqual(r.csvUnmatched, ["99.png"]);
});

test("slug collision => alag suffix milta hai", async () => {
  const db = await openDb();
  const a = await submitCollection(db, { ...base, name: "Same Name", entries: [img("1.png", 1)], assetsRoot: tmp() });
  const b = await submitCollection(db, { ...base, name: "Same Name", entries: [img("1.png", 2)], assetsRoot: tmp() });
  assert.notEqual(a.slug, b.slug);
  assert.match(a.slug, /^same-name/);
  assert.match(b.slug, /^same-name/);
});

test("validation: galat payout address / price / maxPerWallet / naam khaali => koi collection nahi banti", async () => {
  const db = await openDb();
  const cases: [object, RegExp][] = [
    [{ ...base, payoutAddress: deriveReceiveAddress(xpub, 1, "mainnet") }, /valid t-address/],
    [{ ...base, priceZats: 0n }, /price/],
    [{ ...base, maxPerWallet: 0 }, /maxPerWallet/],
    [{ ...base, name: "" }, /naam/],
  ];
  for (const [over, re] of cases) {
    await assert.rejects(submitCollection(db, { ...base, ...over, name: (over as any).name ?? "Test", entries: [img("1.png", 1), img("2.png", 2)], assetsRoot: tmp() } as any), re);
  }
  const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM collections`);
  assert.equal(n.rows[0].n, 0);
});

test("kharab image (SVG jaisa) => poori submission reject, kuch nahi likhta", async () => {
  const db = await openDb();
  const root = tmp();
  await assert.rejects(
    submitCollection(db, { ...base, name: "Bad", entries: [img("1.png", 1), bufEntry("2.png", Buffer.from("<svg/>"))], assetsRoot: root }),
    /valid PNG/
  );
  assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM collections`)).rows[0].n, 0);
});

test("total upload size limit se zyada => reject", async () => {
  const db = await openDb();
  await assert.rejects(
    submitCollection(db, { ...base, name: "Big", entries: [img("1.png", 1), img("2.png", 2)], assetsRoot: tmp(), maxTotalBytes: 10 }),
    /MB hai, limit/
  );
});

test("cover image supported, provenance hash bina cover ke tokens se hi banta hai", async () => {
  const db = await openDb();
  const r = await submitCollection(db, { ...base, name: "Cover Test", entries: [img("1.png", 1), img("2.png", 2), img("cover.png", 9)], assetsRoot: tmp() });
  assert.equal(r.supply, 2); // cover ginti me nahi
  const c = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM assets WHERE collection_id = (SELECT id FROM collections WHERE slug = $1) AND token_number = 0`, [r.slug]);
  assert.equal(c.rows[0].n, 1);
});

test("2 se zyada cover images => reject", async () => {
  const db = await openDb();
  await assert.rejects(
    submitCollection(db, { ...base, name: "TwoCovers", entries: [img("1.png", 1), img("cover.png", 8), bufEntry("Cover.jpg", sampleArt(9, 8))], assetsRoot: tmp() }),
    /Sirf ek cover/
  );
});

test("duplicate file naam (subfolder se aayi ho to bhi basename collide) => reject", async () => {
  const db = await openDb();
  await assert.rejects(
    submitCollection(db, { ...base, name: "Dup", entries: [img("photos/1.png", 1), img("more/1.png", 2)], assetsRoot: tmp() }),
    /Duplicate file naam/
  );
});

test("subfolder path bhej diya to bhi sirf basename use hota hai (path traversal safe)", async () => {
  const db = await openDb();
  const r = await submitCollection(db, { ...base, name: "Path Safe", entries: [bufEntry("../../etc/1.png", sampleArt(1, 8)), img("2.png", 2)], assetsRoot: tmp() });
  assert.equal(r.supply, 2);
});

test("REVIEW: approve => live (public), reject => cancelled + reason; dobara review nahi ho sakta", async () => {
  const db = await openDb();
  const a = await submitCollection(db, { ...base, name: "Approve Me", entries: [img("1.png", 1)], assetsRoot: tmp() });
  await approveSubmission(db, a.slug);
  assert.equal((await getCollectionBySlug(db, a.slug))!.status, "live");
  await assert.rejects(approveSubmission(db, a.slug), /pending review me nahi/);

  const b = await submitCollection(db, { ...base, name: "Reject Me", entries: [img("1.png", 1)], assetsRoot: tmp() });
  await rejectSubmission(db, b.slug, "spam/duplicate art");
  assert.equal((await getCollectionBySlug(db, b.slug))!.status, "cancelled");
  const r = await db.query<{ reason: string }>(`SELECT reject_reason AS reason FROM collections WHERE slug = $1`, [b.slug]);
  assert.equal(r.rows[0].reason, "spam/duplicate art");
  await assert.rejects(rejectSubmission(db, b.slug, "x"), /pending review me nahi/);
  const pend = await listPendingReview(db);
  assert.equal(pend.length, 0);
});

test("MIGRATION SAFETY: 'pending_review' collection maujood ho to bhi migrate() dobara chalna crash NAHI karta", async () => {
  const db = await openDb();
  await submitCollection(db, { ...base, name: "Persisted Pending", entries: [img("1.png", 1)], assetsRoot: tmp() });
  const { migrate } = await import("../src/db/index.js");
  await assert.doesNotReject(migrate(db));
  await assert.doesNotReject(migrate(db));
  const pend = await listPendingReview(db);
  assert.equal(pend.length, 1);
});

test("launchAt: submit hote hi collection ka starts_at set ho jaata hai", async () => {
  const db = await openDb();
  const future = new Date(Date.now() + 86400_000);
  const r = await submitCollection(db, { ...base, name: "Scheduled Drop", entries: [img("1.png", 1)], assetsRoot: tmp(), launchAt: future });
  const c = await getCollectionBySlug(db, r.slug);
  assert.equal(c!.startsAt?.getTime(), future.getTime());
});

test("launchAt na diya ho to starts_at null rehta hai", async () => {
  const db = await openDb();
  const r = await submitCollection(db, { ...base, name: "No Schedule", entries: [img("1.png", 1)], assetsRoot: tmp() });
  const c = await getCollectionBySlug(db, r.slug);
  assert.equal(c!.startsAt, null);
});

test("launchAt: galat date => reject, koi collection nahi banti", async () => {
  const db = await openDb();
  await assert.rejects(
    submitCollection(db, { ...base, name: "Bad Date", entries: [img("1.png", 1)], assetsRoot: tmp(), launchAt: new Date("not-a-date") }),
    /valid date/
  );
  assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM collections`)).rows[0].n, 0);
});

test("setCollectionMedia: CLI-wali collection pe bhi banner lagta hai, dobara lagane pe replace hota hai; galat file reject", async () => {
  const db = await openDb();
  const root = tmp();
  const r = await submitCollection(db, { ...base, name: "No Banner", entries: [img("1.png", 1)], assetsRoot: root });
  const dir = tmp();
  writeFileSync(join(dir, "b1.png"), sampleArt(5, 8));
  writeFileSync(join(dir, "b2.png"), sampleArt(6, 8));
  writeFileSync(join(dir, "fake.png"), "not an image");
  const m1 = await setCollectionMedia(db, { slug: r.slug, kind: "banner", file: join(dir, "b1.png"), assetsRoot: root });
  assert.ok(existsSync(join(root, m1.file)));
  const m2 = await setCollectionMedia(db, { slug: r.slug, kind: "banner", file: join(dir, "b2.png"), assetsRoot: root });
  assert.notEqual(m1.file, m2.file);
  const rows = await db.query<{ file: string }>(`SELECT file FROM collection_media WHERE kind = 'banner'`);
  assert.deepEqual(rows.rows.map((x) => x.file), [m2.file]); // ek hi banner, naya wala
  await assert.rejects(setCollectionMedia(db, { slug: r.slug, kind: "banner", file: join(dir, "fake.png"), assetsRoot: root }), SubmissionError);
  await assert.rejects(setCollectionMedia(db, { slug: "nahi-hai", kind: "banner", file: join(dir, "b1.png"), assetsRoot: root }), SubmissionError);
  await db.close();
});
