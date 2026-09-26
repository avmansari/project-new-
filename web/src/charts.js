// Small dependency-free SVG charts (line + candlestick) that follow the dataviz rules:
// 2px lines, 10% area wash, hairline recessive grid, one y-axis, crosshair + tooltip on hover/focus,
// tooltip built with textContent, and a data table for every chart (never tooltip-only).
const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

const PAD = { top: 12, right: 12, bottom: 26, left: 56 };

function niceTicks(min, max, count = 4) {
  if (min === max) {
    const d = Math.abs(min) || 1;
    min -= d / 2;
    max += d / 2;
  }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || mag * 10;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toPrecision(12));
  return { lo, hi, ticks };
}

const fmtTime = (ms, spanMs) => {
  const d = new Date(ms);
  if (spanMs > 2 * 86400_000) return d.toLocaleDateString("en", { month: "short", day: "numeric" });
  if (spanMs < 3600_000) return d.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return d.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
};

function tooltipEl(host) {
  let tip = host.querySelector(".viz-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "viz-tip";
    tip.hidden = true;
    host.appendChild(tip);
  }
  return tip;
}

function showTip(tip, host, x, y, rows) {
  tip.replaceChildren();
  for (const [value, label, color] of rows) {
    const row = document.createElement("div");
    row.className = "viz-tip-row";
    if (color) {
      const key = document.createElement("span");
      key.className = "viz-key";
      key.style.background = color;
      row.appendChild(key);
    }
    const b = document.createElement("b");
    b.textContent = value;
    const s = document.createElement("span");
    s.textContent = label;
    row.append(b, s);
    tip.appendChild(row);
  }
  tip.hidden = false;
  const w = host.clientWidth;
  const tw = tip.offsetWidth;
  tip.style.left = `${Math.min(Math.max(x - tw / 2, 0), w - tw)}px`;
  tip.style.top = `${Math.max(y - tip.offsetHeight - 10, 0)}px`;
}

function tableView(host, headers, rows) {
  let det = host.querySelector("details.viz-table");
  if (!det) {
    det = document.createElement("details");
    det.className = "viz-table small";
    const sum = document.createElement("summary");
    sum.textContent = "Show data table";
    det.appendChild(sum);
    host.appendChild(det);
  }
  det.querySelector("table")?.remove();
  const t = document.createElement("table");
  t.className = "book";
  const hr = document.createElement("tr");
  headers.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    hr.appendChild(th);
  });
  t.appendChild(hr);
  rows.slice(-200).reverse().forEach((r) => {
    const tr = document.createElement("tr");
    r.forEach((c) => {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    });
    t.appendChild(tr);
  });
  det.appendChild(t);
}

function frame(host, height) {
  host.classList.add("viz");
  let svg = host.querySelector("svg.viz-svg");
  if (!svg) {
    svg = el("svg", { class: "viz-svg", role: "img" });
    host.prepend(svg);
  }
  const width = Math.max(host.clientWidth, 260);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.replaceChildren();
  return { svg, width, height };
}

function emptyState(host, msg) {
  host.classList.add("viz");
  host.querySelector("svg.viz-svg")?.remove();
  let p = host.querySelector(".viz-empty");
  if (!p) {
    p = document.createElement("p");
    p.className = "viz-empty muted small";
    host.prepend(p);
  }
  p.textContent = msg;
}

function axes(svg, width, height, yTicks, y, xTicks, x, spanMs, yFmt) {
  const g = el("g", { class: "viz-axes" });
  for (const t of yTicks) {
    const yy = Math.round(y(t)) + 0.5;
    g.appendChild(el("line", { x1: PAD.left, x2: width - PAD.right, y1: yy, y2: yy, class: "viz-grid" }));
    const lbl = el("text", { x: PAD.left - 6, y: yy + 4, "text-anchor": "end", class: "viz-label" });
    lbl.textContent = yFmt(t);
    g.appendChild(lbl);
  }
  for (const t of xTicks) {
    const lbl = el("text", { x: x(t), y: height - 8, "text-anchor": "middle", class: "viz-label" });
    lbl.textContent = fmtTime(t, spanMs);
    g.appendChild(lbl);
  }
  svg.appendChild(g);
}

function timeTicks(min, max, count) {
  if (max === min) return [min];
  const out = [];
  for (let i = 0; i <= count; i++) out.push(min + ((max - min) * i) / count);
  return out;
}

/**
 * Single-series line chart over time.
 * points: [{ t: ms, y: number }] ; opts: { label, yFmt, height, empty }
 */
export function lineChart(host, points, { label = "", yFmt = (v) => String(v), height = 180, empty = "No data yet" } = {}) {
  host.querySelector(".viz-empty")?.remove();
  if (points.length < 2) return emptyState(host, empty);
  const { svg, width } = frame(host, height);
  svg.setAttribute("aria-label", `${label} over time`);
  const tMin = points[0].t;
  const tMax = points[points.length - 1].t;
  const ys = points.map((p) => p.y);
  const { lo, hi, ticks } = niceTicks(Math.min(...ys, 0), Math.max(...ys));
  const x = (t) => PAD.left + ((t - tMin) / (tMax - tMin || 1)) * (width - PAD.left - PAD.right);
  const y = (v) => PAD.top + (1 - (v - lo) / (hi - lo || 1)) * (height - PAD.top - PAD.bottom);
  axes(svg, width, height, ticks, y, timeTicks(tMin, tMax, width < 420 ? 2 : 4), x, tMax - tMin, yFmt);

  const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.y).toFixed(1)}`).join("");
  svg.appendChild(el("path", { d: `${d}L${x(tMax)},${y(lo)}L${x(tMin)},${y(lo)}Z`, class: "viz-area" }));
  svg.appendChild(el("path", { d, class: "viz-line" }));
  const last = points[points.length - 1];
  svg.appendChild(el("circle", { cx: x(last.t), cy: y(last.y), r: 4, class: "viz-dot" }));

  // crosshair + tooltip (snaps to nearest point)
  const cross = el("line", { y1: PAD.top, y2: height - PAD.bottom, class: "viz-cross", visibility: "hidden" });
  const hoverDot = el("circle", { r: 4, class: "viz-dot", visibility: "hidden" });
  svg.append(cross, hoverDot);
  const hit = el("rect", { x: PAD.left, y: 0, width: width - PAD.left - PAD.right, height, fill: "transparent", tabindex: 0 });
  svg.appendChild(hit);
  const tip = tooltipEl(host);
  const at = (i) => {
    const p = points[i];
    const px = x(p.t);
    cross.setAttribute("x1", px);
    cross.setAttribute("x2", px);
    cross.setAttribute("visibility", "visible");
    hoverDot.setAttribute("cx", px);
    hoverDot.setAttribute("cy", y(p.y));
    hoverDot.setAttribute("visibility", "visible");
    showTip(tip, host, px, y(p.y), [[yFmt(p.y), `${label} · ${new Date(p.t).toLocaleString("en")}`, "var(--series-1)"]]);
  };
  let focusIdx = points.length - 1;
  const nearest = (clientX) => {
    const r = svg.getBoundingClientRect();
    const t = tMin + ((clientX - r.left - PAD.left) / (width - PAD.left - PAD.right)) * (tMax - tMin);
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i].t - t) < Math.abs(points[best].t - t)) best = i;
    return best;
  };
  const hide = () => {
    cross.setAttribute("visibility", "hidden");
    hoverDot.setAttribute("visibility", "hidden");
    tip.hidden = true;
  };
  hit.addEventListener("pointermove", (e) => at((focusIdx = nearest(e.clientX))));
  hit.addEventListener("pointerleave", hide);
  hit.addEventListener("focus", () => at(focusIdx));
  hit.addEventListener("blur", hide);
  hit.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") at((focusIdx = Math.max(0, focusIdx - 1)));
    if (e.key === "ArrowRight") at((focusIdx = Math.min(points.length - 1, focusIdx + 1)));
  });

  tableView(host, ["Time", label], points.map((p) => [new Date(p.t).toLocaleString("en"), yFmt(p.y)]));
}

/**
 * Candlestick chart. candles: [{ t, o, h, l, c, v }] (numbers); opts: { yFmt, volFmt, height }
 * Up candles = --up (blue), down = --down (red): a CVD-safe diverging pair.
 */
export function candleChart(host, candles, { yFmt = (v) => String(v), volFmt = (v) => String(v), height = 220, empty = "No trades yet" } = {}) {
  host.querySelector(".viz-empty")?.remove();
  if (!candles.length) return emptyState(host, empty);
  const { svg, width } = frame(host, height);
  svg.setAttribute("aria-label", "Price per lot, candlestick chart");
  const step = candles.length > 1 ? candles[1].t - candles[0].t : 3600_000;
  const tMin = candles[0].t - step / 2;
  const tMax = candles[candles.length - 1].t + step / 2;
  const { lo, hi, ticks } = niceTicks(Math.min(...candles.map((c) => c.l)), Math.max(...candles.map((c) => c.h)));
  const plotW = width - PAD.left - PAD.right;
  const x = (t) => PAD.left + ((t - tMin) / (tMax - tMin || 1)) * plotW;
  const y = (v) => PAD.top + (1 - (v - lo) / (hi - lo || 1)) * (height - PAD.top - PAD.bottom);
  axes(svg, width, height, ticks, y, timeTicks(candles[0].t, candles[candles.length - 1].t, width < 420 ? 2 : 4), x, tMax - tMin, yFmt);

  const slot = plotW / Math.max(candles.length, 1);
  const bodyW = Math.max(2, Math.min(24, slot - 2)); // <= 24px, 2px surface gap between neighbours
  const tip = tooltipEl(host);
  for (const c of candles) {
    const up = c.c >= c.o;
    const cls = up ? "viz-up" : "viz-down";
    const cx = x(c.t);
    const g = el("g", { class: `viz-candle ${cls}`, tabindex: 0 });
    g.appendChild(el("line", { x1: cx, x2: cx, y1: y(c.h), y2: y(c.l), class: "viz-wick" }));
    const top = y(Math.max(c.o, c.c));
    const bh = Math.max(2, Math.abs(y(c.o) - y(c.c)));
    g.appendChild(el("rect", { x: cx - bodyW / 2, y: top, width: bodyW, height: bh, rx: Math.min(2, bodyW / 4) }));
    // hit target bigger than the mark: the whole column slot
    g.appendChild(el("rect", { x: cx - slot / 2, y: PAD.top, width: slot, height: height - PAD.top - PAD.bottom, fill: "transparent" }));
    const show = () => {
      g.classList.add("hover");
      showTip(tip, host, cx, top, [
        [yFmt(c.c), `close · ${new Date(c.t).toLocaleString("en")}`, up ? "var(--up)" : "var(--down)"],
        [`${yFmt(c.o)} → ${yFmt(c.c)}`, "open → close"],
        [`${yFmt(c.l)} – ${yFmt(c.h)}`, "low – high"],
        [volFmt(c.v), "volume"],
      ]);
    };
    const hide = () => {
      g.classList.remove("hover");
      tip.hidden = true;
    };
    g.addEventListener("pointerenter", show);
    g.addEventListener("pointerleave", hide);
    g.addEventListener("focus", show);
    g.addEventListener("blur", hide);
    svg.appendChild(g);
  }
  tableView(
    host,
    ["Time", "Open", "High", "Low", "Close", "Volume"],
    candles.map((c) => [new Date(c.t).toLocaleString("en"), yFmt(c.o), yFmt(c.h), yFmt(c.l), yFmt(c.c), volFmt(c.v)])
  );
}

/** Re-render charts when their container width changes. */
export function onResize(host, render) {
  let w = host.clientWidth;
  new ResizeObserver(() => {
    if (Math.abs(host.clientWidth - w) > 8) {
      w = host.clientWidth;
      render();
    }
  }).observe(host);
}
