// Transfer tab: send tokens from the connected wallet to any address.
import { isAddress, parseEther, formatEther } from "viem";
import * as chain from "./chain.js";
import { $, store, on, emit, fmtTok, fmtDur, short, errMsg, escapeHtml } from "./store.js";
import { usd } from "./price.js";
import { indexer } from "./indexer.js";

let actFilter = "all";

function setStatus(s) {
  $("txStatus").textContent = s;
}

/** The connected wallet's claims, transfers and trades, newest first. */
function activity() {
  const me = store.wallet?.address.toLowerCase();
  if (!me) return [];
  const marketAddr = chain.MARKET_CONTRACT?.address.toLowerCase();
  const zero = "0x0000000000000000000000000000000000000000";
  const items = [];
  const tradeTxs = new Set();

  for (const e of indexer.events("market", "Trade")) {
    const a = e.args;
    tradeTxs.add(e.tx);
    const buyer = a.buyer.toLowerCase() === me;
    const seller = a.seller.toLowerCase() === me;
    if (!buyer && !seller) continue;
    items.push({
      kind: "trade",
      block: e.block,
      logIndex: e.logIndex,
      t: Number(a.timestamp) * 1000,
      tx: e.tx,
      text: buyer
        ? `🟢 Bought ${a.lots} lot${a.lots === 1n ? "" : "s"} @ ${usd(a.pricePerLot)} / lot · paid ${usd(a.ethPaid)}`
        : `🔴 Sold ${a.lots} lot${a.lots === 1n ? "" : "s"} @ ${usd(a.pricePerLot)} / lot · got ${usd(a.ethPaid - a.fee)}`,
    });
  }
  for (const e of indexer.events("token", "BlockMined")) {
    const a = e.args;
    if (a.miner.toLowerCase() !== me) continue;
    items.push({
      kind: "claim",
      block: e.block,
      logIndex: e.logIndex,
      t: Number(a.timestamp) * 1000,
      tx: e.tx,
      text: `⛏️ Claimed block #${a.height} · +${fmtTok(a.reward)}`,
    });
  }
  for (const e of indexer.events("token", "Transfer")) {
    const { from, to, value } = e.args;
    const f = from.toLowerCase();
    const t = to.toLowerCase();
    if (f !== me && t !== me) continue;
    // mints, market escrow and trade settlement are shown as claims / trades instead
    if (f === zero || f === marketAddr || t === marketAddr || tradeTxs.has(e.tx)) continue;
    items.push({
      kind: "transfer",
      block: e.block,
      logIndex: e.logIndex,
      t: null,
      tx: e.tx,
      text: f === me ? `↗ Sent ${fmtTok(value)} to ${short(to)}` : `↘ Received ${fmtTok(value)} from ${short(from)}`,
    });
  }
  return items.sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block < b.block ? 1 : -1));
}

function render() {
  $("txBalance").textContent = store.wallet ? fmtTok(store.tokenBalance) : "–";
  if (!store.wallet) {
    $("activity").innerHTML = `<li class="muted">Connect your wallet to see your history</li>`;
    return;
  }
  const list = activity().filter((i) => actFilter === "all" || i.kind === actFilter);
  $("activity").innerHTML = list.length
    ? list
        .slice(0, 100)
        .map((i) => {
          const url = chain.explorerTx(i.tx);
          const when = i.t ? ` · <span class="muted">${fmtDur(Math.max(0, (Date.now() - i.t) / 1000))} ago</span>` : "";
          return `<li>${escapeHtml(i.text)}${when}${url ? ` · <a href="${url}" target="_blank" rel="noopener">tx</a>` : ""}</li>`;
        })
        .join("")
    : `<li class="muted">${indexer.isLoaded() ? "Nothing here yet" : "Loading history…"}</li>`;
}

export function initTransfer() {
  $("txMax").onclick = () => ($("txAmount").value = formatEther(store.tokenBalance));

  $("txSend").onclick = async () => {
    if (!store.wallet) return alert("Please click 'Connect wallet' at the top first.");
    const to = $("txTo").value.trim();
    let amount;
    try {
      amount = parseEther($("txAmount").value.trim() || "0");
    } catch {
      return setStatus("Invalid amount");
    }
    if (!isAddress(to)) return setStatus("Invalid address (0x… 42 characters)");
    if (to.toLowerCase() === store.wallet.address.toLowerCase()) return setStatus("You cannot send to your own wallet");
    if (amount <= 0n) return setStatus("Amount must be greater than 0");
    if (amount > store.tokenBalance) return setStatus(`Insufficient balance (${fmtTok(store.tokenBalance)})`);

    $("txSend").disabled = true;
    setStatus("Confirm in your wallet…");
    try {
      await chain.transferTokens(store.wallet, to, amount);
      indexer.refresh().catch(() => {});
      setStatus(`✓ Sent ${fmtTok(amount)}`);
      $("txAmount").value = "";
      emit("balances");
    } catch (e) {
      setStatus(`Transfer failed: ${errMsg(e)}`);
    } finally {
      $("txSend").disabled = false;
      render();
    }
  };

  $("txWatch").onclick = async () => {
    try {
      await chain.watchToken(store.wallet, store.symbol);
    } catch (e) {
      setStatus(errMsg(e));
    }
  };

  document.querySelectorAll("[data-act]").forEach((b) => {
    b.onclick = () => {
      actFilter = b.dataset.act;
      document.querySelectorAll("[data-act]").forEach((x) => x.classList.toggle("active", x === b));
      render();
    };
  });
  on("balances:updated", render);
  on("wallet", render);
  indexer.subscribe(render);
  render();
}
