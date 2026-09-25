import type { Db } from "../db/index.js";

export type ActivityKind = "mint" | "list" | "cancel_list" | "sale" | "airdrop" | "offer_made" | "offer_accepted" | "offer_rejected";

export interface ActivityItem {
  id: number;
  kind: ActivityKind;
  collectionSlug: string;
  collectionName: string;
  tokenNumber: number | null;
  amountZats: bigint | null;
  address: string | null;
  detail: string | null;
  createdAt: Date;
}

export async function logActivity(
  db: Db,
  collectionId: number,
  kind: ActivityKind,
  fields: { tokenNumber?: number; amountZats?: bigint; address?: string; detail?: string } = {}
): Promise<void> {
  await db.query(
    `INSERT INTO activity (kind, collection_id, token_number, amount_zats, address, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
    [kind, collectionId, fields.tokenNumber ?? null, fields.amountZats?.toString() ?? null, fields.address ?? null, fields.detail ?? null]
  );
}

export async function listActivity(db: Db, opts: { slug?: string; limit?: number; offset?: number } = {}): Promise<{ total: number; items: ActivityItem[] }> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
  const offset = Math.max(0, opts.offset ?? 0);
  const params: unknown[] = [limit, offset];
  if (opts.slug) params.push(opts.slug);
  const total = (
    await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM activity a JOIN collections c ON c.id = a.collection_id ${opts.slug ? "WHERE c.slug = $1" : ""}`,
      opts.slug ? [opts.slug] : []
    )
  ).rows[0].n;
  const where = opts.slug ? `WHERE c.slug = $3` : ``;
  const r = await db.query<any>(
    `SELECT a.id, a.kind, c.slug, c.name AS cname, a.token_number, a.amount_zats::text AS amount, a.address, a.detail, a.created_at
     FROM activity a JOIN collections c ON c.id = a.collection_id ${where}
     ORDER BY a.id DESC LIMIT $1 OFFSET $2`,
    params
  );
  return {
    total,
    items: r.rows.map((x) => ({
      id: x.id,
      kind: x.kind,
      collectionSlug: x.slug,
      collectionName: x.cname,
      tokenNumber: x.token_number,
      amountZats: x.amount !== null ? BigInt(x.amount) : null,
      address: x.address,
      detail: x.detail,
      createdAt: new Date(x.created_at),
    })),
  };
}
