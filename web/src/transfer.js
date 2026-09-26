// Transfer tab: send tokens from the connected wallet to any address.
import { isAddress, parseEther, formatEther } from "viem";
import * as chain from "./chain.js";
import { $, store, on, emit, fmtTok, short, errMsg } from "./store.js";

const sent = [];

function setStatus(s) {
  $("txStatus").textContent = s;
}

function render() {
  $("txBalance").textContent = store.wallet ? fmtTok(store.tokenBalance) : "–";
  $("txSent").innerHTML = sent.length
    ? sent
        .map((t) => {
          const url = chain.explorerTx(t.hash);
          return `<li>${fmtTok(t.amount)} → <span class="mono">${short(t.to)}</span> ${url ? `· <a href="${url}" target="_blank" rel="noopener">tx</a>` : ""}</li>`;
        })
        .join("")
    : `<li class="muted">Abhi tak kuch nahi bheja</li>`;
}

export function initTransfer() {
  $("txMax").onclick = () => ($("txAmount").value = formatEther(store.tokenBalance));

  $("txSend").onclick = async () => {
    if (!store.wallet) return alert("Pehle upar 'Connect wallet' dabao.");
    const to = $("txTo").value.trim();
    let amount;
    try {
      amount = parseEther($("txAmount").value.trim() || "0");
    } catch {
      return setStatus("Amount galat hai");
    }
    if (!isAddress(to)) return setStatus("Address galat hai (0x… 42 characters)");
    if (to.toLowerCase() === store.wallet.address.toLowerCase()) return setStatus("Apne hi wallet mein nahi bhej sakte");
    if (amount <= 0n) return setStatus("Amount 0 se zyada daalo");
    if (amount > store.tokenBalance) return setStatus(`Balance kam hai (${fmtTok(store.tokenBalance)})`);

    $("txSend").disabled = true;
    setStatus("wallet mein confirm karo…");
    try {
      const { hash } = await chain.transferTokens(store.wallet, to, amount);
      sent.unshift({ to, amount, hash });
      setStatus(`✓ ${fmtTok(amount)} bhej diye`);
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

  on("balances:updated", render);
  render();
}
