// UI + mining loop for the browser miner.
//
// Flow:
//   poll chain -> new challenge? -> (re)start engine
//   engine finds nonce -> show "you can claim 5000 tokens"
//   user clicks Claim -> approves in wallet -> tokens land in the same wallet -> chain has a new challenge -> mining resumes
import { formatEther } from "viem";
import { leadingZeroBits, hexToBytes, expectedHashes } from "@pow/shared";
import { CONTRACT_ADDRESS, POLL_MS } from "./config.js";
import * as chain from "./chain.js";
import { createEngine } from "./engine.js";

const $ = (id) => document.getElementById(id);
const state = {
  info: null,
  symbol: "XYZ",
  wallet: null,
  wantMining: false,
  solution: null, // pending solution waiting for claim
  claiming: false,
  hashrate: 0,
  myBlocks: [],
};

// ---------- formatting ----------
const fmtNum = (n) => Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(n);
const fmtTok = (wei) => `${Number(formatEther(wei)).toLocaleString("en", { maximumFractionDigits: 4 })} ${state.symbol}`;
const fmtDur = (s) => {
  if (!isFinite(s)) return "∞";
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
};
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const setStatus = (s) => ($("status").textContent = s);

// ---------- engine ----------
const engine = createEngine({
  onHashrate(rate, total) {
    state.hashrate = rate;
    $("hashrate").textContent = `${fmtNum(rate)} H/s`;
    $("totalHashes").textContent = fmtNum(total);
    updateEta();
  },
  onFound(sol) {
    handleSolution(sol);
  },
});

function updateEta() {
  if (!state.info || !state.hashrate) return ($("eta").textContent = "–");
  $("eta").textContent = fmtDur(expectedHashes(state.info.target) / state.hashrate);
}

function minerSettings() {
  return { threads: Number($("threads").value), useGpu: $("useGpu").checked };
}

async function startEngine() {
  if (!state.info || !state.wallet) return;
  const job = { challenge: state.info.challenge, miner: state.wallet.address, target: state.info.target };
  const res = await engine.start(job, minerSettings());
  if (!res.gpu && !res.threads) {
    setStatus("nothing to mine with — enable CPU threads or GPU");
    return;
  }
  $("gpuStatus").textContent = res.gpu ? `✓ ${res.gpu}` : $("useGpu").checked ? "✗ unavailable (CPU only)" : "";
  setStatus(`mining block #${state.info.height}`);
}

// ---------- solution handling ----------
function handleSolution(sol) {
  const bits = leadingZeroBits(hexToBytes(sol.digest));
  const reward = state.info.reward; // fixed 5000 per block
  state.solution = { ...sol, bits, reward, height: state.info.height };
  $("solHeight").textContent = `#${state.info.height}`;
  $("solBits").textContent = bits;
  $("solReq").textContent = state.info.requiredBits;
  $("solReward").textContent = fmtTok(reward);
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
    const ev = await chain.claimBlock(state.wallet, { nonce: sol.nonce, challenge: sol.challenge });
    state.myBlocks.unshift({ height: ev.height, reward: ev.reward, hash: ev.hash });
    renderMyBlocks();
    setStatus(`claimed block #${ev.height} ✓ ${fmtTok(ev.reward)} wallet mein aa gaye`);
  } catch (e) {
    console.error(e);
    const msg = e.shortMessage || e.message || String(e);
    if (/reject|denied/i.test(msg)) setStatus("claim cancel kiya (wallet mein reject)");
    else setStatus(msg.includes("StaleChallenge") ? "late ho gaya — kisi aur ne yeh block claim kar liya" : `claim failed: ${msg}`);
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
    setStatus("RPC error: " + (e.shortMessage || e.message));
    return;
  }
  const changed = !state.info || info.challenge !== state.info.challenge || info.target !== state.info.target;
  state.info = info;
  renderInfo();

  if (changed || force) {
    // pending solution for an old block is now useless
    if (state.solution && state.solution.challenge !== info.challenge && !state.claiming) {
      clearSolution();
      setStatus("block was mined by someone else — moving on");
    }
    if (state.wantMining && !state.solution) await startEngine();
    loadRecent();
    loadBalance();
  }
}

function renderInfo() {
  const i = state.info;
  $("height").textContent = `#${i.height}`;
  $("difficulty").textContent = fmtNum(Number(i.difficulty));
  $("bits").textContent = i.requiredBits;
  $("reward").textContent = fmtTok(i.reward);
  $("supply").textContent = fmtTok(i.totalSupply);
  $("lastBlock").textContent = `${fmtDur(Math.max(0, Date.now() / 1000 - Number(i.lastBlockTime)))} ago`;
  $("challenge").textContent = `challenge: ${i.challenge}`;
  updateEta();
}

async function loadRecent() {
  try {
    const blocks = await chain.recentBlocks();
    $("recent").innerHTML = blocks.length
      ? blocks
          .map((b) => `<li>#${b.height} · <span class="mono">${short(b.miner)}</span> · ${fmtTok(b.reward)} · ${b.achievedBits} bits</li>`)
          .join("")
      : `<li class="muted">No blocks yet — be the first!</li>`;
  } catch {
    $("recent").innerHTML = `<li class="muted">Could not load events</li>`;
  }
}

async function loadBalance() {
  if (!state.wallet) return;
  $("balance").textContent = fmtTok(await chain.balanceOf(state.wallet.address));
  $("gasBal").textContent = Number(await chain.ethBalance(state.wallet.address)).toFixed(5);
}

function renderMyBlocks() {
  $("myBlocks").innerHTML = state.myBlocks
    .map((b) => {
      const url = chain.explorerTx(b.hash);
      return `<li>#${b.height} · ${fmtTok(b.reward)} ${url ? `· <a href="${url}" target="_blank" rel="noopener">tx</a>` : ""}</li>`;
    })
    .join("");
}

// ---------- wallet ----------
function onWallet(w) {
  state.wallet = w;
  $("walletInfo").classList.remove("hidden");
  $("minerAddr").textContent = w.address;
  $("btnConnect").textContent = "Connected ✓";
  $("btnStart").disabled = false;
  loadBalance();
}

$("btnConnect").onclick = async () => {
  try {
    onWallet(await chain.connectInjected());
  } catch (e) {
    alert(e.shortMessage || e.message);
  }
};

// Wallet account switched: the hash is bound to the address, so restart mining for the new one.
chain.onAccountChange(async (addr) => {
  if (!addr || !state.wallet) return;
  state.wallet = { ...state.wallet, address: addr };
  onWallet(state.wallet);
  clearSolution();
  if (state.wantMining) await startEngine();
});

// ---------- miner controls ----------
let wakeLock = null;
$("btnStart").onclick = async () => {
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

// ---------- boot ----------
(function init() {
  const cores = navigator.hardwareConcurrency || 2;
  $("threads").max = cores;
  $("threads").value = Math.max(1, cores - 1);
  $("threadsVal").textContent = $("threads").value;
  $("useGpu").checked = engine.hasGpuApi();
  if (!engine.hasGpuApi()) $("gpuStatus").textContent = "(not supported in this browser)";
  $("contractAddr").textContent = CONTRACT_ADDRESS;
  chain.getSymbol().then((s) => {
    state.symbol = s;
    $("sym").textContent = s;
  }).catch(() => {});
  refresh();
  setInterval(refresh, POLL_MS);
})();
