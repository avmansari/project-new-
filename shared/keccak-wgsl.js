// WebGPU (WGSL) Keccak-256 miner kernel + helpers for packing inputs.
//
// WGSL has no 64-bit ints, so every Keccak lane is a vec2<u32> = (lo, hi).
// The whole 84-byte input fits in ONE Keccak block (rate = 136 bytes), so each GPU thread
// runs exactly one Keccak-f[1600] permutation per nonce.
//
// Host (JS) pre-packs the padded 136-byte block into 17 lanes. Each thread only overwrites
// lane 10's low word = bytes 80..83 = the big-endian "inner counter" of the nonce.

// Rotation offsets r[x + 5y]
const RHO = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

export const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const hex32 = (v) => "0x" + v.toString(16).padStart(8, "0") + "u";

// Emit WGSL for a constant 64-bit rotate-left of vec2 expression `v` by n.
function rot(v, n) {
  if (n === 0) return v;
  if (n === 32) return `vec2<u32>(${v}.y, ${v}.x)`;
  if (n < 32) {
    return `vec2<u32>((${v}.x << ${n}u) | (${v}.y >> ${32 - n}u), (${v}.y << ${n}u) | (${v}.x >> ${32 - n}u))`;
  }
  const m = n - 32;
  return `vec2<u32>((${v}.y << ${m}u) | (${v}.x >> ${32 - m}u), (${v}.x << ${m}u) | (${v}.y >> ${32 - m}u))`;
}

function generateRound() {
  const L = [];
  // theta
  for (let x = 0; x < 5; x++) L.push(`let c${x} = a${x} ^ a${x + 5} ^ a${x + 10} ^ a${x + 15} ^ a${x + 20};`);
  for (let x = 0; x < 5; x++) L.push(`let d${x} = c${(x + 4) % 5} ^ ${rot(`c${(x + 1) % 5}`, 1)};`);
  for (let i = 0; i < 25; i++) L.push(`a${i} = a${i} ^ d${i % 5};`);
  // rho + pi:  b[y, 2x+3y] = rot(a[x,y], r[x,y])
  for (let x = 0; x < 5; x++) {
    for (let y = 0; y < 5; y++) {
      const src = x + 5 * y;
      const dst = y + 5 * ((2 * x + 3 * y) % 5);
      L.push(`let b${dst} = ${rot(`a${src}`, RHO[src])};`);
    }
  }
  // chi
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const i = x + 5 * y;
      L.push(`a${i} = b${i} ^ (~b${((x + 1) % 5) + 5 * y} & b${((x + 2) % 5) + 5 * y});`);
    }
  }
  // iota
  L.push(`a0 = a0 ^ RC[r];`);
  return L.map((l) => "    " + l).join("\n");
}

export const WORKGROUP_SIZE = 256;

export const KECCAK_MINER_WGSL = /* wgsl */ `
struct Params {
  lanes: array<vec2<u32>, 17>, // padded input block (lane 10 .x is replaced per thread)
  tgt: array<u32, 8>,          // target as big-endian 32-bit words (tgt[0] = most significant)
  base: u32,                   // inner-counter start for this dispatch
  _p0: u32,                    // pad struct to 176 bytes
};

struct Result {
  found: atomic<u32>,
  counter: u32,
};

@group(0) @binding(0) var<storage, read> params: Params;
@group(0) @binding(1) var<storage, read_write> result: Result;

const RC = array<vec2<u32>, 24>(
${ROUND_CONSTANTS.map((c) => `  vec2<u32>(${hex32(c & 0xffffffffn)}, ${hex32(c >> 32n)})`).join(",\n")}
);

fn bswap(v: u32) -> u32 {
  return ((v & 0xffu) << 24u) | ((v & 0xff00u) << 8u) | ((v >> 8u) & 0xff00u) | (v >> 24u);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let idx = gid.x + gid.y * nwg.x * ${WORKGROUP_SIZE}u;
  let counter = params.base + idx;

${Array.from({ length: 25 }, (_, i) =>
  i < 17
    ? i === 10
      ? `  var a10 = vec2<u32>(bswap(counter), params.lanes[10].y);`
      : `  var a${i} = params.lanes[${i}];`
    : `  var a${i} = vec2<u32>(0u, 0u);`
).join("\n")}

  for (var r = 0u; r < 24u; r = r + 1u) {
${generateRound()}
  }

  // digest = bytes of lanes 0..3 (little-endian) -> compare as big-endian uint256 with target
  let dw = array<u32, 8>(bswap(a0.x), bswap(a0.y), bswap(a1.x), bswap(a1.y),
                         bswap(a2.x), bswap(a2.y), bswap(a3.x), bswap(a3.y));
  var ok = true;
  for (var k = 0u; k < 8u; k = k + 1u) {
    let t = params.tgt[k];
    if (dw[k] < t) { ok = true; break; }
    if (dw[k] > t) { ok = false; break; }
  }
  if (ok) {
    let prev = atomicAdd(&result.found, 1u);
    if (prev == 0u) { result.counter = counter; }
  }
}
`;

/** Pack an 84-byte input into the Params buffer layout (176 bytes). */
export function packParams(input84, targetBytes32, base) {
  const block = new Uint8Array(136);
  block.set(input84, 0);
  block[84] ^= 0x01; // keccak pad start
  block[135] ^= 0x80; // keccak pad end
  const buf = new ArrayBuffer(176);
  const u32 = new Uint32Array(buf);
  const dv = new DataView(block.buffer);
  for (let i = 0; i < 34; i++) u32[i] = dv.getUint32(i * 4, true);
  const tdv = new DataView(targetBytes32.buffer, targetBytes32.byteOffset, 32);
  for (let k = 0; k < 8; k++) u32[34 + k] = tdv.getUint32(k * 4, false);
  u32[42] = base >>> 0;
  return buf;
}
