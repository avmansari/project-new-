// CPU mining Web Worker (one per core). Works on every phone/desktop browser.
import { buildInput, bigToBytes32, mineBatch, writeU32BE, bytesToHex } from "@pow/shared";

const BATCH = 20_000;
let jobId = 0;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "stop") {
    jobId++;
    return;
  }
  if (msg.type === "start") {
    const myJob = ++jobId;
    const input = buildInput(msg.challenge, msg.miner);
    const target = bigToBytes32(BigInt(msg.target));
    let outer = msg.workerIndex << 24; // split nonce space between workers
    let inner = 0;
    writeU32BE(input, 76, outer);

    const loop = () => {
      if (myJob !== jobId) return; // a newer job/stop arrived
      const r = mineBatch(input, target, inner, BATCH);
      self.postMessage({ type: "hashes", n: r.hashes });
      if (r.found) {
        self.postMessage({ type: "found", nonce: r.nonce.toString(), digest: bytesToHex(r.digest) });
        return;
      }
      inner += BATCH;
      if (inner > 0xffffffff - BATCH) {
        inner = 0;
        writeU32BE(input, 76, ++outer);
      }
      setTimeout(loop, 0); // yield so "stop" messages get through
    };
    loop();
  }
};
