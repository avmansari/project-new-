import type { Network } from "../config.js";
import type { Db } from "../db/index.js";
import { isAddressForNetwork } from "../zcash/address.js";

export type CollectionStatus = "draft" | "pending_review" | "live" | "ended" | "cancelled";

export interface Collection {
  id: number;
  slug: string;
  name: string;
  supply: number;
  priceZats: bigint;
  maxPerWallet: number;
  status: CollectionStatus;
  creatorAddress: string | null;
  feeBps: number;
  holdHours: number;
  advanceBps: number;
  payoutFrozen: boolean;
  frozenReason: string | null;
  /** "instant": mint hote hi image. "after_soldout": sold out hone tak sabko placeholder. */
  revealMode: "instant" | "after_soldout";
  provenanceHash: string | null;
  /** Set ho to isse pehle mint nahi ho sakta (collection dikhti hai, bas order create fail hota hai). */
  startsAt: Date | null;
  description: string;
  websiteUrl: string | null;
  xUrl: string | null;
  metadataJson: string | null;
}

export interface NewCollection {
  slug: string;
  name: string;
  supply: number;
  priceZats: bigint;
  maxPerWallet: number;
  status?: CollectionStatus;
  /** Creator ka payout address. Diya ho to `network` bhi do taaki address validate ho. */
  creatorAddress?: string;
  network?: Network;
  /** Platform fee, basis points (100 = 1%). Default 100. Max 1000 (10%). */
  feeBps?: number;
  /** Settlement (sold out / ended) ke baad kitne ghante paisa ruka rahe. Default 72. */
  holdHours?: number;
  /** Trusted creator ko turant kitna % (bps). Default 0 = kuch nahi. */
  advanceBps?: number;
  revealMode?: "instant" | "after_soldout";
  /** Scheduled launch: isse pehle order/mint nahi ho sakta. null/undefined = turant chalu. */
  startsAt?: Date | null;
  description?: string;
  websiteUrl?: string | null;
  xUrl?: string | null;
  metadataJson?: string | null;
}

export const COLLECTION_COLS = `id, slug, name, supply, price_zats::text AS price_zats, max_per_wallet, status,
  creator_address, fee_bps, hold_hours, advance_bps, payout_frozen, frozen_reason, reveal_mode, provenance_hash, starts_at,
  description, website_url, x_url, metadata_json`;

export function mapCollection(r: any): Collection {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    supply: r.supply,
    priceZats: BigInt(r.price_zats),
    maxPerWallet: r.max_per_wallet,
    status: r.status,
    creatorAddress: r.creator_address ?? null,
    feeBps: r.fee_bps,
    holdHours: r.hold_hours,
    advanceBps: r.advance_bps,
    payoutFrozen: r.payout_frozen,
    frozenReason: r.frozen_reason ?? null,
    revealMode: r.reveal_mode,
    provenanceHash: r.provenance_hash ?? null,
    startsAt: r.starts_at ? new Date(r.starts_at) : null,
    description: r.description ?? "",
    websiteUrl: r.website_url ?? null,
    xUrl: r.x_url ?? null,
    metadataJson: r.metadata_json ?? null,
  };
}

export async function createCollection(db: Db, input: NewCollection): Promise<Collection> {
  if (!/^[a-z0-9-]{2,40}$/.test(input.slug)) {
    throw new Error("slug sirf a-z, 0-9 aur '-' ho sakta hai (2-40 chars)");
  }
  if (!Number.isInteger(input.supply) || input.supply < 1) throw new Error("supply >= 1 integer honi chahiye");
  if (!Number.isInteger(input.maxPerWallet) || input.maxPerWallet < 1) throw new Error("maxPerWallet >= 1 honi chahiye");
  if (input.priceZats <= 0n) throw new Error("price > 0 honi chahiye");

  const feeBps = input.feeBps ?? 100;
  const holdHours = input.holdHours ?? 72;
  const advanceBps = input.advanceBps ?? 0;
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) throw new Error("feeBps 0..1000 (max 10%) hona chahiye");
  if (!Number.isInteger(holdHours) || holdHours < 0 || holdHours > 24 * 90) throw new Error("holdHours 0..2160 hona chahiye");
  if (!Number.isInteger(advanceBps) || advanceBps < 0 || advanceBps > 10000) throw new Error("advanceBps 0..10000 hona chahiye");
  const revealMode = input.revealMode ?? "instant";
  if (revealMode !== "instant" && revealMode !== "after_soldout") throw new Error("revealMode 'instant' ya 'after_soldout' hona chahiye");
  if (input.startsAt && Number.isNaN(input.startsAt.getTime())) throw new Error("startsAt ek valid date honi chahiye");
  for (const [label, value] of [["website", input.websiteUrl], ["X", input.xUrl]] as const) {
    if (value && (!/^https:\/\//i.test(value) || value.length > 500)) throw new Error(`${label} URL https:// se shuru honi chahiye`);
  }
  if (input.creatorAddress) {
    if (!input.network) throw new Error("creatorAddress ke saath network bhi do (validation ke liye)");
    if (!isAddressForNetwork(input.creatorAddress, input.network)) {
      throw new Error(`creatorAddress ${input.network} ka valid t-address nahi hai`);
    }
  }

  const res = await db.query(
    `INSERT INTO collections (slug, name, supply, price_zats, max_per_wallet, status, creator_address, fee_bps, hold_hours, advance_bps, reveal_mode, starts_at, description, website_url, x_url, metadata_json)
     VALUES ($1,$2,$3,$4::bigint,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING ${COLLECTION_COLS}`,
    [
      input.slug, input.name, input.supply, input.priceZats.toString(), input.maxPerWallet,
      input.status ?? "live", input.creatorAddress ?? null, feeBps, holdHours, advanceBps, revealMode,
      input.startsAt ? input.startsAt.toISOString() : null,
      input.description?.trim().slice(0, 2000) ?? "", input.websiteUrl ?? null, input.xUrl ?? null, input.metadataJson ?? null,
    ]
  );
  return mapCollection(res.rows[0]);
}

/** Admin/creator collection ka scheduled launch time badal sakta hai (approve ke baad bhi). */
export async function setLaunchTime(db: Db, slug: string, startsAt: Date | null): Promise<void> {
  if (startsAt && Number.isNaN(startsAt.getTime())) throw new Error("startsAt ek valid date honi chahiye");
  const r = await db.query(`UPDATE collections SET starts_at = $2 WHERE slug = $1 RETURNING id`, [slug, startsAt ? startsAt.toISOString() : null]);
  if (!r.rows[0]) throw new Error("collection nahi mili");
}

export async function getCollectionBySlug(db: Db, slug: string): Promise<Collection | null> {
  const res = await db.query(`SELECT ${COLLECTION_COLS} FROM collections WHERE slug = $1`, [slug]);
  return res.rows[0] ? mapCollection(res.rows[0]) : null;
}
