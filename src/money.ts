/**
 * Paise HAMESHA zatoshi (integer, bigint) mein rakho. 1 ZEC = 100,000,000 zats.
 * Float (0.1 + 0.2 wali problem) se paise ka hisaab kabhi mat karo.
 */
export const ZATS_PER_ZEC = 100_000_000n;

export function parseZec(input: string): bigint {
  const s = input.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(s)) {
    throw new Error(`Invalid ZEC amount: "${input}" (max 8 decimals)`);
  }
  const [whole, frac = ""] = s.split(".");
  const zats = BigInt(whole) * ZATS_PER_ZEC + BigInt(frac.padEnd(8, "0"));
  if (zats <= 0n) throw new Error("Amount must be > 0");
  return zats;
}

export function formatZec(zats: bigint): string {
  const whole = zats / ZATS_PER_ZEC;
  const frac = (zats % ZATS_PER_ZEC).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
