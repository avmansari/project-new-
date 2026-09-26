// Share card: after a successful claim, draw a 1200x630 image ("I mined block #123 with RTX 3060 Ti ⛏️")
// and offer one-click sharing to X. On phones the Web Share API shares the image itself; on desktop the
// X composer opens with the text + link and the image is downloaded so it can be attached.
import { $ } from "./store.js";

const W = 1200;
const H = 630;
let current = null; // { blob, url, text }

function draw({ height, gpu, symbol, reward, bits, hashrate, site }) {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");

  // background
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#0b0f0c");
  bg.addColorStop(1, "#141a16");
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  // subtle hash grid
  g.strokeStyle = "#1c241f";
  g.lineWidth = 1;
  for (let x = 0; x < W; x += 40) {
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, H);
    g.stroke();
  }
  // accent bar
  g.fillStyle = "#ccff00";
  g.fillRect(0, 0, 14, H);

  const font = (w, px) => `${w} ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  g.fillStyle = "#8a9a8f";
  g.font = font(600, 34);
  g.fillText(`⛏️  ${symbol} · Proof-of-Work on Robinhood Chain`, 70, 100);

  g.fillStyle = "#e8f0ea";
  g.font = font(800, 92);
  g.fillText(`I mined block #${height}`, 70, 240);

  g.fillStyle = "#ccff00";
  g.font = font(800, 64);
  const gpuLine = gpu ? `with ${gpu}` : "from my browser";
  // shrink long GPU names to fit
  let size = 64;
  while (g.measureText(gpuLine).width > W - 140 && size > 36) {
    size -= 4;
    g.font = font(800, size);
  }
  g.fillText(gpuLine, 70, 330);

  g.fillStyle = "#e8f0ea";
  g.font = font(700, 44);
  g.fillText(`+${reward} ${symbol}`, 70, 440);
  g.fillStyle = "#8a9a8f";
  g.font = font(500, 32);
  const stats = [`difficulty ${bits} bits`, hashrate ? `${hashrate}` : null].filter(Boolean).join("  ·  ");
  g.fillText(stats, 70, 495);

  g.fillStyle = "#8a9a8f";
  g.font = font(600, 30);
  g.fillText(site, 70, 580);
  return c;
}

/** Build the card after a claim and show the share panel. */
export async function showShareCard(info) {
  const canvas = draw(info);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  if (current?.url) URL.revokeObjectURL(current.url);
  const url = URL.createObjectURL(blob);
  const text = `I just mined block #${info.height} of $${info.symbol} ${info.gpu ? `with my ${info.gpu} ` : ""}⛏️ Proof-of-Work mining right in the browser on Robinhood Chain. Mine yours 👇`;
  current = { blob, url, text, name: `mined-block-${info.height}.png`, site: info.siteUrl };
  $("shareImg").src = url;
  $("shareCard").classList.remove("hidden");
  const canShareFile = !!(navigator.canShare && navigator.canShare({ files: [new File([blob], current.name, { type: "image/png" })] }));
  $("shareNative").classList.toggle("hidden", !canShareFile);
}

function download() {
  const a = document.createElement("a");
  a.href = current.url;
  a.download = current.name;
  a.click();
}

export function initShare() {
  $("shareX").onclick = () => {
    if (!current) return;
    // open X first (keeps the click's popup permission), then save the image for the user to attach
    const u = `https://x.com/intent/post?text=${encodeURIComponent(current.text)}&url=${encodeURIComponent(current.site)}`;
    window.open(u, "_blank", "noopener");
    download();
  };
  $("shareDownload").onclick = () => current && download();
  $("shareNative").onclick = async () => {
    if (!current) return;
    try {
      await navigator.share({ files: [new File([current.blob], current.name, { type: "image/png" })], text: `${current.text} ${current.site}` });
    } catch {}
  };
  $("shareClose").onclick = () => $("shareCard").classList.add("hidden");
}
