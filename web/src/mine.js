// Mine tab: poll chain -> (re)start engine -> block solved -> Claim -> approve -> tokens in the same wallet.
// The "reactor" UI: hashrate gauge, puzzle bits, live hash stream, odds, haul and the block-found modal.
import { leadingZeroBits, hexToBytes, expectedHashes } from "@pow/shared";
import { detectGpu } from "@pow/shared/gpu-name";
import * as chain from "./chain.js";
import { createEngine } from "./engine.js";
import { showShareCard, initShare, reopenShare } from "./share.js";
import { track } from "./analytics.js";
import { networkHashrate, recentHashrates } from "./stats.js";
import { indexer } from "./indexer.js";
import { usd } from "./price.js";
import { $, store, on, emit, fmtNum, fmtAmt, fmtTok, fmtDur, short, errMsg, avatar, rateParts, fmtRate, hashHtml } from "./store.js";

const TOTAL_BLOCKS = 4200;
const BLOCKS_PER_DAY = 86400 / 120; // target block time is 2 minutes
const LOT = 5000n * 10n ** 18n;

const state = {
  info: null,
  wantMining: false,
  solution: null, // pending solution waiting for claim
  claiming: false,
  hashrate: 0,
  myBlocks: [], // claimed in this session (shown until the indexer has them)
  gpuName: null,
  gpuActive: false,
  jobHashes: 0, // hashes on the current block (for the gauge)
  jobStart: 0, // when we started on the current block
  jobChallenge: null,
  best: null, // best digest hex on the current block
  sessionMs: 0,
  sessionFrom: 0,
  seenHeights: new Set(),
};

const setStatus = (s) => ($("status").textContent = s);
const bitsOf = (hex) => leadingZeroBits(hexToBytes(hex));

const engine = createEngine({
  onHashrate(rate, total) {
    if (state.bench) return state.bench.push(rate);
    state.jobHashes += rate; // the engine reports once per second
    state.hashrate = rate;
    $("totalHashes").textContent = fmtNum(total);
    renderRate();
  },
  onSample,
  onFound: handleSolution,
});

// ---------------- gauge / KPIs ----------------
function renderRate() {
  const [v, unit] = rateParts(state.hashrate);
  $("hashrate").textContent = state.wantMining ? v : "0";
  $("hashUnit").textContent = unit;
  $("streamRate").textContent = state.wantMining ? `live · ${fmtRate(state.hashrate)}` : "idle";
  updateEta();
  renderGauge();
  renderOdds();
}

/** Ring = work done on this block vs the expected work (100% = "on average you'd have found it by now"). */
function renderGauge() {
  const exp = state.info ? expectedHashes(state.info.target) : 0;
  const frac = exp && state.wantMining ? Math.min(1, state.jobHashes / exp) : 0;
  $("gaugeArc").style.strokeDashoffset = String(854.5 * (1 - frac));
  $("gaugeWork").textContent = state.wantMining && exp ? `${(Math.min(9.99, state.jobHashes / exp) * 100).toFixed(0)}% of expected work` : " ";
}

function updateEta() {
  if (!state.info || !state.hashrate || !state.wantMining) return ($("eta").textContent = "–");
  $("eta").textContent = `~${fmtDur(expectedHashes(state.info.target) / state.hashrate)}`;
}

function tickSession() {
  const ms = state.sessionMs + (state.wantMining ? Date.now() - state.sessionFrom : 0);
  const s = Math.floor(ms / 1000);
  $("session").textContent = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

function setMiningUi(on) {
  $("btnStart").classList.toggle("hidden", on);
  $("btnStop").classList.toggle("hidden", !on);
  $("btnStart").disabled = on;
  $("btnStop").disabled = !on;
  $("reactorCard").classList.toggle("mining", on);
  $("mnPill").classList.toggle("idle", !on);
  renderPill();
  if (!on) {
    $("hashrate").textContent = "0";
    $("streamRate").textContent = "idle";
    renderGauge();
    updateEta();
  }
}

function renderPill() {
  const h = state.info ? `#${Number(state.info.height).toLocaleString("en")}` : "";
  $("mnPillText").textContent = state.wantMining ? `Mining block ${h}` : `Ready · block ${h}`;
}

// ---------------- puzzle + hash stream ----------------
function renderPuzzle() {
  const req = state.info?.requiredBits ?? 0;
  const best = state.best ? bitsOf(state.best) : 0;
  const n = Math.max(32, req + 4);
  const bar = $("puzzleBits");
  bar.style.setProperty("--n", n);
  if (bar.children.length !== n) bar.innerHTML = "<i></i>".repeat(n);
  [...bar.children].forEach((el, i) => {
    el.classList.toggle("z", i < req && i < best);
    el.classList.toggle("best", i < best);
    el.style.outline = i < req && i >= best ? "1px solid rgba(198,255,61,.35)" : "";
  });
  $("puzzleReq").textContent = req || "–";
  $("bestBits").textContent = state.best ? `${best}` : "–";
  $("puzzleToGo").textContent = state.best ? (best >= req ? "solved!" : `${req - best} bits to go`) : "";
  $("bestHash").innerHTML = state.best ? `best: ${hashHtml(state.best)}` : "best: start mining to see your best hash";
}

const STREAM_LINES = 14;
let lastLine = 0;
let lastBestBits = 0;
function streamLine(html, cls = "") {
  const term = $("stream");
  term.querySelector(".idle")?.remove();
  term.insertAdjacentHTML("afterbegin", `<div class="l ${cls}">${html}</div>`);
  while (term.children.length > STREAM_LINES) term.lastElementChild.remove();
}

function onSample(digest, best) {
  if (best && best !== state.best) {
    state.best = best;
    const b = bitsOf(best);
    if (b > lastBestBits && b >= 8) streamLine(`◆ new best · ${b} zero bits · ${hashHtml(best, 42)}`, "near");
    lastBestBits = b;
    renderPuzzle();
  }
  // show at most ~8 sample lines per second
  const now = performance.now();
  if (!digest || now - lastLine < 120) return;
  lastLine = now;
  streamLine(`${short(digest)}  →  ${hashHtml(digest, 48)}`);
}

// ---------------- solution ----------------
function handleSolution(sol) {
  const bits = bitsOf(sol.digest);
  state.solution = { ...sol, bits, reward: state.info.reward, height: state.info.height };
  const secs = state.jobStart ? (Date.now() - state.jobStart) / 1000 : 0;
  $("solHeight").textContent = `#${Number(state.info.height).toLocaleString("en")}`;
  $("solTime").textContent = secs ? `Solved in ${fmtDur(secs)}` : "Solved";
  $("solBits").textContent = bits;
  $("solReq").textContent = state.info.requiredBits;
  $("solReward").textContent = fmtTok(state.info.reward);
  $("solDigest").innerHTML = hashHtml(sol.digest, 50);
  $("solDevice").textContent = [state.gpuActive && state.gpuName, Number($("threads").value) ? `${$("threads").value} CPU threads` : null].filter(Boolean).join(" + ") || "–";
  $("solWallet").textContent = store.wallet ? short(store.wallet.address) : "your wallet";
  $("solutionCard").classList.remove("hidden");
  streamLine(`★ BLOCK FOUND · ${bits} zero bits · ${hashHtml(sol.digest, 42)}`, "win");
  confetti();
  setStatus("block solved!");
  navigator.vibrate?.([120, 60, 200]);
  alertFound(state.info.height);
  if (pref("autoClaim")) claim(true);
}

function confetti() {
  const box = $("confetti");
  const cols = ["#c6ff3d", "#3dffb5", "#38d6ff", "#ffd166", "#ffffff"];
  box.innerHTML = Array.from({ length: 140 }, () => {
    const d = 2.2 + Math.random() * 2.2;
    return `<i style="left:${Math.random() * 100}%;background:${cols[(Math.random() * cols.length) | 0]};--dx:${(Math.random() - 0.5) * 240}px;--rot:${(Math.random() * 900) | 0}deg;animation-duration:${d}s;animation-delay:${Math.random() * 0.6}s"></i>`;
  }).join("");
  box.classList.remove("hidden");
  clearTimeout(confetti.t);
  confetti.t = setTimeout(() => box.classList.add("hidden"), 5200);
}

// ---------------- preferences (auto-claim, sound, notifications) ----------------
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
    [880, 1320, 1760].forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.2, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.14);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + i * 0.12);
      o.stop(t + i * 0.12 + 0.15);
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

async function claim(auto = false) {
  const sol = state.solution;
  if (!sol || state.claiming) return;
  state.claiming = true;
  $("btnClaim").disabled = true;
  $("btnClaim").textContent = "Approve in your wallet…";
  setStatus("Approve in your wallet…");
  try {
    const ev = await chain.claimBlock(store.wallet, { nonce: sol.nonce, challenge: sol.challenge });
    state.myBlocks.unshift({ height: ev.height, reward: ev.reward, hash: ev.hash });
    track("Block claimed", { gpu: $("useGpu").checked ? "yes" : "no" });
    renderMyBlocks();
    setStatus(`claimed block #${ev.height} ✓ ${fmtTok(ev.reward)} added to your wallet`);
    showShareCard({
      height: ev.height.toString(),
      gpu: state.gpuActive ? state.gpuName : null,
      symbol: store.symbol,
      reward: Number(ev.reward / 10n ** 18n).toLocaleString("en"),
      bits: sol.bits,
      hashrate: state.hashrate ? fmtRate(state.hashrate) : null,
      site: location.host,
      siteUrl: location.origin,
    }, { open: !auto })
      .then(() => ($("shareAgain").disabled = false))
      .catch(() => {});
    emit("balances");
    indexer.refresh().catch(() => {});
  } catch (e) {
    console.error(e);
    const msg = errMsg(e);
    setStatus(msg.includes("StaleChallenge") ? "too late — someone else claimed this block" : `claim failed: ${msg}`);
  } finally {
    state.claiming = false;
    $("btnClaim").disabled = false;
    $("btnClaim").textContent = "Claim tokens →";
    clearSolution();
    await refresh(true);
  }
}

// ---------------- engine control ----------------
async function startEngine() {
  if (!state.info || !store.wallet) return;
  if (state.jobChallenge !== state.info.challenge) {
    state.jobChallenge = state.info.challenge;
    state.jobHashes = 0;
    state.jobStart = Date.now();
    state.best = null;
    lastBestBits = 0;
    renderPuzzle();
  }
  const job = { challenge: state.info.challenge, miner: store.wallet.address, target: state.info.target };
  const res = await engine.start(job, { threads: Number($("threads").value), useGpu: $("useGpu").checked });
  if (!res.gpu && !res.threads) return setStatus("Enable CPU threads or the GPU");
  state.gpuActive = !!res.gpu;
  $("gpuStatus").textContent = res.gpu ? "✓ active" : $("useGpu").checked ? "✗ unavailable, CPU only" : "off";
  setStatus(`mining block #${state.info.height}`);
  streamLine(`$ mining block #${state.info.height} · target ${state.info.requiredBits} zero bits · ${[res.gpu && "GPU", res.threads && `${res.threads} CPU threads`].filter(Boolean).join(" + ")}`, "near");
}

// ---------------- chain polling ----------------
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
    if (!indexer.isLoaded()) loadRecentFallback();
  }
}

function renderInfo() {
  const i = state.info;
  const h = Number(i.height);
  $("height").textContent = `#${h.toLocaleString("en")}`;
  $("difficulty").textContent = fmtNum(Number(i.difficulty));
  $("bits").textContent = i.requiredBits;
  $("supply").textContent = `${fmtNum(Number(i.totalSupply / 10n ** 18n))} / 21M`;
  $("lastBlock").textContent = `${fmtDur(Math.max(0, Date.now() / 1000 - Number(i.lastBlockTime)))} ago`;
  $("sbHeight").textContent = `#${h.toLocaleString("en")}`;
  $("sbBar").style.width = `${Math.min(100, (h / TOTAL_BLOCKS) * 100)}%`;
  $("sbText").textContent = `${h.toLocaleString("en")} / ${TOTAL_BLOCKS.toLocaleString("en")} mined · ${((h / TOTAL_BLOCKS) * 100).toFixed(1)}%`;
  renderPill();
  renderPuzzle();
  updateEta();
}

// ---------------- odds / haul / feeds (from the indexer) ----------------
function renderOdds() {
  const net = networkHashrate();
  const rate = state.wantMining ? state.hashrate : 0;
  if (rate && net) {
    const share = rate / (net + rate);
    $("oddsShare").textContent = `${(share * 100).toFixed(share < 0.01 ? 2 : 1)}%`;
    const perDay = share * BLOCKS_PER_DAY;
    $("oddsDay").textContent = perDay >= 10 ? `~${perDay.toFixed(0)}` : `~${perDay.toFixed(perDay < 1 ? 2 : 1)}`;
  } else {
    $("oddsShare").textContent = rate ? "100%" : "–";
    $("oddsDay").textContent = rate ? `~${BLOCKS_PER_DAY}` : "–";
  }
}

function renderOddsBars() {
  const rates = recentHashrates(24);
  const max = Math.max(...rates, 1);
  $("oddsBars").innerHTML = rates.length
    ? rates.map((r) => `<i style="height:${Math.max(4, (r / max) * 100)}%" title="${fmtRate(r)}"></i>`).join("")
    : `<span class="muted small">Needs a few blocks first</span>`;
}

function minedEvents() {
  return indexer
    .events("token", "BlockMined")
    .map((e) => ({ height: Number(e.args.height), miner: e.args.miner, reward: e.args.reward, bits: Number(e.args.achievedBits), t: Number(e.args.timestamp) * 1000, tx: e.tx }))
    .sort((a, b) => b.height - a.height);
}

function renderFeeds() {
  const all = minedEvents();
  const me = store.wallet?.address.toLowerCase();
  const now = Date.now();
  const recent = all.slice(0, 7);
  $("recent").innerHTML = recent.length
    ? recent
        .map((b) => {
          const you = me && b.miner.toLowerCase() === me;
          const fresh = state.seenHeights.size && !state.seenHeights.has(b.height);
          return `<li class="${fresh ? "fresh" : ""}">${avatar(b.miner, 30)}<div style="min-width:0"><div><span class="mono">#${b.height.toLocaleString("en")}</span> · <span class="${you ? "you" : "mono"}">${you ? "You" : short(b.miner)}</span></div><div class="muted small">${b.bits} bits · ${fmtAmt(b.reward, 0)} ${store.symbol}</div></div><span class="t">${fmtDur(Math.max(0, (now - b.t) / 1000))} ago</span></li>`;
        })
        .join("")
    : `<li class="muted">No blocks yet — be the first!</li>`;
  recent.forEach((b) => state.seenHeights.add(b.height));
  const last = all.slice(0, 21);
  $("avgBlock").textContent = last.length > 1 ? `avg ${fmtDur((last[0].t - last[last.length - 1].t) / 1000 / (last.length - 1))}` : "";

  // my blocks: indexer + anything claimed this session that the indexer hasn't picked up yet
  if (me) {
    const mine = all.filter((b) => b.miner.toLowerCase() === me);
    const today = mine.filter((b) => b.t >= now - 86400_000).length;
    $("haulToday").textContent = `${today} block${today === 1 ? "" : "s"} today`;
    const known = new Set(mine.map((b) => b.height));
    const extra = state.myBlocks.filter((b) => !known.has(Number(b.height))).map((b) => ({ height: Number(b.height), reward: b.reward, tx: b.hash, t: now }));
    renderMyBlocks([...extra, ...mine]);
  }
  renderOddsBars();
  renderHaul();
}

function renderMyBlocks(list) {
  list ??= state.myBlocks.map((b) => ({ height: Number(b.height), reward: b.reward, tx: b.hash }));
  $("myBlocks").innerHTML = list.length
    ? list
        .slice(0, 5)
        .map((b) => {
          const url = chain.explorerTx(b.tx);
          return `<li>⛏ Block <b>#${b.height.toLocaleString("en")}</b> · +${fmtAmt(b.reward, 0)} ${store.symbol}${url ? ` · <a href="${url}" target="_blank" rel="noopener">tx ↗</a>` : ""}</li>`;
        })
        .join("") + (list.length > 5 ? `<li class="muted">+${list.length - 5} more · see Transfer → activity</li>` : "")
    : `<li class="muted">${store.wallet ? "No blocks yet — start mining!" : "Connect a wallet to start"}</li>`;
}

function lastTradePrice() {
  const trades = indexer.events("market", "Trade");
  if (!trades.length) return null;
  const t = trades.reduce((a, b) => (b.block > a.block || (b.block === a.block && b.logIndex > a.logIndex) ? b : a));
  return t.args.pricePerLot;
}

function renderHaul() {
  if (!store.wallet) {
    $("haulBal").textContent = "–";
    $("haulLots").textContent = "connect a wallet";
    $("haulUsd").textContent = "–";
    return;
  }
  const bal = store.tokenBalance;
  const lots = bal / LOT;
  $("haulBal").textContent = fmtAmt(bal, 0);
  $("haulLots").textContent = `${store.symbol} · ${lots} lot${lots === 1n ? "" : "s"}`;
  const p = lastTradePrice();
  $("haulUsd").textContent = p ? usd((bal * p) / LOT) : "–";
  $("haulNote").textContent = p ? "at the last trade price" : "no trades yet";
}

async function loadRecentFallback() {
  try {
    const blocks = await chain.recentBlocks(7);
    if (indexer.isLoaded()) return;
    $("recent").innerHTML = blocks.length
      ? blocks.map((b) => `<li>${avatar(b.miner, 30)}<div><div><span class="mono">#${b.height}</span> · <span class="mono">${short(b.miner)}</span></div><div class="muted small">${b.achievedBits} bits</div></div></li>`).join("")
      : `<li class="muted">No blocks yet — be the first!</li>`;
  } catch {
    $("recent").innerHTML = `<li class="muted">Could not load events</li>`;
  }
}

// ---------------- benchmark ----------------
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
  $("btnStart").disabled = false;
  const rate = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  if (!rate) return ($("benchResult").textContent = "Could not measure; enable CPU threads or the GPU.");
  const parts = [`<b>${fmtRate(rate)}</b> with ${settings.threads} CPU thread(s)${res.gpu ? " + GPU" : ""}.`];
  if (state.info) {
    const eta = expectedHashes(state.info.target) / rate;
    parts.push(`Alone at today's difficulty (${state.info.requiredBits} bits): a block about every <b>${fmtDur(eta)}</b>.`);
    const net = networkHashrate();
    if (net) {
      const share = Math.min(100, (rate / (net + rate)) * 100);
      // the network finds ~1 block per TARGET_BLOCK_TIME (120 s), so your average wait is 120 s / your share
      parts.push(`Network is ~${fmtRate(net)} → you'd win about <b>${share.toFixed(share < 1 ? 2 : 1)}%</b> of blocks, one every <b>${fmtDur(120 / (share / 100))}</b>.`);
    }
  }
  $("benchResult").innerHTML = parts.join(" ");
  track("Benchmark run", { gpu: res.gpu ? "yes" : "no" });
}

// ---------------- device info ----------------
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
  $("cpuName").textContent = `${cores} cores`;
  const det = await detectGpu();
  const manual = savedGpu();
  state.gpuName = manual || det.name;
  $("gpuName").textContent = state.gpuName || "not detected";
  if (manual) $("gpuName").title = "set by you";
  $("gpuRaw").textContent = `WebGL:  ${det.raw.webgl ?? "–"}\nWebGPU: ${det.raw.webgpu ? JSON.stringify(det.raw.webgpu) : "–"}\nDetected: ${det.name ?? "–"} (${det.source})${manual ? `\nManual: ${manual}` : ""}`;
  $("gpuApi").textContent = engine.hasGpuApi() ? "" : "WebGPU isn't available in this browser → CPU only (use Chrome/Edge)";
  if (!$("gpuStatus").textContent) $("gpuStatus").textContent = engine.hasGpuApi() ? "ready" : "unavailable";
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

// ---------------- power modes ----------------
function modeSettings(mode) {
  const cores = navigator.hardwareConcurrency || 2;
  const gpu = engine.hasGpuApi();
  if (mode === "max") return { threads: Math.max(1, cores - 1), gpu };
  if (mode === "balanced") return { threads: Math.max(1, Math.floor(cores / 2)), gpu };
  return { threads: 1, gpu: false };
}
function syncMode() {
  const t = Number($("threads").value);
  const g = $("useGpu").checked;
  document.querySelectorAll("[data-mode]").forEach((b) => {
    const m = modeSettings(b.dataset.mode);
    b.classList.toggle("active", m.threads === t && m.gpu === g);
  });
  const th = $("threads");
  th.style.setProperty("--p", `${(Number(th.value) / Number(th.max || 1)) * 100}%`);
  $("threadsVal").textContent = th.value;
}

// ---------------- init ----------------
export function initMine() {
  const cores = navigator.hardwareConcurrency || 2;
  $("threads").max = cores;
  $("threads").value = Math.max(1, cores - 1);
  $("useGpu").checked = engine.hasGpuApi();
  syncMode();
  showDevice();
  renderPuzzle();
  renderMyBlocks();
  $("gpuEdit").onclick = editGpu;
  $("btnBench").onclick = benchmark;
  initShare();
  $("shareAgain").onclick = () => reopenShare();

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
    state.sessionFrom = Date.now();
    track("Mining started", { gpu: $("useGpu").checked ? "yes" : "no", threads: String($("threads").value) });
    setMiningUi(true);
    try {
      wakeLock = await navigator.wakeLock?.request("screen"); // keep phone screen awake while mining
    } catch {}
    await refresh(true);
  };
  $("btnStop").onclick = () => {
    state.wantMining = false;
    state.sessionMs += Date.now() - state.sessionFrom;
    engine.stop();
    wakeLock?.release?.();
    setMiningUi(false);
    setStatus("stopped");
    streamLine("$ stopped", "");
  };
  $("btnClaim").onclick = () => claim();
  $("btnDiscard").onclick = () => {
    clearSolution();
    refresh(true);
  };
  const restartIfMining = () => state.wantMining && !state.solution && startEngine();
  $("threads").oninput = syncMode;
  $("threads").onchange = restartIfMining;
  $("useGpu").onchange = () => {
    syncMode();
    restartIfMining();
  };
  document.querySelectorAll("[data-mode]").forEach((b) => {
    b.onclick = () => {
      const m = modeSettings(b.dataset.mode);
      $("threads").value = m.threads;
      $("useGpu").checked = m.gpu;
      syncMode();
      restartIfMining();
    };
  });

  // Wallet account switched: the hash is bound to the address, so restart mining for the new one.
  on("wallet", (w) => {
    clearSolution();
    renderFeeds();
    if (!w) {
      // disconnected: stop mining
      if (state.wantMining) $("btnStop").click();
      return;
    }
    if (state.wantMining) startEngine();
  });
  on("balances:updated", renderHaul);
  indexer.subscribe(renderFeeds);
  setInterval(tickSession, 1000);
  setInterval(() => indexer.isLoaded() && renderFeeds(), 30_000); // keep "x ago" fresh

  return refresh;
}
