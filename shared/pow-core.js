// Shared PoW logic — used by the CLI miner (Node) and the browser CPU worker.
// Must stay byte-for-byte identical to the contract:
//   digest = keccak256(abi.encodePacked(bytes32 challenge, address miner, uint256 nonce))
//
// 84-byte input layout:
//   [ 0..31]  challenge
//   [32..51]  miner address
//   [52..83]  nonce (uint256, big-endian)
//       [52..75] random per-session prefix  (so different devices never overlap)
//       [76..79] "outer" counter            (bumped every 2^32 hashes / per GPU dispatch)
//       [80..83] "inner" counter            (the hot loop / GPU thread id)
import { keccak_256 } from "@noble/hashes/sha3";

export const INPUT_LEN = 84;
export const MAX_BONUS_BITS = 8n;
export const HALVING_INTERVAL = 210_000n;
export const BASE_REWARD = 50n * 10n ** 18n;

export function hexToBytes(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function bigToBytes32(v) {
  return hexToBytes(BigInt(v).toString(16).padStart(64, "0"));
}

/** Build the 84-byte input with challenge, address and a random nonce prefix. */
export function buildInput(challengeHex, minerAddress, randomPrefix) {
  const input = new Uint8Array(INPUT_LEN);
  input.set(hexToBytes(challengeHex), 0);
  input.set(hexToBytes(minerAddress), 32);
  input.set(randomPrefix ?? randomBytes(24), 52);
  return input;
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function writeU32BE(buf, offset, v) {
  buf[offset] = v >>> 24;
  buf[offset + 1] = (v >>> 16) & 0xff;
  buf[offset + 2] = (v >>> 8) & 0xff;
  buf[offset + 3] = v & 0xff;
}

/** a <= b for two 32-byte big-endian numbers */
export function lte(a, b) {
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return true;
}

export function leadingZeroBits(bytes) {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

export function nonceFromInput(input) {
  return BigInt(bytesToHex(input.subarray(52, 84)));
}

export function digestFor(challengeHex, minerAddress, nonce) {
  const input = new Uint8Array(INPUT_LEN);
  input.set(hexToBytes(challengeHex), 0);
  input.set(hexToBytes(minerAddress), 32);
  input.set(bigToBytes32(nonce), 52);
  return keccak_256(input);
}

/**
 * Hash `count` nonces starting at inner counter `start` (outer counter must already be in input).
 * Returns { found, nonce, digest, hashes }.
 */
export function mineBatch(input, targetBytes, start, count) {
  const t0 = targetBytes[0];
  for (let i = 0; i < count; i++) {
    writeU32BE(input, 80, (start + i) >>> 0);
    const d = keccak_256(input);
    // fast reject on first byte before full compare
    if (d[0] > t0) continue;
    if (lte(d, targetBytes)) {
      return { found: true, nonce: nonceFromInput(input), digest: d, hashes: i + 1 };
    }
  }
  return { found: false, hashes: count };
}

/** Mirrors PowInscription._reward (height -> halving, luck bonus on extra zero bits). */
export function rewardFor(height, requiredBits, achievedBits) {
  const halvings = BigInt(height) / HALVING_INTERVAL;
  if (halvings >= 64n) return 0n;
  const base = BASE_REWARD >> halvings;
  let extra = BigInt(achievedBits) - BigInt(requiredBits);
  if (extra < 0n) extra = 0n;
  if (extra > MAX_BONUS_BITS) extra = MAX_BONUS_BITS;
  return (base * (MAX_BONUS_BITS + extra)) / MAX_BONUS_BITS;
}

/** Expected hashes to find a block at `target` (for ETA display). */
export function expectedHashes(target) {
  return Number((2n ** 256n) / (BigInt(target) + 1n));
}
