import { test } from "node:test";
import assert from "node:assert/strict";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import {
  accountXpubFromMnemonic,
  deriveReceiveAddress,
  isAddressForNetwork,
  newMnemonic,
} from "../src/zcash/address.js";
import { loadConfig } from "../src/config.js";

// Public test mnemonic (kabhi real funds mat bhejna isme)
const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("mainnet address t1 se shuru hota hai, length 35", () => {
  const xpub = accountXpubFromMnemonic(M);
  const a = deriveReceiveAddress(xpub, 0, "mainnet");
  assert.ok(a.startsWith("t1"), a);
  assert.equal(a.length, 35);
  assert.ok(isAddressForNetwork(a, "mainnet"));
  assert.ok(!isAddressForNetwork(a, "testnet"));
});

test("testnet address tm se shuru hota hai", () => {
  const xpub = accountXpubFromMnemonic(M);
  const a = deriveReceiveAddress(xpub, 0, "testnet");
  assert.ok(a.startsWith("tm"), a);
  assert.ok(isAddressForNetwork(a, "testnet"));
});

test("deterministic + har index alag", () => {
  const xpub = accountXpubFromMnemonic(M);
  const set = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const a = deriveReceiveAddress(xpub, i, "mainnet");
    assert.equal(a, deriveReceiveAddress(xpub, i, "mainnet"));
    set.add(a);
  }
  assert.equal(set.size, 50);
});

test("xpub path aur seed se seedha private path ek hi public key dete hain", () => {
  const xpub = accountXpubFromMnemonic(M);
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(M));
  const viaPrivate = root.derive("m/44'/133'/0'/0/7");
  const viaXpub = HDKey.fromExtendedKey(xpub).deriveChild(0).deriveChild(7);
  assert.deepEqual(viaPrivate.publicKey, viaXpub.publicKey);
});

test("naya mnemonic 24 words ka", () => {
  assert.equal(newMnemonic().split(" ").length, 24);
});

test("invalid index reject hota hai", () => {
  const xpub = accountXpubFromMnemonic(M);
  assert.throws(() => deriveReceiveAddress(xpub, -1, "mainnet"));
  assert.throws(() => deriveReceiveAddress(xpub, 1.5, "mainnet"));
});

test("mainnet bina CONFIRM_MAINNET=yes ke start nahi hota", () => {
  assert.throws(() => loadConfig({ NETWORK: "mainnet", WALLET_XPUB: "x" } as any), /CONFIRM_MAINNET/);
  const ok = loadConfig({ NETWORK: "mainnet", CONFIRM_MAINNET: "yes", WALLET_XPUB: "x" } as any);
  assert.equal(ok.network, "mainnet");
});

test("default network testnet hai", () => {
  assert.equal(loadConfig({ WALLET_XPUB: "x" } as any).network, "testnet");
});
