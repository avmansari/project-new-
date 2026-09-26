// App shell: wallet connect, balances, top tabs (Mine / Transfer / Marketplace).
import { CONTRACT_ADDRESS, MARKET, POLL_MS } from "./config.js";
import * as chain from "./chain.js";
import { $, store, on, emit, fmtTok, fmtEth, short, errMsg } from "./store.js";
import { initMine } from "./mine.js";
import { initTransfer } from "./transfer.js";
import { initMarket } from "./market.js";
import { pickWallet, restoreWallet, rememberWallet } from "./wallets.js";
import { initStats } from "./stats.js";
import { indexer } from "./indexer.js";
import { ethUsd } from "./price.js";

// ---------- balances ----------
async function loadBalances() {
  if (!store.wallet) return;
  try {
    const [tok, eth] = await Promise.all([chain.balanceOf(store.wallet.address), chain.ethBalanceWei(store.wallet.address)]);
    store.tokenBalance = tok;
    store.ethBalance = eth;
    $("hdrBal").textContent = `${fmtTok(tok)} · ${fmtEth(eth, 4)}`;
    emit("balances:updated");
  } catch {}
}
on("balances", loadBalances);

// ---------- wallet ----------
function setWallet(w) {
  store.wallet = w;
  $("btnConnect").textContent = w ? short(w.address) : "Connect wallet";
  $("btnConnect").classList.toggle("secondary", !!w);
  $("hdrBal").classList.toggle("hidden", !w);
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
}

function disconnect() {
  store.wallet?.provider?.disconnect?.(); // WalletConnect session
  rememberWallet(null);
  setWallet(null);
}

$("btnConnect").onclick = async () => {
  if (store.wallet) {
    if (confirm(`${store.wallet.name || "Wallet"} disconnect karein?`)) disconnect();
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
const TABS = ["mine", "transfer", "market", "stats"];
let market;
function showTab(name) {
  if (!TABS.includes(name)) name = "mine";
  for (const t of TABS) {
    $(`tab-${t}`).classList.toggle("hidden", t !== name);
    document.querySelector(`[data-tab="${t}"]`).classList.toggle("active", t === name);
  }
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
indexer.start();
ethUsd().then(() => emit("balances:updated"));
setInterval(ethUsd, 60_000);
$("contractAddr").textContent = CONTRACT_ADDRESS;
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
