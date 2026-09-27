// WebGPU miner: runs the Keccak kernel from @pow/shared on the device GPU.
// Works on desktop Chrome/Edge and Android Chrome (WebGPU enabled). Falls back to CPU if unavailable.
import { KECCAK_MINER_WGSL, WORKGROUP_SIZE, packParams } from "@pow/shared/keccak-wgsl";
import { buildInput, bigToBytes32, digestFor, writeU32BE, nonceFromInput, lte, bytesToHex, hashInput } from "@pow/shared";

export async function createGpuMiner() {
  if (!("gpu" in navigator)) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return null;
  const device = await adapter.requestDevice();

  const module = device.createShaderModule({ code: KECCAK_MINER_WGSL });
  const info = await module.getCompilationInfo?.();
  const errors = info?.messages?.filter((m) => m.type === "error") ?? [];
  if (errors.length) throw new Error("WGSL compile error: " + errors.map((e) => e.message).join("\n"));

  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
  const paramsBuf = device.createBuffer({ size: 176, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const resultBuf = device.createBuffer({ size: 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const readBuf = device.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsBuf } },
      { binding: 1, resource: { buffer: resultBuf } },
    ],
  });
  const zero = new Uint32Array(2);

  let runId = 0; // bumps on every mine()/stop(); older loops see the change and exit
  let loopDone = Promise.resolve(); // only one loop may use the GPU buffers at a time
  let groups = 256; // auto-tuned so one dispatch takes ~100ms

  /** Hash `groups*256` nonces starting at `base`; returns found counter or null. */
  async function dispatch(input, targetBytes, base) {
    device.queue.writeBuffer(paramsBuf, 0, packParams(input, targetBytes, base));
    device.queue.writeBuffer(resultBuf, 0, zero);
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(groups);
    pass.end();
    enc.copyBufferToBuffer(resultBuf, 0, readBuf, 0, 8);
    device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    const [found, counter] = new Uint32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
    return found ? counter : null;
  }

  return {
    name: adapter.info?.description || adapter.info?.vendor || "WebGPU",
    /**
     * job = { challenge, miner, target (bigint) }
     * onHashes(n, sampleDigestHex) called after every dispatch; resolves with {nonce, digest} or null when stopped.
     */
    async mine(job, onHashes) {
      const myRun = ++runId;
      await loopDone; // wait for the previous loop to release the buffers
      if (myRun !== runId) return null;
      let release;
      loopDone = new Promise((r) => (release = r));
      try {
        return await this._loop(job, onHashes, myRun);
      } finally {
        release();
      }
    },
    async _loop(job, onHashes, myRun) {
      const input = buildInput(job.challenge, job.miner);
      const targetBytes = bigToBytes32(job.target);
      let outer = 0;
      let base = 0;
      writeU32BE(input, 76, outer);
      while (myRun === runId) {
        const perDispatch = groups * WORKGROUP_SIZE;
        if (base + perDispatch > 0xffffffff) {
          outer++;
          base = 0;
          writeU32BE(input, 76, outer);
        }
        const t0 = performance.now();
        const hit = await dispatch(input, targetBytes, base);
        const dt = performance.now() - t0;
        writeU32BE(input, 80, base); // one CPU-side sample digest per dispatch for the live hash stream
        onHashes?.(perDispatch, bytesToHex(hashInput(input)));
        if (hit !== null) {
          writeU32BE(input, 80, hit);
          const nonce = nonceFromInput(input);
          const digest = digestFor(job.challenge, job.miner, nonce); // CPU re-check
          if (lte(digest, targetBytes)) {
            return { nonce, digest: bytesToHex(digest) };
          }
          console.warn("GPU reported a false positive; ignoring");
        }
        base += perDispatch;
        // auto-tune dispatch size toward ~100ms (keeps UI + phone responsive)
        if (dt < 60 && groups < 65535) groups = Math.min(65535, groups * 2);
        else if (dt > 200 && groups > 16) groups = Math.max(16, groups >> 1);
      }
      return null;
    },
    stop() {
      runId++;
    },
  };
}
