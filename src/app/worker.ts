import type { ChainClient } from "../chain/types.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { runReleases, type ReleaseResult } from "../services/ledger.js";
import { releaseStaleListings, settlePaidPurchases, type PurchaseOutcome } from "../services/marketplace.js";
import { mintPaidOrders, type MintResult } from "../services/mint.js";
import { activatePaidOffers, expireStaleOffers } from "../services/offers.js";
import { trackRefunds, type TrackSummary } from "../services/refund-tracker.js";
import { scanOnce, type ScanSummary } from "../watcher/scan.js";

export type WorkerCfg = Pick<
  AppConfig,
  "minConfirmations" | "lateGraceHours" | "minPayoutZats" | "minRefundNetZats" | "refundExpiryMargin" | "refundStuckMinutes"
>;

export interface TickResult {
  scan: ScanSummary;
  minted: MintResult[];
  purchases: { orderId: string; outcome: PurchaseOutcome }[];
  listingsReleased: number;
  offersActivated: number;
  offersExpired: number;
  track: TrackSummary | null;
  release: ReleaseResult;
}

/** Ek round: payments dekho => mint => refund tracker => creator release. Sab idempotent. */
export async function runTick(db: Db, chain: ChainClient, cfg: WorkerCfg, now: Date = new Date()): Promise<TickResult> {
  const scan = await scanOnce(db, chain, cfg, now);
  const minted = await mintPaidOrders(db);
  const purchases = await settlePaidPurchases(db);
  const listingsReleased = await releaseStaleListings(db);
  const offersActivated = await activatePaidOffers(db);
  const offersExpired = await expireStaleOffers(db, now);
  let track: TrackSummary | null = null;
  try {
    track = await trackRefunds(db, chain, cfg, now);
  } catch (e) {
    console.error("[refund-tracker]", (e as Error).message);
  }
  const release = await runReleases(db, { minPayoutZats: cfg.minPayoutZats, dustZats: cfg.minRefundNetZats }, now);
  return { scan, minted, purchases, listingsReleased, offersActivated, offersExpired, track, release };
}

export function formatTick(r: TickResult, now: Date = new Date()): string {
  const parts = [`[${now.toISOString()}] scanned=${r.scan.scanned} errors=${r.scan.errors}`];
  if (r.scan.ignoredOld) parts.push(`ignored_old=${r.scan.ignoredOld}`);
  if (r.scan.transitions.length) parts.push("CHANGES: " + r.scan.transitions.map((t) => `${t.orderId.slice(0, 8)}: ${t.from} -> ${t.to}`).join(", "));
  const m = r.minted.filter((x) => x.outcome !== "already_minted");
  if (m.length) parts.push("MINT: " + m.map((x) => `${x.orderId.slice(0, 8)}: ${x.outcome}${x.tokenNumbers ? " #" + x.tokenNumbers.join(",#") : ""}${x.reason ? " (" + x.reason + ")" : ""}`).join(", "));
  const p = r.purchases.filter((x) => x.outcome === "sold");
  if (p.length) parts.push("SALE: " + p.map((x) => `${x.orderId.slice(0, 8)}: sold`).join(", "));
  if (r.listingsReleased) parts.push(`listings_released=${r.listingsReleased}`);
  if (r.offersActivated) parts.push(`offers_activated=${r.offersActivated}`);
  if (r.offersExpired) parts.push(`offers_expired=${r.offersExpired}`);
  if (r.track) {
    const t = [...r.track.confirmed.map((i) => `refund#${i}:CONFIRMED`), ...r.track.failed.map((i) => `refund#${i}:FAILED`), ...r.track.alerts.map((i) => `refund#${i}:ALERT`)];
    if (t.length) parts.push("TRACK: " + t.join(", "));
  }
  const rel = [...r.release.settled.map((x) => `settled:${x}`), ...r.release.created.map((c) => `payout#${c.id}:${c.slug}`)];
  if (rel.length) parts.push("RELEASE: " + rel.join(", "));
  return parts.join("  ");
}

export interface WorkerHandle {
  stop(): Promise<void>;
}

/** Background loop. Ek tick khatam hone ke baad hi agla shuru (overlap nahi). */
export function startWorker(
  db: Db,
  chain: ChainClient,
  cfg: WorkerCfg,
  opts: { intervalMs: number; onTick?: (r: TickResult) => void; onError?: (e: unknown) => void }
): WorkerHandle {
  let running = true;
  let wake: (() => void) | null = null;
  const sleep = (ms: number) =>
    new Promise<void>((res) => {
      const t = setTimeout(res, ms);
      wake = () => {
        clearTimeout(t);
        res();
      };
    });
  const loop = (async () => {
    while (running) {
      try {
        opts.onTick?.(await runTick(db, chain, cfg));
      } catch (e) {
        opts.onError?.(e);
      }
      if (running) await sleep(opts.intervalMs);
    }
  })();
  return {
    async stop() {
      running = false;
      wake?.();
      await loop;
    },
  };
}
