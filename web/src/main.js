// App shell: wallet connect, balances, top tabs (Mine / Transfer / Marketplace).
import { CONTRACT_ADDRESS, MARKET, POLL_MS } from "./config.js";
import * as chain from "./chain.js";
import { $, store, on, emit, fmtTok, fmtEth, short, errMsg } from "./store.js";
import { initMine } from "./mine.js";
import { initTransfer } from "./transfer.js";
import { initMarket } from "./market.js";

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
  $("btnConnect").textContent = short(w.address);
  $("btnConnect").classList.add("secondary");
  $("hdrBal").classList.remove("hidden");
  emit("wallet", w);
  loadBalances();
}

$("btnConnect").onclick = async () => {
  if (store.wallet) return;
  try {
    setWallet(await chain.connectInjected());
  } catch (e) {
    alert(errMsg(e));
  }
};

chain.onAccountChange((addr) => {
  if (addr && store.wallet) setWallet({ ...store.wallet, address: addr });
});

// ---------- tabs ----------
const TABS = ["mine", "transfer", "market"];
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
