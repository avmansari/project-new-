// Noir Wallet (browser extension) ke saath kaam: connect -> payment popup -> approve.
// Provider: window.noirwallet.zcash  (EIP-1193 jaisa request({method, params})).
// Ye module DOM ko nahi chhoota, isliye Node mein mock provider ke saath test hota hai.

export const NOIR_EVENT = "noirwallet#initialized";

export function getInjected(win) {
  const w = win && win.noirwallet;
  return w && w.isNoirWallet && w.zcash ? w.zcash : null;
}

/** Extension kabhi kabhi page load ke baad inject hoti hai: event ka intezaar (max timeoutMs). */
export function detectNoir(win, timeoutMs = 3000) {
  const now = getInjected(win);
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      win.removeEventListener(NOIR_EVENT, finish);
      resolve(getInjected(win));
    };
    const timer = setTimeout(finish, timeoutMs);
    win.addEventListener(NOIR_EVENT, finish, { once: true });
  });
}

/** "tm..." / "t2..." => testnet, "t1..." / "t3..." => mainnet, baaki null (shielded 'u..' / 'zs..' etc.) */
export function networkOfAddress(addr) {
  if (typeof addr !== "string") return null;
  if (/^t[m2]/.test(addr)) return "testnet";
  if (/^t[13]/.test(addr)) return "mainnet";
  return null;
}

export function explainError(e) {
  const code = e && typeof e.code === "number" ? e.code : undefined;
  const msg = (e && e.message) || "Wallet ne error diya";
  if (code === 4001 || code === 5000 || (e && e.code === "USER_REJECTED")) return { kind: "rejected", message: "Aapne wallet mein request reject kar di." };
  if (code === -32002) return { kind: "pending", message: "Wallet mein pehle se ek request khuli hai. Noir kholke use approve ya reject karo." };
  if (code === 4200 || code === -32601) return { kind: "unsupported", message: "Ye wallet ye kaam support nahi karta." };
  return { kind: "other", message: msg };
}

/** Wallet connect (popup aata hai). silent=true => bina popup, sirf pehle se authorized. */
export async function connectNoir(provider, opts = {}) {
  const raw = await provider.request({ method: opts.silent ? "zcash_getAccounts" : "zcash_requestAccounts" });
  if (!raw || typeof raw.transparent !== "string") throw new Error("Wallet se address nahi mila");
  return { transparent: raw.transparent, shielded: typeof raw.shielded === "string" ? raw.shielded : null };
}

/** Wallet aur website ek hi network pe hain? Nahi to throw (galat network pe payment nahi bhejni). */
export function assertSameNetwork(transparent, siteNetwork) {
  const w = networkOfAddress(transparent);
  if (!w) throw new Error("Wallet ka transparent (t) address nahi mila");
  if (w !== siteNetwork) throw new Error(`Wallet ${w} pe hai, lekin ye website ${siteNetwork} pe hai. Sahi network wala wallet use karo.`);
}

const AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/;

/** Wallet se payment: popup mein exactly ye amount aur ye address dikhega. Return: txid. */
export async function sendPayment(provider, { to, amount }) {
  if (typeof to !== "string" || !networkOfAddress(to)) throw new Error("payment address galat hai");
  if (typeof amount !== "string" || !AMOUNT.test(amount) || Number(amount) <= 0) throw new Error("amount galat hai");
  const txid = await provider.request({ method: "zcash_sendTransaction", params: [{ to, amount }] });
  if (typeof txid !== "string" || txid.length === 0) throw new Error("Wallet ne transaction id nahi diya");
  return txid;
}

export function fmtZec(zats) {
  const z = BigInt(zats);
  const whole = z / 100000000n;
  const frac = (z % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * MINT: order banao -> wallet popup (fixed amount) -> approve => transaction submit.
 *  - order ka amount collection ke price x quantity se EXACT milna chahiye, warna wallet ko bulate hi nahi.
 *  - popup reject / error => order turant cancel (supply free).
 * api = { createOrder(body) -> order, cancelOrder(id) }
 */
export async function mintWithWallet({ provider, api, collection, quantity, buyerAddress, onStatus }) {
  const say = onStatus || (() => {});
  const expected = BigInt(collection.priceZats) * BigInt(quantity);
  say("Order ban raha hai...");
  const order = await api.createOrder({ collection: collection.slug, quantity, buyerAddress });
  if (BigInt(order.amountZats) !== expected) {
    await api.cancelOrder(order.id).catch(() => {});
    throw new Error("Server ne alag amount bataya, isliye payment nahi bheji.");
  }
  say(`Wallet mein ${order.amountZec} ZEC ki payment approve karo...`);
  let txid;
  try {
    txid = await sendPayment(provider, { to: order.payAddress, amount: order.amountZec });
  } catch (e) {
    await api.cancelOrder(order.id).catch(() => {});
    throw e;
  }
  return { order, txid };
}
