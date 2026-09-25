import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { secp256k1 } from "@noble/curves/secp256k1";
import type { Network } from "../config.js";
import { formatZec } from "../money.js";
import type { PlanInput, PlanOutput, RefundPlanItem } from "../services/refunds.js";
import {
  accountXpubFromMnemonic,
  addressToScriptPubKey,
  derivePayPrivateKey,
  isAddressForNetwork,
  pubkeyToAddress,
} from "./address.js";
import { bytesToHex } from "./bytes.js";
import {
  p2pkhScript,
  hash160,
  parseTx,
  serializeTx,
  signAllInputs,
  txidDigest,
  txidDisplayToInternal,
  txidInternalToDisplay,
  verifySignedTx,
  type SpentOutput,
  type TxCommon,
  type TxIn,
  type TxOut,
} from "./tx.js";

export interface SignParams {
  network: Network;
  /** Node se lo (getblockchaininfo => consensus.chaintip). Galat hua to tx reject hogi. */
  branchId: number;
  /** Tip height + delta. Iske baad tx invalid ho jaati hai (stale tx se bachav). */
  expiryHeight: number;
  treasuryAddress?: string;
  maxFeeZats: bigint;
  maxInputs?: number;
}

export interface SignedRefund {
  refundId: number;
  orderId: string;
  txid: string;
  hex: string;
  feeZats: bigint;
}

const sum = (xs: { amountZats: bigint }[]) => xs.reduce((a, x) => a + x.amountZats, 0n);

// ---------------- plan file parse (strict) ----------------

function reqStr(o: any, k: string): string {
  if (typeof o?.[k] !== "string") throw new Error(`plan: '${k}' string hona chahiye`);
  return o[k];
}
function reqInt(o: any, k: string): number {
  if (!Number.isInteger(o?.[k]) || o[k] < 0) throw new Error(`plan: '${k}' non-negative integer hona chahiye`);
  return o[k];
}
function reqZats(o: any, k: string): bigint {
  const s = reqStr(o, k);
  if (!/^\d{1,18}$/.test(s)) throw new Error(`plan: '${k}' zats (digits) hona chahiye`);
  return BigInt(s);
}

export function parsePlanJson(text: string): RefundPlanItem[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("plan file valid JSON nahi hai");
  }
  if (!Array.isArray(data)) throw new Error("plan file ek array honi chahiye");
  return data.map((it: any): RefundPlanItem => {
    if (!Array.isArray(it?.inputs) || !Array.isArray(it?.outputs)) throw new Error("plan: inputs/outputs array chahiye");
    return {
      refundId: reqInt(it, "refundId"),
      orderId: reqStr(it, "orderId"),
      toAddress: reqStr(it, "toAddress"),
      grossZats: reqZats(it, "grossZats"),
      feeZats: reqZats(it, "feeZats"),
      inputs: it.inputs.map((x: any): PlanInput => ({
        txid: reqStr(x, "txid"),
        vout: reqInt(x, "vout"),
        amountZats: reqZats(x, "amountZats"),
        addressIndex: reqInt(x, "addressIndex"),
      })),
      outputs: it.outputs.map((x: any): PlanOutput => {
        const role = reqStr(x, "role");
        if (role !== "refund" && role !== "change") throw new Error(`plan: role '${role}' galat`);
        return { address: reqStr(x, "address"), amountZats: reqZats(x, "amountZats"), role };
      }),
    };
  });
}

// ---------------- safety checks ----------------

/**
 * Plan file par BHAROSA nahi karta. Har cheez dobara check hoti hai; kuch bhi ajeeb ho to THROW (sign nahi hota).
 */
export function validatePlan(item: RefundPlanItem, p: SignParams): void {
  const maxIn = p.maxInputs ?? 50;
  if (item.inputs.length < 1 || item.inputs.length > maxIn) throw new Error(`inputs ki ginti 1..${maxIn} honi chahiye`);
  const seen = new Set<string>();
  for (const i of item.inputs) {
    if (!/^[0-9a-f]{64}$/.test(i.txid)) throw new Error(`input txid galat: ${i.txid}`);
    if (i.amountZats <= 0n) throw new Error("input amount > 0 hona chahiye");
    if (i.addressIndex >= 0x80000000) throw new Error("addressIndex range se bahar");
    const key = `${i.txid}:${i.vout}`;
    if (seen.has(key)) throw new Error(`duplicate input ${key}`);
    seen.add(key);
  }
  const refunds = item.outputs.filter((o) => o.role === "refund");
  const changes = item.outputs.filter((o) => o.role === "change");
  if (refunds.length !== 1 || changes.length > 1 || item.outputs.length !== refunds.length + changes.length) {
    throw new Error("outputs: exactly 1 'refund' aur zyada se zyada 1 'change' hona chahiye");
  }
  for (const o of item.outputs) {
    if (o.amountZats <= 0n) throw new Error("output amount > 0 hona chahiye");
    if (!isAddressForNetwork(o.address, p.network)) throw new Error(`output address ${p.network} ka valid nahi: ${o.address}`);
  }
  if (refunds[0].address !== item.toAddress) throw new Error("refund output address plan ke toAddress se alag hai");
  if (refunds[0].amountZats > item.grossZats) throw new Error("buyer ko owed (gross) se zyada bhejna hai");
  if (changes.length === 1) {
    if (!p.treasuryAddress) throw new Error("change output hai lekin TREASURY_ADDRESS set nahi hai");
    if (changes[0].address !== p.treasuryAddress) {
      throw new Error(`change address TREASURY_ADDRESS se alag hai (${changes[0].address}) -- plan file tampered ho sakti hai`);
    }
  }
  if (item.feeZats > p.maxFeeZats) throw new Error(`fee ${item.feeZats} zats limit ${p.maxFeeZats} se zyada hai`);
  if (sum(item.inputs) !== sum(item.outputs) + item.feeZats) {
    throw new Error("BALANCE: inputs != outputs + fee. Sign nahi karunga.");
  }
}

export function assertMnemonicMatchesXpub(mnemonic: string, xpub: string): void {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error("mnemonic valid nahi hai (words ya checksum galat)");
  if (accountXpubFromMnemonic(mnemonic, 0) !== xpub) {
    throw new Error("Ye mnemonic WALLET_XPUB se match nahi karta. Galat wallet ka mnemonic hai -- rukiye.");
  }
}

// ---------------- sign ----------------

export function signRefund(item: RefundPlanItem, mnemonic: string, p: SignParams): SignedRefund {
  validatePlan(item, p);
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error("mnemonic valid nahi hai");
  mnemonicToSeedSync(mnemonic); // early failure

  const common: TxCommon = { branchId: p.branchId, lockTime: 0, expiryHeight: p.expiryHeight };

  const privKeys = item.inputs.map((i) => derivePayPrivateKey(mnemonic, i.addressIndex));
  const spent: SpentOutput[] = item.inputs.map((i, k) => ({
    amountZats: i.amountZats,
    scriptPubKey: p2pkhScript(hash160(secp256k1.getPublicKey(privKeys[k], true))),
  }));
  const ins: TxIn[] = item.inputs.map((i) => ({
    prevTxid: txidDisplayToInternal(i.txid),
    vout: i.vout,
    sequence: 0xffffffff,
    scriptSig: new Uint8Array(0),
  }));
  const outs: TxOut[] = item.outputs.map((o) => ({ valueZats: o.amountZats, scriptPubKey: addressToScriptPubKey(o.address, p.network) }));

  const signedIns = signAllInputs(common, ins, outs, spent, privKeys);
  const bytes = serializeTx(common, signedIns, outs);

  // ---- Independent re-check: signed bytes ko wapas parse karke sab kuch dobara dekho ----
  const v = verifySignedTx(bytes, spent);
  const expectedTxid = txidInternalToDisplay(txidDigest(common, ins, outs));
  if (v.txid !== expectedTxid) throw new Error("BUG: txid mismatch");
  if (v.feeZats !== item.feeZats) throw new Error("BUG: fee mismatch");
  if (v.branchId !== p.branchId || v.expiryHeight !== p.expiryHeight) throw new Error("BUG: branch/expiry mismatch");
  const back = parseTx(bytes);
  if (back.outs.length !== item.outputs.length) throw new Error("BUG: outputs ki ginti alag");
  back.outs.forEach((o, k) => {
    const want = item.outputs[k];
    if (o.valueZats !== want.amountZats || bytesToHex(o.scriptPubKey) !== bytesToHex(addressToScriptPubKey(want.address, p.network))) {
      throw new Error(`BUG: output #${k} plan se match nahi karta`);
    }
  });

  return { refundId: item.refundId, orderId: item.orderId, txid: v.txid, hex: bytesToHex(bytes), feeZats: item.feeZats };
}

/** Sign karne se pehle insaan ko dikhane wala summary */
export function summarizePlan(item: RefundPlanItem, mnemonic: string, network: Network): string[] {
  const lines = [`refund#${item.refundId}  order ${item.orderId.slice(0, 8)}`];
  for (const i of item.inputs) {
    const addr = pubkeyToAddress(secp256k1.getPublicKey(derivePayPrivateKey(mnemonic, i.addressIndex), true), network);
    lines.push(`   IN   ${formatZec(i.amountZats).padStart(12)} ZEC  from ${addr}  (${i.txid.slice(0, 10)}...:${i.vout})`);
  }
  for (const o of item.outputs) lines.push(`   OUT  ${formatZec(o.amountZats).padStart(12)} ZEC  ${o.role.padEnd(6)} -> ${o.address}`);
  lines.push(`   FEE  ${formatZec(item.feeZats).padStart(12)} ZEC`);
  return lines;
}
