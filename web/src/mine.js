// Mine tab: poll chain -> (re)start engine -> block solved -> Claim -> approve -> tokens in the same wallet.
import { leadingZeroBits, hexToBytes, expectedHashes } from "@pow/shared";
import { detectGpu } from "@pow/shared/gpu-name";
import * as chain from "./chain.js";
import { createEngine } from "./engine.js";
import { showShareCard, initShare } from "./share.js";
import { track } from "./analytics.js";
import { networkHashrate } from "./stats.js";
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
    if (state.bench) return state.bench.push(rate);
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
  if (!res.gpu && !res.threads) return setStatus("Enable CPU threads or the GPU");
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
  alertFound(state.info.height);
  if (pref("autoClaim")) claim();
}

// ---------- preferences (auto-claim, sound, notifications) ----------
const PREFS_KEY = "pow-mine-prefs";
function prefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}
const pref = (k) => !!prefs()[k];
function setPref(k, v) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs(), [k]: v }));
  } catch {}
}

let audioCtx;
function beep() {
  try {
    audioCtx ??= new AudioContext();
    const t = audioCtx.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.15);
      g.gain.exponentialRampToValueAtTime(0.2, t + i * 0.15 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.15 + 0.14);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + i * 0.15);
      o.stop(t + i * 0.15 + 0.15);
    });
  } catch {}
}

function alertFound(height) {
  if (pref("sound")) beep();
  if (pref("notify") && "Notification" in window && Notification.permission === "granted" && document.hidden) {
    try {
      new Notification("⛏️ Block solved!", { body: `You solved block #${height}. Claim your ${store.symbol} now.`, tag: "pow-block" });
    } catch {}
  }
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
  setStatus("Approve in your wallet…");
  try {
    const ev = await chain.claimBlock(store.wallet, { nonce: sol.nonce, challenge: sol.challenge });
    state.myBlocks.unshift({ height: ev.height, reward: ev.reward, hash: ev.hash });
    track("Block claimed", { gpu: $("useGpu").checked ? "yes" : "no" });
    renderMyBlocks();
    setStatus(`claimed block #${ev.height} ✓ ${fmtTok(ev.reward)} added to your wallet`);
    showShareCard({
      height: ev.height.toString(),
      gpu: $("useGpu").checked ? state.gpuName : null,
      symbol: store.symbol,
      reward: Number(ev.reward / 10n ** 18n).toLocaleString("en"),
      bits: sol.bits,
      hashrate: state.hashrate ? `${fmtNum(state.hashrate)} H/s` : null,
      site: location.host,
      siteUrl: location.origin,
    }).catch(() => {});
    emit("balances");
  } catch (e) {
    console.error(e);
    const msg = errMsg(e);
    setStatus(msg.includes("StaleChallenge") ? "too late — someone else claimed this block" : `claim failed: ${msg}`);
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
      setStatus("someone else claimed this block — mining the next one");
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
      : `<li class="muted">No blocks yet — be the first!</li>`;
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

// ---------- benchmark ----------
const BENCH_SECONDS = 10;
async function benchmark() {
  if (state.wantMining) return ($("benchResult").textContent = "Stop mining first, then run the benchmark.");
  const settings = { threads: Number($("threads").value), useGpu: $("useGpu").checked };
  $("btnBench").disabled = true;
  $("btnStart").disabled = true;
  state.bench = [];
  // an impossible target (0) so the engine just hashes at full speed and never "finds" anything
  const res = await engine.start({ challenge: "0x" + "00".repeat(32), miner: "0x" + "00".repeat(20), target: 0n }, settings);
  for (let s = BENCH_SECONDS; s > 0; s--) {
    $("benchResult").textContent = `Measuring… ${s}s`;
    await new Promise((r) => setTimeout(r, 1000));
  }
  engine.stop();
  const samples = state.bench.slice(2); // skip warm-up (workers/GPU start)
  state.bench = null;
  $("btnBench").disabled = false;
  $("btnStart").disabled = !store.wallet ? false : state.wantMining;
  const rate = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  if (!rate) return ($("benchResult").textContent = "Could not measure; enable CPU threads or the GPU.");
  const parts = [`<b>${fmtNum(rate)} H/s</b> with ${settings.threads} CPU thread(s)${res.gpu ? " + GPU" : ""}`];
  if (state.info) {
    const eta = expectedHashes(state.info.target) / rate;
    parts.push(`At today's difficulty (${state.info.requiredBits} bits) you'd find a block about every <b>${fmtDur(eta)}</b> if you mined alone.`);
    const net = networkHashrate();
    if (net) {
      const share = Math.min(100, (rate / (net + rate)) * 100);
      // the network finds ~1 block per TARGET_BLOCK_TIME (120 s), so your average wait is 120 s / your share
      parts.push(`Network is ~${fmtNum(net)} H/s → you'd win roughly <b>${share.toFixed(share < 1 ? 2 : 1)}%</b> of blocks, about one every <b>${fmtDur(120 / (share / 100))}</b>.`);
    }
  }
  $("benchResult").innerHTML = parts.join("<br />");
  track("Benchmark run", { gpu: res.gpu ? "yes" : "no" });
}

// ---------- device info ----------
const GPU_KEY = "pow-gpu-name";
const savedGpu = () => {
  try {
    return localStorage.getItem(GPU_KEY);
  } catch {
    return null;
  }
};

async function showDevice() {
  const cores = navigator.hardwareConcurrency || 2;
  $("cpuName").textContent = `${cores} threads`;
  const det = await detectGpu();
  const manual = savedGpu();
  state.gpuName = manual || det.name;
  $("gpuName").textContent = state.gpuName || "not detected — click 'change'";
  if (manual) $("gpuName").title = "set by you";
  $("gpuRaw").textContent = `WebGL:  ${det.raw.webgl ?? "–"}\nWebGPU: ${det.raw.webgpu ? JSON.stringify(det.raw.webgpu) : "–"}\nDetected: ${det.name ?? "–"} (${det.source})${manual ? `\nManual: ${manual}` : ""}`;
  $("gpuApi").textContent = engine.hasGpuApi() ? "WebGPU ready ✓ (GPU mining available)" : "WebGPU is not available in this browser → CPU mining only (use Chrome/Edge)";
}

function editGpu() {
  const v = prompt("Type your GPU name (e.g. Intel Arc B580). Leave empty to go back to auto-detect:", savedGpu() || state.gpuName || "");
  if (v === null) return;
  try {
    if (v.trim()) localStorage.setItem(GPU_KEY, v.trim().slice(0, 60));
    else localStorage.removeItem(GPU_KEY);
  } catch {}
  showDevice();
}

// ---------- init ----------
export function initMine() {
  const cores = navigator.hardwareConcurrency || 2;
  $("threads").max = cores;
  $("threads").value = Math.max(1, cores - 1);
  $("threadsVal").textContent = $("threads").value;
  $("useGpu").checked = engine.hasGpuApi();
  showDevice();
  $("gpuEdit").onclick = editGpu;
  $("btnBench").onclick = benchmark;
  initShare();

  // auto-claim / sound / notification toggles (remembered per browser)
  $("autoClaim").checked = pref("autoClaim");
  $("soundOn").checked = pref("sound");
  $("notifyOn").checked = pref("notify") && "Notification" in window && Notification.permission === "granted";
  $("autoClaim").onchange = () => setPref("autoClaim", $("autoClaim").checked);
  $("soundOn").onchange = () => {
    setPref("sound", $("soundOn").checked);
    if ($("soundOn").checked) beep(); // preview + unlocks audio on iOS
  };
  $("notifyOn").onchange = async () => {
    if (!$("notifyOn").checked) return setPref("notify", false);
    if (!("Notification" in window)) {
      $("notifyOn").checked = false;
      return alert("This browser does not support notifications.");
    }
    const perm = await Notification.requestPermission();
    $("notifyOn").checked = perm === "granted";
    setPref("notify", perm === "granted");
  };

  let wakeLock = null;
  $("btnStart").onclick = async () => {
    if (!store.wallet) return alert("Please click 'Connect wallet' at the top first.");
    state.wantMining = true;
    track("Mining started", { gpu: $("useGpu").checked ? "yes" : "no", threads: String($("threads").value) });
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
  on("wallet", (w) => {
    clearSolution();
    if (!w) {
      // disconnected: stop mining
      if (state.wantMining) $("btnStop").click();
      return;
    }
    if (state.wantMining) startEngine();
  });

  return refresh;
}
