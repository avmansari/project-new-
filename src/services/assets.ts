import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import sharp from "sharp";
import { detectImage, type ImageMime } from "../assets/image.js";
import type { Db } from "../db/index.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const THUMB_MAX_DIMENSION = 320;

/** Gallery thumbnail: chhota WebP, transparency safe rakhta hai. Fail ho to caller full image dikhayega. */
async function makeThumbnail(buf: Buffer): Promise<Buffer> {
  return sharp(buf, { animated: false })
    .resize({ width: THUMB_MAX_DIMENSION, height: THUMB_MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 75 })
    .toBuffer();
}

export interface Attribute {
  trait_type: string;
  value: string | number;
}

export interface TokenAsset {
  tokenNumber: number;
  name: string;
  description: string;
  attributes: Attribute[];
  mime: ImageMime;
  /** assetsRoot ke andar ka relative path. Hamesha hamara banaya hua (user input se nahi). */
  file: string;
  sha256: string;
  width: number;
  height: number;
  /** assetsRoot ke andar chhoti (compressed) copy ka path. Null = nahi bani, full image use karo. */
  thumbFile: string | null;
}

export interface ImportResult {
  slug: string;
  count: number;
  coverImported: boolean;
  provenanceHash: string;
  totalBytes: number;
  /** Kitni images doosri image ki bilkul copy hain (same bytes). Error nahi, sirf warning. */
  duplicateImages: number;
  uniqueImages: number;
}

/**
 * File ka data LAZY hai: `read()` tabhi bulao jab zaroorat ho, aur turant istemal karke chhod do.
 * Isse 10,000 images ka collection bhi ek waqt me sirf EK file jitni memory leta hai, poora nahi.
 *  - Memory (multipart, chhote uploads): `read` sirf already-liye-hue Buffer ko wapas karta hai.
 *  - Disk (bade session-based uploads, CLI folder import): `read` file ko us waqt padhta hai.
 */
export interface LazyEntry {
  /** File ka naam jaisa upload/folder me tha (e.g. "3.png", "cover.png", "2.json") */
  name: string;
  size: number;
  read(): Buffer;
}

export interface AssetEntry {
  name: string;
  buf: Buffer;
}

export function bufEntry(name: string, buf: Buffer): LazyEntry {
  return { name, size: buf.length, read: () => buf };
}

/** Disk ki file ko LAZY entry banata hai: size turant (stat se), bytes tabhi jab `.read()` bulao. */
export function readLazyFile(path: string, name: string): LazyEntry {
  return { name, size: statSync(path).size, read: () => readFileSync(path) };
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i;
const IGNORE = /^(\.ds_store|thumbs\.db|desktop\.ini)$/i;
const SIDE_OK = /\.(json|txt|md)$/i;

function readSidecarMeta(jsonBuf: Buffer | undefined, jname: string): { name?: string; description?: string; attributes?: Attribute[] } {
  if (!jsonBuf) return {};
  let j: any;
  try {
    j = JSON.parse(jsonBuf.toString("utf8"));
  } catch {
    throw new Error(`${jname}: valid JSON nahi hai`);
  }
  const out: { name?: string; description?: string; attributes?: Attribute[] } = {};
  if (j.name !== undefined) {
    if (typeof j.name !== "string" || !j.name.trim() || j.name.length > 100) throw new Error(`${jname}: name text hona chahiye (max 100)`);
    out.name = j.name.trim();
  }
  if (j.description !== undefined) {
    if (typeof j.description !== "string" || j.description.length > 1000) throw new Error(`${jname}: description text hona chahiye (max 1000)`);
    out.description = j.description;
  }
  if (j.attributes !== undefined) {
    if (!Array.isArray(j.attributes) || j.attributes.length > 50) throw new Error(`${jname}: attributes array hona chahiye (max 50)`);
    out.attributes = j.attributes.map((a: any) => {
      const okVal = (typeof a?.value === "string" && a.value.length <= 100) || (typeof a?.value === "number" && Number.isFinite(a.value));
      if (typeof a?.trait_type !== "string" || !a.trait_type || a.trait_type.length > 50 || !okVal) {
        throw new Error(`${jname}: har attribute {"trait_type": "text", "value": "text ya number"} hona chahiye`);
      }
      return { trait_type: a.trait_type, value: a.value };
    });
  }
  return out;
}

interface Staged {
  token: number;
  file: string;
  mime: ImageMime;
  sha: string;
  width: number;
  height: number;
  bytes: number;
  name: string;
  description: string;
  attributes: Attribute[];
}

/**
 * Poore collection ko EK BAAR me memory me nahi laata. Har file ki apni baari me hi bytes padhi
 * jaati hain, kaam ho jaane ke baad turant chhod di jaati hain -- isliye 200 MB ho ya 10 GB, peak
 * memory hamesha "sabse badi ek file" jitni hi rehti hai.
 *
 * Do passes (atomicity ke liye): pehle SAB files validate (kuch bhi disk pe likhe bina), sirf
 * tabhi jab SAB sahi hon to hi doosre pass me copy + DB likhte hain.
 *
 *  - Images ki ginti collection ki supply ke barabar honi chahiye.
 *  - Sirf PNG/JPEG/WebP/GIF (bytes se jaanch), max maxBytes per file, SVG nahi.
 *  - Optional: cover.png/jpg, aur <naam>.json (name, description, attributes).
 *  - MINT SHURU HONE KE BAAD art badal NAHI sakta.
 */
export async function importAssetsFromEntries(
  db: Db,
  opts: { slug: string; entries: LazyEntry[]; assetsRoot: string; replace?: boolean; maxBytes?: number; allowMismatch?: boolean }
): Promise<ImportResult> {
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;
  const col = await db.query<{ id: number; name: string; supply: number }>(`SELECT id, name, supply FROM collections WHERE slug = $1`, [opts.slug]);
  if (!col.rows[0]) throw new Error(`collection '${opts.slug}' nahi mili`);
  const c = col.rows[0];

  const minted = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM tokens WHERE collection_id = $1`, [c.id]);
  if (minted.rows[0].n > 0) throw new Error("Is collection ka mint shuru ho chuka hai, art ab badla nahi ja sakta.");
  const existing = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM assets WHERE collection_id = $1`, [c.id]);
  if (existing.rows[0].n > 0 && !opts.replace) throw new Error("Is collection ki images pehle se import hain. Badalni ho to --replace lagao (mint shuru hone se pehle hi).");

  const names = opts.entries.map((e) => e.name);
  const dupNames = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupNames.length) throw new Error(`Duplicate file naam: ${[...new Set(dupNames)].join(", ")}`);
  const bad = names.filter((n) => !IMG_EXT.test(n) && !SIDE_OK.test(n));
  if (bad.length) throw new Error(`Ye files allowed nahi (sirf PNG/JPG/WebP/GIF, SVG nahi): ${bad.slice(0, 5).join(", ")}`);

  const byName = new Map(opts.entries.map((e) => [e.name, e]));
  const imgs = names.filter((n) => IMG_EXT.test(n));
  const coverName = imgs.find((n) => basename(n, extname(n)).toLowerCase() === "cover");
  const tokenFiles = imgs.filter((n) => n !== coverName).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  if (tokenFiles.length !== c.supply && !opts.allowMismatch) {
    throw new Error(`${tokenFiles.length} images hain, lekin collection ki supply ${c.supply} hai. Dono barabar hone chahiye.`);
  }

  // ---- PASS 1: validate, EK-EK karke bytes padhna (kuch bhi disk pe nahi likhte) ----
  const stage = (file: string, token: number): Staged => {
    const entry = byName.get(file)!;
    if (entry.size > maxBytes) throw new Error(`${file}: ${(entry.size / 1048576).toFixed(1)} MB hai, limit ${(maxBytes / 1048576).toFixed(0)} MB`);
    const buf = entry.read();
    const info = detectImage(buf);
    if (!info) throw new Error(`${file}: valid PNG/JPEG/WebP/GIF nahi hai (kharab file, SVG, ya koi aur format)`);
    const ext = extname(file).slice(1).toLowerCase().replace("jpeg", "jpg");
    if (ext !== info.ext) throw new Error(`${file}: extension .${ext} hai lekin asli file ${info.mime} hai`);
    const jname = file.replace(/\.[^.]+$/, "") + ".json";
    const side = token === 0 ? {} : readSidecarMeta(byName.get(jname)?.read(), jname);
    return {
      token, file, mime: info.mime, sha: sha256(buf), width: info.width, height: info.height, bytes: buf.length,
      name: side.name ?? (token === 0 ? `${c.name} cover` : `${c.name} #${token}`),
      description: side.description ?? "",
      attributes: side.attributes ?? [],
    };
  };
  const stagedTokens: Staged[] = tokenFiles.map((f, i) => stage(f, i + 1));
  const stagedCover = coverName ? stage(coverName, 0) : null;
  const provenanceHash = sha256(Buffer.from(stagedTokens.map((p) => `${p.token}:${p.sha}\n`).join("")));

  // ---- PASS 2: sab valid nikla, ab EK-EK karke copy karo (phir se padho, likho, chhodo) ----
  const root = resolve(opts.assetsRoot);
  const dest = resolve(root, opts.slug);
  if (!dest.startsWith(root + sep)) throw new Error("slug se path galat ban raha hai");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const all = stagedCover ? [stagedCover, ...stagedTokens] : stagedTokens;
  const relOf = (p: Staged) => `${opts.slug}/${p.token === 0 ? "cover" : p.token}.${p.mime === "image/jpeg" ? "jpg" : p.mime.split("/")[1]}`;
  const thumbRelOf = (p: Staged) => `${opts.slug}/${p.token === 0 ? "cover" : p.token}_thumb.webp`;
  const thumbFor = new Map<Staged, string | null>();
  for (const p of all) {
    const entry = byName.get(p.file)!;
    const buf = entry.read();
    writeFileSync(join(root, relOf(p)), buf); // dusri baar padha, likha, turant chhod diya
    try {
      const thumbBuf = await makeThumbnail(buf);
      writeFileSync(join(root, thumbRelOf(p)), thumbBuf);
      thumbFor.set(p, thumbRelOf(p));
    } catch {
      thumbFor.set(p, null); // thumbnail fail ho jaye to bhi import rukta nahi, bas full image fallback banegi
    }
  }

  await db.transaction(async (tx) => {
    await tx.query(`DELETE FROM assets WHERE collection_id = $1`, [c.id]);
    for (const p of all) {
      await tx.query(
        `INSERT INTO assets (collection_id, token_number, file, mime, sha256, bytes, width, height, name, description, attributes, thumb_file)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [c.id, p.token, relOf(p), p.mime, p.sha, p.bytes, p.width, p.height, p.name, p.description, JSON.stringify(p.attributes), thumbFor.get(p) ?? null]
      );
    }
    await tx.query(`UPDATE collections SET provenance_hash = $2 WHERE id = $1`, [c.id, provenanceHash]);
  });
  const uniqueImages = new Set(stagedTokens.map((p) => p.sha)).size;
  return {
    slug: opts.slug,
    count: stagedTokens.length,
    coverImported: !!stagedCover,
    provenanceHash,
    totalBytes: all.reduce((a, p) => a + p.bytes, 0),
    duplicateImages: stagedTokens.length - uniqueImages,
    uniqueImages,
  };
}

/** CLI wrapper: folder se LAZY entries banata hai (har file apni baari aane par hi disk se padhi jaati hai). */
export async function importAssets(
  db: Db,
  opts: { slug: string; dir: string; assetsRoot: string; replace?: boolean; maxBytes?: number }
): Promise<ImportResult> {
  if (!existsSync(opts.dir) || !statSync(opts.dir).isDirectory()) throw new Error(`folder nahi mila: ${opts.dir}`);
  const names = readdirSync(opts.dir).filter((n) => statSync(join(opts.dir, n)).isFile() && !IGNORE.test(n));
  const entries: LazyEntry[] = names.map((n) => {
    const p = join(opts.dir, n);
    return { name: n, size: statSync(p).size, read: () => readFileSync(p) };
  });
  return importAssetsFromEntries(db, { ...opts, entries });
}

function mapAsset(r: any): TokenAsset {
  let attributes: Attribute[] = [];
  try {
    attributes = JSON.parse(r.attributes);
  } catch {
    /* kharab JSON => khaali */
  }
  return { tokenNumber: r.token_number, name: r.name, description: r.description, attributes, mime: r.mime, file: r.file, sha256: r.sha256, width: r.width, height: r.height, thumbFile: r.thumb_file ?? null };
}

const ASSET_COLS = `token_number, name, description, attributes, mime, file, sha256, width, height, thumb_file`;

export async function getAsset(db: Db, collectionId: number, tokenNumber: number): Promise<TokenAsset | null> {
  const r = await db.query(`SELECT ${ASSET_COLS} FROM assets WHERE collection_id = $1 AND token_number = $2`, [collectionId, tokenNumber]);
  return r.rows[0] ? mapAsset(r.rows[0]) : null;
}

/** Collection ke saare (mint hue) tokens ke assets, ek query mein */
export async function getAssetsFor(db: Db, collectionId: number, tokenNumbers: number[]): Promise<Map<number, TokenAsset>> {
  const out = new Map<number, TokenAsset>();
  if (tokenNumbers.length === 0) return out;
  const r = await db.query(`SELECT ${ASSET_COLS} FROM assets WHERE collection_id = $1 AND token_number = ANY($2::int[])`, [collectionId, tokenNumbers]);
  for (const row of r.rows) out.set((row as any).token_number, mapAsset(row));
  return out;
}

/**
 * Reveal: "instant" => hamesha. "after_soldout" => tab jab saare tokens mint ho chuke ho.
 * Isse pehle unminted / unrevealed token ki image kabhi nahi jaati.
 */
export async function isRevealed(db: Db, collectionId: number): Promise<boolean> {
  const r = await db.query<{ mode: string; supply: number; minted: number }>(
    `SELECT c.reveal_mode AS mode, c.supply, (SELECT count(*)::int FROM tokens t WHERE t.collection_id = c.id AND t.voided_at IS NULL) AS minted
     FROM collections c WHERE c.id = $1`,
    [collectionId]
  );
  const x = r.rows[0];
  return !!x && (x.mode === "instant" || x.minted >= x.supply);
}
