import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath, sep } from "node:path";
import type { ChainClient } from "../chain/types.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { formatZec } from "../money.js";
import { getCollectionBySlug } from "../services/collections.js";
import { logActivity, listActivity } from "../services/activity.js";
import { getRates, convert } from "../services/settings.js";
import { computeRarity } from "../services/rarity.js";
import {
  cancelListing, createPurchaseOrder, getListing, listActiveListings, listToken, ListingError,
} from "../services/marketplace.js";
import { acceptOffer, cancelOffer, createOffer, getOffer, listOffersForToken, OfferError, rejectOffer } from "../services/offers.js";
import { submitCollection, SubmissionError, approveSubmission, rejectSubmission } from "../services/creator-submit.js";
import { createSession, cleanupSession, receiveSessionFile, sessionEntries, SessionError, sweepStaleSessions } from "../services/upload-session.js";
import { verifyAdminPassword, createAdminSession, checkAdminSession, deleteAdminSession } from "../services/admin-auth.js";
import { parseContentType, parseMultipart } from "./multipart.js";
import { parseZec } from "../money.js";
import { cancelPendingOrder, createOrder, getOrder, OrderError, type Order } from "../services/orders.js";
import { isAddressForNetwork } from "../zcash/address.js";
import { getAsset, getAssetsFor, isRevealed } from "../services/assets.js";
import { blockToken, cancelCollection, freezeCollection, unblockToken, unfreezeCollection } from "../services/moderation.js";
import { HttpError, RateLimiter, readBody, readJson, SECURITY_HEADERS, sendFile, sendJson, serveStatic } from "./http.js";
import { parseCookies, setCookie, clearCookie } from "./cookies.js";

export type AppCfg = Pick<
  AppConfig,
  "network" | "walletXpub" | "orderTtlMinutes" | "minConfirmations" | "rateLimitPerMin" | "orderRatePerMin" | "orderRatePerHour"
    | "marketplaceFeeBps" | "verifiedVolumeZats" | "maxFileBytes" | "maxSessionBytes" | "adminSessionHours" | "uploadRatePerMin"
> & { assetsDir?: string; imageRatePerMin?: number; zecUsdRate?: number; zecInrRate?: number; adminPasswordHash?: string };

export interface AppOptions {
  db: Db;
  cfg: AppCfg;
  chain: ChainClient;
  webDir?: string;
  assetsDir?: string;
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9-]{2,40}$/;

export type Stage = "awaiting_payment" | "payment_seen" | "minting" | "done" | "expired" | "refund_pending" | "refunded";

export function stageOf(o: Order, now: Date): Stage {
  switch (o.status) {
    case "minted":
      return "done";
    case "paid":
      return "minting";
    case "expired":
      return "expired";
    case "refund_needed":
      return o.refundDueZats > 0n && o.refundedZats >= o.refundDueZats ? "refunded" : o.refundDueZats > 0n ? "refund_pending" : "expired";
    case "pending":
      if (o.funded) return "payment_seen";
      return o.expiresAt.getTime() <= now.getTime() ? "expired" : "awaiting_payment";
    default:
      return "expired";
  }
}

/** Order ka PUBLIC roop: koi internal field (address_index, xpub, etc.) nahi. */
function publicOrder(o: Order, c: { slug: string; name: string }, now: Date, tokens: number[] = []) {
  const zec = formatZec(o.amountZats);
  return {
    id: o.id,
    collection: c.slug,
    collectionName: c.name,
    quantity: o.quantity,
    status: o.status,
    stage: stageOf(o, now),
    buyerAddress: o.buyerAddress,
    payAddress: o.payAddress,
    amountZats: o.amountZats.toString(),
    amountZec: zec,
    paymentUri: `zcash:${o.payAddress}?amount=${zec}`,
    expiresAt: o.expiresAt.toISOString(),
    receivedZats: o.receivedZats.toString(),
    refundDueZats: (o.refundDueZats > o.refundedZats ? o.refundDueZats - o.refundedZats : 0n).toString(),
    tokens,
  };
}

const err = (status: number, code: string, message: string) => new HttpError(status, code, message);

export function createApp(opts: AppOptions): { server: Server; close(): Promise<void> } {
  const { db, cfg, chain } = opts;
  const now = opts.now ?? (() => new Date());
  const webDir = opts.webDir ?? fileURLToPath(new URL("../../web/", import.meta.url));

  const assetsRoot = resolvePath(opts.assetsDir ?? cfg.assetsDir ?? "./data/assets");
  const general = new RateLimiter(60_000, cfg.rateLimitPerMin);
  const images = new RateLimiter(60_000, cfg.imageRatePerMin ?? 600);
  const orderMin = new RateLimiter(60_000, cfg.orderRatePerMin);
  const orderHour = new RateLimiter(3_600_000, cfg.orderRatePerHour);
  // Bade collection upload karte waqt SAINKDO files alag-alag requests me jaati hain (ek session ke
  // andar, seedha stream hoti hain) -- ye normal API rate limit se bahar rakhni hai, warna 500-1000
  // image wala collection upload karte hi "too many requests" pe atak jaata.
  const uploads = new RateLimiter(60_000, cfg.uploadRatePerMin ?? 6000);
  const sweeper = setInterval(() => {
    general.sweep();
    images.sweep();
    uploads.sweep();
    orderMin.sweep();
    orderHour.sweep();
  }, 60_000);
  sweeper.unref();

  const limited = (r: { ok: boolean; retryAfterSec: number }) => {
    if (!r.ok) throw new HttpError(429, "RATE_LIMITED", "Bahut zyada requests, thoda ruko", { "Retry-After": String(r.retryAfterSec) });
  };

  async function collectionsList(opts: { sort?: "new" | "trending"; window?: "24h" | "7d" | "all"; q?: string } = {}) {
    const t = now().toISOString();
    const winClause = opts.window === "24h" ? "AND s.created_at > now() - interval '24 hours'" : opts.window === "7d" ? "AND s.created_at > now() - interval '7 days'" : "";
    const rates = await getRates(db, { usd: cfg.zecUsdRate, inr: cfg.zecInrRate });
    const params: unknown[] = [t];
    let searchClause = "";
    if (opts.q) {
      params.push(`%${opts.q}%`);
      searchClause = `AND (c.name ILIKE $${params.length} OR c.slug ILIKE $${params.length})`;
    }
    const r = await db.query<any>(
      `SELECT c.slug, c.name, c.supply, c.price_zats::text AS price, c.max_per_wallet, c.status, c.payout_frozen,
              c.reveal_mode, c.provenance_hash, c.verified_override, c.starts_at, c.description, c.website_url, c.x_url,
              EXISTS (SELECT 1 FROM assets a WHERE a.collection_id = c.id AND a.token_number = 0) AS has_cover,
              EXISTS (SELECT 1 FROM collection_media m WHERE m.collection_id = c.id AND m.kind = 'profile') AS has_profile,
              EXISTS (SELECT 1 FROM collection_media m WHERE m.collection_id = c.id AND m.kind = 'banner') AS has_banner,
              (SELECT count(*)::int FROM tokens k WHERE k.collection_id = c.id AND k.voided_at IS NULL) AS minted,
              COALESCE((SELECT SUM(o.quantity) FROM orders o WHERE o.collection_id = c.id AND o.kind = 'mint'
                        AND (o.status IN ('paid','minted') OR (o.status = 'pending' AND (o.expires_at > $1::timestamptz OR o.funded)))), 0)::int AS committed,
              COALESCE((SELECT SUM(s.gross_zats) FROM sales s WHERE s.collection_id = c.id AND s.status = 'active'), 0)::text AS volume_total,
              COALESCE((SELECT SUM(s.gross_zats) FROM sales s WHERE s.collection_id = c.id AND s.status = 'active' ${winClause}), 0)::text AS volume_window,
              (SELECT MIN(l.price_zats) FROM listings l WHERE l.collection_id = c.id AND l.status = 'active')::text AS floor_zats,
              (SELECT count(*)::int FROM listings l WHERE l.collection_id = c.id AND l.status = 'active') AS listing_count
       FROM collections c WHERE c.status IN ('live','ended') ${searchClause} ORDER BY c.id DESC LIMIT 100`,
      params
    );
    // trending sort needs volume_window as a real order key; do it in JS for portability across query shapes above
    const rows = r.rows.map((x: any) => {
      const volumeTotal = BigInt(x.volume_total);
      const verified = x.verified_override !== null ? x.verified_override : volumeTotal >= cfg.verifiedVolumeZats;
      const priceZecStr = formatZec(BigInt(x.price));
      return {
        slug: x.slug, name: x.name, supply: x.supply, minted: x.minted,
        available: Math.max(0, x.supply - x.committed),
        priceZats: x.price, priceZec: priceZecStr,
        priceUsd: convert(priceZecStr, rates.usd), priceInr: convert(priceZecStr, rates.inr),
        maxPerWallet: x.max_per_wallet, status: x.status, frozen: x.payout_frozen,
        coverUrl: x.has_cover ? `/api/collections/${x.slug}/cover` : null,
        profileUrl: x.has_profile ? `/api/collections/${x.slug}/profile` : null,
        bannerUrl: x.has_banner ? `/api/collections/${x.slug}/banner` : null,
        revealMode: x.reveal_mode, revealed: x.reveal_mode === "instant" || x.minted >= x.supply,
        provenanceHash: x.provenance_hash ?? null,
        verified,
        volumeTotalZats: x.volume_total, volumeTotalZec: formatZec(volumeTotal),
        volumeWindowZats: x.volume_window, volumeWindowZec: formatZec(BigInt(x.volume_window)),
        floorZats: x.floor_zats, floorZec: x.floor_zats !== null ? formatZec(BigInt(x.floor_zats)) : null,
        listingCount: x.listing_count,
        startsAt: x.starts_at ?? null,
        description: x.description ?? "", websiteUrl: x.website_url ?? null, xUrl: x.x_url ?? null,
      };
    });
    if (opts.sort === "trending") rows.sort((a, b) => (BigInt(b.volumeWindowZats) > BigInt(a.volumeWindowZats) ? 1 : -1));
    return rows;
  }

  const imageUrl = (slug: string, n: number) => `/api/collections/${slug}/tokens/${n}/image`;

  interface TokenRow { collection_id: number; slug: string; cname: string; token_number: number; blocked?: boolean; blocked_reason?: string | null }
  /** Tokens ko dikhane layak roop do: image (reveal ke hisaab se), naam. Unrevealed => sirf placeholder, koi asli detail nahi. */
  async function describeTokens(rows: TokenRow[]) {
    const byCol = new Map<number, TokenRow[]>();
    for (const r of rows) byCol.set(r.collection_id, [...(byCol.get(r.collection_id) ?? []), r]);
    const out = new Map<string, { collection: string; collectionName: string; tokenNumber: number; name: string; imageUrl: string | null; thumbUrl: string | null; revealed: boolean; blocked: boolean; blockedReason: string | null }>();
    for (const [cid, list] of byCol) {
      const revealed = await isRevealed(db, cid);
      const assets = revealed ? await getAssetsFor(db, cid, list.map((r) => r.token_number)) : new Map();
      for (const r of list) {
        const a = assets.get(r.token_number);
        const generic = `${r.cname} #${r.token_number}`;
        const full = revealed ? (a ? imageUrl(r.slug, r.token_number) : null) : "/placeholder.svg";
        out.set(`${cid}:${r.token_number}`, {
          collection: r.slug,
          collectionName: r.cname,
          tokenNumber: r.token_number,
          name: revealed && a ? a.name : generic,
          imageUrl: full,
          thumbUrl: revealed ? (full ? full + "?thumb=1" : null) : "/placeholder.svg",
          revealed,
          blocked: !!r.blocked,
          blockedReason: r.blocked_reason ?? null,
        });
      }
    }
    return rows.map((r) => out.get(`${r.collection_id}:${r.token_number}`)!);
  }

  async function collectionBySlug(slug: string) {
    if (!SLUG.test(slug)) throw err(400, "BAD_SLUG", "slug galat hai");
    const r = await db.query<{ id: number; slug: string; name: string; supply: number; provenance_hash: string | null }>(
      `SELECT id, slug, name, supply, provenance_hash FROM collections WHERE slug = $1 AND status IN ('live','ended')`,
      [slug]
    );
    if (!r.rows[0]) throw err(404, "COLLECTION_NOT_FOUND", "collection nahi mili");
    return r.rows[0];
  }

  /** Token sirf tab jab mint ho chuka ho (unminted token ki image kabhi nahi) */
  async function mintedToken(colId: number, n: number) {
    const r = await db.query(`SELECT 1 FROM tokens WHERE collection_id = $1 AND token_number = $2 AND voided_at IS NULL`, [colId, n]);
    return !!r.rows[0];
  }

  function parseToken(v: string): number {
    if (!/^[1-9]\d{0,6}$/.test(v)) throw err(400, "BAD_TOKEN", "token number galat hai");
    return Number(v);
  }

  async function serveAsset(req: IncomingMessage, res: ServerResponse, a: { file: string; mime: string; sha256: string }) {
    const abs = resolvePath(assetsRoot, a.file);
    if (!abs.startsWith(assetsRoot + sep)) throw err(404, "NOT_FOUND", "Nahi mila"); // (a.file hamara apna hai, phir bhi)
    await sendFile(req, res, abs, a.mime, a.sha256);
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const path = url.pathname;
    const ip = req.socket.remoteAddress ?? "unknown";

    if (!path.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD") throw err(405, "METHOD_NOT_ALLOWED", "Sirf GET");
      if (await serveStatic(webDir, path, res)) return;
      throw err(404, "NOT_FOUND", "Nahi mila");
    }

    const isImage = /^\/api\/collections\/[a-z0-9-]{2,40}\/(cover|profile|banner|tokens\/\d{1,7}\/image)$/.test(path);
    const isUploadFile = /^\/api\/creator\/sessions\/[0-9a-f-]{36}\/files$/.test(path);
    limited(isImage ? images.check(ip) : isUploadFile ? uploads.check(ip) : general.check(ip));
    if (method !== "GET" && method !== "POST" && !(isImage && method === "HEAD")) throw err(405, "METHOD_NOT_ALLOWED", "Sirf GET ya POST");
    const seg = path.split("/").filter(Boolean); // ["api", ...]

    if (method === "GET" && path === "/api/health") return sendJson(res, 200, { ok: true });

    if (method === "GET" && path === "/api/config") {
      return sendJson(res, 200, { network: cfg.network, minConfirmations: cfg.minConfirmations, orderTtlMinutes: cfg.orderTtlMinutes });
    }

    if (method === "GET" && path === "/api/collections") {
      const sort = url.searchParams.get("sort") === "trending" ? "trending" : "new";
      const win = url.searchParams.get("window");
      const window = win === "24h" || win === "7d" ? win : "all";
      const q = url.searchParams.get("q")?.slice(0, 100) || undefined;
      return sendJson(res, 200, { collections: await collectionsList({ sort, window, q }) });
    }

    if (method === "GET" && path === "/api/search") {
      const q = url.searchParams.get("q")?.slice(0, 100) || "";
      if (!q.trim()) return sendJson(res, 200, { collections: [] });
      return sendJson(res, 200, { collections: await collectionsList({ q }) });
    }

    if (method === "GET" && path === "/api/activity") {
      const slug = url.searchParams.get("collection") || undefined;
      if (slug && !SLUG.test(slug)) throw err(400, "BAD_SLUG", "slug galat hai");
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 30) || 30));
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset") ?? 0) || 0));
      const r = await listActivity(db, { slug, limit, offset });
      return sendJson(res, 200, {
        total: r.total,
        items: r.items.map((x) => ({
          id: x.id, kind: x.kind, collection: x.collectionSlug, collectionName: x.collectionName,
          tokenNumber: x.tokenNumber, amountZats: x.amountZats?.toString() ?? null,
          amountZec: x.amountZats !== null ? formatZec(x.amountZats) : null,
          address: x.address, detail: x.detail, createdAt: x.createdAt.toISOString(),
        })),
      });
    }

    // ---- images / gallery ----
    if ((method === "GET" || method === "HEAD") && seg.length === 4 && seg[1] === "collections" && (seg[3] === "profile" || seg[3] === "banner")) {
      const col = await collectionBySlug(seg[2]);
      const media = await db.query<{ file: string; mime: string; sha256: string }>(
        `SELECT file, mime, sha256 FROM collection_media WHERE collection_id = $1 AND kind = $2`, [col.id, seg[3]]
      );
      if (!media.rows[0]) throw err(404, "NO_COLLECTION_MEDIA", "collection image nahi mili");
      return serveAsset(req, res, media.rows[0]);
    }
    if ((method === "GET" || method === "HEAD") && seg.length === 4 && seg[1] === "collections" && seg[3] === "cover") {
      const col = await collectionBySlug(seg[2]);
      const a = await getAsset(db, col.id, 0);
      if (!a) throw err(404, "NO_COVER", "cover nahi hai");
      return serveAsset(req, res, a);
    }
    if ((method === "GET" || method === "HEAD") && seg.length === 6 && seg[1] === "collections" && seg[3] === "tokens" && seg[5] === "image") {
      const col = await collectionBySlug(seg[2]);
      const n = parseToken(seg[4]);
      if (!(await mintedToken(col.id, n))) throw err(404, "TOKEN_NOT_MINTED", "ye token abhi mint nahi hua");
      if (!(await isRevealed(db, col.id))) {
        res.writeHead(302, { Location: "/placeholder.svg", "Cache-Control": "no-store", ...SECURITY_HEADERS });
        return void res.end();
      }
      const a = await getAsset(db, col.id, n);
      if (!a) throw err(404, "NO_IMAGE", "is token ki image nahi hai");
      if (url.searchParams.get("thumb") === "1" && a.thumbFile) {
        return serveAsset(req, res, { file: a.thumbFile, mime: "image/webp", sha256: a.sha256 + "-thumb" });
      }
      return serveAsset(req, res, a);
    }
    if (method === "GET" && seg.length === 4 && seg[1] === "collections" && seg[3] === "gallery") {
      const col = await collectionBySlug(seg[2]);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 24) || 24));
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset") ?? 0) || 0));
      const traitType = url.searchParams.get("trait_type")?.slice(0, 50);
      const traitValue = url.searchParams.get("value")?.slice(0, 100);
      const sortRarity = url.searchParams.get("sort") === "rarity";

      let tokenNums: number[] | null = null;
      if (traitType || sortRarity) {
        // Trait filter / rarity sort: attributes ek JSON string field hain, isliye is scale (kuch hazaar tokens) pe JS me chaan lete hain.
        const rar = sortRarity ? await computeRarity(db, col.id) : null;
        const all = await db.query<{ token_number: number; attributes: string }>(
          `SELECT a.token_number, a.attributes FROM assets a JOIN tokens t ON t.collection_id = a.collection_id AND t.token_number = a.token_number
           WHERE a.collection_id = $1 AND a.token_number > 0 AND t.voided_at IS NULL`,
          [col.id]
        );
        let filtered = all.rows;
        if (traitType) {
          filtered = filtered.filter((r) => {
            let attrs: { trait_type: string; value: unknown }[] = [];
            try { attrs = JSON.parse(r.attributes); } catch { /* khaali */ }
            return attrs.some((a) => a.trait_type === traitType && (traitValue === undefined || String(a.value) === traitValue));
          });
        }
        let nums = filtered.map((r) => r.token_number);
        if (sortRarity && rar) nums = nums.sort((a, b) => (rar.get(b)?.score ?? 0) - (rar.get(a)?.score ?? 0));
        tokenNums = nums;
      }

      const total = tokenNums
        ? tokenNums.length
        : (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM tokens WHERE collection_id = $1 AND voided_at IS NULL`, [col.id])).rows[0].n;
      let rows: { token_number: number; blocked: boolean; blocked_reason: string | null }[];
      if (tokenNums) {
        const page = tokenNums.slice(offset, offset + limit);
        const r = await db.query<any>(`SELECT token_number, blocked, blocked_reason FROM tokens WHERE collection_id = $1 AND token_number = ANY($2::int[])`, [col.id, page]);
        const byNum = new Map(r.rows.map((x: any) => [x.token_number, x]));
        rows = page.map((n) => byNum.get(n)!).filter(Boolean);
      } else {
        const r = await db.query<any>(
          `SELECT token_number, blocked, blocked_reason FROM tokens WHERE collection_id = $1 AND voided_at IS NULL ORDER BY token_number LIMIT $2 OFFSET $3`,
          [col.id, limit, offset]
        );
        rows = r.rows;
      }
      const items = await describeTokens(rows.map((r) => ({ collection_id: col.id, slug: col.slug, cname: col.name, token_number: r.token_number, blocked: r.blocked, blocked_reason: r.blocked_reason })));
      return sendJson(res, 200, { total, offset, limit, items }); // owner ka address jaan-bujh ke nahi (privacy)
    }
    if (method === "GET" && seg.length === 5 && seg[1] === "collections" && seg[3] === "tokens") {
      const col = await collectionBySlug(seg[2]);
      const n = parseToken(seg[4]);
      const tk = await db.query<{ blocked: boolean; blocked_reason: string | null; owner_address: string }>(`SELECT blocked, blocked_reason, owner_address FROM tokens WHERE collection_id = $1 AND token_number = $2 AND voided_at IS NULL`, [col.id, n]);
      if (!tk.rows[0]) throw err(404, "TOKEN_NOT_MINTED", "ye token abhi mint nahi hua");
      const revealed = await isRevealed(db, col.id);
      const a = revealed ? await getAsset(db, col.id, n) : null;
      const rarity = revealed ? (await computeRarity(db, col.id)).get(n) ?? null : null;
      const activeListing = (await db.query<{ id: number; price_zats: string; seller_address: string }>(
        `SELECT id, price_zats::text AS price_zats, seller_address FROM listings WHERE collection_id = $1 AND token_number = $2 AND status = 'active'`,
        [col.id, n]
      )).rows[0];
      const offers = await listOffersForToken(db, col.slug, n);
      return sendJson(res, 200, {
        token: {
          collection: col.slug,
          collectionName: col.name,
          provenanceHash: col.provenance_hash,
          tokenNumber: n,
          revealed,
          name: a ? a.name : `${col.name} #${n}`,
          description: a ? a.description : "",
          attributes: a ? a.attributes : [],
          imageUrl: revealed ? (a ? imageUrl(col.slug, n) : null) : "/placeholder.svg",
          width: a?.width ?? null,
          height: a?.height ?? null,
          rarity: rarity ? { score: rarity.score, rank: rarity.rank, of: rarity.totalRanked } : null,
          blocked: tk.rows[0].blocked, blockedReason: tk.rows[0].blocked_reason ?? null,
          ownerAddress: tk.rows[0].owner_address,
          listing: activeListing ? { id: activeListing.id, priceZats: activeListing.price_zats, priceZec: formatZec(BigInt(activeListing.price_zats)), sellerAddress: activeListing.seller_address } : null,
          offers: offers.map((o) => ({ id: o.id, buyerAddress: o.buyerAddress, priceZec: formatZec(o.priceZats) })),
        },
      });
    }

    if (method === "GET" && seg.length === 3 && seg[1] === "collections") {
      if (!SLUG.test(seg[2])) throw err(400, "BAD_SLUG", "slug galat hai");
      const c = (await collectionsList()).find((x) => x.slug === seg[2]);
      if (!c) throw err(404, "COLLECTION_NOT_FOUND", "collection nahi mili");
      return sendJson(res, 200, { collection: c });
    }

    // ---- marketplace (resale) ----
    if (method === "GET" && path === "/api/marketplace/listings") {
      const slug = url.searchParams.get("collection") || undefined;
      if (slug && !SLUG.test(slug)) throw err(400, "BAD_SLUG", "slug galat hai");
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 24) || 24));
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset") ?? 0) || 0));
      const r = await listActiveListings(db, { slug, limit, offset });
      return sendJson(res, 200, {
        total: r.total,
        items: r.items.map((l) => ({
          id: l.id, collection: l.slug, collectionName: l.collectionName, tokenNumber: l.tokenNumber,
          priceZats: l.priceZats.toString(), priceZec: formatZec(l.priceZats), sellerAddress: l.sellerAddress,
          imageUrl: imageUrl(l.slug, l.tokenNumber), thumbUrl: imageUrl(l.slug, l.tokenNumber) + "?thumb=1",
        })),
      });
    }

    if (method === "POST" && path === "/api/marketplace/listings") {
      limited(orderMin.check(ip));
      const b = (await readJson(req)) as Record<string, unknown> | null;
      if (!b || typeof b !== "object" || Array.isArray(b)) throw err(400, "BAD_BODY", "JSON object chahiye");
      const { collection, tokenNumber, sellerAddress, priceZec } = b;
      if (typeof collection !== "string" || !SLUG.test(collection)) throw err(400, "BAD_COLLECTION", "collection galat hai");
      if (typeof tokenNumber !== "number" || !Number.isInteger(tokenNumber) || tokenNumber < 1) throw err(400, "BAD_TOKEN", "tokenNumber galat hai");
      if (typeof sellerAddress !== "string" || sellerAddress.length > 100) throw err(400, "BAD_ADDRESS", "sellerAddress galat hai");
      if (typeof priceZec !== "string" || priceZec.length > 30) throw err(400, "BAD_PRICE", "priceZec (string) chahiye");
      let priceZats: bigint;
      try {
        priceZats = parseZec(priceZec);
      } catch {
        throw err(400, "BAD_PRICE", "priceZec galat format me hai");
      }
      try {
        const l = await listToken(db, cfg, { slug: collection, tokenNumber, sellerAddress, priceZats });
        return sendJson(res, 201, { listing: { id: l.id, collection: l.slug, tokenNumber: l.tokenNumber, priceZec: formatZec(l.priceZats), status: l.status } });
      } catch (e) {
        if (e instanceof ListingError) {
          const status = e.code === "COLLECTION_NOT_FOUND" ? 404 : e.code === "NOT_OWNER" ? 403 : e.code === "INVALID_PRICE" || e.code === "INVALID_ADDRESS" ? 400 : 409;
          throw err(status, e.code, e.message);
        }
        throw e;
      }
    }

    if (method === "POST" && seg.length === 5 && seg[1] === "marketplace" && seg[2] === "listings" && seg[4] === "cancel") {
      const id = Number(seg[3]);
      if (!Number.isInteger(id) || id < 1) throw err(400, "BAD_LISTING_ID", "listing id galat hai");
      const b = (await readJson(req)) as Record<string, unknown> | null;
      const sellerAddress = b && typeof b.sellerAddress === "string" ? b.sellerAddress : "";
      if (!sellerAddress) throw err(400, "BAD_ADDRESS", "sellerAddress zaroori hai");
      try {
        await cancelListing(db, id, sellerAddress);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        if (e instanceof ListingError) {
          const status = e.code === "LISTING_NOT_FOUND" ? 404 : e.code === "NOT_OWNER" ? 403 : 409;
          throw err(status, e.code, e.message);
        }
        throw e;
      }
    }

    if (method === "POST" && seg.length === 5 && seg[1] === "marketplace" && seg[2] === "listings" && seg[4] === "buy") {
      limited(orderMin.check(ip));
      limited(orderHour.check(ip));
      const id = Number(seg[3]);
      if (!Number.isInteger(id) || id < 1) throw err(400, "BAD_LISTING_ID", "listing id galat hai");
      const b = (await readJson(req)) as Record<string, unknown> | null;
      const buyerAddress = b && typeof b.buyerAddress === "string" ? b.buyerAddress : "";
      if (!buyerAddress || buyerAddress.length > 100 || !isAddressForNetwork(buyerAddress, cfg.network)) {
        throw err(400, "BAD_ADDRESS", `buyerAddress ${cfg.network} ka valid t-address hona chahiye`);
      }
      let tipHeight: number | undefined;
      if (chain.tipHeight) {
        try {
          tipHeight = await chain.tipHeight();
        } catch {
          throw err(503, "CHAIN_UNAVAILABLE", "Blockchain server abhi nahi mil raha, thodi der baad try karo");
        }
      }
      let order: Order;
      try {
        order = await createPurchaseOrder(db, cfg, { listingId: id, buyerAddress, now: now(), tipHeight });
      } catch (e) {
        if (e instanceof ListingError) {
          const status = e.code === "LISTING_NOT_FOUND" ? 404 : e.code === "LISTING_NOT_ACTIVE" ? 409 : 400;
          throw err(status, e.code, e.message);
        }
        throw e;
      }
      const c = await db.query<{ slug: string; name: string }>(`SELECT slug, name FROM collections WHERE id = $1`, [order.collectionId]);
      return sendJson(res, 201, { order: publicOrder(order, c.rows[0], now()) });
    }

    // ---- offers (kisi bhi minted token pe, listed ho ya na ho) ----
    if (method === "GET" && seg.length === 6 && seg[1] === "collections" && seg[3] === "tokens" && seg[5] === "offers") {
      const col = await collectionBySlug(seg[2]);
      const n = parseToken(seg[4]);
      const list = await listOffersForToken(db, col.slug, n);
      return sendJson(res, 200, {
        items: list.map((o) => ({ id: o.id, tokenNumber: o.tokenNumber, buyerAddress: o.buyerAddress, priceZec: formatZec(o.priceZats), status: o.status })),
      });
    }

    if (method === "POST" && path === "/api/offers") {
      limited(orderMin.check(ip));
      limited(orderHour.check(ip));
      const b = (await readJson(req)) as Record<string, unknown> | null;
      if (!b || typeof b !== "object") throw err(400, "BAD_BODY", "JSON object chahiye");
      const { collection, tokenNumber, buyerAddress, priceZec } = b;
      if (typeof collection !== "string" || !SLUG.test(collection)) throw err(400, "BAD_COLLECTION", "collection galat hai");
      if (typeof tokenNumber !== "number" || !Number.isInteger(tokenNumber) || tokenNumber < 1) throw err(400, "BAD_TOKEN", "tokenNumber galat hai");
      if (typeof buyerAddress !== "string" || buyerAddress.length > 100) throw err(400, "BAD_ADDRESS", "buyerAddress galat hai");
      if (typeof priceZec !== "string" || priceZec.length > 30) throw err(400, "BAD_PRICE", "priceZec (string) chahiye");
      let priceZats: bigint;
      try {
        priceZats = parseZec(priceZec);
      } catch {
        throw err(400, "BAD_PRICE", "priceZec galat format me hai");
      }
      let tipHeight: number | undefined;
      if (chain.tipHeight) {
        try {
          tipHeight = await chain.tipHeight();
        } catch {
          throw err(503, "CHAIN_UNAVAILABLE", "Blockchain server abhi nahi mil raha, thodi der baad try karo");
        }
      }
      try {
        const o = await createOffer(db, cfg, { slug: collection, tokenNumber, buyerAddress, priceZats, now: now(), tipHeight });
        return sendJson(res, 201, {
          offer: { id: o.id, tokenNumber: o.tokenNumber, priceZec: formatZec(o.priceZats), status: o.status }, orderId: o.orderId,
          payAddress: o.payAddress, amountZec: formatZec(o.priceZats), expiresAt: o.expiresAt.toISOString(),
        });
      } catch (e) {
        if (e instanceof OfferError) {
          const status = e.code === "COLLECTION_NOT_FOUND" ? 404 : e.code === "INVALID_PRICE" || e.code === "INVALID_ADDRESS" ? 400 : 409;
          throw err(status, e.code, e.message);
        }
        throw e;
      }
    }

    if (method === "POST" && seg.length === 4 && seg[1] === "offers" && (seg[3] === "accept" || seg[3] === "reject" || seg[3] === "cancel")) {
      const id = Number(seg[2]);
      if (!Number.isInteger(id) || id < 1) throw err(400, "BAD_OFFER_ID", "offer id galat hai");
      const b = (await readJson(req)) as Record<string, unknown> | null;
      const address = b && typeof b.address === "string" ? b.address : "";
      if (!address) throw err(400, "BAD_ADDRESS", "address chahiye");
      try {
        if (seg[3] === "accept") await acceptOffer(db, id, address);
        else if (seg[3] === "reject") await rejectOffer(db, id, address);
        else await cancelOffer(db, id, address);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        if (e instanceof OfferError) {
          const status = e.code === "OFFER_NOT_FOUND" ? 404 : e.code === "NOT_OWNER" || e.code === "NOT_BUYER" ? 403 : 409;
          throw err(status, e.code, e.message);
        }
        throw e;
      }
    }

    // ---- creator self-upload: SESSION based, har file seedhe disk pe stream hoti hai ----
    // (bade collection 10 GB ke bhi ho sakte hain -- server ka RAM kabhi nahi bharta)
    if (method === "POST" && path === "/api/creator/sessions") {
      limited(orderHour.check(ip));
      const b = (await readJson(req)) as Record<string, unknown> | null;
      if (!b || typeof b !== "object") throw err(400, "BAD_BODY", "JSON object chahiye");
      const fields = {
        name: String(b.name ?? "").slice(0, 200),
        priceZec: String(b.priceZec ?? "").slice(0, 30),
        maxPerWallet: String(b.maxPerWallet ?? "").slice(0, 10),
          payoutAddress: String(b.payoutAddress ?? "").slice(0, 100),
          description: String(b.description ?? "").slice(0, 2000),
          websiteUrl: String(b.websiteUrl ?? "").slice(0, 500),
          xUrl: String(b.xUrl ?? "").slice(0, 500),
        revealMode: String(b.revealMode ?? "instant").slice(0, 20),
        launchAt: String(b.launchAt ?? "").slice(0, 40),
      };
      const id = await createSession(db, assetsRoot, fields);
      return sendJson(res, 201, { sessionId: id });
    }

    if (method === "POST" && seg.length === 5 && seg[1] === "creator" && seg[2] === "sessions" && seg[4] === "files") {
      const sessionId = seg[3];
      const filename = (url.searchParams.get("name") ?? "").slice(0, 200);
      try {
        const r = await receiveSessionFile(db, req, assetsRoot, sessionId, filename, cfg.maxFileBytes, cfg.maxSessionBytes);
        return sendJson(res, 200, { ok: true, bytes: r.bytes });
      } catch (e) {
        if (e instanceof SessionError) throw err(e.status, "SESSION_FILE_ERROR", e.message);
        throw e;
      }
    }

    if (method === "POST" && seg.length === 5 && seg[1] === "creator" && seg[2] === "sessions" && seg[4] === "finalize") {
      const sessionId = seg[3];
      try {
        const { fields, entries } = await sessionEntries(db, assetsRoot, sessionId);
        let priceZats: bigint;
        try {
          priceZats = parseZec(fields.priceZec);
        } catch {
          throw err(400, "BAD_PRICE", "priceZec galat hai");
        }
        let launchAt: Date | null = null;
        if (fields.launchAt && fields.launchAt.trim()) {
          launchAt = new Date(fields.launchAt);
          if (Number.isNaN(launchAt.getTime())) throw err(400, "BAD_LAUNCH_AT", "launchAt ek valid date/time honi chahiye");
        }
        const r = await submitCollection(db, {
          network: cfg.network, assetsRoot, name: fields.name, maxPerWallet: Number(fields.maxPerWallet), priceZats,
          payoutAddress: fields.payoutAddress, feeBps: 100, holdHours: 72, revealMode: fields.revealMode === "after_soldout" ? "after_soldout" : "instant",
          entries, maxTotalBytes: cfg.maxSessionBytes, launchAt,
          description: fields.description, websiteUrl: fields.websiteUrl || null, xUrl: fields.xUrl || null,
        });
        await cleanupSession(db, assetsRoot, sessionId);
        return sendJson(res, 201, {
          slug: r.slug, supply: r.supply, provenanceHash: r.provenanceHash, status: "pending_review",
          csvMatched: r.csvMatched, csvUnmatched: r.csvUnmatched,
        });
      } catch (e) {
        if (e instanceof SessionError) throw err(e.status, "SESSION_ERROR", e.message);
        if (e instanceof SubmissionError) throw err(400, "SUBMISSION_INVALID", e.message);
        throw e;
      }
    }

    // ---- admin dashboard (password-protected, /admin.html) ----
    if (method === "POST" && path === "/api/admin/login") {
      limited(orderMin.check(ip)); // login pe strict rate limit (brute-force se bachav)
      const b = (await readJson(req)) as Record<string, unknown> | null;
      const password = b && typeof b.password === "string" ? b.password : "";
      if (!verifyAdminPassword(password, cfg.adminPasswordHash)) {
        await new Promise((r) => setTimeout(r, 300)); // galat password pe halka delay (brute-force slow)
        throw err(401, "BAD_PASSWORD", "Password galat hai");
      }
      const token = await createAdminSession(db, cfg.adminSessionHours);
      setCookie(res, "admin_session", token, { maxAgeSec: cfg.adminSessionHours * 3600 });
      return sendJson(res, 200, { ok: true });
    }
    if (method === "POST" && path === "/api/admin/logout") {
      const token = parseCookies(req).admin_session;
      if (token) await deleteAdminSession(db, token);
      clearCookie(res, "admin_session");
      return sendJson(res, 200, { ok: true });
    }
    if (path.startsWith("/api/admin/")) {
      const authed = await checkAdminSession(db, parseCookies(req).admin_session);
      if (!authed) throw err(401, "NOT_LOGGED_IN", "Admin login chahiye");

      if (method === "GET" && path === "/api/admin/stats") {
        const orders = await db.query<any>(`SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE status = 'pending' AND NOT funded AND expires_at > now())::int AS awaiting,
          count(*) FILTER (WHERE status = 'pending' AND funded)::int AS confirming,
          count(*) FILTER (WHERE status = 'paid')::int AS minting,
          count(*) FILTER (WHERE status IN ('expired','refund_needed'))::int AS review,
          COALESCE(sum(amount_zats) FILTER (WHERE status IN ('paid','minted')), 0)::text AS volume_zats
          FROM orders`);
        const payouts = await db.query<any>(`SELECT count(*)::int AS count, COALESCE(sum(amount_zats), 0)::text AS amount_zats FROM payout_requests WHERE status = 'pending'`);
        const payments = await db.query<any>(`SELECT o.id, c.name AS collection_name, o.amount_zats::text, o.status, o.funded,
          o.created_at, o.buyer_address, COALESCE(max(p.confirmations), 0)::int AS confirmations
          FROM orders o JOIN collections c ON c.id = o.collection_id
          LEFT JOIN payments p ON p.order_id = o.id
          WHERE o.status IN ('pending','paid','refund_needed')
          GROUP BY o.id, c.name ORDER BY o.created_at DESC LIMIT 100`);
        return sendJson(res, 200, {
          stats: { total: orders.rows[0].total, awaiting: orders.rows[0].awaiting, confirming: orders.rows[0].confirming,
            minting: orders.rows[0].minting, review: orders.rows[0].review, volumeZats: orders.rows[0].volume_zats,
            payoutCount: payouts.rows[0].count, payoutAmountZats: payouts.rows[0].amount_zats },
          payments: payments.rows.map((x: any) => ({ id: x.id, collectionName: x.collection_name, amountZats: x.amount_zats,
            status: x.status, funded: x.funded, confirmations: x.confirmations, createdAt: x.created_at,
            buyerAddress: x.buyer_address })),
        });
      }

      if (method === "GET" && path === "/api/admin/pending") {
        const rows = await db.query<any>(
          `SELECT slug, name, supply, submitted_at, creator_address,
                  EXISTS (SELECT 1 FROM assets a WHERE a.collection_id = c.id AND a.token_number = 0) AS has_cover
           FROM collections c WHERE status = 'pending_review' ORDER BY submitted_at`
        );
        return sendJson(res, 200, {
          items: rows.rows.map((x: any) => ({
            slug: x.slug, name: x.name, supply: x.supply, submittedAt: x.submitted_at, creatorAddress: x.creator_address,
            coverUrl: x.has_cover ? `/api/admin/collections/${x.slug}/cover` : null,
          })),
        });
      }
      if (method === "GET" && seg.length === 5 && seg[2] === "collections" && seg[4] === "preview") {
        const c = await db.query<{ id: number }>(`SELECT id FROM collections WHERE slug = $1`, [seg[3]]);
        if (!c.rows[0]) throw err(404, "COLLECTION_NOT_FOUND", "collection nahi mili");
        const rows = await db.query<{ token_number: number }>(`SELECT token_number FROM assets WHERE collection_id = $1 AND token_number > 0 ORDER BY token_number LIMIT 12`, [c.rows[0].id]);
        return sendJson(res, 200, { tokenNumbers: rows.rows.map((r) => r.token_number) });
      }
      if ((method === "GET" || method === "HEAD") && seg.length === 5 && seg[2] === "collections" && (seg[4] === "cover" || seg[4] === "image")) {
        const c = await db.query<{ id: number }>(`SELECT id FROM collections WHERE slug = $1`, [seg[3]]);
        if (!c.rows[0]) throw err(404, "COLLECTION_NOT_FOUND", "collection nahi mili");
        const n = seg[4] === "cover" ? 0 : parseToken(url.searchParams.get("n") ?? "");
        const a = await getAsset(db, c.rows[0].id, n);
        if (!a) throw err(404, "NOT_FOUND", "nahi mila");
        return serveAsset(req, res, a);
      }
      if (method === "POST" && path === "/api/admin/approve") {
        const b = (await readJson(req)) as { slug?: string } | null;
        if (!b?.slug) throw err(400, "BAD_SLUG", "slug chahiye");
        try {
          await approveSubmission(db, b.slug);
          return sendJson(res, 200, { ok: true });
        } catch (e) {
          throw err(409, "APPROVE_FAILED", (e as Error).message);
        }
      }
      if (method === "POST" && path === "/api/admin/reject") {
        const b = (await readJson(req)) as { slug?: string; reason?: string } | null;
        if (!b?.slug || !b.reason?.trim()) throw err(400, "BAD_BODY", "slug aur reason chahiye");
        try {
          await rejectSubmission(db, b.slug, b.reason.trim());
          return sendJson(res, 200, { ok: true });
        } catch (e) {
          throw err(409, "REJECT_FAILED", (e as Error).message);
        }
      }
      if (method === "GET" && path === "/api/admin/collections") {
        const rows = await db.query<any>(`SELECT slug, name, status, payout_frozen, frozen_reason FROM collections WHERE status IN ('live','ended') ORDER BY id DESC`);
        return sendJson(res, 200, { items: rows.rows.map((x: any) => ({ slug: x.slug, name: x.name, status: x.status, frozen: x.payout_frozen, frozenReason: x.frozen_reason })) });
      }
      if (method === "GET" && path === "/api/admin/all") {
        const rows = await db.query<any>(
          `SELECT slug, name, status, supply, creator_address, submitted_at, reject_reason, starts_at
           FROM collections WHERE status != 'draft' ORDER BY id DESC LIMIT 300`
        );
        return sendJson(res, 200, {
          items: rows.rows.map((x: any) => ({
            slug: x.slug, name: x.name, status: x.status, supply: x.supply, creatorAddress: x.creator_address,
            submittedAt: x.submitted_at, rejectReason: x.reject_reason, startsAt: x.starts_at,
          })),
        });
      }
      if (method === "POST" && path === "/api/admin/freeze") {
        const b = (await readJson(req)) as { slug?: string; reason?: string } | null;
        if (!b?.slug || !b.reason?.trim()) throw err(400, "BAD_BODY", "slug aur reason chahiye");
        await freezeCollection(db, b.slug, b.reason.trim());
        return sendJson(res, 200, { ok: true });
      }
      if (method === "POST" && path === "/api/admin/unfreeze") {
        const b = (await readJson(req)) as { slug?: string } | null;
        if (!b?.slug) throw err(400, "BAD_SLUG", "slug chahiye");
        await unfreezeCollection(db, b.slug);
        return sendJson(res, 200, { ok: true });
      }
      if (method === "POST" && path === "/api/admin/cancel-collection") {
        const b = (await readJson(req)) as { slug?: string; reason?: string } | null;
        if (!b?.slug || !b.reason?.trim()) throw err(400, "BAD_BODY", "slug aur reason chahiye");
        const s = await cancelCollection(db, b.slug, b.reason.trim());
        return sendJson(res, 200, { ok: true, ordersToRefund: s.ordersToRefund, tokensVoided: s.tokensVoided });
      }
      if (method === "POST" && path === "/api/admin/block") {
        const b = (await readJson(req)) as { slug?: string; tokenNumber?: number; reason?: string } | null;
        if (!b?.slug || !b.tokenNumber || !b.reason?.trim()) throw err(400, "BAD_BODY", "slug, tokenNumber, reason chahiye");
        await blockToken(db, b.slug, b.tokenNumber, b.reason.trim());
        return sendJson(res, 200, { ok: true });
      }
      if (method === "POST" && path === "/api/admin/unblock") {
        const b = (await readJson(req)) as { slug?: string; tokenNumber?: number } | null;
        if (!b?.slug || !b.tokenNumber) throw err(400, "BAD_BODY", "slug aur tokenNumber chahiye");
        await unblockToken(db, b.slug, b.tokenNumber);
        return sendJson(res, 200, { ok: true });
      }
      throw err(404, "NOT_FOUND", "Nahi mila");
    }

    if (method === "POST" && path === "/api/orders") {
      limited(orderMin.check(ip));
      limited(orderHour.check(ip));
      const b = (await readJson(req)) as Record<string, unknown> | null;
      if (!b || typeof b !== "object" || Array.isArray(b)) throw err(400, "BAD_BODY", "JSON object chahiye");
      const { collection, quantity, buyerAddress } = b;
      if (typeof collection !== "string" || !SLUG.test(collection)) throw err(400, "BAD_COLLECTION", "collection (slug) galat hai");
      if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw err(400, "BAD_QUANTITY", "quantity 1..1000 integer honi chahiye");
      if (typeof buyerAddress !== "string" || buyerAddress.length > 100 || !isAddressForNetwork(buyerAddress, cfg.network)) {
        throw err(400, "BAD_ADDRESS", `buyerAddress ${cfg.network} ka valid transparent (t) address hona chahiye`);
      }
      // Chain ka tip: order isse pehle ke payments nahi ginta. Chain na mile to order NAHI banta.
      let tipHeight: number | undefined;
      if (chain.tipHeight) {
        try {
          tipHeight = await chain.tipHeight();
        } catch {
          throw err(503, "CHAIN_UNAVAILABLE", "Blockchain server abhi nahi mil raha, thodi der baad try karo");
        }
      }
      let order: Order;
      try {
        order = await createOrder(db, cfg, { collectionSlug: collection, quantity, buyerAddress, now: now(), tipHeight });
      } catch (e) {
        if (e instanceof OrderError) {
          const status = e.code === "COLLECTION_NOT_FOUND" ? 404 : e.code === "INVALID_QUANTITY" || e.code === "INVALID_BUYER_ADDRESS" ? 400 : 409;
          throw err(status, e.code, e.message);
        }
        throw e;
      }
      const c = (await getCollectionBySlug(db, collection))!;
      return sendJson(res, 201, { order: publicOrder(order, c, now()) });
    }

    if (method === "POST" && seg.length === 4 && seg[1] === "orders" && seg[3] === "cancel") {
      if (!UUID.test(seg[2])) throw err(400, "BAD_ORDER_ID", "order id galat hai");
      let o: Order;
      try {
        o = await cancelPendingOrder(db, seg[2], now());
      } catch (e) {
        if (e instanceof OrderError) throw err(e.code === "ORDER_NOT_FOUND" ? 404 : 409, e.code, e.message);
        throw e;
      }
      const c = await db.query<{ slug: string; name: string }>(`SELECT slug, name FROM collections WHERE id = $1`, [o.collectionId]);
      return sendJson(res, 200, { order: publicOrder(o, c.rows[0], now()) });
    }

    if (method === "GET" && seg.length === 3 && seg[1] === "orders") {
      if (!UUID.test(seg[2])) throw err(400, "BAD_ORDER_ID", "order id galat hai");
      const o = await getOrder(db, seg[2]);
      if (!o) throw err(404, "ORDER_NOT_FOUND", "order nahi mila");
      const c = await db.query<{ slug: string; name: string }>(`SELECT slug, name FROM collections WHERE id = $1`, [o.collectionId]);
      const tk = await db.query<{ token_number: number }>(
        `SELECT token_number FROM tokens WHERE order_id = $1 AND voided_at IS NULL ORDER BY token_number`,
        [o.id]
      );
      const items = await describeTokens(tk.rows.map((x) => ({ collection_id: o.collectionId, slug: c.rows[0].slug, cname: c.rows[0].name, token_number: x.token_number })));
      return sendJson(res, 200, { order: { ...publicOrder(o, c.rows[0], now(), tk.rows.map((x) => x.token_number)), items } });
    }

    if (method === "GET" && seg.length === 3 && seg[1] === "wallet") {
      const addr = seg[2];
      if (addr.length > 100 || !isAddressForNetwork(addr, cfg.network)) throw err(400, "BAD_ADDRESS", "address galat hai");
      const r = await db.query<any>(
        `SELECT c.id AS collection_id, c.slug, c.name AS cname, t.token_number FROM tokens t JOIN collections c ON c.id = t.collection_id
         WHERE t.owner_address = $1 AND t.voided_at IS NULL ORDER BY c.id, t.token_number LIMIT 500`,
        [addr]
      );
      const items = await describeTokens(r.rows);
      return sendJson(res, 200, {
        address: addr,
        tokens: items.map((x) => ({
          collection: x.collection, collectionName: x.collectionName, tokenNumber: x.tokenNumber, name: x.name,
          imageUrl: x.imageUrl, thumbUrl: x.thumbUrl, revealed: x.revealed, blocked: x.blocked, blockedReason: x.blockedReason,
        })),
      });
    }

    if (method === "GET" && seg.length === 4 && seg[1] === "wallet" && seg[3] === "history") {
      const addr = seg[2];
      if (addr.length > 100 || !isAddressForNetwork(addr, cfg.network)) throw err(400, "BAD_ADDRESS", "address galat hai");
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 30) || 30));
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset") ?? 0) || 0));
      const r = await db.query<any>(
        `SELECT o.id, o.kind, o.status, o.quantity, o.amount_zats::text AS amount, o.buyer_address, o.created_at, c.slug, c.name AS cname
         FROM orders o JOIN collections c ON c.id = o.collection_id
         WHERE o.buyer_address = $1 ORDER BY o.created_at DESC LIMIT $2 OFFSET $3`,
        [addr, limit, offset]
      );
      const sold = await db.query<any>(
        `SELECT s.order_id, s.gross_zats::text AS amount, s.created_at, c.slug, c.name AS cname, o.buyer_address AS to_address, l.token_number
         FROM sales s JOIN collections c ON c.id = s.collection_id JOIN orders o ON o.id = s.order_id
         LEFT JOIN listings l ON l.order_id = o.id
         WHERE s.kind = 'resale' AND l.seller_address = $1 ORDER BY s.created_at DESC LIMIT $2 OFFSET $3`,
        [addr, limit, offset]
      );
      return sendJson(res, 200, {
        address: addr,
        purchases: r.rows.map((x) => ({
          orderId: x.id, kind: x.kind, status: x.status, collection: x.slug, collectionName: x.cname,
          quantity: x.quantity, amountZec: formatZec(BigInt(x.amount)), createdAt: new Date(x.created_at).toISOString(),
        })),
        sold: sold.rows.map((x) => ({
          orderId: x.order_id, collection: x.slug, collectionName: x.cname, tokenNumber: x.token_number,
          amountZec: formatZec(BigInt(x.amount)), buyerAddress: x.to_address, createdAt: new Date(x.created_at).toISOString(),
        })),
      });
    }

    throw err(404, "NOT_FOUND", "Nahi mila");
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    route(req, res, url).catch((e: unknown) => {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return sendJson(res, e.status, { error: { code: e.code, message: e.message } }, e.headers);
      console.error("[api] unexpected:", e); // stack sirf server log mein, user ko nahi
      sendJson(res, 500, { error: { code: "INTERNAL", message: "Kuch gadbad hui, baad mein try karo" } });
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;

  return {
    server,
    close: () =>
      new Promise<void>((resolveClose) => {
        clearInterval(sweeper);
        server.close(() => resolveClose());
        server.closeAllConnections?.();
      }),
  };
}

void SECURITY_HEADERS;
