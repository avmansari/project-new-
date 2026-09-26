// Turn the raw WebGL renderer string into a clean GPU name.
//   "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Ti (0x00002489) Direct3D11 vs_5_0 ps_5_0, D3D11)" -> "NVIDIA GeForce RTX 3060 Ti"
//   "ANGLE (Intel, Intel(R) Arc(TM) B580 Graphics (0x0000E20B) Direct3D11 ...)"             -> "Intel Arc B580 Graphics"
//   "ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 ...)"                          -> "AMD Radeon RX 6700 XT"
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

/** Best-effort GPU name in the browser (WebGL debug info, falls back to WebGPU adapter info). */
export async function detectGpuName() {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { powerPreference: "high-performance" }) || canvas.getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    const raw = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
    const name = cleanGpuName(raw);
    if (name && !/^(WebKit WebGL|Mozilla|Generic Renderer)$/i.test(name)) return name;
  } catch {}
  try {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
    const info = adapter?.info;
    const name = [info?.vendor, info?.description || info?.architecture].filter(Boolean).join(" ");
    if (name) return name.replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {}
  return null;
}
