import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { formatZec } from "../src/money.js";
import { cancelPayoutRequest, collectionStats, listPayoutRequests, markPayoutSent, runReleases } from "../src/services/ledger.js";
import { blockToken, cancelCollection, endCollection, freezeCollection, reportCollection, unblockToken, unfreezeCollection } from "../src/services/moderation.js";
import { approveSubmission, listPendingReview, rejectSubmission } from "../src/services/creator-submit.js";
import { airdrop } from "../src/services/mint.js";
import { setSetting } from "../src/services/settings.js";
import { promptLine } from "../src/util/prompt.js";

/**
 * Admin commands:
 *   npm run admin -- stats <slug>
 *   npm run admin -- end <slug>
 *   npm run admin -- freeze <slug> "<reason>"
 *   npm run admin -- unfreeze <slug>
 *   npm run admin -- cancel <slug> "<reason>" [--yes]
 *   npm run admin -- report <slug> <buyerAddress> "<reason>"
 *   npm run admin -- release
 *   npm run admin -- payouts
 *   npm run admin -- payout-sent <id> <txid>
 *   npm run admin -- payout-cancel <id>
 *   npm run admin -- review                          (pending creator submissions dekho)
 *   npm run admin -- approve <slug>                   (submission ko live karo)
 *   npm run admin -- reject <slug> "<reason>"
 *   npm run admin -- block <slug> <tokenNumber> "<reason>"   (chori/report hui NFT trade hone se roko)
 *   npm run admin -- unblock <slug> <tokenNumber>
 *   npm run admin -- verify <slug> true|false|auto    (blue-tick override)
 *   npm run admin -- set-rate usd|inr <rate>           (multi-currency display rate)
 *   npm run admin -- airdrop <slug> <address> [count]  (free mint, payment ke bina)
 */
const [cmd, a1, a2, a3, a4] = process.argv.slice(2).filter((x) => x !== "--yes");
const yes = process.argv.includes("--yes");
const cfg = loadConfig();
const db = await openDb(cfg.dbDir);
const need = (v: string | undefined, name: string) => {
  if (!v) {
    console.error(`Missing: ${name}. Dekho file ke upar wala usage.`);
    process.exit(1);
  }
  return v;
};
const z = (v: bigint) => `${formatZec(v)} ZEC`;

try {
  switch (cmd) {
    case "stats": {
      const s = await collectionStats(db, need(a1, "slug"));
      console.log(`\n${s.slug}  [${s.status}]${s.frozen ? "  FROZEN: " + s.frozenReason : ""}`);
      console.log(`  minted        : ${s.minted}/${s.supply}   sales: ${s.salesCount}`);
      console.log(`  gross         : ${z(s.grossZats)}`);
      console.log(`  platform fee  : ${z(s.platformFeeZats)}   (tumhari kamai)`);
      console.log(`  creator net   : ${z(s.creatorNetZats)}`);
      console.log(`     held (ruka): ${z(s.heldZats)}`);
      console.log(`     requested  : ${z(s.requestedZats)}   paid: ${z(s.paidZats)}`);
      console.log(`  settled_at    : ${s.settledAt?.toISOString() ?? "abhi nahi (sold out / end hone ka intezaar)"}`);
      console.log(`  release_at    : ${s.releaseAt?.toISOString() ?? "-"}`);
      console.log(`  creator addr  : ${s.payoutAddress ?? "SET NAHI (payout nahi banega)"}\n`);
      break;
    }
    case "end":
      await endCollection(db, need(a1, "slug"));
      console.log("Collection end ho gayi (nayi sales band, hold ki ghadi shuru).");
      break;
    case "freeze":
      await freezeCollection(db, need(a1, "slug"), need(a2, "reason"));
      console.log("Freeze: payouts aur nayi sales band.");
      break;
    case "unfreeze":
      await unfreezeCollection(db, need(a1, "slug"));
      console.log("Unfreeze ho gayi.");
      break;
    case "cancel": {
      const slug = need(a1, "slug");
      const reason = need(a2, "reason");
      if (!yes) {
        const c = (await promptLine(`'${slug}' CANCEL hogi, saare buyers ko refund milega. Confirm ke liye CANCEL likho: `)).trim();
        if (c !== "CANCEL") {
          console.log("Ruk gaya.");
          break;
        }
      }
      const s = await cancelCollection(db, slug, reason);
      console.log(`Cancel ho gayi. Refund orders: ${s.ordersToRefund} (${z(s.refundZats)}), tokens void: ${s.tokensVoided}`);
      console.log(`Creator ko pehle hi bheja gaya: ${z(s.alreadyPaidToCreatorZats)}`);
      console.log("Ab chalao: npm run refunds:plan");
      break;
    }
    case "report": {
      const r = await reportCollection(db, need(a1, "slug"), need(a2, "buyerAddress"), need(a3, "reason"), cfg);
      console.log(`Reports: ${r.reports}/${r.threshold}  ${r.frozen ? "=> AUTO-FREEZE" : ""}`);
      break;
    }
    case "release": {
      const r = await runReleases(db, { minPayoutZats: cfg.minPayoutZats, dustZats: cfg.minRefundNetZats });
      for (const s of r.settled) console.log(`SETTLED: ${s}`);
      for (const c of r.created) console.log(`PAYOUT REQUEST #${c.id} [${c.kind}] ${c.slug}: ${z(c.amountZats)} -> ${c.address}`);
      for (const s of r.skipped) console.log(`SKIP ${s.slug}: ${s.reason}`);
      if (!r.settled.length && !r.created.length && !r.skipped.length) console.log("Abhi kuch release karne layak nahi.");
      break;
    }
    case "payouts": {
      const ps = await listPayoutRequests(db);
      if (!ps.length) console.log("Koi payout request nahi.");
      for (const p of ps) console.log(`payout#${p.id} ${p.status.padEnd(9)} ${p.kind.padEnd(7)} ${p.slug} ${z(p.amountZats)} -> ${p.address}${p.txid ? " txid=" + p.txid : ""}`);
      break;
    }
    case "payout-sent":
      await markPayoutSent(db, Number(need(a1, "id")), need(a2, "txid"));
      console.log("payout 'sent' mark hua.");
      break;
    case "payout-cancel":
      await cancelPayoutRequest(db, Number(need(a1, "id")));
      console.log("payout request cancel (paisa wapas held).");
      break;
    case "review": {
      const pend = await listPendingReview(db);
      if (!pend.length) console.log("Koi pending submission nahi.");
      for (const p of pend) console.log(`${p.slug}  "${p.name}"  supply=${p.supply}  creator=${p.creatorAddress ?? "-"}  submitted=${p.submittedAt?.toISOString() ?? "-"}`);
      break;
    }
    case "approve":
      await approveSubmission(db, need(a1, "slug"));
      console.log("Approve ho gaya, collection ab LIVE hai.");
      break;
    case "reject":
      await rejectSubmission(db, need(a1, "slug"), need(a2, "reason"));
      console.log("Reject ho gaya.");
      break;
    case "block":
      await blockToken(db, need(a1, "slug"), Number(need(a2, "tokenNumber")), need(a3, "reason"));
      console.log("Token blocked (trade nahi ho sakega; active listing bhi cancel ho gayi).");
      break;
    case "unblock":
      await unblockToken(db, need(a1, "slug"), Number(need(a2, "tokenNumber")));
      console.log("Token unblocked.");
      break;
    case "verify": {
      const slug = need(a1, "slug");
      const v = need(a2, "true|false|auto");
      const val = v === "auto" ? null : v === "true";
      await db.query(`UPDATE collections SET verified_override = $2 WHERE slug = $1`, [slug, val]);
      console.log(`verified_override = ${val === null ? "auto (volume ke hisaab se)" : val}`);
      break;
    }
    case "set-rate": {
      const cur = need(a1, "usd|inr");
      if (cur !== "usd" && cur !== "inr") throw new Error("currency 'usd' ya 'inr' honi chahiye");
      await setSetting(db, `rate_${cur}`, need(a2, "rate"));
      console.log(`1 ZEC = ${a2} ${cur.toUpperCase()} set ho gaya (turant asar).`);
      break;
    }
    case "airdrop": {
      const picked = await airdrop(db, cfg, need(a1, "slug"), need(a2, "address"), a3 ? Number(a3) : 1);
      console.log(`Airdrop ho gaya: tokens #${picked.join(", #")} -> ${a2}`);
      break;
    }
    default:
      console.error("Commands: stats | end | freeze | unfreeze | cancel | report | release | payouts | payout-sent | payout-cancel | review | approve | reject | block | unblock | verify | set-rate | airdrop");
      process.exitCode = 1;
  }
} catch (e) {
  console.error("Error:", (e as Error).message);
  process.exitCode = 1;
}
await db.close();
