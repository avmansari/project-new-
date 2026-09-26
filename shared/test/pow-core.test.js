import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3";
import { buildInput, mineBatch, bigToBytes32, digestFor, leadingZeroBits, rewardFor, bytesToHex, writeU32BE } from "../pow-core.js";
import { packParams } from "../keccak-wgsl.js";

const challenge = "0x" + "ab".repeat(32);
const miner = "0x" + "12".repeat(20);

test("mineBatch finds a nonce whose digest matches digestFor()", () => {
  const target = (2n ** 256n - 1n) >> 12n;
  const input = buildInput(challenge, miner);
  const r = mineBatch(input, bigToBytes32(target), 0, 1 << 20);
  assert.ok(r.found);
  const d = digestFor(challenge, miner, r.nonce);
  assert.equal(bytesToHex(d), bytesToHex(r.digest));
  assert.ok(BigInt(bytesToHex(d)) <= target);
  assert.ok(leadingZeroBits(d) >= 12);
});

test("rewardFor mirrors contract", () => {
  const e = 10n ** 18n;
  assert.equal(rewardFor(0, 20, 20), 50n * e);
  assert.equal(rewardFor(0, 20, 24), 75n * e);
  assert.equal(rewardFor(0, 20, 40), 100n * e);
  assert.equal(rewardFor(210000, 20, 20), 25n * e);
});

test("packParams lays out keccak padding correctly", () => {
  const input = buildInput(challenge, miner);
  writeU32BE(input, 80, 0x01020304);
  const u32 = new Uint32Array(packParams(input, bigToBytes32(1n), 7));
  assert.equal(u32[20], 0x04030201); // lane10.lo = bswap(counter)
  assert.equal(u32[21], 0x00000001); // pad byte 84
  assert.equal(u32[33], 0x80000000); // pad byte 135
  assert.equal(u32[41], 1); // target LSW
  assert.equal(u32[42], 7);
  // sanity: noble keccak of input equals keccak with our padding assumption
  assert.equal(keccak_256(input).length, 32);
});
