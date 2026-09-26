// ETH/USD price for showing USD values next to ETH. Cached for 60 s.
// Sources: Coinbase public API, then CoinGecko. If both fail, USD values are simply hidden.
let cache = { price: null, at: 0 };

export async function ethUsd() {
  if (cache.price && Date.now() - cache.at < 60_000) return cache.price;
  const sources = [
    ["https://api.coinbase.com/v2/prices/ETH-USD/spot", (j) => Number(j.data.amount)],
    ["https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", (j) => Number(j.ethereum.usd)],
  ];
  for (const [url, pick] of sources) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const p = pick(await r.json());
      if (p > 0) {
        cache = { price: p, at: Date.now() };
        return p;
      }
    } catch {}
  }
  return cache.price; // stale or null
}

/** Last known price without waiting (null until the first fetch finishes). */
export const ethUsdCached = () => cache.price;

/** "≈ $12.34" for a wei amount, or "" when the price is unknown. */
export function usdOf(wei) {
  const p = cache.price;
  if (!p || wei == null) return "";
  const usd = (Number(wei) / 1e18) * p;
  const digits = usd < 1 ? (usd < 0.01 ? 4 : 3) : 2;
  return `≈ $${usd.toLocaleString("en", { minimumFractionDigits: digits > 2 ? 2 : 2, maximumFractionDigits: digits })}`;
}

/** Format a wei amount in US dollars ("$12.34"); falls back to ETH if the price isn't known yet. */
export function usd(wei) {
  const p = cache.price;
  if (wei == null) return "–";
  if (!p) return `${(Number(wei) / 1e18).toLocaleString("en", { maximumFractionDigits: 6 })} ETH`;
  const v = (Number(wei) / 1e18) * p;
  const digits = v !== 0 && Math.abs(v) < 1 ? (Math.abs(v) < 0.01 ? 4 : 3) : 2;
  return `$${v.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}

/** Number of dollars (from user input) -> wei at today's price. Returns null if the price is unknown or input invalid. */
export function usdToWei(dollars) {
  const p = cache.price;
  const d = Number(String(dollars).replace(/[$,\s]/g, ""));
  if (!p || !(d > 0) || !isFinite(d)) return null;
  // micro-dollar integer math to avoid float drift in wei
  return (BigInt(Math.round(d * 1e6)) * 10n ** 18n) / BigInt(Math.round(p * 1e6));
}
