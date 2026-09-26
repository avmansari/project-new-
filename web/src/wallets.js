// Multi-wallet picker.
//  1. Browser extension wallets are discovered automatically via EIP-6963
//     (MetaMask, Rabby, Coinbase, OKX, Trust, Phantom, Brave, Zerion, …) — each shows its own name + icon.
//  2. WalletConnect: any mobile wallet app via QR code (needs VITE_WC_PROJECT_ID from https://cloud.reown.com, free).
//  3. On phones without an in-app wallet: "Open in <wallet> app" deep links.
import { CHAIN } from "./config.js";
import { $, escapeHtml } from "./store.js";

const WC_PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID || "";
const LAST_KEY = "pow-last-wallet";

// ---------------- EIP-6963 discovery ----------------
const discovered = new Map(); // rdns -> { info: {name, icon, rdns, uuid}, provider }
window.addEventListener("eip6963:announceProvider", (e) => {
  const d = e.detail;
  if (d?.info?.rdns && d.provider) discovered.set(d.info.rdns, d);
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

function injectedWallets() {
  const list = [...discovered.values()];
  // Old-style wallets that only set window.ethereum (no EIP-6963)
  if (!list.length && window.ethereum) {
    const e = window.ethereum;
    const name = e.isRabby ? "Rabby" : e.isCoinbaseWallet ? "Coinbase Wallet" : e.isTrust ? "Trust Wallet" : e.isOkxWallet ? "OKX Wallet" : e.isMetaMask ? "MetaMask" : "Browser wallet";
    list.push({ info: { name, icon: null, rdns: "injected" }, provider: e });
  }
  return list;
}

const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function deepLinks() {
  const here = location.href;
  const noProto = here.replace(/^https?:\/\//, "");
  return [
    { name: "MetaMask", url: `https://metamask.app.link/dapp/${noProto}` },
    { name: "Trust Wallet", url: `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(here)}` },
    { name: "Coinbase Wallet", url: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(here)}` },
  ];
}

async function walletConnectProvider() {
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  const provider = await EthereumProvider.init({
    projectId: WC_PROJECT_ID,
    optionalChains: [CHAIN.id],
    rpcMap: { [CHAIN.id]: CHAIN.rpcUrls.default.http[0] },
    showQrModal: true,
    metadata: {
      name: "PoW Miner",
      description: "Mine, transfer and trade on Robinhood Chain",
      url: location.origin,
      icons: [],
    },
  });
  await provider.connect();
  return provider;
}

// ---------------- picker modal ----------------
function iconHtml(icon, name) {
  return icon ? `<img src="${escapeHtml(icon)}" alt="" width="28" height="28" />` : `<span class="wicon">${escapeHtml(name[0])}</span>`;
}

/** Opens the picker; resolves with { provider, id } or null if closed. */
export function pickWallet() {
  // ask again right before opening (some extensions announce late)
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return new Promise((resolve) => {
    const wallets = injectedWallets();
    const overlay = document.createElement("div");
    overlay.className = "modal";
    overlay.innerHTML = `
      <div class="sheet" role="dialog" aria-label="Connect a wallet">
        <div class="sheet-head"><h2>Connect a wallet</h2><button class="secondary mini" data-close>✕</button></div>
        ${wallets.length ? `<p class="small muted">Detected in this browser:</p>` : ""}
        <div class="wlist">
          ${wallets.map((w, i) => `<button class="witem" data-inj="${i}">${iconHtml(w.info.icon, w.info.name)}<span>${escapeHtml(w.info.name)}</span></button>`).join("")}
          ${
            WC_PROJECT_ID
              ? `<button class="witem" data-wc>${iconHtml(null, "W")}<span>WalletConnect<br /><small class="muted">Scan a QR with your phone wallet</small></span></button>`
              : ""
          }
        </div>
        ${
          !wallets.length && isMobile()
            ? `<p class="small muted">On a phone: open this site inside your wallet app</p>
               <div class="wlist">${deepLinks().map((d) => `<a class="witem" href="${d.url}">${iconHtml(null, d.name)}<span>Open in ${d.name}</span></a>`).join("")}</div>`
            : ""
        }
        ${
          !wallets.length && !isMobile()
            ? `<p class="small">No wallet extension found. Install one: <a href="https://metamask.io/download/" target="_blank" rel="noopener">MetaMask</a> · <a href="https://rabby.io" target="_blank" rel="noopener">Rabby</a> · <a href="https://www.coinbase.com/wallet/downloads" target="_blank" rel="noopener">Coinbase Wallet</a></p>`
            : ""
        }
      </div>`;
    const close = (v) => {
      overlay.remove();
      resolve(v);
    };
    overlay.addEventListener("click", async (e) => {
      if (e.target === overlay || e.target.closest("[data-close]")) return close(null);
      const inj = e.target.closest("[data-inj]");
      if (inj) {
        const w = wallets[Number(inj.dataset.inj)];
        return close({ provider: w.provider, id: w.info.rdns, name: w.info.name });
      }
      if (e.target.closest("[data-wc]")) {
        overlay.style.display = "none";
        try {
          const provider = await walletConnectProvider();
          close({ provider, id: "walletconnect", name: "WalletConnect" });
        } catch (err) {
          console.error(err);
          close(null);
        }
      }
    });
    document.body.appendChild(overlay);
  });
}

// ---------------- remember last wallet ----------------
export function rememberWallet(id) {
  try {
    if (id) localStorage.setItem(LAST_KEY, id);
    else localStorage.removeItem(LAST_KEY);
  } catch {}
}

/** Silent reconnect on page load (no popup) if the last used extension is still authorised. */
export async function restoreWallet() {
  let id = null;
  try {
    id = localStorage.getItem(LAST_KEY);
  } catch {}
  if (!id || id === "walletconnect") return null;
  await new Promise((r) => setTimeout(r, 400)); // give extensions time to announce
  const w = injectedWallets().find((x) => x.info.rdns === id);
  if (!w) return null;
  try {
    const accounts = await w.provider.request({ method: "eth_accounts" });
    return accounts?.length ? { provider: w.provider, id, name: w.info.name } : null;
  } catch {
    return null;
  }
}

export const hasWalletConnect = () => !!WC_PROJECT_ID;
