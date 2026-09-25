export { bytesToHex, hexToBytes } from "@noble/hashes/utils";

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function u8(n: number): Uint8Array {
  return Uint8Array.from([n & 0xff]);
}

export function u32le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`u32 out of range: ${n}`);
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

export function i64le(n: bigint): Uint8Array {
  if (n < 0n || n > 0x7fffffffffffffffn) throw new Error(`i64 out of range: ${n}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

export function compactSize(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`compactSize out of range: ${n}`);
  if (n < 253) return Uint8Array.from([n]);
  if (n <= 0xffff) return concat(Uint8Array.from([253]), Uint8Array.from([n & 0xff, n >> 8]));
  return concat(Uint8Array.from([254]), u32le(n));
}

export function reversed(b: Uint8Array): Uint8Array {
  return Uint8Array.from(b).reverse();
}

/** Bytes padhne wala chhota reader (parser ke liye). Bounds check hamesha. */
export class Reader {
  pos = 0;
  constructor(public readonly buf: Uint8Array) {}
  take(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.buf.length) throw new Error("tx bytes khatam ho gaye (kharab data)");
    const s = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
  u32(): number {
    const b = this.take(4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  }
  i64(): bigint {
    const b = this.take(8);
    return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
  }
  compact(): number {
    const f = this.take(1)[0];
    if (f < 253) return f;
    if (f === 253) {
      const b = this.take(2);
      return b[0] | (b[1] << 8);
    }
    if (f === 254) return this.u32();
    throw new Error("compactSize bahut bada");
  }
  rest(): Uint8Array {
    return this.buf.subarray(this.pos);
  }
}
