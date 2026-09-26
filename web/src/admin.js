// Owner dashboard (admin.html): revenue from all 3 fee sources, users, volume, and owner-only settings.
// Data comes from the same indexer as the app (or the hosted indexer when VITE_INDEXER_URL is set).
import * as chain from "./chain.js";
import { indexer } from "./indexer.js";
import { lineChart, onResize } from "./charts.js";
import { ethUsd, usdOf } from "./price.js";
import { pickWallet, restoreWallet, rememberWallet } from "./wallets.js";
import { $, fmtEth, fmtAmt, fmtDur, short, errMsg, escapeHtml } from "./store.js";
import { usd, ethUsdCached } from "./price.js";
import { analyticsUrl } from "./analytics.js";

const DAY = 86400_000;
let rangeDays = 1;
let wallet = null;
let info = null;

const lc = (a) => a?.toLowerCase();
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0n);

function collect() {
  const claims = indexer.events("token", "BlockMined").map((e) => ({ t: Number(e.args.timestamp) * 1000, fee: e.args.feePaid, who: e.args.miner }));
  const trades = indexer.events("market", "Trade").map((e) => ({ t: Number(e.args.timestamp) * 1000, fee: e.args.fee, vol: e.args.ethPaid, who: [e.args.buyer, e.args.seller] }));
  const swaps = indexer.events("pool", "Swap").map((e) => ({ t: Number(e.args.timestamp) * 1000, fee: e.args.protocolFee, vol: e.args.ethAmount, who: [e.args.trader] }));
  return { claims, trades, swaps };
}

function holders() {
  const bal = new Map();
  const skip = new Set(["0x0000000000000000000000000000000000000000", lc(chain.MARKET_CONTRACT?.address), lc(chain.POOL_CONTRACT?.address)]);
  for (const e of indexer.events("token", "Transfer")) {
    bal.set(lc(e.args.from), (bal.get(lc(e.args.from)) ?? 0n) - e.args.value);
    bal.set(lc(e.args.to), (bal.get(lc(e.args.to)) ?? 0n) + e.args.value);
  }
  let n = 0;
  for (const [a, v] of bal) if (v > 0n && !skip.has(a)) n++;
  return n;
}

async function render() {
  if (!wallet || !info) return;
  const { claims, trades, swaps } = collect();
  const cutoff = rangeDays ? Date.now() - rangeDays * DAY : 0;
  const inR = (x) => x.t >= cutoff;
  const c = claims.filter(inR);
  const t = trades.filter(inR);
  const s = swaps.filter(inR);

  const claimFees = sum(c, (x) => x.fee);
  const marketFees = sum(t, (x) => x.fee);
  const dexFees = sum(s, (x) => x.fee);
  const total = claimFees + marketFees + dexFees;
  $("adTotal").textContent = fmtEth(total, 6);
  $("adTotalUsd").textContent = usdOf(total);
  $("adClaim").textContent = fmtEth(claimFees, 6);
  $("adClaimN").textContent = `${c.length} claims ${usdOf(claimFees)}`;
  $("adMarket").textContent = fmtEth(marketFees, 6);
  $("adMarketN").textContent = `${t.length} trades ${usdOf(marketFees)}`;
  if ($("adDex")) $("adDex").textContent = fmtEth(dexFees, 6);
  if ($("adDexN")) $("adDexN").textContent = `${s.length} swaps ${usdOf(dexFees)}`;

  const miners = new Set(c.map((x) => lc(x.who)));
  const traders = new Set([...t, ...s].flatMap((x) => x.who.map(lc)));
  traders.delete(lc(chain.POOL_CONTRACT?.address));
  $("adUsers").textContent = new Set([...miners, ...traders]).size.toLocaleString("en");
  $("adMiners").textContent = miners.size.toLocaleString("en");
  $("adTraders").textContent = traders.size.toLocaleString("en");
  $("adHolders").textContent = holders().toLocaleString("en");
  const bookVol = sum(t, (x) => x.vol);
  const dexVol = sum(s, (x) => x.vol);
  $("adBookVol").textContent = `${fmtEth(bookVol, 4)} ${usdOf(bookVol)}`;
  if ($("adDexVol")) $("adDexVol").textContent = `${fmtEth(dexVol, 4)} ${usdOf(dexVol)}`;
  $("adBlocks").textContent = c.length.toLocaleString("en");
  $("adTrades").textContent = (t.length + s.length).toLocaleString("en");

  // revenue per day (all sources), within range
  const days = new Map();
  for (const x of [...c, ...t, ...s]) {
    const d = Math.floor(x.t / DAY) * DAY;
    days.set(d, (days.get(d) ?? 0n) + x.fee);
  }
  const pts = [...days.entries()].sort((a, b) => a[0] - b[0]).map(([d, v]) => ({ t: d, y: Number(v) / 1e18 }));
  lineChart($("chRevenue"), pts, { label: "Revenue", yFmt: (v) => `${+v.toPrecision(4)} ETH`, empty: "Needs revenue on at least 2 different days" });

  renderAlerts();
  $("adWallet").textContent = fmtEth(await chain.ethBalanceWei(info.feeRecipient), 5);
  $("adWalletAddr").textContent = short(info.feeRecipient);
}

// ---------------- alerts ----------------
const AL_KEY = "pow-admin-alerts";
const alPrefs = (() => {
  try {
    return JSON.parse(localStorage.getItem(AL_KEY)) || {};
  } catch {
    return {};
  }
})();
const saveAl = () => {
  try {
    localStorage.setItem(AL_KEY, JSON.stringify(alPrefs));
  } catch {}
};
let alType = "all";
let seen = null; // alert ids already shown (for new-alert notifications)

function alerts() {
  const out = [];
  const p = ethUsdCached();
  const minUsd = Number(alPrefs.min ?? 100);
  const mk = (e, type, amount, text) => ({ id: `${e.block}-${e.logIndex}-${type}`, type, amount, text, tx: e.tx, block: e.block, logIndex: e.logIndex, t: e.args.timestamp ? Number(e.args.timestamp) * 1000 : null });
  for (const e of indexer.events("token", "BlockMined")) {
    out.push(mk(e, "claim", e.args.feePaid ?? 0n, `⛏️ Block #${e.args.height} claimed by ${short(e.args.miner)}`));
    if (e.args.feePaid > 0n) out.push(mk(e, "fee", e.args.feePaid, `💰 Claim fee +${usd(e.args.feePaid)} (block #${e.args.height})`));
  }
  for (const e of indexer.events("market", "Trade")) {
    const a = e.args;
    const valueUsd = p ? (Number(a.ethPaid) / 1e18) * p : null;
    if (valueUsd !== null && valueUsd >= minUsd)
      out.push(mk(e, "big", a.ethPaid, `🐳 Big trade ${usd(a.ethPaid)}: ${a.lots} lot(s) @ ${usd(a.pricePerLot)} · ${short(a.seller)} → ${short(a.buyer)}`));
    if (a.fee > 0n) out.push(mk(e, "fee", a.fee, `💰 Marketplace fee +${usd(a.fee)} (trade ${usd(a.ethPaid)})`));
  }
  for (const e of indexer.events("market", "OfferMade")) {
    const a = e.args;
    const total = a.lots * a.pricePerLot;
    out.push(mk(e, "offer", total, `💬 Offer ${usd(total)}: ${a.lots} lot(s) @ ${usd(a.pricePerLot)} on listing #${a.listingId} by ${short(a.buyer)}`));
  }
  for (const e of indexer.events("pool", "Swap")) {
    if (e.args.protocolFee > 0n) out.push(mk(e, "fee", e.args.protocolFee, `💰 DEX fee +${usd(e.args.protocolFee)}`));
  }
  return out;
}

function renderAlerts() {
  const all = alerts();
  const list = all.filter((a) => alType === "all" || a.type === alType);
  if ($("alSort").value === "amount") list.sort((a, b) => (a.amount === b.amount ? 0 : a.amount < b.amount ? 1 : -1));
  else list.sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block < b.block ? 1 : -1));
  const tag = { big: "big trade", fee: "fee", claim: "claim", offer: "offer" };
  $("alList").innerHTML = list.length
    ? list
        .slice(0, 200)
        .map((a) => {
          const url = chain.explorerTx(a.tx);
          const when = a.t ? `${fmtDur(Math.max(0, (Date.now() - a.t) / 1000))} ago` : `block ${a.block}`;
          return `<li><span class="al-tag">${tag[a.type]}</span><span>${escapeHtml(a.text)}</span><span class="al-when">${when}${url ? ` · <a href="${url}" target="_blank" rel="noopener">tx</a>` : ""}</span></li>`;
        })
        .join("")
    : `<li class="muted">No alerts${alType === "big" && !ethUsdCached() ? " (big trades need the live $ price)" : ""}</li>`;
  $("alCount").textContent = `${list.length} alert(s)${list.length > 200 ? " · showing 200" : ""}`;

  // browser notification for alerts that arrived while the dashboard is open
  const ids = new Set(all.map((a) => a.id));
  if (seen && alPrefs.notify && "Notification" in window && Notification.permission === "granted") {
    const fresh = all.filter((a) => !seen.has(a.id) && a.type !== "claim");
    for (const a of fresh.slice(0, 3)) {
      try {
        new Notification("Owner alert", { body: a.text, tag: a.id });
      } catch {}
    }
  }
  seen = ids;
}

async function loadInfo() {
  info = await chain.adminInfo();
  $("adSettings").textContent =
    `Claim fee: ${fmtEth(info.mintFee, 8)} ${usdOf(info.mintFee)} · marketplace fee: ${Number(info.marketFee ?? 0) / 100}% · ` +
    (chain.hasPool ? `DEX fee: ${Number(info.poolFee ?? 0) / 100}% (+0.3% LPs) · ` : "") +
    `fee wallet: ${short(info.feeRecipient)} · owner: ${short(info.tokenOwner)}`;
  // H-1 safety net: fees that could not be pushed to the fee wallet
  const owed = info.feesOwed;
  const totalOwed = owed.token + owed.market + owed.pool;
  $("adOwed").classList.toggle("hidden", totalOwed === 0n);
  if (totalOwed > 0n)
    $("adOwedText").textContent = `${fmtEth(totalOwed, 6)} of fees could not be sent to the fee wallet (it rejected ETH). Make sure the fee wallet can receive ETH, then click below.`;
  const a = analyticsUrl();
  $("adAnalytics").innerHTML = a ? `📈 Visitors & mining analytics: <a href="${a}" target="_blank" rel="noopener">open Plausible dashboard</a>` : "📈 Analytics is off (set VITE_PLAUSIBLE_DOMAIN to turn it on).";
}

function allowed(addr) {
  const a = lc(addr);
  return [info.tokenOwner, info.feeRecipient, info.marketOwner, info.poolOwner].filter(Boolean).map(lc).includes(a);
}

async function connect(picked, silent = false) {
  wallet = await chain.connectProvider(picked.provider, { silent });
  rememberWallet(picked.id);
  $("btnConnect").textContent = short(wallet.address);
  await loadInfo();
  if (!allowed(wallet.address)) {
    $("gate").innerHTML = `<p>This wallet (<span class="mono">${short(wallet.address)}</span>) is not the owner or fee wallet.</p>`;
    $("dash").classList.add("hidden");
    return;
  }
  $("gate").classList.add("hidden");
  $("dash").classList.remove("hidden");
  render();
}

const status = (m) => ($("adStatus").textContent = m);
async function act(label, fn) {
  if (!wallet) return;
  if (lc(wallet.address) !== lc(info.tokenOwner)) return status("Only the contract owner can change settings.");
  try {
    status(`${label}: confirm in your wallet…`);
    await fn();
    await loadInfo(); // refresh numbers first, then report
    status(`✓ ${label} done`);
  } catch (e) {
    status(`${label} failed: ${errMsg(e)}`);
  }
}

const pctToBps = (v) => BigInt(Math.round(Number(v) * 100));

// alerts controls
document.querySelectorAll("[data-al]").forEach((b) => {
  b.onclick = () => {
    alType = b.dataset.al;
    document.querySelectorAll("[data-al]").forEach((x) => x.classList.toggle("active", x === b));
    renderAlerts();
  };
});
$("alSort").value = alPrefs.sort ?? "new";
$("alMin").value = alPrefs.min ?? 100;
$("alNotify").checked = !!alPrefs.notify && "Notification" in window && Notification.permission === "granted";
$("alSort").onchange = () => {
  alPrefs.sort = $("alSort").value;
  saveAl();
  renderAlerts();
};
$("alMin").onchange = () => {
  alPrefs.min = Number($("alMin").value) || 0;
  saveAl();
  renderAlerts();
};
$("alNotify").onchange = async () => {
  if ($("alNotify").checked && "Notification" in window) $("alNotify").checked = (await Notification.requestPermission()) === "granted";
  alPrefs.notify = $("alNotify").checked;
  saveAl();
};
$("adOwedGo").onclick = () =>
  act("Fee delivery", async () => {
    for (const c of ["token", "market", "pool"]) if (info.feesOwed[c] > 0n) await chain.adminCall(wallet, c, "withdrawFees", []);
  });

$("btnConnect").onclick = async () => {
  const picked = await pickWallet();
  if (picked) connect(picked).catch((e) => alert(errMsg(e)));
};
document.querySelectorAll("[data-arange]").forEach((b) => {
  b.onclick = () => {
    rangeDays = Number(b.dataset.arange);
    document.querySelectorAll("[data-arange]").forEach((x) => x.classList.toggle("active", x === b));
    render();
  };
});
$("adSyncFee").onclick = () =>
  act("Claim fee update", async () => {
    const price = await ethUsd();
    if (!price) throw new Error("Could not fetch the ETH price");
    const wei = (10n ** 18n * 100_000n) / BigInt(Math.round(price * 1e6)); // $0.10 = 100,000 micro-dollars
    await chain.adminCall(wallet, "token", "setMintFeeWei", [wei]);
  });
$("adMarketFeeGo").onclick = () =>
  act("Marketplace fee update", () => chain.adminCall(wallet, "market", "setFee", [pctToBps($("adMarketFee").value), info.marketRecipient]));
if ($("adDexFeeGo")) $("adDexFeeGo").onclick = () => act("DEX fee update", () => chain.adminCall(wallet, "pool", "setFee", [pctToBps($("adDexFee").value), info.poolRecipient]));
$("adRecipientGo").onclick = () =>
  act("Fee wallet update", async () => {
    const r = $("adRecipient").value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(r)) throw new Error("Invalid address");
    await chain.adminCall(wallet, "token", "setFeeRecipient", [r]);
    if (chain.hasMarket) await chain.adminCall(wallet, "market", "setFee", [info.marketFee, r]);
    if (chain.hasPool) await chain.adminCall(wallet, "pool", "setFee", [info.poolFee, r]);
  });

if (!chain.hasPool) document.querySelectorAll(".dex-only").forEach((el) => el.remove());
chain.getSymbol().then((s) => document.querySelectorAll(".sym").forEach((el) => (el.textContent = s))).catch(() => {});
ethUsd();
indexer.start();
indexer.subscribe(() => render());
onResize($("chRevenue"), render);
restoreWallet().then((p) => p && connect(p, true).catch(() => {}));
