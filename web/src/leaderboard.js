// Leaderboard tab: top 100 holders.
// Balance = wallet balance (from Transfer events) + lots the holder has listed on the marketplace (escrowed, still theirs).
import * as chain from "./chain.js";
import { indexer } from "./indexer.js";
import { $, store, on, fmtAmt, short } from "./store.js";

const MAX_SUPPLY = 21_000_000n * 10n ** 18n;
let listed = new Map(); // maker -> escrowed tokens in open listings
let lotSize = 5000n * 10n ** 18n;

async function loadListings() {
  if (!chain.hasMarket) return;
  try {
    lotSize = await chain.lotSize();
    const orders = await chain.getOrders();
    listed = new Map();
    for (const o of orders) {
      if (!o.active || o.isBid || o.lots === 0n) continue;
      const k = o.maker.toLowerCase();
      listed.set(k, (listed.get(k) ?? 0n) + o.lots * lotSize);
    }
  } catch {}
}

function holders() {
  const bal = new Map();
  for (const e of indexer.events("token", "Transfer")) {
    const f = e.args.from.toLowerCase();
    const t = e.args.to.toLowerCase();
    bal.set(f, (bal.get(f) ?? 0n) - e.args.value);
    bal.set(t, (bal.get(t) ?? 0n) + e.args.value);
  }
  const skip = new Set(["0x0000000000000000000000000000000000000000", chain.MARKET_CONTRACT?.address.toLowerCase(), chain.POOL_CONTRACT?.address.toLowerCase()]);
  for (const [a, v] of listed) bal.set(a, (bal.get(a) ?? 0n) + v);
  return [...bal.entries()]
    .filter(([a, v]) => v > 0n && !skip.has(a))
    .map(([address, balance]) => ({ address, balance, listed: listed.get(address) ?? 0n }))
    .sort((a, b) => (a.balance === b.balance ? 0 : a.balance < b.balance ? 1 : -1));
}

function render() {
  const all = holders();
  const me = store.wallet?.address.toLowerCase();
  const table = $("lbTable");
  table.replaceChildren();
  const head = document.createElement("tr");
  ["#", "Holder", "Balance", "Lots", "% of max supply"].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  });
  table.appendChild(head);
  if (!all.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "muted";
    td.textContent = indexer.isLoaded() ? "No holders yet" : "Loading…";
    tr.appendChild(td);
    table.appendChild(tr);
  }
  all.slice(0, 100).forEach((h, i) => {
    const tr = document.createElement("tr");
    if (h.address === me) tr.className = "sel";
    const medal = ["🥇", "🥈", "🥉"][i] ?? String(i + 1);
    const cells = [
      medal,
      `${short(h.address)}${h.address === me ? " (you)" : ""}${h.listed > 0n ? ` · ${(h.listed / lotSize).toLocaleString("en")} listed` : ""}`,
      `${fmtAmt(h.balance, 0)} ${store.symbol}`,
      (h.balance / lotSize).toLocaleString("en"),
      `${((Number(h.balance) / Number(MAX_SUPPLY)) * 100).toFixed(3)}%`,
    ];
    cells.forEach((c, j) => {
      const td = document.createElement("td");
      td.textContent = c;
      if (j === 1) td.className = "mono small";
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });
  const myRank = all.findIndex((h) => h.address === me);
  $("lbMe").textContent = me
    ? myRank >= 0
      ? `You are #${myRank + 1} of ${all.length.toLocaleString("en")} holders with ${fmtAmt(all[myRank].balance, 0)} ${store.symbol}.`
      : "You don't hold any tokens yet: start mining!"
    : `${all.length.toLocaleString("en")} holders · connect your wallet to see your rank.`;
}

export function initLeaderboard() {
  indexer.subscribe(render);
  on("wallet", render);
  on("balances:updated", render);
  return {
    async show() {
      await loadListings();
      render();
    },
  };
}
