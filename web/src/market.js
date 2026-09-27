// Marketplace tab: on-chain order book, traded ONLY in whole lots (1 lot = 5,000 tokens).
// Prices are shown and entered in US dollars; on-chain they are ETH (converted at the current ETH/USD price).
import * as chain from "./chain.js";
import { $, store, on, emit, fmtAmt, fmtDur, short, errMsg, avatar } from "./store.js";
import { indexer } from "./indexer.js";
import { candleChart, onResize } from "./charts.js";
import { usd, usdToWei, ethUsd, ethUsdCached } from "./price.js";
import { initSwap } from "./swap.js";
import { track } from "./analytics.js";

let swapUi = { refresh() {} };

const REFRESH_MS = 4000;
const state = { orders: [], offers: [], trades: [], feeBps: 0n, lotSize: 0n, side: "sell", selected: null, busy: false, timer: null, lsort: "cheap", change24: null };

const setStatus = (s) => ($("mkStatus").textContent = s);
const me = () => store.wallet?.address.toLowerCase();
const mine = (o) => store.wallet && o.maker.toLowerCase() === me();
const nowSec = () => Math.floor(Date.now() / 1000);
/** expiry 0 = never */
const isExpired = (x) => x.expiry > 0n && Number(x.expiry) <= nowSec();
function timeLeft(x) {
  if (!x.expiry) return "never";
  const s = Number(x.expiry) - nowSec();
  if (s <= 0) return "expired";
  if (s < 3600) return `${Math.ceil(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
/** expiry select value (seconds from now, "0" = never) -> unix seconds */
const expiryFrom = (sel) => (Number(sel) > 0 ? BigInt(nowSec() + Number(sel)) : 0n);
const lotsLabel = (n) => `${n} lot${BigInt(n) === 1n ? "" : "s"}`;
/** Whole lots the connected wallet can sell right now. */
const myLots = () => (state.lotSize ? store.tokenBalance / state.lotSize : 0n);
const parseLots = (v) => {
  const s = String(v).trim();
  return /^\d+$/.test(s) ? BigInt(s) : -1n;
};

// ---------------- data ----------------
async function refresh() {
  if (!chain.hasMarket) return;
  try {
    if (!state.lotSize) {
      state.lotSize = await chain.lotSize();
      document.querySelectorAll(".lotsize").forEach((el) => (el.textContent = fmtAmt(state.lotSize, 0)));
    }
    const [orders, offers, feeBps] = await Promise.all([chain.getOrders(), chain.getOffers(), chain.marketFeeBps(), ethUsd()]);
    state.orders = orders;
    state.offers = offers;
    swapUi.refresh();
    state.feeBps = feeBps;
    render();
  } catch (e) {
    setStatus("Market load error: " + errMsg(e));
  }
}

// ---------------- rendering ----------------
function render() {
  const open = state.orders.filter((o) => o.active && o.lots > 0n && !isExpired(o));
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const asks = open.filter((o) => !o.isBid).sort((a, b) => cmp(a.pricePerLot, b.pricePerLot));
  const bids = open.filter((o) => o.isBid).sort((a, b) => cmp(b.pricePerLot, a.pricePerLot));

  // stats
  $("mkFloor").textContent = asks.length ? usd(asks[0].pricePerLot) : "–";
  $("mkBestBid").textContent = bids.length ? usd(bids[0].pricePerLot) : "–";
  $("mkLast").textContent = state.trades.length ? usd(state.trades[0].pricePerLot) : asks.length ? usd(asks[0].pricePerLot) : "–";
  renderGallery(asks);
  renderDepth(asks, bids);
  $("mkFee").textContent = `${Number(state.feeBps) / 100}%`;
  state.asks = asks;
  updateQuickBuy();
  $("mkBal").textContent = store.wallet ? `${lotsLabel(myLots())}` : "–";

  const row = (o, action) => `
    <tr class="${state.selected?.id === o.id ? "sel" : ""}">
      <td class="${o.isBid ? "up" : "down"}">${usd(o.pricePerLot)}</td>
      <td>${o.lots}</td>
      <td>${usd(chain.costOf(o.lots, o.pricePerLot))}</td>
      <td class="mono small">${mine(o) ? "you" : short(o.maker)}</td>
      <td class="small muted">${timeLeft(o)}</td>
      <td>${mine(o) ? `<button class="mini secondary" data-cancel="${o.id}">Cancel</button>` : `<button class="mini" data-pick="${o.id}">${action}</button>`}</td>
    </tr>`;
  const head = `<tr><th>Price / lot</th><th>Lots</th><th>Total</th><th>By</th><th>Expires</th><th></th></tr>`;
  $("mkAsks").innerHTML = head + (asks.map((o) => row(o, "Buy")).join("") || `<tr><td colspan="6" class="muted">No sell orders</td></tr>`);
  $("mkBids").innerHTML = head + (bids.map((o) => row(o, "Sell")).join("") || `<tr><td colspan="6" class="muted">No buy orders</td></tr>`);

  // my orders (expired ones stay here until reclaimed)
  const my = state.orders.filter((o) => o.active && o.lots > 0n && mine(o));
  $("mkMine").innerHTML = my.length
    ? my
        .map((o) => {
          const exp = isExpired(o);
          return `<li>${o.isBid ? "🟢 Buying" : "🔴 Selling"} ${lotsLabel(o.lots)} @ ${usd(o.pricePerLot)} / lot · <span class="muted">${exp ? "expired" : `expires: ${timeLeft(o)}`}</span> <button class="mini secondary" data-cancel="${o.id}">${exp ? "Reclaim" : "Cancel"}</button></li>`;
        })
        .join("")
    : `<li class="muted">${store.wallet ? "No open orders" : "Connect your wallet"}</li>`;

  // offers
  const byId = new Map(state.orders.map((o) => [o.id, o]));
  const liveOffers = state.offers.filter((f) => f.active);
  const incoming = liveOffers.filter((f) => {
    const l = byId.get(BigInt(f.listingId));
    return l && mine(l) && l.active && !isExpired(l) && !isExpired(f);
  });
  $("mkOffersIn").innerHTML = incoming.length
    ? incoming
        .map((f) => {
          const l = byId.get(BigInt(f.listingId));
          const value = chain.costOf(f.lots, f.pricePerLot);
          const fee = (value * state.feeBps) / 10_000n;
          return `<li>${lotsLabel(f.lots)} @ <b>${usd(f.pricePerLot)}</b> / lot (you ask ${usd(l.pricePerLot)}) · you get ${usd(value - fee)} · by <span class="mono small">${short(f.buyer)}</span> · <span class="muted">${timeLeft(f)}</span> <button class="mini" data-accept="${f.id}"${f.lots > l.lots ? " disabled title=\"listing has fewer lots now\"" : ""}>Accept</button></li>`;
        })
        .join("")
    : `<li class="muted">No offers on your listings</li>`;
  const myOffers = liveOffers.filter((f) => f.buyer.toLowerCase() === me());
  $("mkOffersMine").innerHTML = myOffers.length
    ? myOffers
        .map((f) => {
          const exp = isExpired(f);
          return `<li>Offer on listing #${f.listingId}: ${lotsLabel(f.lots)} @ ${usd(f.pricePerLot)} / lot · <span class="muted">${exp ? "expired" : `expires: ${timeLeft(f)}`}</span> <button class="mini secondary" data-${exp ? "reclaim-offer" : "cancel-offer"}="${f.id}">${exp ? "Reclaim" : "Cancel"}</button></li>`;
        })
        .join("")
    : `<li class="muted">${store.wallet ? "You have no open offers" : "Connect your wallet"}</li>`;

  const now = Date.now();
  $("mkTrades").innerHTML = state.trades.length
    ? state.trades
        .slice(0, 12)
        .map((t) => {
          const url = chain.explorerTx(t.tx);
          const buyer = t.src === "dex" && t.buyer === chain.POOL_CONTRACT?.address ? t.seller : t.buyer;
          const ago = `${fmtDur(Math.max(0, (now - t.t) / 1000))}`;
          return `<li><span class="bid">${lotsLabel(t.lots)}</span><span>${usd(t.pricePerLot)}</span><span class="muted" title="buyer">${short(buyer)}</span>${url ? `<a href="${url}" target="_blank" rel="noopener" class="muted">${ago} ↗</a>` : `<span class="muted">${ago}</span>`}</li>`;
        })
        .join("")
    : `<li class="muted">No trades yet</li>`;

  if (state.selected) {
    const fresh = open.find((o) => o.id === state.selected.id);
    if (!fresh) closeTrade("This order is no longer available (filled or cancelled)");
    else state.selected = fresh;
  }
  updateTradeCost();
  updateCreateTotal();
}

// ---------------- lots gallery + depth book ----------------
/** Deterministic "hash art" text for a listing card. */
function artFor(o) {
  let x = Number(o.id % 2147483647n) * 2654435761 + parseInt(o.maker.slice(2, 10), 16);
  let out = "";
  for (let i = 0; i < 300; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out += "0123456789abcdef"[(x >>> 0) % 16];
  }
  return out;
}

function renderGallery(asks) {
  const cmp = { cheap: () => 0, new: (a, b) => (a.id < b.id ? 1 : -1), big: (a, b) => (a.lots < b.lots ? 1 : a.lots > b.lots ? -1 : 0) }[state.lsort];
  const list = asks.slice().sort(cmp);
  const totalLots = asks.reduce((s, o) => s + o.lots, 0n);
  $("mkListedCount").textContent = asks.length ? `· ${asks.length} listing${asks.length === 1 ? "" : "s"} · ${totalLots} lots` : "";
  $("mkGallery").innerHTML = list.length
    ? list
        .slice(0, 24)
        .map((o) => {
          const tag = mine(o) ? "yours" : o === asks[0] ? "🔥 floor" : o.lots >= 5n ? "bulk" : "";
          return `<div class="card hover lot">
            <div class="art"><pre>${artFor(o)}</pre><span class="num">LOT #${String(o.id).padStart(4, "0")}</span>${tag ? `<span class="pill tag2">${tag}</span>` : ""}</div>
            <div class="body">
              <div class="row between" style="margin:0"><span class="price">${usd(o.pricePerLot)}</span><span class="muted mono small">${lotsLabel(o.lots)}</span></div>
              <div class="row between" style="margin:10px 0 0;flex-wrap:nowrap"><span class="seller">${avatar(o.maker, 18)}${mine(o) ? "you" : `${o.maker.slice(0, 6)}…`}</span>${
                mine(o) ? `<button class="mini secondary" data-cancel="${o.id}">Cancel</button>` : `<button class="mini" data-pick="${o.id}">Buy</button>`
              }</div>
              <div class="muted small" style="margin-top:6px">${timeLeft(o) === "never" ? "no expiry" : `expires in ${timeLeft(o)}`}</div>
            </div></div>`;
        })
        .join("")
    : `<div class="card muted">No lots listed right now. Be the first: use <b>Sell</b> on the right.</div>`;
}

function renderDepth(asks, bids) {
  const a = asks.slice(0, 6).reverse();
  const b = bids.slice(0, 6);
  const maxLots = [...a, ...b].reduce((m, o) => (o.lots > m ? o.lots : m), 1n);
  const row = (o, side) => {
    const w = Math.max(6, Number((o.lots * 100n) / maxLots));
    const bg = side === "ask" ? "rgba(230,103,103,.14)" : "rgba(57,135,229,.16)";
    return `<tr ${mine(o) ? "" : `data-pick="${o.id}"`} style="background:linear-gradient(270deg, ${bg} ${w}%, transparent ${w}%)" title="${mine(o) ? "your order" : side === "ask" ? "click to buy" : "click to sell"}"><td class="${side}">${usd(o.pricePerLot)}</td><td>${lotsLabel(o.lots)}</td><td class="muted" style="text-align:right">${usd(chain.costOf(o.lots, o.pricePerLot))}</td></tr>`;
  };
  const mid = state.trades.length ? usd(state.trades[0].pricePerLot) : "–";
  const ch = state.change24;
  $("mkDepth").innerHTML =
    (a.map((o) => row(o, "ask")).join("") || `<tr><td colspan="3" class="muted">No sell orders</td></tr>`) +
    `<tr class="mid"><td colspan="3">${mid} ${ch === null ? "" : `<span class="${ch >= 0 ? "up" : "down"}" style="font-size:12px">${ch >= 0 ? "▲" : "▼"}</span>`}</td></tr>` +
    (b.map((o) => row(o, "bid")).join("") || `<tr><td colspan="3" class="muted">No buy orders</td></tr>`);
  $("mkSpread").textContent = asks.length && bids.length ? `spread ${usd(asks[0].pricePerLot > bids[0].pricePerLot ? asks[0].pricePerLot - bids[0].pricePerLot : 0n)}` : "";
}

/** Right panel: Buy (quick buy) | Sell (list lots) | Bid (buy order). */
function showPane(which) {
  $("qbPane").classList.toggle("hidden", which !== "buy");
  $("mkCreatePane").classList.toggle("hidden", which === "buy");
  $("qbTab").classList.toggle("active", which === "buy");
  if (which !== "buy") setSide(which === "bid" ? "buy" : "sell");
  else {
    $("mkSideSell").classList.remove("active");
    $("mkSideBuy").classList.remove("active");
  }
}

// ---------------- fill an existing order ----------------
function pickOrder(id) {
  const o = state.orders.find((x) => x.id === id);
  if (!o) return;
  state.selected = o;
  $("mkTrade").classList.remove("hidden");
  $("mkTradeTitle").textContent = o.isBid ? `Sell into bid #${o.id}` : `Buy LOT #${String(o.id).padStart(4, "0")}`;
  $("mkTradeInfo").textContent = `${usd(o.pricePerLot)} per lot · ${lotsLabel(o.lots)} available`;
  $("mkTradeLots").value = "1";
  $("mkTradeGo").textContent = o.isBid ? "Sell lots" : "Buy lots";
  // offers are only for sell listings
  $("mkOfferBox").classList.toggle("hidden", o.isBid);
  $("mkOfferPrice").value = "";
  render();
}

function closeTrade(msg) {
  state.selected = null;
  $("mkTrade").classList.add("hidden");
  if (msg) setStatus(msg);
}

function tradeMax() {
  const o = state.selected;
  if (!o) return 0n;
  if (o.isBid) return myLots() < o.lots ? myLots() : o.lots;
  return o.lots;
}

function updateTradeCost() {
  const o = state.selected;
  if (!o) return;
  const lots = parseLots($("mkTradeLots").value);
  if (lots <= 0n) return ($("mkTradeCost").textContent = "Enter 1 or more whole lots");
  const eth = chain.costOf(lots, o.pricePerLot);
  const fee = (eth * state.feeBps) / 10_000n;
  const tokens = `${fmtAmt(lots * state.lotSize, 0)} ${store.symbol}`;
  $("mkTradeCost").textContent = o.isBid
    ? `Sell ${lotsLabel(lots)} (${tokens}) → you receive ${usd(eth - fee)} (fee ${usd(fee)})`
    : `Buy ${lotsLabel(lots)} (${tokens}) → you pay ${usd(eth)}`;
}

async function doTrade() {
  const o = state.selected;
  if (!o || state.busy) return;
  if (!store.wallet) return alert("Please click 'Connect wallet' at the top first.");
  const lots = parseLots($("mkTradeLots").value);
  if (lots <= 0n) return setStatus("Enter whole lots (1, 2, 3…)");
  if (lots > o.lots) return setStatus(`This order only has ${lotsLabel(o.lots)} available`);
  if (o.isBid && lots > myLots()) return setStatus(`You only have ${lotsLabel(myLots())}`);
  if (!o.isBid && chain.costOf(lots, o.pricePerLot) > store.ethBalance) return setStatus("Not enough ETH");

  await busy(async () => {
    setStatus("Confirm in your wallet…");
    if (o.isBid) await chain.sellIntoBid(store.wallet, o.id, lots, setStatus);
    else await chain.buyFromListing(store.wallet, o.id, lots, o.pricePerLot);
    closeTrade(`✓ Trade done: ${lotsLabel(lots)}`);
    track("Trade", { side: o.isBid ? "sell" : "buy", lots: String(lots) });
  });
}

// ---------------- create a new order ----------------
function setSide(side) {
  state.side = side;
  $("mkSideSell").classList.toggle("active", side === "sell");
  $("mkSideBuy").classList.toggle("active", side === "buy");
  $("mkCreate").textContent = side === "sell" ? "List lots for sale" : "Place buy order";
  $("mkCreateHint").textContent =
    side === "sell"
      ? "Your lots are locked in the market contract until someone buys them or you cancel. (2 wallet confirmations: approve + list)"
      : "Your ETH is locked until someone sells you lots or you cancel.";
  updateCreateTotal();
}

function updateCreateTotal() {
  const lots = parseLots($("mkLots").value);
  const price = usdToWei($("mkPrice").value);
  $("mkTotal").textContent =
    lots > 0n && price > 0n
      ? `${usd(chain.costOf(lots, price))} for ${lotsLabel(lots)} (${fmtAmt(lots * state.lotSize, 0)} ${store.symbol})`
      : "–";
  if (state.side === "sell") $("mkLotsHint").textContent = store.wallet ? `You have ${lotsLabel(myLots())}` : "";
  else $("mkLotsHint").textContent = "";
}

async function createOrder() {
  if (state.busy) return;
  if (!store.wallet) return alert("Please click 'Connect wallet' at the top first.");
  const lots = parseLots($("mkLots").value);
  const price = usdToWei($("mkPrice").value);
  if (lots <= 0n) return setStatus("Enter whole lots (1, 2, 3…)");
  if (price === null) return setStatus(ethUsdCached() ? "Enter a price per lot in $" : "Dollar price not available right now, try again in a moment");
  if (state.side === "sell" && lots > myLots()) return setStatus(`You only have ${lotsLabel(myLots())}`);
  if (state.side === "buy" && chain.costOf(lots, price) > store.ethBalance) return setStatus("Not enough ETH");

  await busy(async () => {
    setStatus("Confirm in your wallet…");
    const expiry = expiryFrom($("mkExpiry").value);
    if (state.side === "sell") await chain.listForSale(store.wallet, lots, price, setStatus, expiry);
    else await chain.placeBid(store.wallet, lots, price, expiry);
    $("mkLots").value = "1";
    setStatus(state.side === "sell" ? "✓ Sell order is live" : "✓ Buy order is live");
    track("Order created", { side: state.side });
  });
}

async function cancel(id) {
  await busy(async () => {
    setStatus("Confirm in your wallet…");
    await chain.cancelOrder(store.wallet, id);
    setStatus(`✓ Order #${id} cancelled, funds returned`);
  });
}

async function busy(fn) {
  state.busy = true;
  document.querySelectorAll("#tab-market button").forEach((b) => (b.disabled = true));
  try {
    await fn();
    emit("balances");
  } catch (e) {
    console.error(e);
    setStatus(`Failed: ${errMsg(e)}`);
  } finally {
    state.busy = false;
    document.querySelectorAll("#tab-market button").forEach((b) => (b.disabled = false));
    await refresh();
    indexer.refresh().catch(() => {}); // pull the new Trade event right away
  }
}

/** +/- stepper buttons next to a lots input */
function stepper(inputId, max) {
  const input = $(inputId);
  const set = (v) => {
    const m = max();
    if (m > 0n && v > m) v = m;
    input.value = String(v < 1n ? 1n : v);
    input.dispatchEvent(new Event("input"));
  };
  $(`${inputId}Minus`).onclick = () => set(parseLots(input.value) - 1n);
  $(`${inputId}Plus`).onclick = () => set(parseLots(input.value) + 1n);
}

// ---------------- offers ----------------
async function makeOffer() {
  const o = state.selected;
  if (!o || o.isBid || state.busy) return;
  if (!store.wallet) return alert("Please click 'Connect wallet' at the top first.");
  const lots = parseLots($("mkTradeLots").value);
  const price = usdToWei($("mkOfferPrice").value);
  if (lots <= 0n || lots > o.lots) return setStatus(`Enter 1–${o.lots} whole lots`);
  if (price === null) return setStatus(ethUsdCached() ? "Enter your offer price per lot in $" : "Dollar price not available right now, try again in a moment");
  if (chain.costOf(lots, price) > store.ethBalance) return setStatus("Not enough ETH");
  await busy(async () => {
    setStatus("Confirm in your wallet…");
    await chain.makeOffer(store.wallet, o.id, lots, price, expiryFrom($("mkOfferExpiry").value));
    track("Offer made");
    closeTrade(`✓ Offer sent: ${lotsLabel(lots)} @ ${usd(price)} / lot. The seller can accept it; your payment is locked until then.`);
  });
}

const offerAction = (fn, done) => (id) =>
  busy(async () => {
    setStatus("Confirm in your wallet…");
    await fn(store.wallet, id);
    setStatus(done);
  });
const acceptOffer = offerAction(chain.acceptOffer, "✓ Offer accepted: lots sent, ETH received");
const cancelOffer = offerAction(chain.cancelOffer, "✓ Offer cancelled, ETH returned");
const reclaimOffer = offerAction(chain.reclaimExpiredOffer, "✓ Expired offer closed, ETH returned");

// ---------------- history: 24h stats, holders, price chart (from the indexer) ----------------
const PRANGES = { "24h": [86400, 3600], "7d": [7 * 86400, 4 * 3600], "30d": [30 * 86400, 86400], all: [Infinity, 86400] };
let prange = "24h";
const ethNum = (wei) => Number(wei) / 1e18;

function tradesFromIndex() {
  const book = indexer.events("market", "Trade").map((e) => ({ ...e.args, src: "book", t: Number(e.args.timestamp) * 1000, tx: e.tx, block: e.block, logIndex: e.logIndex }));
  // DEX swaps count as trades too (price per lot = ETH amount / lots)
  const dex = indexer.events("pool", "Swap").map((e) => {
    const a = e.args;
    return {
      src: "dex",
      lots: a.lots,
      pricePerLot: a.ethAmount / a.lots,
      ethPaid: a.ethAmount,
      fee: a.protocolFee,
      buyer: a.isBuy ? a.trader : chain.POOL_CONTRACT.address,
      seller: a.isBuy ? chain.POOL_CONTRACT.address : a.trader,
      t: Number(a.timestamp) * 1000,
      tx: e.tx,
      block: e.block,
      logIndex: e.logIndex,
    };
  });
  return [...book, ...dex]
    // newest first; trades inside one tx (quick buy) keep their on-chain order
    .sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block < b.block ? 1 : -1));
}

function holdersCount() {
  const bal = new Map();
  const skip = new Set(["0x0000000000000000000000000000000000000000", chain.MARKET_CONTRACT?.address.toLowerCase(), chain.POOL_CONTRACT?.address.toLowerCase()]);
  for (const e of indexer.events("token", "Transfer")) {
    const { from, to, value } = e.args;
    const f = from.toLowerCase();
    const t = to.toLowerCase();
    bal.set(f, (bal.get(f) ?? 0n) - value);
    bal.set(t, (bal.get(t) ?? 0n) + value);
  }
  let n = 0;
  for (const [a, v] of bal) if (v > 0n && !skip.has(a)) n++;
  return n;
}

function renderHistory() {
  state.trades = tradesFromIndex();
  const now = Date.now();
  const day = state.trades.filter((t) => t.t >= now - 86400_000);
  const vol = day.reduce((s, t) => s + t.ethPaid, 0n);
  $("mk24Vol").textContent = usd(vol);
  $("mk24Count").textContent = `${day.length} trade${day.length === 1 ? "" : "s"} · ${day.reduce((s, t) => s + t.lots, 0n)} lots`;
  if (day.length) {
    const prices = day.map((t) => t.pricePerLot);
    const hi = prices.reduce((a, b) => (b > a ? b : a));
    const lo = prices.reduce((a, b) => (b < a ? b : a));
    $("mk24HL").textContent = `${usd(hi)} / ${usd(lo)}`;
  } else $("mk24HL").textContent = "–";
  // change: latest price vs the last price before the 24h window (or the first trade inside it)
  const before = state.trades.find((t) => t.t < now - 86400_000);
  const base = before ?? day[day.length - 1];
  if (state.trades.length && base && base !== state.trades[0]) {
    const pct = ((ethNum(state.trades[0].pricePerLot) - ethNum(base.pricePerLot)) / ethNum(base.pricePerLot)) * 100;
    state.change24 = pct;
    const txt = `${pct >= 0 ? "▲ +" : "▼ "}${pct.toFixed(2)}% 24h`;
    for (const id of ["mk24Change", "mkLastChange"]) {
      $(id).textContent = txt;
      $(id).className = `${id === "mkLastChange" ? "pill " : "s "}${pct >= 0 ? "up" : "down"}`;
    }
  } else {
    state.change24 = null;
    $("mk24Change").textContent = "no change data yet";
    $("mk24Change").className = "s";
    $("mkLastChange").textContent = "";
    $("mkLastChange").className = "pill hidden";
  }
  $("mkHolders").textContent = holdersCount().toLocaleString("en");
  renderChart();
  render();
}

function renderChart() {
  const [span, bucket] = PRANGES[prange];
  const now = Date.now();
  const list = state.trades.filter((t) => t.t >= now - span * 1000).slice().reverse(); // oldest first
  const map = new Map();
  for (const t of list) {
    const k = Math.floor(t.t / 1000 / bucket) * bucket * 1000;
    const p = ethNum(t.pricePerLot);
    const c = map.get(k);
    if (!c) map.set(k, { t: k, o: p, h: p, l: p, c: p, v: ethNum(t.ethPaid) });
    else {
      c.h = Math.max(c.h, p);
      c.l = Math.min(c.l, p);
      c.c = p;
      c.v += ethNum(t.ethPaid);
    }
  }
  const candles = [...map.values()];
  // candles are kept in ETH on-chain; shown in $ at today's ETH price
  const p = ethUsdCached();
  const fmt = p ? (v) => `$${(v * p).toLocaleString("en", { maximumFractionDigits: v * p < 1 ? 4 : 2 })}` : (v) => `${+v.toPrecision(4)} ETH`;
  candleChart($("chPrice"), candles, { yFmt: fmt, volFmt: fmt, empty: "No trades in this range yet" });
  $("chPriceNote").textContent = candles.length ? `${list.length} trade(s) · ${bucket >= 86400 ? "1 day" : bucket / 3600 + "h"} candles · blue = up, red = down${p ? " · $ at today's ETH price" : ""}` : "";
}

// ---------------- quick buy ----------------
/** Cheapest-first fill plan for `want` lots, skipping your own listings. */
function quickPlan(want) {
  const plan = [];
  let left = want;
  for (const o of state.asks ?? []) {
    if (left <= 0n) break;
    if (mine(o)) continue;
    const take = o.lots < left ? o.lots : left;
    plan.push({ id: o.id, lots: take, pricePerLot: o.pricePerLot });
    left -= take;
  }
  return { plan, missing: left };
}

function updateQuickBuy() {
  const want = parseLots($("qbLots").value);
  document.querySelectorAll("[data-q]").forEach((b) => b.classList.toggle("active", BigInt(b.dataset.q) === want));
  $("qbTokens").textContent = want > 0n && state.lotSize ? `lot${want === 1n ? "" : "s"} · ${fmtAmt(want * state.lotSize, 0)} ${store.symbol}` : "lots";
  if (want <= 0n) return ($("qbPreview").textContent = "Enter whole lots (1, 2, 3…)");
  const { plan, missing } = quickPlan(want);
  if (!plan.length) return ($("qbPreview").textContent = "No listings to buy from right now");
  const total = plan.reduce((s, f) => s + chain.costOf(f.lots, f.pricePerLot), 0n);
  const got = want - missing;
  const avg = total / got;
  $("qbPreview").textContent =
    `${lotsLabel(got)} from ${plan.length} listing(s) · avg ${usd(avg)} / lot · total ${usd(total)}` +
    (missing > 0n ? ` · only ${lotsLabel(got)} available` : "");
}

async function quickBuy() {
  if (!store.wallet) return alert("Please click 'Connect wallet' at the top first.");
  const want = parseLots($("qbLots").value);
  if (want <= 0n) return setStatus("Enter whole lots (1, 2, 3…)");
  const { plan } = quickPlan(want);
  if (!plan.length) return setStatus("No listings to buy from right now");
  const total = plan.reduce((s, f) => s + chain.costOf(f.lots, f.pricePerLot), 0n);
  if (total > store.ethBalance) return setStatus("Not enough ETH");
  await busy(async () => {
    setStatus("Confirm in your wallet…");
    await chain.buyMany(store.wallet, plan);
    setStatus(`✓ Quick buy done: ${lotsLabel(plan.reduce((s, f) => s + f.lots, 0n))}`);
  });
}

// ---------------- init ----------------
export function initMarket() {
  if (!chain.hasMarket) {
    $("tab-market").innerHTML = `<section class="card"><p class="muted">Marketplace contract is not deployed. Run <code>npm run deploy:testnet</code> again.</p></section>`;
    return { show() {}, hide() {} };
  }
  swapUi = initSwap();
  $("mkSideSell").onclick = () => showPane("sell");
  $("mkSideBuy").onclick = () => showPane("bid");
  $("mkLots").oninput = updateCreateTotal;
  $("mkPrice").oninput = updateCreateTotal;
  $("mkCreate").onclick = createOrder;
  $("mkTradeLots").oninput = updateTradeCost;
  $("mkTradeGo").onclick = doTrade;
  $("mkOfferGo").onclick = makeOffer;
  $("mkTradeClose").onclick = () => closeTrade();
  $("mkTrade").addEventListener("click", (e) => e.target === $("mkTrade") && closeTrade());
  $("mkTradeMax").onclick = () => {
    $("mkTradeLots").value = String(tradeMax());
    updateTradeCost();
  };
  stepper("mkLots", () => (state.side === "sell" ? myLots() : 0n));
  stepper("qbLots", () => (state.asks ?? []).filter((o) => !mine(o)).reduce((s, o) => s + o.lots, 0n));
  $("qbLots").oninput = updateQuickBuy;
  $("qbChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-q]");
    if (!b) return;
    $("qbLots").value = b.dataset.q;
    updateQuickBuy();
  });
  $("qbTab").onclick = () => showPane("buy");
  document.querySelectorAll("[data-lsort]").forEach((b) => {
    b.onclick = () => {
      state.lsort = b.dataset.lsort;
      document.querySelectorAll("[data-lsort]").forEach((x) => x.classList.toggle("active", x === b));
      render();
    };
  });
  $("qbGo").onclick = quickBuy;
  document.querySelectorAll("[data-prange]").forEach((b) => {
    b.onclick = () => {
      prange = b.dataset.prange;
      document.querySelectorAll("[data-prange]").forEach((x) => x.classList.toggle("active", x === b));
      renderChart();
    };
  });
  indexer.subscribe(renderHistory);
  onResize($("chPrice"), renderChart);
  stepper("mkTradeLots", tradeMax);
  $("tab-market").addEventListener("click", (e) => {
    const t = (sel) => e.target.closest(sel);
    if (t("[data-pick]")) pickOrder(BigInt(t("[data-pick]").dataset.pick));
    if (t("[data-cancel]")) cancel(BigInt(t("[data-cancel]").dataset.cancel));
    if (t("[data-accept]")) acceptOffer(BigInt(t("[data-accept]").dataset.accept));
    if (t("[data-cancel-offer]")) cancelOffer(BigInt(t("[data-cancel-offer]").dataset.cancelOffer));
    if (t("[data-reclaim-offer]")) reclaimOffer(BigInt(t("[data-reclaim-offer]").dataset.reclaimOffer));
  });
  on("wallet", render);
  on("balances:updated", () => {
    $("mkBal").textContent = store.wallet ? lotsLabel(myLots()) : "–";
    $("mkBalEth").textContent = store.wallet ? usd(store.ethBalance) : "–";
    updateCreateTotal();
  });
  setSide("sell");
  showPane("buy");

  // realtime: poll only while the tab is visible
  return {
    show() {
      refresh();
      clearInterval(state.timer);
      state.timer = setInterval(() => !document.hidden && !state.busy && refresh(), REFRESH_MS);
    },
    hide() {
      clearInterval(state.timer);
    },
  };
}
