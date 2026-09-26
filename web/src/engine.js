// Mining engine: runs CPU workers and/or the WebGPU kernel on the current job.
import { createGpuMiner } from "./gpu-miner.js";

export function createEngine({ onHashrate, onFound }) {
  let workers = [];
  let gpu = null;
  let gpuTried = false;
  let job = null;
  let hashes = 0;
  let totalHashes = 0;
  let timer = null;

  const foundOnce = (sol) => {
    if (!job) return;
    const j = job;
    stop();
    onFound({ ...sol, challenge: j.challenge, miner: j.miner });
  };

  function startCpu(threads) {
    for (let i = 0; i < threads; i++) {
      const w = new Worker(new URL("./cpu-worker.js", import.meta.url), { type: "module" });
      w.onmessage = (e) => {
        if (e.data.type === "hashes") hashes += e.data.n;
        else if (e.data.type === "found") foundOnce({ nonce: BigInt(e.data.nonce), digest: e.data.digest });
      };
      w.postMessage({ type: "start", challenge: job.challenge, miner: job.miner, target: job.target.toString(), workerIndex: i });
      workers.push(w);
    }
  }

  async function startGpu() {
    if (!gpuTried) {
      gpuTried = true;
      try {
        gpu = await createGpuMiner();
      } catch (e) {
        console.error(e);
        gpu = null;
      }
    }
    if (!gpu) return false;
    const myJob = job;
    gpu.mine(myJob, (n) => (hashes += n)).then((sol) => sol && myJob === job && foundOnce(sol));
    return true;
  }

  async function start(newJob, { threads, useGpu }) {
    stop();
    job = newJob;
    hashes = 0;
    let gpuOk = false;
    if (useGpu) gpuOk = await startGpu();
    if (threads > 0) startCpu(threads);
    let last = performance.now();
    timer = setInterval(() => {
      const now = performance.now();
      const rate = (hashes * 1000) / (now - last);
      totalHashes += hashes;
      hashes = 0;
      last = now;
      onHashrate(rate, totalHashes);
    }, 1000);
    return { gpu: gpuOk ? gpu.name : null, threads };
  }

  function stop() {
    job = null;
    for (const w of workers) w.terminate();
    workers = [];
    gpu?.stop();
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, isRunning: () => job !== null, hasGpuApi: () => "gpu" in navigator };
}
