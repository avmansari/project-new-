// Leaderboard tab: top 100 holders.
// Balance = wallet balance (from Transfer events) + lots the holder has listed on the marketplace (escrowed, still theirs).
import * as chain from "./chain.js";
import { indexer } from "./indexer.js";
import { $, store, on, fmtAmt, short, avatar, escapeHtml } from "./store.js";

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

const pct = (v) => (Number(v) / Number(MAX_SUPPLY)) * 100;

function podium(top) {
  const slots = [
    [top[1], 2, "var(--silver)", ""],
    [top[0], 1, "var(--gold)", "g"],
    [top[2], 3, "var(--bronze)", ""],
  ];
  const me = store.wallet?.address.toLowerCase();
  $("lbPodium").innerHTML = slots
    .map(([h, rank, color, cls]) => {
      if (!h) return `<div class="card pod empty ${cls}"><div class="crown"></div><div class="rk" style="color:${color}">#${rank}</div><div class="muted small" style="margin:10px 0 24px">up for grabs</div></div>`;
      return `<div class="card pod ${cls} rise" style="animation-delay:${rank * 0.06}s">
        <div class="crown">${rank === 1 ? "👑" : ""}</div>${avatar(h.address, rank === 1 ? 84 : 66)}
        <div class="who">${escapeHtml(short(h.address))}${h.address === me ? " · you" : ""}</div>
        <div class="step"><div class="rk" style="color:${color}">#${rank}</div>
          <div class="big-num" style="font-size:22px;margin-top:6px">${fmtAmt(h.balance, 0)} ${escapeHtml(store.symbol)}</div>
          <div class="muted small">${(h.balance / lotSize).toLocaleString("en")} lots · ${pct(h.balance).toFixed(3)}% of max supply</div></div></div>`;
    })
    .join("");
}

function render() {
  const all = holders();
  const me = store.wallet?.address.toLowerCase();
  podium(all.slice(0, 3));
  const topBal = all[0]?.balance ?? 1n;
  const head = `<thead><tr><th>Rank</th><th>Holder</th><th>Balance</th><th>Lots</th><th>Share of max supply</th></tr></thead>`;
  const rows = all.length
    ? all
        .slice(0, 100)
        .map((h, i) => {
          const isMe = h.address === me;
          const medal = ["🥇", "🥈", "🥉"][i];
          return `<tr class="${isMe ? "sel" : ""}">
            <td><span class="rk-badge">${medal ?? i + 1}</span></td>
            <td><span class="who-cell">${avatar(h.address, 28)}<span class="mono">${isMe ? '<b style="color:var(--lime)">You</b> · ' : ""}${escapeHtml(short(h.address))}${h.listed > 0n ? ` <span class="muted small">· ${(h.listed / lotSize).toLocaleString("en")} listed</span>` : ""}</span></span></td>
            <td class="mono"><b>${fmtAmt(h.balance, 0)}</b> <span class="muted">${escapeHtml(store.symbol)}</span></td>
            <td class="mono">${(h.balance / lotSize).toLocaleString("en")}</td>
            <td><span class="who-cell"><span class="shareb"><i style="width:${Math.max(2, Number((h.balance * 100n) / topBal))}%"></i></span><span class="mono muted small">${pct(h.balance).toFixed(3)}%</span></span></td></tr>`;
        })
        .join("")
    : `<tr><td colspan="5" class="muted">${indexer.isLoaded() ? "No holders yet — mine the first block!" : "Loading…"}</td></tr>`;
  $("lbTable").innerHTML = head + `<tbody>${rows}</tbody>`;
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
