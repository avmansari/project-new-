// Stats tab: network stats tiles, hashrate / block time / difficulty charts, and the miners leaderboard.
// Everything comes from BlockMined events via the in-browser indexer.
import { indexer } from "./indexer.js";
import { lineChart, onResize } from "./charts.js";
import { $, store, on, fmtNum, fmtTok, fmtDur, short } from "./store.js";

const TOTAL_BLOCKS = 4200;
const RANGES = { "24h": 86400, "7d": 7 * 86400, all: Infinity };
let range = "24h";

const workOf = (target) => Number(2n ** 256n / (BigInt(target) + 1n)); // expected hashes for one block
const fmtRate = (h) => `${fmtNum(h)} H/s`;

function blocks() {
  return indexer
    .events("token", "BlockMined")
    .map((e) => ({
      height: Number(e.args.height),
      miner: e.args.miner,
      reward: e.args.reward,
      bits: Number(e.args.requiredBits),
      target: e.args.target,
      t: Number(e.args.timestamp) * 1000,
    }))
    .sort((a, b) => a.height - b.height);
}

/** Estimated network hashrate (H/s) from the last 20 blocks, or null. */
export function networkHashrate() {
  const recent = blocks().slice(-21);
  if (recent.length < 2) return null;
  const secs = (recent[recent.length - 1].t - recent[0].t) / 1000;
  return secs > 0 ? recent.slice(1).reduce((s, b) => s + workOf(b.target), 0) / secs : null;
}

function inRange(list) {
  const cutoff = Date.now() - RANGES[range] * 1000;
  return list.filter((b) => b.t >= cutoff);
}

function render() {
  const all = blocks();
  const now = Date.now();

  // ---- tiles (always network-wide, not range-filtered)
  $("stBlocks").textContent = `${all.length.toLocaleString("en")} / ${TOTAL_BLOCKS.toLocaleString("en")}`;
  $("stMined").textContent = `${((all.length / TOTAL_BLOCKS) * 100).toFixed(2)}%`;
  $("stLeft").textContent = (TOTAL_BLOCKS - all.length).toLocaleString("en");
  const recent = all.slice(-21);
  const avg = recent.length > 1 ? (recent[recent.length - 1].t - recent[0].t) / 1000 / (recent.length - 1) : null;
  $("stAvgTime").textContent = avg ? fmtDur(avg) : "–";
  const hr = recent.length > 1 ? recent.slice(1).reduce((s, b) => s + workOf(b.target), 0) / ((recent[recent.length - 1].t - recent[0].t) / 1000 || 1) : null;
  $("stHashrate").textContent = hr ? fmtRate(hr) : "–";
  $("stMiners24").textContent = new Set(all.filter((b) => b.t >= now - 86400_000).map((b) => b.miner.toLowerCase())).size.toLocaleString("en");

  // ---- charts (range-filtered)
  const list = inRange(all);
  const cutoff = now - RANGES[range] * 1000;
  const W = 8; // rolling window for hashrate
  const hashPts = [];
  const timePts = [];
  for (let i = 1; i < all.length; i++) {
    const b = all[i];
    if (b.t < cutoff) continue;
    timePts.push({ t: b.t, y: (b.t - all[i - 1].t) / 1000 });
    const from = Math.max(0, i - W);
    const secs = (b.t - all[from].t) / 1000;
    if (secs > 0) {
      let work = 0;
      for (let j = from + 1; j <= i; j++) work += workOf(all[j].target);
      hashPts.push({ t: b.t, y: work / secs });
    }
  }
  const diffPts = list.map((b) => ({ t: b.t, y: b.bits }));
  lineChart($("chHashrate"), hashPts, { label: "Network hashrate", yFmt: fmtRate, empty: "Needs at least 2 blocks in this range" });
  lineChart($("chBlockTime"), timePts, { label: "Block time", yFmt: (v) => (v < 60 ? `${+v.toFixed(1)}s` : fmtDur(v)), empty: "Needs at least 2 blocks in this range" });
  lineChart($("chDifficulty"), diffPts, { label: "Difficulty (zero bits)", yFmt: (v) => `${+v.toFixed(1)} bits`, empty: "Needs at least 2 blocks in this range" });

  // ---- leaderboard (range-filtered)
  const by = new Map();
  for (const b of list) {
    const k = b.miner.toLowerCase();
    const r = by.get(k) ?? { miner: b.miner, blocks: 0, tokens: 0n, last: 0 };
    r.blocks++;
    r.tokens += b.reward;
    r.last = Math.max(r.last, b.t);
    by.set(k, r);
  }
  const rows = [...by.values()].sort((a, b) => b.blocks - a.blocks || b.last - a.last);
  const me = store.wallet?.address.toLowerCase();
  const tbody = $("leaderboard");
  tbody.replaceChildren();
  const head = document.createElement("tr");
  ["#", "Miner", "Blocks", "Share", "Tokens", "Last block"].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  });
  tbody.appendChild(head);
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "muted";
    td.textContent = "No blocks mined in this range yet";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  rows.slice(0, 50).forEach((r, i) => {
    const tr = document.createElement("tr");
    if (r.miner.toLowerCase() === me) tr.className = "sel";
    const cells = [
      i + 1,
      r.miner.toLowerCase() === me ? `${short(r.miner)} (you)` : short(r.miner),
      r.blocks.toLocaleString("en"),
      `${((r.blocks / list.length) * 100).toFixed(1)}%`,
      fmtTok(r.tokens),
      `${fmtDur(Math.max(0, (now - r.last) / 1000))} ago`,
    ];
    cells.forEach((c, j) => {
      const td = document.createElement("td");
      td.textContent = c;
      if (j === 1) td.className = "mono small";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  const myRank = rows.findIndex((r) => r.miner.toLowerCase() === me);
  $("myRank").textContent = me ? (myRank >= 0 ? `You are #${myRank + 1} with ${rows[myRank].blocks} block(s) in this range.` : "You have no blocks in this range yet.") : "";
}

export function initStats() {
  document.querySelectorAll("[data-range]").forEach((b) => {
    b.onclick = () => {
      range = b.dataset.range;
      document.querySelectorAll("[data-range]").forEach((x) => x.classList.toggle("active", x === b));
      render();
    };
  });
  indexer.subscribe(render);
  on("wallet", render);
  ["chHashrate", "chBlockTime", "chDifficulty"].forEach((id) => onResize($(id), render));
  setInterval(() => indexer.isLoaded() && render(), 30_000); // keep "x ago" fresh
}
