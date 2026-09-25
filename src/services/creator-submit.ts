import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { Network } from "../config.js";
import type { Db } from "../db/index.js";
import { csvToMetadataMap, parseCsv } from "../assets/csv.js";
import { detectImage } from "../assets/image.js";
import { bufEntry, importAssetsFromEntries, MAX_IMAGE_BYTES, type LazyEntry } from "./assets.js";
import { createCollection } from "./collections.js";
import { isAddressForNetwork } from "../zcash/address.js";

export class SubmissionError extends Error {}

const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i;
const MEDIA_FILE = /^__collection_(profile|banner)__\.(png|jpe?g|webp|gif)$/i;

function validateCollectionMedia(entry: LazyEntry, kind: "profile" | "banner") {
  if (entry.size > MAX_IMAGE_BYTES) throw new SubmissionError(`${kind} image 5 MB se chhoti honi chahiye`);
  const bytes = entry.read();
  const info = detectImage(bytes);
  if (!info) throw new SubmissionError(`${kind} image valid PNG/JPEG/WebP/GIF honi chahiye`);
  const ext = extname(entry.name).slice(1).toLowerCase().replace("jpeg", "jpg");
  if (ext !== info.ext) throw new SubmissionError(`${kind} image ka extension uske asli format se match nahi karta`);
  return { kind, bytes, mime: info.mime, width: info.width, height: info.height, ext: info.ext,
    sha256: createHash("sha256").update(bytes).digest("hex") };
}

export interface SubmitInput {
  network: Network;
  assetsRoot: string;
  name: string;
  maxPerWallet: number;
  priceZats: bigint;
  payoutAddress: string;
  feeBps: number;
  holdHours: number;
  revealMode: "instant" | "after_soldout";
  /** Scheduled launch (optional): isse pehle mint nahi ho sakta. null/undefined = turant chalu. */
  launchAt?: Date | null;
  description?: string;
  websiteUrl?: string | null;
  xUrl?: string | null;
  metadataJson?: string | null;
  /**
   * Poora folder jaisa hai waisa hi: images (1.png, 2.png...), optional cover.png,
   * optional per-image sidecar JSON (1.json, 2.json...), optional ek metadata.csv
   * (OpenSea-jaisi sheet: columns filename,name,description,trait:X,trait:Y...).
   * LAZY hai -- bade collections (session-upload, disk se) me bytes tabhi padhe jaate hain
   * jab zaroorat ho, isliye 10 GB ka collection bhi ek file jitni hi memory leta hai.
   */
  entries: LazyEntry[];
  maxTotalBytes: number;
}

export interface SubmitResult {
  slug: string;
  supply: number;
  provenanceHash: string;
  csvMatched: number;
  csvUnmatched: string[];
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "collection";
}

export async function submitCollection(db: Db, input: SubmitInput): Promise<SubmitResult> {
  if (!input.name.trim() || input.name.length > 100) throw new SubmissionError("Collection ka naam 1-100 characters ka hona chahiye");
  if (!isAddressForNetwork(input.payoutAddress, input.network)) throw new SubmissionError(`payout address ${input.network} ka valid t-address nahi hai`);
  if (!Number.isInteger(input.maxPerWallet) || input.maxPerWallet < 1) throw new SubmissionError("maxPerWallet >= 1 integer honi chahiye");
  if (input.priceZats <= 0n) throw new SubmissionError("price > 0 honi chahiye");
  if (input.launchAt && Number.isNaN(input.launchAt.getTime())) throw new SubmissionError("launchAt ek valid date/time honi chahiye");

  const clean = input.entries.map((e) => ({ ...e, name: basename(e.name).trim() }));
  const dup = clean.map((e) => e.name).filter((n, i, a) => a.indexOf(n) !== i);
  if (dup.length) throw new SubmissionError(`Duplicate file naam: ${[...new Set(dup)].join(", ")}`);

  const profileEntries = clean.filter((e) => MEDIA_FILE.test(e.name) && e.name.toLowerCase().startsWith("__collection_profile__"));
  const bannerEntries = clean.filter((e) => MEDIA_FILE.test(e.name) && e.name.toLowerCase().startsWith("__collection_banner__"));
  if (profileEntries.length > 1 || bannerEntries.length > 1) throw new SubmissionError("Collection profile aur banner ke liye ek-ek image hi chuno");
  const collectionMedia = [
    ...(profileEntries.length ? [validateCollectionMedia(profileEntries[0], "profile")] : []),
    ...(bannerEntries.length ? [validateCollectionMedia(bannerEntries[0], "banner")] : []),
  ];

  const csvFile = clean.find((e) => e.name.toLowerCase().endsWith(".csv"));
  const collectionMetaFile = clean.find((e) => e.name.toLowerCase() === "collection.json");
  const brandingFiles = new Set([...profileEntries, ...bannerEntries]);
  const withoutCsv = clean.filter((e) => e !== csvFile && e !== collectionMetaFile && !brandingFiles.has(e));
  let metadataJson = input.metadataJson ?? null;
  let description = input.description ?? "";
  let websiteUrl = input.websiteUrl ?? null;
  let xUrl = input.xUrl ?? null;
  if (collectionMetaFile) {
    if (collectionMetaFile.size > 256 * 1024) throw new SubmissionError("collection.json bahut badi hai (max 256 KB)");
    try {
      const meta = JSON.parse(collectionMetaFile.read().toString("utf8")) as Record<string, unknown>;
      metadataJson = JSON.stringify(meta).slice(0, 100000);
      if (!description && typeof meta.description === "string") description = meta.description;
      if (!websiteUrl && typeof meta.website === "string") websiteUrl = meta.website;
      if (!websiteUrl && typeof meta.external_url === "string") websiteUrl = meta.external_url;
      if (!xUrl && typeof meta.x === "string") xUrl = meta.x;
    } catch { throw new SubmissionError("collection.json valid JSON nahi hai"); }
  }
  const covers = withoutCsv.filter((e) => IMG_EXT.test(e.name) && basename(e.name, extname(e.name)).toLowerCase() === "cover");
  const images = withoutCsv.filter((e) => IMG_EXT.test(e.name) && !covers.includes(e));

  if (images.length < 1 || images.length > 20000) throw new SubmissionError(`1 se 20000 images honi chahiye (mila: ${images.length})`);
  if (covers.length > 1) throw new SubmissionError("Sirf ek cover image ho sakti hai");

  // Size sirf GINTI ki jaati hai (statSync se already pata hai), koi bytes nahi padhte -- isliye
  // ek 10 GB collection ke liye bhi ye check ek pal me ho jaata hai.
  const totalBytes = withoutCsv.reduce((a, e) => a + e.size, 0);
  if (totalBytes > input.maxTotalBytes) {
    throw new SubmissionError(`Total upload ${(totalBytes / 1048576).toFixed(0)} MB hai, limit ${(input.maxTotalBytes / 1048576).toFixed(0)} MB`);
  }
  // Har image ka byte-level format check ab importAssetsFromEntries ke Pass 1 me (lazy, ek-ek karke) hota hai.

  const existingJsonNames = new Set(withoutCsv.filter((e) => e.name.toLowerCase().endsWith(".json")).map((e) => e.name.replace(/\.json$/i, "").toLowerCase()));
  const synthesized: LazyEntry[] = [];
  let csvMatched = 0;
  const csvUnmatched: string[] = [];
  if (csvFile) {
    if (csvFile.size > 20 * 1024 * 1024) throw new SubmissionError("metadata.csv bahut badi hai (max 20 MB)");
    const rows = parseCsv(csvFile.read().toString("utf8"));
    const metaMap = csvToMetadataMap(rows);
    for (const img of images) {
      const base = basename(img.name, extname(img.name)).toLowerCase();
      if (existingJsonNames.has(base)) continue; // apna sidecar JSON jeetta hai
      const meta = metaMap.get(img.name.toLowerCase()) ?? metaMap.get(base);
      if (meta) {
        synthesized.push(bufEntry(`${base}.json`, Buffer.from(JSON.stringify(meta))));
        csvMatched++;
      }
    }
    const matchedKeys = new Set(images.map((i) => basename(i.name, extname(i.name)).toLowerCase()));
    for (const row of rows) {
      const key = (row.filename || row.file || row.image || row.token || "").trim();
      if (key && !matchedKeys.has(key.toLowerCase()) && !matchedKeys.has(key.replace(/\.[^.]+$/, "").toLowerCase())) csvUnmatched.push(key);
    }
  }

  const finalEntries: LazyEntry[] = [...withoutCsv.filter((e) => e.name.toLowerCase().endsWith(".json") || IMG_EXT.test(e.name)), ...synthesized];

  let slug = slugify(input.name);
  for (let i = 0; i < 20; i++) {
    const exists = await db.query(`SELECT 1 FROM collections WHERE slug = $1`, [slug]);
    if (!exists.rows[0]) break;
    slug = `${slugify(input.name)}-${randomBytes(2).toString("hex")}`;
  }

  await createCollection(db, {
    slug, name: input.name.trim(), supply: images.length, priceZats: input.priceZats, maxPerWallet: input.maxPerWallet,
    status: "pending_review", creatorAddress: input.payoutAddress, network: input.network,
    feeBps: input.feeBps, holdHours: input.holdHours, revealMode: input.revealMode, startsAt: input.launchAt ?? null,
    description, websiteUrl, xUrl, metadataJson,
  });
  await db.query(`UPDATE collections SET submitted_at = now() WHERE slug = $1`, [slug]);
  try {
    const r = await importAssetsFromEntries(db, { slug, entries: finalEntries, assetsRoot: input.assetsRoot, maxBytes: MAX_IMAGE_BYTES });
    if (collectionMedia.length) {
      const root = resolve(input.assetsRoot);
      const dir = resolve(root, slug);
      mkdirSync(dir, { recursive: true });
      await db.transaction(async (tx) => {
        for (const media of collectionMedia) {
          const file = `${slug}/${media.kind}-${media.sha256.slice(0, 16)}.${media.ext}`;
          writeFileSync(join(root, file), media.bytes);
          await tx.query(
            `INSERT INTO collection_media (collection_id, kind, file, mime, sha256, bytes, width, height)
             VALUES ((SELECT id FROM collections WHERE slug = $1), $2, $3, $4, $5, $6, $7, $8)`,
            [slug, media.kind, file, media.mime, media.sha256, media.bytes.length, media.width, media.height]
          );
        }
      });
    }
    return { slug, supply: r.count, provenanceHash: r.provenanceHash, csvMatched, csvUnmatched };
  } catch (e) {
    // Import fail hua (kharab image, size waghera) -- pending_review me koi adhoori/tooti collection
    // mat chhodo, poori tarah wapas le lo. Import ka error hi user-input error hai (400), server bug nahi.
    await db.query(`DELETE FROM collections WHERE slug = $1`, [slug]);
    throw new SubmissionError((e as Error).message);
  }
}

/**
 * Kisi bhi collection ka banner/PFP lagao ya badlo (CLI se bani collection ke liye bhi).
 * Branding NFT art nahi hai, isliye mint shuru hone ke baad bhi badal sakte hain.
 */
export async function setCollectionMedia(
  db: Db,
  opts: { slug: string; kind: "profile" | "banner"; file: string; assetsRoot: string }
): Promise<{ file: string; width: number; height: number }> {
  const col = await db.query<{ id: number }>(`SELECT id FROM collections WHERE slug = $1`, [opts.slug]);
  if (!col.rows[0]) throw new SubmissionError(`collection '${opts.slug}' nahi mili`);
  if (!existsSync(opts.file) || !statSync(opts.file).isFile()) throw new SubmissionError(`image file nahi mili: ${opts.file}`);
  const media = validateCollectionMedia({ name: basename(opts.file), size: statSync(opts.file).size, read: () => readFileSync(opts.file) }, opts.kind);
  const root = resolve(opts.assetsRoot);
  mkdirSync(resolve(root, opts.slug), { recursive: true });
  const file = `${opts.slug}/${media.kind}-${media.sha256.slice(0, 16)}.${media.ext}`;
  writeFileSync(join(root, file), media.bytes);
  await db.query(
    `INSERT INTO collection_media (collection_id, kind, file, mime, sha256, bytes, width, height)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (collection_id, kind) DO UPDATE SET file = EXCLUDED.file, mime = EXCLUDED.mime, sha256 = EXCLUDED.sha256,
       bytes = EXCLUDED.bytes, width = EXCLUDED.width, height = EXCLUDED.height`,
    [col.rows[0].id, media.kind, file, media.mime, media.sha256, media.bytes.length, media.width, media.height]
  );
  return { file, width: media.width, height: media.height };
}

export async function listPendingReview(db: Db): Promise<{ slug: string; name: string; supply: number; submittedAt: Date | null; creatorAddress: string | null }[]> {
  const r = await db.query<any>(`SELECT slug, name, supply, submitted_at, creator_address FROM collections WHERE status = 'pending_review' ORDER BY submitted_at`);
  return r.rows.map((x) => ({ slug: x.slug, name: x.name, supply: x.supply, submittedAt: x.submitted_at ? new Date(x.submitted_at) : null, creatorAddress: x.creator_address ?? null }));
}

export async function approveSubmission(db: Db, slug: string): Promise<void> {
  const r = await db.query(`UPDATE collections SET status = 'live' WHERE slug = $1 AND status = 'pending_review' RETURNING id`, [slug]);
  if (!r.rows[0]) throw new Error(`'${slug}' pending review me nahi hai`);
}

export async function rejectSubmission(db: Db, slug: string, reason: string): Promise<void> {
  const r = await db.query(`UPDATE collections SET status = 'cancelled', reject_reason = $2 WHERE slug = $1 AND status = 'pending_review' RETURNING id`, [slug, reason]);
  if (!r.rows[0]) throw new Error(`'${slug}' pending review me nahi hai`);
}
