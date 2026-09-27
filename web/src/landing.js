// Landing page: everything here is live — the network numbers come from the token contract,
// the ticker / block wall / podium from BlockMined events (in-browser indexer), the floor from the market.
import * as chain from "./chain.js";
import { indexer } from "./indexer.js";
import { networkHashrate } from "./stats.js";
import { ethUsd, usd } from "./price.js";
import { $, store, fmtAmt, fmtDur, fmtRate, short, avatar, hashHtml, escapeHtml } from "./store.js";

const TOTAL_BLOCKS = 4200;
let height = 0;

// ---------- 3D cube: faces show the latest block numbers + hash text ----------
function renderCube(blocks) {
  const faces = Array.from({ length: 6 }, (_, i) => {
    const b = blocks[i];
    const n = b ? b.height : Math.max(0, height - i);
    const hex = b ? b.digest.slice(2) : "0".repeat(8) + "…";
    return `<div class="f"><span class="n">#${n.toLocaleString("en")}</span>${hex}${hex}</div>`;
  });
  $("cube").innerHTML = faces.join("");
}

function blocks() {
  return indexer
    .events("token", "BlockMined")
    .map((e) => ({ height: Number(e.args.height), miner: e.args.miner, digest: e.args.digest, bits: Number(e.args.achievedBits), reward: e.args.reward, t: Number(e.args.timestamp) * 1000 }))
    .sort((a, b) => b.height - a.height);
}

// ---------- live numbers from the contract ----------
async function loadInfo() {
  try {
    const [i, sym] = await Promise.all([chain.getMiningInfo(), chain.getSymbol()]);
    store.symbol = sym;
    document.querySelectorAll(".sym").forEach((el) => (el.textContent = sym));
    height = Number(i.height);
    $("navBlock").textContent = `Block #${height.toLocaleString("en")} mining now`;
    $("lsBlocks").textContent = height.toLocaleString("en");
    $("lsBits").textContent = `difficulty: ${i.requiredBits} zero bits`;
    $("heroReward").textContent = fmtAmt(i.reward, 0);
    const pct = (Number(i.totalSupply) / 1e18 / 21_000_000) * 100;
    $("lsSupply").textContent = `${pct.toFixed(2)}%`;
    $("supplyBar").style.width = `${Math.max(pct, 0.4)}%`;
    $("ctaLeft").textContent = `${(TOTAL_BLOCKS - height).toLocaleString("en")} blocks left`;
    $("lsNote").textContent = `Live from the blockchain · last block ${fmtDur(Math.max(0, Date.now() / 1000 - Number(i.lastBlockTime)))} ago · updates every 15 s.`;
    renderWall();
  } catch {
    $("lsNote").textContent = "Live stats are unavailable right now.";
  }
}

async function loadFloor() {
  if (!chain.hasMarket) return;
  try {
    const [orders] = await Promise.all([chain.getOrders(), ethUsd()]);
    const now = Math.floor(Date.now() / 1000);
    const asks = orders.filter((o) => o.active && !o.isBid && o.lots > 0n && !(o.expiry > 0n && Number(o.expiry) <= now));
    const floor = asks.reduce((m, o) => (m === null || o.pricePerLot < m ? o.pricePerLot : m), null);
    $("lsFloor").textContent = floor ? usd(floor) : "–";
    $("lsLast").textContent = floor ? `${asks.length} listing${asks.length === 1 ? "" : "s"} on the market` : "no lots listed yet";
  } catch {}
}

// ---------- block wall ----------
let wallBuilt = -1;
function renderWall() {
  const grid = $("wallGrid");
  if (wallBuilt === height) return;
  let html = "";
  for (let i = 0; i < TOTAL_BLOCKS; i++) {
    // mined squares get a stable brightness from their number, so the wall has texture
    const a = (0.4 + (((i * 2654435761) >>> 0) % 1000) / 1666).toFixed(2);
    html += i < height ? `<i class="m" style="--a:${a}" data-i="${i}"></i>` : i === height ? `<i class="cur" data-i="${i}"></i>` : `<i data-i="${i}"></i>`;
  }
  grid.innerHTML = html;
  wallBuilt = height;
}

function wallTip() {
  const tip = $("tip");
  const byHeight = () => new Map(blocks().map((b) => [b.height, b]));
  let map = new Map();
  indexer.subscribe(() => (map = byHeight()));
  const show = (e) => {
    const n = Number(e.target.dataset?.i);
    if (!Number.isFinite(n) || e.target.tagName !== "I") return (tip.style.opacity = 0);
    const b = map.get(n);
    tip.innerHTML =
      n < height
        ? b
          ? `<b>Block #${n.toLocaleString("en")}</b><br>${escapeHtml(short(b.miner))} · <span style="color:var(--lime)">${b.bits} zero bits</span><br>${fmtDur(Math.max(0, (Date.now() - b.t) / 1000))} ago<br><span class="hash">${hashHtml(b.digest, 26)}</span>`
          : `<b>Block #${n.toLocaleString("en")}</b><br>mined`
        : n === height
          ? `<b>Block #${n.toLocaleString("en")}</b><br>being mined right now…`
          : `<b>Block #${n.toLocaleString("en")}</b><br>not mined yet`;
    tip.style.opacity = 1;
    const x = e.clientX ?? 0;
    tip.style.left = `${Math.min(x + 14, innerWidth - tip.offsetWidth - 10)}px`;
    tip.style.top = `${(e.clientY ?? 0) + 14}px`;
  };
  $("wallGrid").addEventListener("mousemove", show);
  $("wallGrid").addEventListener("click", show);
  $("wallGrid").addEventListener("mouseleave", () => (tip.style.opacity = 0));
}

// ---------- ticker, hero hash, stats, podium (indexer) ----------
function renderEvents() {
  const all = blocks();
  renderCube(all);
  const latest = all[0];
  if (latest) {
    $("heroHash").innerHTML = hashHtml(latest.digest, 42);
    $("heroHashNote").textContent = `latest winning hash · block #${latest.height.toLocaleString("en")} · ${latest.bits} zero bits`;
  }
  const items = all.slice(0, 14).map(
    (b) => `<span class="it">${avatar(b.miner, 22)}<b>#${b.height.toLocaleString("en")}</b> mined by ${escapeHtml(short(b.miner))} · <span class="tbits">${b.bits} bits</span> · ${fmtDur(Math.max(0, (Date.now() - b.t) / 1000))} ago</span>`,
  );
  $("ticker").innerHTML = items.length ? [...items, ...items].join("") : `<span class="it muted">No blocks yet — the first one is up for grabs.</span>`;
  $("ticker").style.animationDuration = `${Math.max(20, items.length * 5)}s`;

  const hr = networkHashrate();
  $("lsHash").textContent = hr ? fmtRate(hr) : "–";
  const day = Date.now() - 86400_000;
  $("lsMiners").textContent = new Set(all.filter((b) => b.t >= day).map((b) => b.miner.toLowerCase())).size.toLocaleString("en");

  const by = new Map();
  for (const b of all) {
    const k = b.miner.toLowerCase();
    const r = by.get(k) ?? { miner: b.miner, blocks: 0, reward: 0n };
    r.blocks++;
    r.reward += b.reward;
    by.set(k, r);
  }
  const top = [...by.values()].sort((a, b) => b.blocks - a.blocks);
  const slot = (r, rank) =>
    r
      ? `<div class="card pod p${rank} hover">${avatar(r.miner, 56)}<div class="rank">#${rank}</div><div class="mono">${escapeHtml(short(r.miner))}</div><div class="big-num" style="font-size:24px;margin-top:8px">${r.blocks} block${r.blocks === 1 ? "" : "s"}</div><div class="muted small">${fmtAmt(r.reward, 0)} ${escapeHtml(store.symbol)}</div></div>`
      : `<div class="card pod p${rank}"><div class="rank">#${rank}</div><div class="muted small" style="margin-top:8px">up for grabs — could be you</div></div>`;
  $("podium").innerHTML = slot(top[1], 2) + slot(top[0], 1) + slot(top[2], 3);
}

renderCube([]);
wallTip();
loadInfo();
loadFloor();
indexer.subscribe(renderEvents);
indexer.start();
setInterval(loadInfo, 15_000);
setInterval(loadFloor, 60_000);
