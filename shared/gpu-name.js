// GPU name detection for the miner UI.
//
// Sources (best first):
//  1. WebGL unmasked renderer string (Chrome/Edge/Brave usually give the exact model):
//     "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Ti (0x00002489) Direct3D11 vs_5_0 ps_5_0, D3D11)" -> "NVIDIA GeForce RTX 3060 Ti"
//  2. PCI device id inside that string, when the driver reports a generic name ("Intel(R) Graphics (0x0000E20B)")
//  3. WebGPU adapter info (vendor + architecture) -> family name, e.g. "Intel Arc B-series (Battlemage)".
//     This is also the GPU that actually runs the WebGPU miner, so on dual-GPU laptops it wins
//     when WebGL reports a different vendor (e.g. WebGL on Intel iGPU, WebGPU on NVIDIA).

// Known PCI device ids (vendor 0x8086 Intel Arc) for drivers that report a generic name.
const PCI_IDS = {
  e20b: "Intel Arc B580",
  e20c: "Intel Arc B570",
  "56a0": "Intel Arc A770",
  "56a1": "Intel Arc A750",
  "56a5": "Intel Arc A380",
  "56a6": "Intel Arc A310",
};

// Chrome's WebGPU adapter.info.architecture values -> human family names
const ARCH = {
  nvidia: {
    maxwell: "GeForce GTX 900 series (Maxwell)",
    pascal: "GeForce GTX 10 series (Pascal)",
    volta: "Volta",
    turing: "GeForce RTX 20 / GTX 16 series (Turing)",
    ampere: "GeForce RTX 30 series (Ampere)",
    lovelace: "GeForce RTX 40 series (Ada Lovelace)",
    "ada-lovelace": "GeForce RTX 40 series (Ada Lovelace)",
    blackwell: "GeForce RTX 50 series (Blackwell)",
  },
  amd: {
    "gcn-5": "Radeon Vega (GCN 5)",
    "rdna-1": "Radeon RX 5000 series (RDNA 1)",
    "rdna-2": "Radeon RX 6000 series (RDNA 2)",
    "rdna-3": "Radeon RX 7000 series (RDNA 3)",
    "rdna-4": "Radeon RX 9000 series (RDNA 4)",
  },
  intel: {
    "gen-9": "HD / UHD Graphics (Gen 9)",
    "gen-11": "Iris Plus (Gen 11)",
    "gen-12lp": "Iris Xe / UHD (Gen 12)",
    "gen-12hp": "Arc A-series (Alchemist)",
    "xe-hpg": "Arc A-series (Alchemist)",
    "xe-lpg": "Arc Graphics (Meteor Lake)",
    "xe-2lpg": "Arc Graphics (Lunar Lake)",
    "xe-2hpg": "Arc B-series (Battlemage)",
    "xe-3lpg": "Arc Graphics (Panther Lake)",
  },
};
const VENDOR_NAME = { nvidia: "NVIDIA", amd: "AMD", ati: "AMD", intel: "Intel", apple: "Apple", qualcomm: "Qualcomm", arm: "ARM", google: "Google" };

const GENERIC = /^(intel(\(r\))? graphics|amd radeon(\(tm\))? graphics|microsoft basic render driver|swiftshader.*|llvmpipe.*|webkit webgl|mozilla|generic renderer|apple gpu|angle.*)$/i;

/** Turn the raw WebGL renderer string into a clean GPU name. */
export function cleanGpuName(raw) {
  if (!raw) return null;
  let s = String(raw).trim();

  const angle = s.match(/^ANGLE \((.*)\)$/s);
  if (angle) {
    const inner = angle[1];
    const metal = inner.match(/ANGLE Metal Renderer: ([^,]+)/);
    const vulkan = inner.match(/Vulkan [\d.]+ \((.*)$/);
    if (metal) s = metal[1];
    else if (vulkan) s = vulkan[1];
    else {
      const parts = inner.split(", ");
      s = parts.length >= 2 ? parts[1] : parts[0];
    }
  }

  s = s
    .replace(/\s*\((R|TM|tm|r)\)/g, "") // Intel(R), Arc(TM), Adreno (TM)
    .replace(/[®™]/g, "")
    .replace(/, or similar$/, "")
    .replace(/ \(.*$/, "") // (0x0000E20B) Direct3D11..., (radeonsi, navi22 ...)
    .replace(/\/.*$/, "") // /PCIe/SSE2
    .replace(/ Direct3D.*$/, "")
    .replace(/ OpenGL.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return s || null;
}

/** PCI device id from an ANGLE string: "(0x0000E20B)" -> "e20b" */
export function pciId(raw) {
  const m = String(raw || "").match(/\(0x0000([0-9a-f]{4})\)/i);
  return m ? m[1].toLowerCase() : null;
}

function vendorOf(name) {
  const n = (name || "").toLowerCase();
  if (/nvidia|geforce|quadro/.test(n)) return "nvidia";
  if (/amd|radeon|ati/.test(n)) return "amd";
  if (/intel|arc|iris|uhd/.test(n)) return "intel";
  if (/apple/.test(n)) return "apple";
  if (/adreno|qualcomm/.test(n)) return "qualcomm";
  if (/mali|arm/.test(n)) return "arm";
  return null;
}

/** WebGPU adapter info -> readable name (or null). */
export function nameFromWebGpuInfo(info) {
  if (!info) return null;
  if (info.description && !GENERIC.test(info.description)) return cleanGpuName(info.description);
  const vendor = (info.vendor || "").toLowerCase();
  const arch = (info.architecture || "").toLowerCase();
  if (!vendor) return null;
  const vName = VENDOR_NAME[vendor] || vendor.replace(/\b\w/g, (c) => c.toUpperCase());
  const family = ARCH[vendor === "ati" ? "amd" : vendor]?.[arch];
  if (family) return `${vName} ${family}`;
  return arch ? `${vName} (${arch})` : vName;
}

/**
 * Combine WebGL + WebGPU info into the best name.
 * @returns {{ name: string|null, source: string }}
 */
export function resolveGpuName(webglRaw, webgpuInfo) {
  const glName = cleanGpuName(webglRaw);
  const id = pciId(webglRaw);
  const gpuName = nameFromWebGpuInfo(webgpuInfo);
  const gpuVendor = (webgpuInfo?.vendor || "").toLowerCase().replace("ati", "amd");

  let best = glName && !GENERIC.test(glName) ? glName : null;
  if ((!best || !/arc/i.test(best)) && id && PCI_IDS[id]) best = PCI_IDS[id];

  // Dual-GPU laptops: WebGL may sit on the iGPU while WebGPU (the miner) uses the dGPU
  if (best && gpuVendor && vendorOf(best) && vendorOf(best) !== gpuVendor && gpuName) return { name: gpuName, source: "webgpu" };
  if (best) return { name: best, source: "webgl" };
  if (gpuName) return { name: gpuName, source: "webgpu" };
  return { name: glName, source: glName ? "webgl-generic" : "none" };
}

/** Browser-side detection. Returns { name, source, raw: { webgl, webgpu } }. */
export async function detectGpu() {
  let webgl = null;
  let webgpu = null;
  for (const type of ["webgl2", "webgl", "experimental-webgl"]) {
    try {
      const gl = document.createElement("canvas").getContext(type, { powerPreference: "high-performance" });
      if (!gl) continue;
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      webgl = (ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      if (webgl) break;
    } catch {}
  }
  try {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
    const info = adapter?.info ?? (await adapter?.requestAdapterInfo?.());
    if (info) webgpu = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description };
  } catch {}
  return { ...resolveGpuName(webgl, webgpu), raw: { webgl, webgpu } };
}

/** Back-compat helper: just the name. */
export async function detectGpuName() {
  return (await detectGpu()).name;
}
