/**
 * Image ki jaanch FILE KE BYTES dekhke (extension pe bharosa nahi).
 * Sirf PNG, JPEG, WebP, GIF. SVG jaan-bujh ke nahi (usme script chhup sakti hai).
 * Dimensions header se padhta hai, koi bahari library nahi.
 */
export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface ImageInfo {
  mime: ImageMime;
  width: number;
  height: number;
  ext: "png" | "jpg" | "webp" | "gif";
}

export const MAX_DIMENSION = 16_384;

const EXT: Record<ImageMime, ImageInfo["ext"]> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export function detectImage(b: Uint8Array): ImageInfo | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u8 = (i: number) => b[i];
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  let found: { mime: ImageMime; width: number; height: number } | null = null;

  // PNG
  if (b.length >= 24 && u8(0) === 0x89 && ascii(1, 3) === "PNG" && u8(4) === 0x0d && u8(5) === 0x0a && u8(6) === 0x1a && u8(7) === 0x0a) {
    if (dv.getUint32(8) === 13 && ascii(12, 4) === "IHDR") found = { mime: "image/png", width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  // GIF
  else if (b.length >= 10 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
    found = { mime: "image/gif", width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  // JPEG
  else if (b.length >= 4 && u8(0) === 0xff && u8(1) === 0xd8) {
    let p = 2;
    while (p + 4 <= b.length) {
      if (u8(p) !== 0xff) break;
      while (p < b.length && u8(p) === 0xff) p++; // fill bytes
      const m = u8(p);
      p++;
      if (m === 0xd9 || m === 0xda) break;
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // length nahi
      if (p + 2 > b.length) break;
      const len = dv.getUint16(p);
      if (len < 2) break;
      const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
      if (sof) {
        if (p + 7 > b.length) break;
        found = { mime: "image/jpeg", height: dv.getUint16(p + 3), width: dv.getUint16(p + 5) };
        break;
      }
      p += len;
    }
  }
  // WebP
  else if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8X") {
      found = { mime: "image/webp", width: 1 + (u8(24) | (u8(25) << 8) | (u8(26) << 16)), height: 1 + (u8(27) | (u8(28) << 8) | (u8(29) << 16)) };
    } else if (chunk === "VP8 " && u8(23) === 0x9d && u8(24) === 0x01 && u8(25) === 0x2a) {
      found = { mime: "image/webp", width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    } else if (chunk === "VP8L" && u8(20) === 0x2f) {
      found = {
        mime: "image/webp",
        width: 1 + (u8(21) | ((u8(22) & 0x3f) << 8)),
        height: 1 + ((u8(22) >> 6) | (u8(23) << 2) | ((u8(24) & 0x0f) << 10)),
      };
    }
  }

  if (!found) return null;
  if (found.width < 1 || found.height < 1 || found.width > MAX_DIMENSION || found.height > MAX_DIMENSION) return null;
  return { ...found, ext: EXT[found.mime] };
}
