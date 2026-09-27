// App shell: wallet connect, balances, top tabs (Mine / Transfer / Marketplace).
import { CHAIN, CONTRACT_ADDRESS, MARKET, POLL_MS } from "./config.js";
import * as chain from "./chain.js";
import { $, store, on, emit, fmtAmt, short, errMsg, escapeHtml, avatar } from "./store.js";
import { initMine } from "./mine.js";
import { initTransfer } from "./transfer.js";
import { initMarket } from "./market.js";
import { pickWallet, restoreWallet, rememberWallet } from "./wallets.js";
import { initStats } from "./stats.js";
import { initLeaderboard } from "./leaderboard.js";
import { indexer } from "./indexer.js";
import { ethUsd, usd } from "./price.js";
import { track } from "./analytics.js";
import { requireTerms } from "./terms-gate.js";

requireTerms();

// ---------- balances ----------
async function loadBalances() {
  if (!store.wallet) return;
  try {
    const [tok, eth] = await Promise.all([chain.balanceOf(store.wallet.address), chain.ethBalanceWei(store.wallet.address)]);
    store.tokenBalance = tok;
    store.ethBalance = eth;
    renderHeaderBalances();
    emit("balances:updated");
  } catch {}
}
on("balances", loadBalances);

function renderHeaderBalances() {
  const w = store.wallet;
  $("hdrTok").classList.toggle("hidden", !w);
  $("hdrUsd").classList.toggle("hidden", !w);
  if (!w) return;
  $("hdrTok").textContent = `${fmtAmt(store.tokenBalance, 0)} ${store.symbol}`;
  $("hdrUsd").textContent = usd(store.ethBalance);
}
on("balances:updated", renderHeaderBalances);

// ---------- wallet ----------
function setWallet(w) {
  store.wallet = w;
  const btn = $("btnConnect");
  if (w) btn.innerHTML = `${avatar(w.address, 26)}${escapeHtml(short(w.address))}`;
  else btn.textContent = "Connect wallet";
  btn.classList.toggle("wallet-chip", !!w);
  btn.title = w ? `${w.name || "Wallet"} · click to disconnect` : "";
  renderHeaderBalances();
  emit("wallet", w);
  if (w) loadBalances();
}

async function useProvider(picked, silent = false) {
  const w = await chain.connectProvider(picked.provider, { silent });
  w.name = picked.name;
  rememberWallet(picked.id);
  chain.onAccountChange(picked.provider, (addr) => {
    if (!store.wallet || store.wallet.provider !== picked.provider) return;
    if (!addr) return disconnect();
    setWallet({ ...store.wallet, address: addr });
  });
  setWallet(w);
  if (!silent) track("Wallet connected", { wallet: picked.name || "unknown" });
}

function disconnect() {
  store.wallet?.provider?.disconnect?.(); // WalletConnect session
  rememberWallet(null);
  setWallet(null);
}

$("btnConnect").onclick = async () => {
  if (store.wallet) {
    if (confirm(`Disconnect ${store.wallet.name || "this wallet"}?`)) disconnect();
    return;
  }
  const picked = await pickWallet();
  if (!picked) return;
  try {
    await useProvider(picked);
  } catch (e) {
    alert(errMsg(e));
  }
};

restoreWallet().then((picked) => picked && useProvider(picked, true).catch(() => {}));

// ---------- tabs ----------
const TABS = ["mine", "transfer", "market", "leaderboard", "stats"];
const TITLES = {
  mine: ["Mine", "Race the network for the next block"],
  transfer: ["Transfer", "Send tokens to any address"],
  market: ["Marketplace", "Trade whole lots · priced in USD"],
  leaderboard: ["Leaderboard", "Top 100 holders · updated live"],
  stats: ["Stats", "Network health, straight from the chain"],
};
let leaderboard;
let market;
function showTab(name) {
  if (!TABS.includes(name)) name = "mine";
  for (const t of TABS) {
    $(`tab-${t}`).classList.toggle("hidden", t !== name);
    document.querySelectorAll(`[data-tab="${t}"]`).forEach((b) => b.classList.toggle("active", t === name));
  }
  $("pageTitle").textContent = TITLES[name][0];
  $("pageSub").textContent = TITLES[name][1];
  document.title = `${TITLES[name][0]} · PoW Miner`;
  window.scrollTo({ top: 0 });
  if (name === "leaderboard") leaderboard.show();
  if (name === "market") market.show();
  else market.hide();
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
}
document.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

// ---------- boot ----------
const refreshMine = initMine();
initTransfer();
market = initMarket();
initStats();
leaderboard = initLeaderboard();
indexer.start();
ethUsd().then(() => emit("balances:updated"));
setInterval(ethUsd, 60_000);
$("contractAddr").textContent = CONTRACT_ADDRESS;
$("netName").textContent = CHAIN.name;
$("netTag").textContent = CHAIN.testnet ? "testnet" : "";
$("marketAddr").textContent = MARKET?.address ?? "–";
chain
  .getSymbol()
  .then((s) => {
    store.symbol = s;
    document.querySelectorAll(".sym").forEach((el) => (el.textContent = s));
    emit("balances:updated");
  })
  .catch(() => {});
showTab(location.hash.slice(1));
refreshMine();
setInterval(refreshMine, POLL_MS);
setInterval(loadBalances, POLL_MS * 2);
