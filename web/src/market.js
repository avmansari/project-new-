// Marketplace tab: on-chain order book (sell listings + buy bids), paid in ETH, refreshed every few seconds.
import { parseEther, formatEther } from "viem";
import * as chain from "./chain.js";
import { $, store, on, emit, fmtAmt, fmtTok, fmtEth, short, errMsg } from "./store.js";

const REFRESH_MS = 4000;
const state = { orders: [], trades: [], feeBps: 0n, side: "sell", selected: null, busy: false, timer: null };

const setStatus = (s) => ($("mkStatus").textContent = s);
const mine = (o) => store.wallet && o.maker.toLowerCase() === store.wallet.address.toLowerCase();
const parseAmt = (v) => {
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
  const open = state.orders.filter((o) => o.active && o.amount > 0n);
  const asks = open.filter((o) => !o.isBid).sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
  const bids = open.filter((o) => o.isBid).sort((a, b) => (a.price > b.price ? -1 : a.price < b.price ? 1 : 0));

  // stats
  $("mkFloor").textContent = asks.length ? fmtEth(asks[0].price, 8) : "–";
  $("mkBestBid").textContent = bids.length ? fmtEth(bids[0].price, 8) : "–";
  $("mkLast").textContent = state.trades.length ? fmtEth(state.trades[0].price, 8) : "–";
  const vol = state.trades.reduce((s, t) => s + t.ethPaid, 0n);
  $("mkVolume").textContent = fmtEth(vol, 4);
  $("mkFee").textContent = `${Number(state.feeBps) / 100}%`;

  const row = (o, action) => `
    <tr data-id="${o.id}" class="${state.selected?.id === o.id ? "sel" : ""}">
      <td class="${o.isBid ? "up" : "down"}">${fmtAmt(o.price, 8)}</td>
      <td>${fmtAmt(o.amount, 2)}</td>
      <td>${fmtAmt(chain.costOf(o.amount, o.price), 5)}</td>
      <td class="mono small">${mine(o) ? "you" : short(o.maker)}</td>
      <td>${mine(o) ? `<button class="mini secondary" data-cancel="${o.id}">Cancel</button>` : `<button class="mini" data-pick="${o.id}">${action}</button>`}</td>
    </tr>`;
  const head = `<tr><th>Price (ETH/token)</th><th>Amount</th><th>Total ETH</th><th>By</th><th></th></tr>`;
  $("mkAsks").innerHTML = head + (asks.map((o) => row(o, "Buy")).join("") || `<tr><td colspan="5" class="muted">Koi sell order nahi</td></tr>`);
  $("mkBids").innerHTML = head + (bids.map((o) => row(o, "Sell")).join("") || `<tr><td colspan="5" class="muted">Koi buy order nahi</td></tr>`);

  // my orders
  const my = open.filter(mine);
  $("mkMine").innerHTML = my.length
    ? my
        .map(
          (o) =>
            `<li>${o.isBid ? "🟢 Buying" : "🔴 Selling"} ${fmtTok(o.amount)} @ ${fmtEth(o.price, 8)} <button class="mini secondary" data-cancel="${o.id}">Cancel</button></li>`
        )
        .join("")
    : `<li class="muted">${store.wallet ? "Koi open order nahi" : "Wallet connect karo"}</li>`;

  // trades
  $("mkTrades").innerHTML = state.trades.length
    ? state.trades
        .map((t) => {
          const url = chain.explorerTx(t.tx);
          return `<li>${fmtTok(t.amount)} @ ${fmtEth(t.price, 8)} · <span class="mono small">${short(t.seller)} → ${short(t.buyer)}</span> ${url ? `· <a href="${url}" target="_blank" rel="noopener">tx</a>` : ""}</li>`;
        })
        .join("")
    : `<li class="muted">Abhi tak koi trade nahi</li>`;

  // keep the trade panel in sync with the (possibly partially filled) order
  if (state.selected) {
    const fresh = open.find((o) => o.id === state.selected.id);
    if (!fresh) closeTrade("Yeh order ab available nahi hai (fill ya cancel ho gaya)");
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
  $("mkTradeTitle").textContent = o.isBid ? `Sell into buy order #${o.id}` : `Buy from sell order #${o.id}`;
  $("mkTradeInfo").textContent = `Price ${fmtEth(o.price, 8)} per token · available ${fmtTok(o.amount)}`;
  $("mkTradeAmt").value = formatEther(o.amount);
  $("mkTradeGo").textContent = o.isBid ? "Sell tokens" : "Buy tokens";
  updateTradeCost();
  render();
  $("mkTrade").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeTrade(msg) {
  state.selected = null;
  $("mkTrade").classList.add("hidden");
  if (msg) setStatus(msg);
}

function updateTradeCost() {
  const o = state.selected;
  if (!o) return;
  const amt = parseAmt($("mkTradeAmt").value);
  if (amt <= 0n) return ($("mkTradeCost").textContent = "–");
  const eth = chain.costOf(amt, o.price);
  const fee = (eth * state.feeBps) / 10_000n;
  $("mkTradeCost").textContent = o.isBid ? `Tumhe milega: ${fmtEth(eth - fee)} (fee ${fmtEth(fee)})` : `Tum pay karoge: ${fmtEth(eth)}`;
}

async function doTrade() {
  const o = state.selected;
  if (!o || state.busy) return;
  if (!store.wallet) return alert("Pehle upar 'Connect wallet' dabao.");
  const amt = parseAmt($("mkTradeAmt").value);
  if (amt <= 0n) return setStatus("Amount galat hai");
  if (amt > o.amount) return setStatus(`Is order mein sirf ${fmtTok(o.amount)} available hai`);
  if (o.isBid && amt > store.tokenBalance) return setStatus(`Tumhare paas sirf ${fmtTok(store.tokenBalance)} hai`);
  if (!o.isBid && chain.costOf(amt, o.price) > store.ethBalance) return setStatus("ETH balance kam hai");

  await busy(async () => {
    setStatus("wallet mein confirm karo…");
    if (o.isBid) await chain.sellIntoBid(store.wallet, o.id, amt, setStatus);
    else await chain.buyFromListing(store.wallet, o.id, amt, o.price);
    closeTrade(`✓ Trade ho gaya: ${fmtTok(amt)}`);
  });
}

// ---------------- create a new order ----------------
function setSide(side) {
  state.side = side;
  $("mkSideSell").classList.toggle("active", side === "sell");
  $("mkSideBuy").classList.toggle("active", side === "buy");
  $("mkCreate").textContent = side === "sell" ? "List for sale" : "Place buy order";
  $("mkCreateHint").textContent =
    side === "sell"
      ? "Tumhare tokens market contract mein lock honge jab tak koi khareed na le ya tum cancel na karo. (2 wallet confirmations: approve + list)"
      : "Tumhara ETH lock hoga jab tak koi tokens bech na de ya tum cancel na karo.";
  updateCreateTotal();
}

function updateCreateTotal() {
  const amt = parseAmt($("mkAmt").value);
  const price = parseAmt($("mkPrice").value);
  $("mkTotal").textContent = amt > 0n && price > 0n ? fmtEth(chain.costOf(amt, price)) : "–";
}

async function createOrder() {
  if (state.busy) return;
  if (!store.wallet) return alert("Pehle upar 'Connect wallet' dabao.");
  const amt = parseAmt($("mkAmt").value);
  const price = parseAmt($("mkPrice").value);
  if (amt <= 0n) return setStatus("Token amount daalo");
  if (price <= 0n) return setStatus("Price per token (ETH) daalo");
  if (state.side === "sell" && amt > store.tokenBalance) return setStatus(`Tumhare paas sirf ${fmtTok(store.tokenBalance)} hai`);
  if (state.side === "buy" && chain.costOf(amt, price) > store.ethBalance) return setStatus("ETH balance kam hai");

  await busy(async () => {
    setStatus("wallet mein confirm karo…");
    if (state.side === "sell") await chain.listForSale(store.wallet, amt, price, setStatus);
    else await chain.placeBid(store.wallet, amt, price);
    $("mkAmt").value = "";
    setStatus(state.side === "sell" ? "✓ Sell order live hai" : "✓ Buy order live hai");
  });
}

async function cancel(id) {
  await busy(async () => {
    setStatus("wallet mein confirm karo…");
    await chain.cancelOrder(store.wallet, id);
    setStatus(`✓ Order #${id} cancel ho gaya, funds wapas`);
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

// ---------------- init ----------------
export function initMarket() {
  if (!chain.hasMarket) {
    $("tab-market").innerHTML = `<section class="card"><p class="muted">Marketplace contract deploy nahi hua. <code>npm run deploy:testnet</code> dobara chalao.</p></section>`;
    return { show() {}, hide() {} };
  }
  $("mkSideSell").onclick = () => setSide("sell");
  $("mkSideBuy").onclick = () => setSide("buy");
  $("mkAmt").oninput = updateCreateTotal;
  $("mkPrice").oninput = updateCreateTotal;
  $("mkCreate").onclick = createOrder;
  $("mkTradeAmt").oninput = updateTradeCost;
  $("mkTradeGo").onclick = doTrade;
  $("mkTradeClose").onclick = () => closeTrade();
  $("mkTradeMax").onclick = () => {
    if (!state.selected) return;
    const cap = state.selected.isBid && store.tokenBalance < state.selected.amount ? store.tokenBalance : state.selected.amount;
    $("mkTradeAmt").value = formatEther(cap);
    updateTradeCost();
  };
  // table / list buttons (event delegation)
  $("tab-market").addEventListener("click", (e) => {
    const pick = e.target.closest("[data-pick]");
    const cxl = e.target.closest("[data-cancel]");
    if (pick) pickOrder(BigInt(pick.dataset.pick));
    if (cxl) cancel(BigInt(cxl.dataset.cancel));
  });
  on("wallet", render);
  on("balances:updated", () => {
    $("mkBal").textContent = store.wallet ? fmtAmt(store.tokenBalance, 2) : "–";
    $("mkBalEth").textContent = store.wallet ? fmtAmt(store.ethBalance, 5) : "–";
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
