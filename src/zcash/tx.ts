import { blake2b } from "@noble/hashes/blake2b";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha256";
import { secp256k1 } from "@noble/curves/secp256k1";
import { compactSize, concat, i64le, Reader, reversed, u32le, u8 } from "./bytes.js";

/**
 * Zcash v5 transaction (ZIP 225) -- SIRF transparent inputs/outputs, koi shielded bundle nahi.
 * Digests/signature: ZIP 244. Official test vectors se verify kiya gaya hai (test/zip244.test.ts).
 */

export const TX_HEADER_V5 = 0x80000005; // version 5 | overwintered flag
export const VERSION_GROUP_ID_V5 = 0x26a7270a;
/** v6 (ZIP 229, NU6.3 / Ironwood). Hum v6 sirf PADHTE hain (payments dekhne ke liye); apni tx v5 hi banate hain. */
export const TX_HEADER_V6 = 0x80000006;
export const VERSION_GROUP_ID_V6 = 0xd884b698;
export const SIGHASH_ALL = 0x01;

const enc = new TextEncoder();

/** BLAKE2b-256 with 16-byte personalization */
export function H(personal: string | Uint8Array, data: Uint8Array): Uint8Array {
  const p = typeof personal === "string" ? enc.encode(personal) : personal;
  if (p.length !== 16) throw new Error("personalization exactly 16 bytes honi chahiye");
  return blake2b(data, { dkLen: 32, personalization: p });
}

export interface TxCommon {
  /** Current network upgrade ka consensus branch id. Galat hua to tx reject hogi (paisa safe rehta hai). */
  branchId: number;
  lockTime: number;
  expiryHeight: number;
}

export interface TxIn {
  /** Serialization wala byte order (display txid ka ULTA) */
  prevTxid: Uint8Array;
  vout: number;
  sequence: number;
  scriptSig: Uint8Array;
}

export interface TxOut {
  valueZats: bigint;
  scriptPubKey: Uint8Array;
}

export interface SpentOutput {
  amountZats: bigint;
  scriptPubKey: Uint8Array;
}

export interface ShieldedDigests {
  sapling: Uint8Array;
  orchard: Uint8Array;
}

export const EMPTY_SAPLING_DIGEST = H("ZTxIdSaplingHash", new Uint8Array(0));
export const EMPTY_ORCHARD_DIGEST = H("ZTxIdOrchardHash", new Uint8Array(0));
const EMPTY_SHIELDED: ShieldedDigests = { sapling: EMPTY_SAPLING_DIGEST, orchard: EMPTY_ORCHARD_DIGEST };

export function txidDisplayToInternal(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("txid 64 hex chars ka hona chahiye");
  return reversed(Uint8Array.from(Buffer.from(hex, "hex")));
}
export function txidInternalToDisplay(b: Uint8Array): string {
  return Buffer.from(reversed(b)).toString("hex");
}

// ---------------- digests (ZIP 244) ----------------

export function headerDigest(c: TxCommon, version: 5 | 6 = 5): Uint8Array {
  const header = version === 6 ? TX_HEADER_V6 : TX_HEADER_V5;
  const vgid = version === 6 ? VERSION_GROUP_ID_V6 : VERSION_GROUP_ID_V5;
  return H("ZTxIdHeadersHash", concat(u32le(header), u32le(vgid), u32le(c.branchId), u32le(c.lockTime), u32le(c.expiryHeight)));
}

const prevouts = (ins: TxIn[]) => concat(...ins.map((i) => concat(i.prevTxid, u32le(i.vout))));
const prevoutsDigest = (ins: TxIn[]) => H("ZTxIdPrevoutHash", prevouts(ins));
const sequenceDigest = (ins: TxIn[]) => H("ZTxIdSequencHash", concat(...ins.map((i) => u32le(i.sequence))));
const outputsDigest = (outs: TxOut[]) =>
  H("ZTxIdOutputsHash", concat(...outs.map((o) => concat(i64le(o.valueZats), compactSize(o.scriptPubKey.length), o.scriptPubKey))));

export function transparentTxidDigest(ins: TxIn[], outs: TxOut[]): Uint8Array {
  if (ins.length === 0 && outs.length === 0) return H("ZTxIdTranspaHash", new Uint8Array(0));
  return H("ZTxIdTranspaHash", concat(prevoutsDigest(ins), sequenceDigest(ins), outputsDigest(outs)));
}

function txHashPersonal(branchId: number): Uint8Array {
  return concat(enc.encode("ZcashTxHash_"), u32le(branchId));
}

/** v5 txid digest. Signatures isme shamil NAHI hain, isliye sign karne se txid nahi badalta. */
export function txidDigest(c: TxCommon, ins: TxIn[], outs: TxOut[], sh: ShieldedDigests = EMPTY_SHIELDED): Uint8Array {
  return H(txHashPersonal(c.branchId), concat(headerDigest(c), transparentTxidDigest(ins, outs), sh.sapling, sh.orchard));
}

export interface ShieldedDigestsV6 extends ShieldedDigests {
  ironwood: Uint8Array;
}

/**
 * v6 txid digest (ZIP 229): v5 jaisa, bas Ironwood digest aakhir mein jodta hai, aur anchors effecting data se hat gaye.
 * NOTE: ZIP 229 abhi Draft hai aur iske official test vectors nahi hain. Isliye is txid ko hamesha server se
 * cross-verify kiya jaata hai (src/chain/lightwalletd.ts).
 */
export function txidDigestV6(c: TxCommon, ins: TxIn[], outs: TxOut[], sh: ShieldedDigestsV6): Uint8Array {
  return H(txHashPersonal(c.branchId), concat(headerDigest(c, 6), transparentTxidDigest(ins, outs), sh.sapling, sh.orchard, sh.ironwood));
}

/** SIGHASH_ALL signature digest, input `index` ke liye. `spent[i]` = i-th input ka (amount, scriptPubKey). */
export function sigHashAll(
  c: TxCommon,
  ins: TxIn[],
  outs: TxOut[],
  index: number,
  spent: SpentOutput[],
  sh: ShieldedDigests = EMPTY_SHIELDED
): Uint8Array {
  if (spent.length !== ins.length) throw new Error("spent outputs ki ginti inputs se match honi chahiye");
  if (index < 0 || index >= ins.length) throw new Error("input index out of range");
  const amounts = H("ZTxTrAmountsHash", concat(...spent.map((s) => i64le(s.amountZats))));
  const scripts = H("ZTxTrScriptsHash", concat(...spent.map((s) => concat(compactSize(s.scriptPubKey.length), s.scriptPubKey))));
  const inp = ins[index];
  const txin = H(
    "Zcash___TxInHash",
    concat(inp.prevTxid, u32le(inp.vout), i64le(spent[index].amountZats), compactSize(spent[index].scriptPubKey.length), spent[index].scriptPubKey, u32le(inp.sequence))
  );
  const transparent = H(
    "ZTxIdTranspaHash",
    concat(u8(SIGHASH_ALL), prevoutsDigest(ins), amounts, scripts, sequenceDigest(ins), outputsDigest(outs), txin)
  );
  return H(txHashPersonal(c.branchId), concat(headerDigest(c), transparent, sh.sapling, sh.orchard));
}

// ---------------- serialize / parse ----------------

export function serializeTx(c: TxCommon, ins: TxIn[], outs: TxOut[]): Uint8Array {
  return concat(
    u32le(TX_HEADER_V5),
    u32le(VERSION_GROUP_ID_V5),
    u32le(c.branchId),
    u32le(c.lockTime),
    u32le(c.expiryHeight),
    compactSize(ins.length),
    ...ins.map((i) => concat(i.prevTxid, u32le(i.vout), compactSize(i.scriptSig.length), i.scriptSig, u32le(i.sequence))),
    compactSize(outs.length),
    ...outs.map((o) => concat(i64le(o.valueZats), compactSize(o.scriptPubKey.length), o.scriptPubKey)),
    u8(0), // sapling spends = 0
    u8(0), // sapling outputs = 0
    u8(0) //  orchard actions = 0
  );
}

export interface ParsedTx extends TxCommon {
  ins: TxIn[];
  outs: TxOut[];
  /** Transparent bundle ke BAAD ke bytes (sapling + orchard). Hamari tx mein exactly [0,0,0]. */
  rest: Uint8Array;
}

export function parseTx(bytes: Uint8Array, version: 5 | 6 = 5): ParsedTx {
  const r = new Reader(bytes);
  if (r.u32() !== (version === 6 ? TX_HEADER_V6 : TX_HEADER_V5)) throw new Error(`v${version} transaction nahi hai (header)`);
  if (r.u32() !== (version === 6 ? VERSION_GROUP_ID_V6 : VERSION_GROUP_ID_V5)) throw new Error("version group id galat");
  const branchId = r.u32();
  const lockTime = r.u32();
  const expiryHeight = r.u32();
  const nIn = r.compact();
  const ins: TxIn[] = [];
  for (let i = 0; i < nIn; i++) {
    const prevTxid = Uint8Array.from(r.take(32));
    const vout = r.u32();
    const scriptSig = Uint8Array.from(r.take(r.compact()));
    const sequence = r.u32();
    ins.push({ prevTxid, vout, sequence, scriptSig });
  }
  const nOut = r.compact();
  const outs: TxOut[] = [];
  for (let i = 0; i < nOut; i++) {
    const valueZats = r.i64();
    const scriptPubKey = Uint8Array.from(r.take(r.compact()));
    outs.push({ valueZats, scriptPubKey });
  }
  return { branchId, lockTime, expiryHeight, ins, outs, rest: Uint8Array.from(r.rest()) };
}

// ---------------- scripts ----------------

export const hash160 = (b: Uint8Array) => ripemd160(sha256(b));

/** OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG */
export function p2pkhScript(h160: Uint8Array): Uint8Array {
  if (h160.length !== 20) throw new Error("hash160 20 bytes ka hona chahiye");
  return concat(Uint8Array.from([0x76, 0xa9, 0x14]), h160, Uint8Array.from([0x88, 0xac]));
}

/** scriptPubKey p2pkh ho to uska hash160 deta hai, warna null */
export function p2pkhHash(script: Uint8Array): Uint8Array | null {
  const ok =
    script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 && script[23] === 0x88 && script[24] === 0xac;
  return ok ? script.subarray(3, 23) : null;
}

// ---------------- sign / verify ----------------

/**
 * Saare inputs SIGHASH_ALL se sign karta hai (P2PKH). `privKeys[i]` = i-th input ki key.
 * Har signature bana ke turant verify bhi hota hai. Low-S, deterministic (RFC 6979).
 */
export function signAllInputs(
  c: TxCommon,
  ins: TxIn[],
  outs: TxOut[],
  spent: SpentOutput[],
  privKeys: Uint8Array[]
): TxIn[] {
  if (privKeys.length !== ins.length) throw new Error("har input ke liye ek key chahiye");
  const unsigned = ins.map((i) => ({ ...i, scriptSig: new Uint8Array(0) }));
  return unsigned.map((inp, idx) => {
    const pub = secp256k1.getPublicKey(privKeys[idx], true);
    const want = p2pkhHash(spent[idx].scriptPubKey);
    if (!want || Buffer.compare(Buffer.from(hash160(pub)), Buffer.from(want)) !== 0) {
      throw new Error(`input #${idx}: key is scriptPubKey se match nahi karti (galat mnemonic/index?)`);
    }
    const digest = sigHashAll(c, unsigned, outs, idx, spent);
    const derSig = secp256k1.sign(digest, privKeys[idx], { lowS: true }).toDERRawBytes();
    if (!secp256k1.verify(derSig, digest, pub)) throw new Error(`input #${idx}: signature verify nahi hua`);
    const der = concat(derSig, u8(SIGHASH_ALL));
    return { ...inp, scriptSig: concat(u8(der.length), der, u8(pub.length), pub) };
  });
}

export interface VerifiedTx {
  txid: string;
  branchId: number;
  expiryHeight: number;
  ins: { prevTxid: string; vout: number; amountZats: bigint }[];
  outs: TxOut[];
  feeZats: bigint;
}

/**
 * Signed tx ko INDEPENDENTLY check karta hai (signing code ka istemal kiye bina, sirf parse + digest):
 * har input ki signature valid hai, pubkey scriptPubKey se match, koi shielded hissa nahi, paisa balance.
 */
export function verifySignedTx(bytes: Uint8Array, spent: SpentOutput[]): VerifiedTx {
  const t = parseTx(bytes);
  if (t.rest.length !== 3 || t.rest[0] !== 0 || t.rest[1] !== 0 || t.rest[2] !== 0) {
    throw new Error("shielded bundles maujood hain, ye tool sirf transparent tx samajhta hai");
  }
  if (spent.length !== t.ins.length) throw new Error("spent outputs ki ginti inputs se match nahi karti");
  const unsigned = t.ins.map((i) => ({ ...i, scriptSig: new Uint8Array(0) }));
  t.ins.forEach((inp, idx) => {
    const s = inp.scriptSig;
    const sigLen = s[0];
    const sigPlus = s.subarray(1, 1 + sigLen);
    const pubLen = s[1 + sigLen];
    const pub = s.subarray(2 + sigLen, 2 + sigLen + pubLen);
    if (s.length !== 2 + sigLen + pubLen || pubLen !== 33) throw new Error(`input #${idx}: scriptSig ka format galat`);
    if (sigPlus[sigPlus.length - 1] !== SIGHASH_ALL) throw new Error(`input #${idx}: sighash type SIGHASH_ALL nahi hai`);
    const want = p2pkhHash(spent[idx].scriptPubKey);
    if (!want || Buffer.compare(Buffer.from(hash160(pub)), Buffer.from(want)) !== 0) {
      throw new Error(`input #${idx}: pubkey scriptPubKey se match nahi karti`);
    }
    const digest = sigHashAll(t, unsigned, t.outs, idx, spent);
    const derSig = sigPlus.subarray(0, sigPlus.length - 1);
    if (secp256k1.Signature.fromDER(derSig).hasHighS()) throw new Error(`input #${idx}: high-S signature (non-standard)`);
    if (!secp256k1.verify(derSig, digest, pub)) throw new Error(`input #${idx}: signature INVALID`);
  });
  const inTotal = spent.reduce((a, s) => a + s.amountZats, 0n);
  const outTotal = t.outs.reduce((a, o) => a + o.valueZats, 0n);
  if (outTotal > inTotal) throw new Error("outputs inputs se zyada hain");
  return {
    txid: txidInternalToDisplay(txidDigest(t, unsigned, t.outs)),
    branchId: t.branchId,
    expiryHeight: t.expiryHeight,
    ins: t.ins.map((i, k) => ({ prevTxid: txidInternalToDisplay(i.prevTxid), vout: i.vout, amountZats: spent[k].amountZats })),
    outs: t.outs,
    feeZats: inTotal - outTotal,
  };
}
