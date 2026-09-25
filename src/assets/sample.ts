import { deflateSync } from "node:zlib";

/** Chhota PNG encoder (koi library nahi): sample images banane aur tests ke liye. */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of buf) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** i-th sample art: gradient + gol + patti. Har i alag rang/shape (deterministic). */
export function sampleArt(i: number, size = 400): Buffer {
  const hue = (i * 47) % 360;
  const cx = size / 2 + ((i * 37) % 60) - 30;
  const cy = size / 2 + ((i * 53) % 60) - 30;
  const r = size * (0.22 + ((i * 7) % 10) / 60);
  const stripes = 3 + (i % 5);
  return encodePng(size, size, (x, y) => {
    const dx = x - cx, dy = y - cy;
    if (dx * dx + dy * dy < r * r) return hsl((hue + 180) % 360, 0.75, 0.55);
    if (y > size * 0.78) return Math.floor((x / size) * stripes * 2) % 2 ? hsl((hue + 60) % 360, 0.6, 0.35) : hsl((hue + 120) % 360, 0.6, 0.6);
    return hsl(hue, 0.65, 0.25 + 0.35 * (y / size));
  });
}
