// Landing page: live network numbers straight from the token contract.
import * as chain from "./chain.js";
import { $, fmtDur } from "./store.js";

async function load() {
  try {
    const [i, sym] = await Promise.all([chain.getMiningInfo(), chain.getSymbol()]);
    document.querySelectorAll(".sym").forEach((el) => (el.textContent = sym));
    $("lsBlocks").textContent = `${Number(i.height).toLocaleString("en")} / 4,200`;
    $("lsSupply").textContent = `${((Number(i.totalSupply) / 1e18 / 21_000_000) * 100).toFixed(2)}%`;
    $("lsBits").textContent = `${i.requiredBits} bits`;
    $("lsLast").textContent = `${fmtDur(Math.max(0, Date.now() / 1000 - Number(i.lastBlockTime)))} ago`;
    $("lsNote").textContent = "Live from the blockchain · updates every 15 s.";
  } catch {
    $("lsNote").textContent = "Live stats are unavailable right now.";
  }
}
load();
setInterval(load, 15_000);
