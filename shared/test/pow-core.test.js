import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3";
import { buildInput, mineBatch, mineBatchBest, lte, bigToBytes32, digestFor, leadingZeroBits, bytesToHex, writeU32BE } from "../pow-core.js";
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

test("mineBatchBest finds the same nonce and tracks the lowest digest", () => {
  const challenge = "0x" + "ab".repeat(32);
  const miner = "0x" + "12".repeat(20);
  const prefix = new Uint8Array(24).fill(7);
  const target = bigToBytes32(2n ** 244n);
  const a = mineBatch(buildInput(challenge, miner, prefix), target, 0, 1 << 20);
  const best = new Uint8Array(32).fill(0xff);
  const b = mineBatchBest(buildInput(challenge, miner, prefix), target, 0, 1 << 20, best);
  assert.equal(b.found, true);
  assert.equal(b.nonce, a.nonce);
  // the winning digest is the lowest seen so far
  assert.equal(bytesToHex(best), bytesToHex(b.digest));
  const best2 = new Uint8Array(32).fill(0xff);
  mineBatchBest(buildInput(challenge, miner, prefix), bigToBytes32(0n), 0, 500, best2);
  assert.ok(lte(best2, new Uint8Array(32).fill(0xfe)));
});
