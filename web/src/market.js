// Marketplace tab: on-chain order book, traded ONLY in whole lots (1 lot = 5,000 tokens), price per lot in ETH.
import { parseEther } from "viem";
import * as chain from "./chain.js";
import { $, store, on, emit, fmtAmt, fmtEth, short, errMsg } from "./store.js";

const REFRESH_MS = 4000;
const state = { orders: [], trades: [], feeBps: 0n, lotSize: 0n, side: "sell", selected: null, busy: false, timer: null };

const setStatus = (s) => ($("mkStatus").textContent = s);
const mine = (o) => store.wallet && o.maker.toLowerCase() === store.wallet.address.toLowerCase();
const lotsLabel = (n) => `${n} lot${BigInt(n) === 1n ? "" : "s"}`;
/** Whole lots the connected wallet can sell right now. */
const myLots = () => (state.lotSize ? store.tokenBalance / state.lotSize : 0n);
const parseLots = (v) => {
  const s = String(v).trim();
  return /^\d+$/.test(s) ? BigInt(s) : -1n;
};
const parsePrice = (v) => {
  try {
    return parseEther(String(v).trim() || "0");
  } catch {
    return -1n;
  }
};

// ---------------- data ----------------
async function refresh() {
  if (!chain.hasMarket) return;
  try {
    if (!state.lotSize) {
      state.lotSize = await chain.lotSize();
      document.querySelectorAll(".lotsize").forEach((el) => (el.textContent = fmtAmt(state.lotSize, 0)));
    }
    const [orders, trades, feeBps] = await Promise.all([chain.getOrders(), chain.recentTrades(), chain.marketFeeBps()]);
    state.orders = orders;
    state.trades = trades;
    state.feeBps = feeBps;
    render();
  } catch (e) {
    setStatus("Market load error: " + errMsg(e));
  }
}

// ---------------- rendering ----------------
function render() {
  const open = state.orders.filter((o) => o.active && o.lots > 0n);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const asks = open.filter((o) => !o.isBid).sort((a, b) => cmp(a.pricePerLot, b.pricePerLot));
  const bids = open.filter((o) => o.isBid).sort((a, b) => cmp(b.pricePerLot, a.pricePerLot));

  // stats
  $("mkFloor").textContent = asks.length ? fmtEth(asks[0].pricePerLot) : "–";
  $("mkBestBid").textContent = bids.length ? fmtEth(bids[0].pricePerLot) : "–";
  $("mkLast").textContent = state.trades.length ? fmtEth(state.trades[0].pricePerLot) : "–";
  $("mkVolume").textContent = fmtEth(state.trades.reduce((s, t) => s + t.ethPaid, 0n), 4);
  $("mkFee").textContent = `${Number(state.feeBps) / 100}%`;
  $("mkBal").textContent = store.wallet ? `${lotsLabel(myLots())}` : "–";

  const row = (o, action) => `
    <tr class="${state.selected?.id === o.id ? "sel" : ""}">
      <td class="${o.isBid ? "up" : "down"}">${fmtAmt(o.pricePerLot, 6)}</td>
      <td>${o.lots}</td>
      <td>${fmtAmt(chain.costOf(o.lots, o.pricePerLot), 6)}</td>
      <td class="mono small">${mine(o) ? "you" : short(o.maker)}</td>
      <td>${mine(o) ? `<button class="mini secondary" data-cancel="${o.id}">Cancel</button>` : `<button class="mini" data-pick="${o.id}">${action}</button>`}</td>
    </tr>`;
  const head = `<tr><th>Price / lot (ETH)</th><th>Lots</th><th>Total ETH</th><th>By</th><th></th></tr>`;
  $("mkAsks").innerHTML = head + (asks.map((o) => row(o, "Buy")).join("") || `<tr><td colspan="5" class="muted">No sell orders</td></tr>`);
  $("mkBids").innerHTML = head + (bids.map((o) => row(o, "Sell")).join("") || `<tr><td colspan="5" class="muted">No buy orders</td></tr>`);

  const my = open.filter(mine);
  $("mkMine").innerHTML = my.length
    ? my
        .map(
          (o) =>
            `<li>${o.isBid ? "🟢 Buying" : "🔴 Selling"} ${lotsLabel(o.lots)} @ ${fmtEth(o.pricePerLot)} / lot <button class="mini secondary" data-cancel="${o.id}">Cancel</button></li>`
        )
        .join("")
    : `<li class="muted">${store.wallet ? "No open orders" : "Connect your wallet"}</li>`;

  $("mkTrades").innerHTML = state.trades.length
    ? state.trades
        .map((t) => {
          const url = chain.explorerTx(t.tx);
          return `<li>${lotsLabel(t.lots)} @ ${fmtEth(t.pricePerLot)} / lot · <span class="mono small">${short(t.seller)} → ${short(t.buyer)}</span> ${url ? `· <a href="${url}" target="_blank" rel="noopener">tx</a>` : ""}</li>`;
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

// ---------------- fill an existing order ----------------
function pickOrder(id) {
  const o = state.orders.find((x) => x.id === id);
  if (!o) return;
  state.selected = o;
  $("mkTrade").classList.remove("hidden");
  $("mkTradeTitle").textContent = o.isBid ? `Sell lots into buy order #${o.id}` : `Buy lots from sell order #${o.id}`;
  $("mkTradeInfo").textContent = `${fmtEth(o.pricePerLot)} per lot · ${lotsLabel(o.lots)} available`;
  $("mkTradeLots").value = "1";
  $("mkTradeGo").textContent = o.isBid ? "Sell lots" : "Buy lots";
  render();
  $("mkTrade").scrollIntoView({ behavior: "smooth", block: "nearest" });
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
    ? `Sell ${lotsLabel(lots)} (${tokens}) → you receive ${fmtEth(eth - fee)} (fee ${fmtEth(fee)})`
    : `Buy ${lotsLabel(lots)} (${tokens}) → you pay ${fmtEth(eth)}`;
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
  const price = parsePrice($("mkPrice").value);
  $("mkTotal").textContent =
    lots > 0n && price > 0n ? `${fmtEth(chain.costOf(lots, price))} for ${lotsLabel(lots)} (${fmtAmt(lots * state.lotSize, 0)} ${store.symbol})` : "–";
  if (state.side === "sell") $("mkLotsHint").textContent = store.wallet ? `You have ${lotsLabel(myLots())}` : "";
  else $("mkLotsHint").textContent = "";
}

async function createOrder() {
  if (state.busy) return;
  if (!store.wallet) return alert("Please click 'Connect wallet' at the top first.");
  const lots = parseLots($("mkLots").value);
  const price = parsePrice($("mkPrice").value);
  if (lots <= 0n) return setStatus("Enter whole lots (1, 2, 3…)");
  if (price <= 0n) return setStatus("Enter a price per lot (ETH)");
  if (state.side === "sell" && lots > myLots()) return setStatus(`You only have ${lotsLabel(myLots())}`);
  if (state.side === "buy" && chain.costOf(lots, price) > store.ethBalance) return setStatus("Not enough ETH");

  await busy(async () => {
    setStatus("Confirm in your wallet…");
    if (state.side === "sell") await chain.listForSale(store.wallet, lots, price, setStatus);
    else await chain.placeBid(store.wallet, lots, price);
    $("mkLots").value = "1";
    setStatus(state.side === "sell" ? "✓ Sell order is live" : "✓ Buy order is live");
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

// ---------------- init ----------------
export function initMarket() {
  if (!chain.hasMarket) {
    $("tab-market").innerHTML = `<section class="card"><p class="muted">Marketplace contract is not deployed. Run <code>npm run deploy:testnet</code> again.</p></section>`;
    return { show() {}, hide() {} };
  }
  $("mkSideSell").onclick = () => setSide("sell");
  $("mkSideBuy").onclick = () => setSide("buy");
  $("mkLots").oninput = updateCreateTotal;
  $("mkPrice").oninput = updateCreateTotal;
  $("mkCreate").onclick = createOrder;
  $("mkTradeLots").oninput = updateTradeCost;
  $("mkTradeGo").onclick = doTrade;
  $("mkTradeClose").onclick = () => closeTrade();
  $("mkTradeMax").onclick = () => {
    $("mkTradeLots").value = String(tradeMax());
    updateTradeCost();
  };
  stepper("mkLots", () => (state.side === "sell" ? myLots() : 0n));
  stepper("mkTradeLots", tradeMax);
  $("tab-market").addEventListener("click", (e) => {
    const pick = e.target.closest("[data-pick]");
    const cxl = e.target.closest("[data-cancel]");
    if (pick) pickOrder(BigInt(pick.dataset.pick));
    if (cxl) cancel(BigInt(cxl.dataset.cancel));
  });
  on("wallet", render);
  on("balances:updated", () => {
    $("mkBal").textContent = store.wallet ? lotsLabel(myLots()) : "–";
    $("mkBalEth").textContent = store.wallet ? fmtAmt(store.ethBalance, 5) : "–";
    updateCreateTotal();
  });
  setSide("sell");

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
