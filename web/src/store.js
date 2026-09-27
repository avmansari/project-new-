// Shared app state + helpers used by all tabs (Mine / Transfer / Marketplace).
import { formatEther } from "viem";

export const $ = (id) => document.getElementById(id);

export const store = {
  wallet: null, // { address, client }
  symbol: "XYZ",
  tokenBalance: 0n,
  ethBalance: 0n,
};

const listeners = {};
export const on = (ev, fn) => (listeners[ev] ??= []).push(fn);
export const emit = (ev, data) => (listeners[ev] ?? []).forEach((fn) => fn(data));

export const fmtNum = (n) => Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(n);
export const fmtAmt = (wei, max = 4) => Number(formatEther(wei)).toLocaleString("en", { maximumFractionDigits: max });
export const fmtTok = (wei) => `${fmtAmt(wei)} ${store.symbol}`;
export const fmtEth = (wei, max = 6) => `${fmtAmt(wei, max)} ETH`;
export const fmtDur = (s) => {
  if (!isFinite(s)) return "∞";
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
};
export const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const errMsg = (e) => {
  const m = e?.shortMessage || e?.message || String(e);
  if (/reject|denied/i.test(m)) return "rejected in wallet";
  return m;
};
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Require a connected wallet, otherwise ask the user to connect. */
export function needWallet() {
  if (store.wallet) return true;
  alert("Please click 'Connect wallet' at the top first.");
  return false;
}

/** Deterministic gradient "blockie" for an address (inline HTML). */
export function avatar(addr, size = 28) {
  const a = String(addr || "0x000000").toLowerCase();
  const h1 = parseInt(a.slice(2, 5), 16) % 360;
  const h2 = (h1 + 60 + (parseInt(a.slice(5, 7), 16) % 120)) % 360;
  return `<span class="av" style="width:${size}px;height:${size}px;background:conic-gradient(from ${h1}deg, hsl(${h1} 90% 60%), hsl(${h2} 90% 55%), hsl(${h1} 90% 60%))"></span>`;
}

/** Hashrate split into value + unit, e.g. [412.6, "MH/s"]. */
export function rateParts(h) {
  const units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s"];
  let i = 0;
  while (h >= 1000 && i < units.length - 1) {
    h /= 1000;
    i++;
  }
  return [h >= 100 ? h.toFixed(0) : h >= 10 ? h.toFixed(1) : h.toFixed(2), units[i]];
}
export const fmtRate = (h) => rateParts(h).join(" ");

/** "0x" + digest with its leading zero hex digits highlighted (<b>), trimmed to `len` chars. */
export function hashHtml(hex, len = 66) {
  const body = hex.slice(2);
  const z = body.match(/^0*/)[0].length;
  const rest = body.slice(z, Math.max(z, len - 2));
  return `0x<b>${"0".repeat(z)}</b>${rest}${len - 2 < body.length ? "…" : ""}`;
}
