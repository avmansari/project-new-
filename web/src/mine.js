// Mine tab: poll chain -> (re)start engine -> block solved -> Claim -> approve -> tokens in the same wallet.
import { leadingZeroBits, hexToBytes, expectedHashes } from "@pow/shared";
import { detectGpuName } from "@pow/shared/gpu-name";
import * as chain from "./chain.js";
import { createEngine } from "./engine.js";
import { $, store, on, emit, fmtNum, fmtTok, fmtDur, short, errMsg } from "./store.js";

const state = {
  info: null,
  wantMining: false,
  solution: null, // pending solution waiting for claim
  claiming: false,
  hashrate: 0,
  myBlocks: [],
  gpuName: null,
};

const setStatus = (s) => ($("status").textContent = s);

const engine = createEngine({
  onHashrate(rate, total) {
    state.hashrate = rate;
    $("hashrate").textContent = `${fmtNum(rate)} H/s`;
    $("totalHashes").textContent = fmtNum(total);
    updateEta();
  },
  onFound: handleSolution,
});

function updateEta() {
  if (!state.info || !state.hashrate) return ($("eta").textContent = "–");
  $("eta").textContent = fmtDur(expectedHashes(state.info.target) / state.hashrate);
}

async function startEngine() {
  if (!state.info || !store.wallet) return;
  const job = { challenge: state.info.challenge, miner: store.wallet.address, target: state.info.target };
  const res = await engine.start(job, { threads: Number($("threads").value), useGpu: $("useGpu").checked });
  if (!res.gpu && !res.threads) return setStatus("CPU threads ya GPU on karo");
  $("gpuStatus").textContent = res.gpu ? "✓ active" : $("useGpu").checked ? "✗ unavailable (CPU only)" : "";
  setStatus(`mining block #${state.info.height}`);
}

// ---------- solution ----------
function handleSolution(sol) {
  const bits = leadingZeroBits(hexToBytes(sol.digest));
  state.solution = { ...sol, bits, reward: state.info.reward, height: state.info.height };
  $("solHeight").textContent = `#${state.info.height}`;
  $("solBits").textContent = bits;
  $("solReq").textContent = state.info.requiredBits;
  $("solReward").textContent = fmtTok(state.info.reward);
  $("solDigest").textContent = `hash: ${sol.digest}`;
  $("solutionCard").classList.remove("hidden");
  setStatus("block solved!");
  navigator.vibrate?.(200);
}

function clearSolution() {
  state.solution = null;
  $("solutionCard").classList.add("hidden");
}

async function claim() {
  const sol = state.solution;
  if (!sol || state.claiming) return;
  state.claiming = true;
  $("btnClaim").disabled = true;
  setStatus("wallet mein approve karo…");
  try {
    const ev = await chain.claimBlock(store.wallet, { nonce: sol.nonce, challenge: sol.challenge });
    state.myBlocks.unshift({ height: ev.height, reward: ev.reward, hash: ev.hash });
    renderMyBlocks();
    setStatus(`claimed block #${ev.height} ✓ ${fmtTok(ev.reward)} wallet mein aa gaye`);
    emit("balances");
  } catch (e) {
    console.error(e);
    const msg = errMsg(e);
    setStatus(msg.includes("StaleChallenge") ? "late ho gaya — kisi aur ne yeh block claim kar liya" : `claim failed: ${msg}`);
  } finally {
    state.claiming = false;
    $("btnClaim").disabled = false;
    clearSolution();
    await refresh(true);
  }
}

// ---------- chain polling ----------
async function refresh(force = false) {
  let info;
  try {
    info = await chain.getMiningInfo();
  } catch (e) {
    setStatus("RPC error: " + errMsg(e));
    return;
  }
  const changed = !state.info || info.challenge !== state.info.challenge || info.target !== state.info.target;
  state.info = info;
  renderInfo();

  if (changed || force) {
    if (state.solution && state.solution.challenge !== info.challenge && !state.claiming) {
      clearSolution();
      setStatus("kisi aur ne yeh block claim kar liya — next block pe mining");
    }
    if (state.wantMining && !state.solution) await startEngine();
    loadRecent();
  }
}

function renderInfo() {
  const i = state.info;
  $("height").textContent = `#${i.height}`;
  $("difficulty").textContent = fmtNum(Number(i.difficulty));
  $("bits").textContent = i.requiredBits;
  $("reward").textContent = fmtTok(i.reward);
  $("supply").textContent = `${fmtTok(i.totalSupply)} / 21M`;
  $("lastBlock").textContent = `${fmtDur(Math.max(0, Date.now() / 1000 - Number(i.lastBlockTime)))} ago`;
  updateEta();
}

async function loadRecent() {
  try {
    const blocks = await chain.recentBlocks();
    $("recent").innerHTML = blocks.length
      ? blocks.map((b) => `<li>#${b.height} · <span class="mono">${short(b.miner)}</span> · ${fmtTok(b.reward)} · ${b.achievedBits} bits</li>`).join("")
      : `<li class="muted">Abhi tak koi block nahi — pehle tum bano!</li>`;
  } catch {
    $("recent").innerHTML = `<li class="muted">Could not load events</li>`;
  }
}

function renderMyBlocks() {
  $("myBlocks").innerHTML = state.myBlocks
    .map((b) => {
      const url = chain.explorerTx(b.hash);
      return `<li>#${b.height} · ${fmtTok(b.reward)} ${url ? `· <a href="${url}" target="_blank" rel="noopener">tx</a>` : ""}</li>`;
    })
    .join("");
}

// ---------- device info ----------
async function showDevice() {
  const cores = navigator.hardwareConcurrency || 2;
  $("cpuName").textContent = `${cores} threads`;
  state.gpuName = await detectGpuName();
  $("gpuName").textContent = state.gpuName || "detect nahi hua";
  if (!engine.hasGpuApi()) $("gpuApi").textContent = "WebGPU is browser mein nahi hai → sirf CPU mining (Chrome/Edge use karo)";
  else $("gpuApi").textContent = "WebGPU ready ✓";
}

// ---------- init ----------
export function initMine() {
  const cores = navigator.hardwareConcurrency || 2;
  $("threads").max = cores;
  $("threads").value = Math.max(1, cores - 1);
  $("threadsVal").textContent = $("threads").value;
  $("useGpu").checked = engine.hasGpuApi();
  showDevice();

  let wakeLock = null;
  $("btnStart").onclick = async () => {
    if (!store.wallet) return alert("Pehle upar 'Connect wallet' dabao.");
    state.wantMining = true;
    $("btnStart").disabled = true;
    $("btnStop").disabled = false;
    try {
      wakeLock = await navigator.wakeLock?.request("screen"); // keep phone screen awake while mining
    } catch {}
    await refresh(true);
  };
  $("btnStop").onclick = () => {
    state.wantMining = false;
    engine.stop();
    wakeLock?.release?.();
    $("btnStart").disabled = false;
    $("btnStop").disabled = true;
    setStatus("stopped");
  };
  $("btnClaim").onclick = claim;
  $("btnDiscard").onclick = () => {
    clearSolution();
    refresh(true);
  };
  const restartIfMining = () => state.wantMining && !state.solution && startEngine();
  $("threads").oninput = () => ($("threadsVal").textContent = $("threads").value);
  $("threads").onchange = restartIfMining;
  $("useGpu").onchange = restartIfMining;

  // Wallet account switched: the hash is bound to the address, so restart mining for the new one.
  on("wallet", () => {
    clearSolution();
    if (state.wantMining) startEngine();
  });

  return refresh;
}
