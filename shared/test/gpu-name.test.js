import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanGpuName } from "../gpu-name.js";

const cases = [
  ["ANGLE (Intel, Intel(R) Arc(TM) B580 Graphics (0x0000E20B) Direct3D11 vs_5_0 ps_5_0, D3D11)", "Intel Arc B580 Graphics"],
  ["ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Ti (0x00002489) Direct3D11 vs_5_0 ps_5_0, D3D11)", "NVIDIA GeForce RTX 3060 Ti"],
  ["ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)", "AMD Radeon RX 6700 XT"],
  ["ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4090/PCIe/SSE2, OpenGL 4.5.0)", "NVIDIA GeForce RTX 4090"],
  ["ANGLE (AMD, AMD Radeon RX 6700 XT (radeonsi, navi22, LLVM 15.0.7, DRM 3.49, 6.2.0), OpenGL 4.6)", "AMD Radeon RX 6700 XT"],
  ["ANGLE (Intel, Vulkan 1.3.0 (Intel(R) Arc(TM) B580 Graphics (0x0000E20B)), Intel open-source Mesa driver)", "Intel Arc B580 Graphics"],
  ["ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)", "Apple M2 Pro"],
  ["ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)", "Intel UHD Graphics 630"],
  ["Adreno (TM) 740", "Adreno 740"],
  ["Mali-G710 MC10", "Mali-G710 MC10"],
  ["NVIDIA GeForce GTX 980, or similar", "NVIDIA GeForce GTX 980"],
];

for (const [raw, want] of cases) {
  test(`gpu name: ${want}`, () => assert.equal(cleanGpuName(raw), want));
}
