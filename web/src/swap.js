// DEX pool UI (inside the Marketplace tab): instant buy/sell in whole lots + add/remove liquidity.
import { parseEther } from "viem";
import * as chain from "./chain.js";
import { $, store, on, emit, fmtAmt, fmtEth, errMsg } from "./store.js";
import { usdOf } from "./price.js";

const state = { side: "buy", pool: null, lotSize: 0n, busy: false };
const lotsLabel = (n) => `${n} lot${BigInt(n) === 1n ? "" : "s"}`;
const parseLots = (v) => (/^\d+$/.test(String(v).trim()) ? BigInt(String(v).trim()) : -1n);
const parseEth = (v) => {
  try {
    return parseEther(String(v).trim() || "0");
  } catch {
    return -1n;
  }
};
const setStatus = (s) => ($("mkStatus").textContent = s);
const myLots = () => (state.lotSize ? store.tokenBalance / state.lotSize : 0n);

async function refresh() {
  if (!chain.hasPool) return;
  try {
    state.lotSize ||= await chain.lotSize();
    state.pool = await chain.poolState(store.wallet?.address);
    render();
  } catch (e) {
    $("swPoolInfo").textContent = "Pool load error: " + errMsg(e);
  }
}

function render() {
  const p = state.pool;
  if (!p) return;
  const open = p.reserveEth > 0n;
  const reserveLots = state.lotSize ? p.reserveToken / state.lotSize : 0n;
  $("swPoolInfo").textContent = open
    ? `Pool price: ${fmtEth(p.price)} / lot ${usdOf(p.price)} · pool holds ${reserveLots.toLocaleString("en")} lots + ${fmtEth(p.reserveEth, 4)} · fee ${Number(p.feeBps) / 100}% + 0.3% LP`
    : "The pool is not open yet: the first liquidity provider sets the starting price (see Pool liquidity below).";
  $("swGo").disabled = !open || state.busy;
  updateQuote();

  // liquidity card
  const share = p.totalSupply > 0n ? Number((p.lp * 10_000n) / p.totalSupply) / 100 : 0;
  const myEth = p.totalSupply > 0n ? (p.lp * p.reserveEth) / p.totalSupply : 0n;
  const myTok = p.totalSupply > 0n ? (p.lp * p.reserveToken) / p.totalSupply : 0n;
  $("lpInfo").textContent = store.wallet
    ? p.lp > 0n
      ? `Your share: ${share}% of the pool ≈ ${fmtEth(myEth, 5)} + ${fmtAmt(myTok, 0)} ${store.symbol}`
      : "You have no liquidity in the pool."
    : "Connect your wallet to add liquidity.";
  $("lpFirstRow").classList.toggle("hidden", open);
  $("lpRemove").disabled = p.lp === 0n || state.busy;
  updateLpPreview();
}

async function updateQuote() {
  const p = state.pool;
  const lots = parseLots($("swLots").value);
  if (!p || p.reserveEth === 0n) return ($("swQuote").textContent = "–");
  if (lots <= 0n) return ($("swQuote").textContent = "Enter whole lots (1, 2, 3…)");
  try {
    if (state.side === "buy") {
      const [total, fee] = await chain.quotePoolBuy(lots);
      const avg = total / lots;
      const impact = p.price ? Number(((avg - p.price) * 10_000n) / p.price) / 100 : 0;
      $("swQuote").textContent = `Pay ${fmtEth(total)} ${usdOf(total)} for ${lotsLabel(lots)} · avg ${fmtEth(avg)} / lot · price impact ${impact.toFixed(2)}% (incl. fee ${fmtEth(fee)})`;
    } else {
      const [net, fee] = await chain.quotePoolSell(lots);
      $("swQuote").textContent = `Receive ${fmtEth(net)} ${usdOf(net)} for ${lotsLabel(lots)} · avg ${fmtEth(net / lots)} / lot (after fee ${fmtEth(fee)})${lots > myLots() ? ` · you only have ${lotsLabel(myLots())}` : ""}`;
    }
  } catch {
    $("swQuote").textContent = "Not enough liquidity in the pool for that many lots";
  }
}

function setSide(side) {
  state.side = side;
  $("swBuySide").classList.toggle("active", side === "buy");
  $("swSellSide").classList.toggle("active", side === "sell");
  $("swGo").textContent = side === "buy" ? "Buy instantly" : "Sell instantly";
  updateQuote();
}

async function busy(fn) {
  state.busy = true;
  ["swGo", "lpAdd", "lpRemove"].forEach((id) => ($(id).disabled = true));
  try {
    await fn();
    emit("balances");
  } catch (e) {
    console.error(e);
    setStatus(`Failed: ${errMsg(e)}`);
  } finally {
    state.busy = false;
    $("lpAdd").disabled = false;
    await refresh();
  }
}

async function swap() {
  if (!store.wallet) return alert("Please click 'Connect wallet' at the top first.");
  const lots = parseLots($("swLots").value);
  if (lots <= 0n) return setStatus("Enter whole lots (1, 2, 3…)");
  if (state.side === "sell" && lots > myLots()) return setStatus(`You only have ${lotsLabel(myLots())}`);
  await busy(async () => {
    setStatus("Confirm in your wallet…");
    if (state.side === "buy") await chain.poolBuy(store.wallet, lots);
    else await chain.poolSell(store.wallet, lots, setStatus);
    setStatus(`✓ Swap done: ${state.side === "buy" ? "bought" : "sold"} ${lotsLabel(lots)}`);
  });
}

function lpTokensFor(eth) {
  const p = state.pool;
  if (!p || eth <= 0n) return 0n;
  if (p.reserveEth === 0n) {
    const lots = parseLots($("lpLots").value);
    return lots > 0n ? lots * state.lotSize : 0n;
  }
  return (eth * p.reserveToken) / p.reserveEth + 1n;
}

function updateLpPreview() {
  const eth = parseEth($("lpEth").value);
  const tokens = lpTokensFor(eth);
  if (eth <= 0n || tokens <= 0n) return ($("lpPreview").textContent = "–");
  const price = state.pool.reserveEth === 0n ? (eth * state.lotSize) / tokens : state.pool.price;
  $("lpPreview").textContent = `You add ${fmtEth(eth)} + ${fmtAmt(tokens, 0)} ${store.symbol} · price ${fmtEth(price)} / lot`;
}

async function addLiquidity() {
  if (!store.wallet) return alert("Please click 'Connect wallet' at the top first.");
  const eth = parseEth($("lpEth").value);
  const tokens = lpTokensFor(eth);
  if (eth <= 0n) return setStatus("Enter an ETH amount");
  if (tokens <= 0n) return setStatus("Enter how many lots to pair");
  if (tokens > store.tokenBalance) return setStatus(`You need ${fmtAmt(tokens, 0)} ${store.symbol}`);
  if (eth > store.ethBalance) return setStatus("Not enough ETH");
  await busy(async () => {
    setStatus("Confirm in your wallet…");
    // first provider: exact amount sets the price; later: allow 1% ratio drift between quote and execution
    const first = state.pool.reserveEth === 0n;
    await chain.poolAdd(store.wallet, eth, first ? tokens : (tokens * 101n) / 100n, setStatus);
    $("lpEth").value = "";
    setStatus("✓ Liquidity added");
  });
}

async function removeLiquidity() {
  if (!state.pool?.lp) return;
  await busy(async () => {
    setStatus("Confirm in your wallet…");
    await chain.poolRemove(store.wallet, state.pool.lp);
    setStatus("✓ Liquidity removed: ETH + tokens returned");
  });
}

export function initSwap() {
  if (!chain.hasPool) {
    $("swapCard").remove();
    $("lpCard").remove();
    return { refresh() {} };
  }
  $("swBuySide").onclick = () => setSide("buy");
  $("swSellSide").onclick = () => setSide("sell");
  $("swLots").oninput = updateQuote;
  $("swLotsMinus").onclick = () => {
    $("swLots").value = String(Math.max(1, Number(parseLots($("swLots").value)) - 1));
    updateQuote();
  };
  $("swLotsPlus").onclick = () => {
    $("swLots").value = String(Math.max(1, Number(parseLots($("swLots").value)) + 1));
    updateQuote();
  };
  $("swGo").onclick = swap;
  $("lpEth").oninput = updateLpPreview;
  $("lpLots").oninput = updateLpPreview;
  $("lpAdd").onclick = addLiquidity;
  $("lpRemove").onclick = removeLiquidity;
  on("wallet", refresh);
  on("balances:updated", render);
  return { refresh };
}
