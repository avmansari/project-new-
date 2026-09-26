// CPU mining thread (Node worker_threads)
import { parentPort, workerData } from "node:worker_threads";
import { buildInput, bigToBytes32, mineBatch, writeU32BE, bytesToHex } from "@pow/shared";

const { challenge, miner, target, workerIndex } = workerData;
const input = buildInput(challenge, miner);
const tBytes = bigToBytes32(BigInt(target));
const BATCH = 50_000;
let outer = workerIndex << 24;
let inner = 0;
writeU32BE(input, 76, outer);

for (;;) {
  const r = mineBatch(input, tBytes, inner, BATCH);
  parentPort.postMessage({ type: "hashes", n: r.hashes });
  if (r.found) {
    parentPort.postMessage({ type: "found", nonce: r.nonce.toString(), digest: bytesToHex(r.digest) });
    break;
  }
  inner += BATCH;
  if (inner > 0xffffffff - BATCH) {
    inner = 0;
    writeU32BE(input, 76, ++outer);
  }
}
