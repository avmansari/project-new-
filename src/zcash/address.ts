import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import type { Network } from "../config.js";

/**
 * Zcash transparent address (t-address) derivation.
 *
 * - BIP44 path: m/44'/133'/account'/change/index   (133 = Zcash coin type)
 * - Address = base58check( 2-byte prefix || RIPEMD160(SHA256(compressedPubKey)) )
 * - Prefix: mainnet t1 = 0x1CB8, testnet tm = 0x1D25
 *
 * NOTE: Ye sirf TRANSPARENT addresses hain (shielded nahi). Transparent tx
 * public hote hain. Shielded support baad ke step mein aayega.
 */

const b58c = createBase58check(sha256);

const PREFIX: Record<Network, Uint8Array> = {
  mainnet: Uint8Array.from([0x1c, 0xb8]),
  testnet: Uint8Array.from([0x1d, 0x25]),
};

export const ZCASH_COIN_TYPE = 133;

export function newMnemonic(): string {
  return generateMnemonic(wordlist, 256); // 24 words
}

/** Account-level xpub nikalta hai (m/44'/133'/account'). Ye server pe rakh sakte ho, isse paisa spend nahi hota. */
export function accountXpubFromMnemonic(mnemonic: string, account = 0): string {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error("Invalid mnemonic");
  }
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const acct = root.derive(`m/44'/${ZCASH_COIN_TYPE}'/${account}'`);
  return acct.publicExtendedKey;
}

export function pubkeyToAddress(pubkey: Uint8Array, network: Network): string {
  const h160 = ripemd160(sha256(pubkey));
  const payload = new Uint8Array(PREFIX[network].length + h160.length);
  payload.set(PREFIX[network], 0);
  payload.set(h160, PREFIX[network].length);
  return b58c.encode(payload);
}

/** Sirf t1/tm (P2PKH) addresses. Baaki (P2SH, shielded) yahan supported nahi. Galat address pe THROW. */
export function addressToScriptPubKey(address: string, network: Network): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = b58c.decode(address);
  } catch {
    throw new Error(`address decode nahi hua: ${address}`);
  }
  const p = PREFIX[network];
  if (bytes.length !== 22 || bytes[0] !== p[0] || bytes[1] !== p[1]) {
    throw new Error(`${address} ${network} ka transparent P2PKH address nahi hai`);
  }
  const h160 = bytes.subarray(2);
  return Uint8Array.from([0x76, 0xa9, 0x14, ...h160, 0x88, 0xac]);
}

export function scriptPubKeyToAddress(script: Uint8Array, network: Network): string | null {
  const ok = script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 && script[23] === 0x88 && script[24] === 0xac;
  if (!ok) return null;
  const payload = new Uint8Array(22);
  payload.set(PREFIX[network], 0);
  payload.set(script.subarray(3, 23), 2);
  return b58c.encode(payload);
}

/** Mnemonic se index-th PAY address ki PRIVATE key (m/44'/133'/account'/0/index). Sirf offline signer use kare. */
export function derivePayPrivateKey(mnemonic: string, index: number, account = 0): Uint8Array {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error("Invalid mnemonic");
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new Error("index must be a non-hardened integer");
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(`m/44'/${ZCASH_COIN_TYPE}'/${account}'/0/${index}`);
  if (!node.privateKey) throw new Error("private key nahi nikli");
  return node.privateKey;
}

/** xpub se index-th receiving address (change=0 chain) nikalta hai. Private key ki zaroorat nahi. */
export function deriveReceiveAddress(xpub: string, index: number, network: Network): string {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error("index must be a non-hardened integer");
  }
  const node = HDKey.fromExtendedKey(xpub).deriveChild(0).deriveChild(index);
  if (!node.publicKey) throw new Error("No public key derived");
  return pubkeyToAddress(node.publicKey, network);
}

/** Address sahi network ka hai ya nahi (galti se testnet address mainnet pe use na ho). */
export function isAddressForNetwork(address: string, network: Network): boolean {
  try {
    const bytes = b58c.decode(address);
    const p = PREFIX[network];
    return bytes.length === 22 && bytes[0] === p[0] && bytes[1] === p[1];
  } catch {
    return false;
  }
}
