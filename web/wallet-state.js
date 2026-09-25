// Ek jagah se poori site ke liye "connected wallet" ka state. localStorage me save hota hai,
// taaki page badalne ya refresh karne pe dobara connect na karna pade.
import { connectNoir, detectNoir, explainError, networkOfAddress } from "./noir.js";

const KEY = "wallet:address";
const listeners = new Set();

export function getConnectedAddress() {
  try { return localStorage.getItem(KEY) || null; } catch { return null; }
}
function setConnectedAddress(addr) {
  try { addr ? localStorage.setItem(KEY, addr) : localStorage.removeItem(KEY); } catch { /* ignore */ }
  for (const fn of listeners) fn(addr);
}
export function onWalletChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function disconnectWallet() {
  setConnectedAddress(null);
}

/** Page load pe: agar wallet pehle se authorized hai to silently (bina popup) address utha leta hai. */
export async function tryReconnect(network) {
  const provider = await detectNoir(window, 1500);
  if (!provider) return null;
  try {
    const acc = await connectNoir(provider, { silent: true });
    if (networkOfAddress(acc.transparent) !== network) return null; // galat network wallet, chup rahenge
    setConnectedAddress(acc.transparent);
    return acc.transparent;
  } catch {
    return null;
  }
}

/** "Connect Wallet" button dabane pe: popup ke saath asli connect. */
export async function connectWallet(network) {
  const provider = await detectNoir(window, 3000);
  if (!provider) throw new Error("Noir Wallet nahi mila. Extension install hai? localhost pe kholo (127.0.0.1 pe nahi).");
  const acc = await connectNoir(provider, { silent: false });
  if (networkOfAddress(acc.transparent) !== network) {
    throw new Error(`Wallet ${networkOfAddress(acc.transparent) || "kisi aur"} network pe hai, ye site ${network} pe hai.`);
  }
  setConnectedAddress(acc.transparent);
  return acc.transparent;
}

export async function getNoirProvider() {
  return detectNoir(window, 3000);
}

export function short(addr) {
  return addr ? addr.slice(0, 6) + "..." + addr.slice(-4) : "";
}

export { explainError };
