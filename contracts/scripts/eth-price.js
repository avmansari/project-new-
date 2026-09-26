// ETH/USD price helper for fee scripts. Order: ETH_USD_PRICE env -> Coinbase -> CoinGecko.
async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

async function ethUsdPrice() {
  if (process.env.ETH_USD_PRICE) return Number(process.env.ETH_USD_PRICE);
  try {
    const j = await fetchJson("https://api.coinbase.com/v2/prices/ETH-USD/spot");
    return Number(j.data.amount);
  } catch {}
  try {
    const j = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    return Number(j.ethereum.usd);
  } catch {}
  throw new Error("Could not fetch the ETH price. Set ETH_USD_PRICE=3000 (for example) in contracts/.env");
}

/** USD amount (e.g. 0.1) -> wei at the given ETH price. */
function usdToWei(usd, ethUsd) {
  // work in micro-dollars to stay in integers
  const micro = BigInt(Math.round(usd * 1e6));
  const priceMicro = BigInt(Math.round(ethUsd * 1e6));
  return (micro * 10n ** 18n) / priceMicro;
}

module.exports = { ethUsdPrice, usdToWei };
