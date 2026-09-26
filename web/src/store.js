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
