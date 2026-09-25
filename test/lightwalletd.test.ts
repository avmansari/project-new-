import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as grpc from "@grpc/grpc-js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createChain, createLightwalletd, resolveLwdUrl } from "../src/chain/index.js";
import { lightwalletdService, LightwalletdChain, parseServerUrl } from "../src/chain/lightwalletd.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { parseZec } from "../src/money.js";
import { createCollection } from "../src/services/collections.js";
import { mintPaidOrders } from "../src/services/mint.js";
import { createOrder, getOrder } from "../src/services/orders.js";
import { scanOnce } from "../src/watcher/scan.js";
import { accountXpubFromMnemonic, addressToScriptPubKey, deriveReceiveAddress } from "../src/zcash/address.js";
import { bytesToHex, compactSize, concat, hexToBytes, i64le, u32le } from "../src/zcash/bytes.js";
import { decodeRawTx } from "../src/zcash/rawtx.js";
import { shieldedDigestsFromRest } from "../src/zcash/shielded-digests.js";
import { TX_HEADER_V6, VERSION_GROUP_ID_V6 } from "../src/zcash/tx.js";
import { parseTx, serializeTx, txidDigest, txidInternalToDisplay, type TxIn, type TxOut } from "../src/zcash/tx.js";

const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const xpub = accountXpubFromMnemonic(M);
const A = deriveReceiveAddress(xpub, 10, "testnet");
const OTHER = deriveReceiveAddress(xpub, 11, "testnet");
const common = { branchId: 0xc8e71055, lockTime: 0, expiryHeight: 3_000_000 };
const prev = (n: string): Uint8Array => Uint8Array.from(createHash("sha256").update(n).digest());
const mkIn = (n: string): TxIn => ({ prevTxid: prev(n), vout: 0, sequence: 0xffffffff, scriptSig: hexToBytes("00") });
const out = (addr: string, zec: string): TxOut => ({ valueZats: parseZec(zec), scriptPubKey: addressToScriptPubKey(addr, "testnet") });

/** transparent-only v5 tx + uska sahi txid */
function v5(outs: TxOut[], seed = "a") {
  const ins = [mkIn(seed)];
  const bytes = serializeTx(common, ins, outs);
  const unsigned = ins.map((i) => ({ ...i, scriptSig: new Uint8Array(0) }));
  return { bytes, txid: txidInternalToDisplay(txidDigest(common, unsigned, outs)) };
}
/** v4 (Sapling) tx, txid = reversed sha256d, alag se calculate */
function v4(outs: TxOut[]) {
  const bytes = concat(
    u32le(0x80000004), u32le(0x892f2085),
    compactSize(1), prev("v4"), u32le(0), compactSize(0), u32le(0xffffffff),
    compactSize(outs.length), ...outs.map((o) => concat(i64le(o.valueZats), compactSize(o.scriptPubKey.length), o.scriptPubKey)),
    u32le(0), u32le(0), i64le(0n), compactSize(0), compactSize(0), compactSize(0)
  );
  const h = createHash("sha256").update(createHash("sha256").update(bytes).digest()).digest();
  return { bytes, txid: Buffer.from(h).reverse().toString("hex") };
}

// ---------- official vectors: production decodeRawTx ----------
const vectors = (JSON.parse(readFileSync(new URL("./vectors/zip_0244.json", import.meta.url), "utf8")) as any[]).slice(2);
vectors.forEach((v, k) => {
  test(`decodeRawTx: official vector #${k} ka txid (reversed display) match`, () => {
    const d = decodeRawTx(hexToBytes(v[0]));
    assert.equal(d.txid, Buffer.from(hexToBytes(v[1])).reverse().toString("hex"));
    assert.equal(d.version, 5);
  });
});

test("decodeRawTx: v4 aur v5 (transparent) sahi; v3 / chhoti tx reject", () => {
  const a = v5([out(A, "0.5"), out(OTHER, "0.1")]);
  const d = decodeRawTx(a.bytes);
  assert.equal(d.txid, a.txid);
  assert.equal(d.outputs.length, 2);
  assert.equal(d.outputs[0].vout, 0);
  const b = v4([out(A, "0.25")]);
  const d4 = decodeRawTx(b.bytes);
  assert.equal(d4.txid, b.txid);
  assert.equal(d4.version, 4);
  assert.equal(d4.outputs[0].valueZats, parseZec("0.25"));
  assert.throws(() => decodeRawTx(concat(u32le(0x80000003), new Uint8Array(20))), /unsupported/);
  assert.throws(() => decodeRawTx(new Uint8Array(3)), /chhoti/);
});

// ---------- mock lightwalletd server ----------
interface Mock {
  tip: number;
  chain: string;
  taddr: boolean;
  estimated: number;
  txs: Map<string, { data: Uint8Array; height: number | string }[]>;
  fail: boolean;
  sendCode: number;
  sendMsg: string | null; // null => txid echo
  lastSent?: Buffer;
  lastRange?: { start: number; end: number };
  /** Server ki "sachai": display txid -> tx bytes. GetTransaction sirf inhe jaanta hai. */
  truth: Map<string, Uint8Array>;
  hashOrder: "internal" | "display";
  truthHeights: Map<string, string>;
  txCalls: number;
  txFailCode: number | null;
}
const mock: Mock = {
  tip: 1000, chain: "test", taddr: true, estimated: 1000, txs: new Map(), fail: false, sendCode: 0, sendMsg: null,
  truth: new Map(), hashOrder: "internal", truthHeights: new Map(), txCalls: 0, txFailCode: null,
};

const server = new grpc.Server();
server.addService(lightwalletdService().service, {
  GetLightdInfo: (_c: any, cb: any) =>
    mock.fail
      ? cb({ code: grpc.status.UNAVAILABLE, message: "down" })
      : cb(null, { chainName: mock.chain, taddrSupport: mock.taddr, blockHeight: String(mock.tip), estimatedHeight: String(mock.estimated), consensusBranchId: "c8e71055", vendor: "mock", version: "0" }),
  GetLatestBlock: (_c: any, cb: any) => (mock.fail ? cb({ code: grpc.status.UNAVAILABLE, message: "down" }) : cb(null, { height: String(mock.tip) })),
  GetTaddressTxids: (call: any) => {
    if (mock.fail) return call.emit("error", { code: grpc.status.INTERNAL, details: "boom" });
    const r = call.request;
    mock.lastRange = { start: Number(r.range.start.height), end: Number(r.range.end.height) };
    for (const t of mock.txs.get(r.address) ?? []) call.write({ data: Buffer.from(t.data), height: String(t.height) });
    call.end();
  },
  GetTransaction: (call: any, cb: any) => {
    mock.txCalls++;
    if (mock.txFailCode !== null) return cb({ code: mock.txFailCode, message: "tx lookup failed" });
    const asked = Buffer.from(call.request.hash);
    for (const [displayTxid, data] of mock.truth) {
      const display = Buffer.from(displayTxid, "hex");
      const want = mock.hashOrder === "internal" ? Buffer.from(display).reverse() : display;
      if (asked.equals(want)) return cb(null, { data: Buffer.from(data), height: mock.truthHeights.get(displayTxid) ?? "5" });
    }
    cb({ code: grpc.status.UNKNOWN, message: "-5: No such mempool or blockchain transaction" });
  },
  SendTransaction: (call: any, cb: any) => {
    mock.lastSent = Buffer.from(call.request.data);
    if (mock.sendCode !== 0) return cb(null, { errorCode: mock.sendCode, errorMessage: mock.sendMsg ?? "rejected" });
    const txid = decodeRawTx(Uint8Array.from(mock.lastSent)).txid;
    cb(null, { errorCode: 0, errorMessage: mock.sendMsg ?? `"${txid}"` });
  },
});
const port: number = await new Promise((res, rej) => server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
const client = (over: Partial<ConstructorParameters<typeof LightwalletdChain>[0]> = {}) =>
  new LightwalletdChain({ url: `http://127.0.0.1:${port}`, network: "testnet", lookbackBlocks: 500, timeoutMs: 3000, ...over });
const reset = () => {
  Object.assign(mock, {
    tip: 1000, chain: "test", taddr: true, estimated: 1000, txs: new Map(), fail: false, sendCode: 0, sendMsg: null,
    lastSent: undefined, truth: new Map(), hashOrder: "internal", truthHeights: new Map(), txCalls: 0, txFailCode: null,
  });
};
after(() => server.forceShutdown());

test("URL parse: https default 443, http default 9067, galat reject", () => {
  assert.deepEqual(parseServerUrl("https://testnet.zec.rocks"), { target: "testnet.zec.rocks:443", secure: true });
  assert.deepEqual(parseServerUrl("https://x.io:8443/"), { target: "x.io:8443", secure: true });
  assert.deepEqual(parseServerUrl("http://127.0.0.1"), { target: "127.0.0.1:9067", secure: false });
  assert.throws(() => parseServerUrl("zec.rocks:443"), /LWD_URL/);
});

test("info + assertReady: sahi server pass; galat chain / taddr nahi / sync nahi => throw", async () => {
  reset();
  const c = client();
  const i = await c.assertReady();
  assert.equal(i.branchId, 0xc8e71055);
  assert.equal(i.blockHeight, 1000);
  mock.chain = "main";
  await assert.rejects(c.assertReady(), /NETWORK=testnet/);
  reset(); mock.taddr = false;
  await assert.rejects(c.assertReady(), /transparent/);
  reset(); mock.estimated = 1500;
  await assert.rejects(c.assertReady(), /sync/);
  c.close();
});

test("getReceived: amounts, vout, confirmations (tip-height+1), dusre address ke outputs nahi, range sahi", async () => {
  reset();
  const t1 = v5([out(A, "0.5"), out(OTHER, "0.1")], "x1");
  const t2 = v5([out(OTHER, "0.2"), out(A, "0.001"), out(A, "0.002")], "x2"); // ek tx mein 2 outputs hamare
  mock.txs.set(A, [{ data: t1.bytes, height: 990 }, { data: t2.bytes, height: 1000 }]);
  const c = client();
  const r = await c.getReceived(A);
  assert.deepEqual(mock.lastRange, { start: 500, end: 1000 });
  const byKey = new Map(r.map((o) => [`${o.txid}:${o.vout}`, o]));
  assert.equal(r.length, 3);
  assert.equal(byKey.get(`${t1.txid}:0`)!.amountZats, parseZec("0.5"));
  assert.equal(byKey.get(`${t1.txid}:0`)!.confirmations, 11); // 1000-990+1
  assert.equal(byKey.get(`${t2.txid}:1`)!.amountZats, parseZec("0.001"));
  assert.equal(byKey.get(`${t2.txid}:1`)!.confirmations, 1);
  assert.equal(byKey.get(`${t2.txid}:2`)!.amountZats, parseZec("0.002"));
  assert.ok(![...byKey.keys()].some((k) => k === `${t1.txid}:1`)); // OTHER wala output nahi
  c.close();
});

test("getReceived: shielded hisse wali v5 tx (Noir deshielding jaisi) + v4 dono sahi", async () => {
  reset();
  // asli vector ki shielded bundles + hamara transparent output
  const vec = parseTx(hexToBytes(vectors[1][0] as string));
  const outs = [out(A, "0.001")];
  const base = serializeTx({ branchId: vec.branchId, lockTime: vec.lockTime, expiryHeight: vec.expiryHeight }, vec.ins, outs);
  const bytes = concat(base.subarray(0, base.length - 3), vec.rest);
  const unsigned = vec.ins.map((i) => ({ ...i, scriptSig: new Uint8Array(0) }));
  const wantTxid = txidInternalToDisplay(txidDigest(vec, unsigned, outs, shieldedDigestsFromRest(vec.rest)));
  const legacy = v4([out(A, "0.003")]);
  mock.txs.set(A, [{ data: bytes, height: 995 }, { data: legacy.bytes, height: 998 }]);
  mock.truth.set(legacy.txid, legacy.bytes); // v4 ko server se verify karte hain (official vector nahi)
  const c = client();
  const r = await c.getReceived(A);
  assert.equal(r.length, 2);
  assert.equal(r.find((o) => o.txid === wantTxid)!.amountZats, parseZec("0.001"));
  assert.equal(r.find((o) => o.txid === legacy.txid)!.amountZats, parseZec("0.003"));
  c.close();
});

test("getReceived: mempool (height 0) => 0 conf; fork (u64 max) => ignore; duplicate tx ek hi baar", async () => {
  reset();
  const m = v5([out(A, "0.01")], "m");
  const f = v5([out(A, "0.02")], "f");
  mock.txs.set(A, [
    { data: m.bytes, height: 0 },
    { data: m.bytes, height: 0 },
    { data: f.bytes, height: "18446744073709551615" }, // u64 max = fork sentinel
  ]);
  const c = client();
  const r = await c.getReceived(A);
  assert.equal(r.filter((o) => o.txid === f.txid).length, 0); // fork wali tx ignore
  assert.equal(r.filter((o) => o.txid === m.txid).length, 1);
  assert.equal(r.find((o) => o.txid === m.txid)!.confirmations, 0);
  c.close();
});

test("ERROR pe THROW (khaali list kabhi nahi): server down, stream error, unsupported tx", async () => {
  reset();
  const c = client();
  mock.fail = true;
  await assert.rejects(c.getReceived(A));
  await assert.rejects(c.info());
  reset();
  mock.txs.set(A, [{ data: concat(u32le(0x80000003), new Uint8Array(30)), height: 990 }]);
  await assert.rejects(c.getReceived(A), /unsupported/);
  await assert.rejects(c.getReceived("garbage-address"));
  c.close();
});

test("broadcast: txid wapas; quoted echo theek; error code / txid mismatch => throw", async () => {
  reset();
  const c = client();
  const t = v5([out(A, "0.5")], "b");
  assert.equal(await c.broadcast(bytesToHex(t.bytes)), t.txid);
  assert.equal(bytesToHex(mock.lastSent!), bytesToHex(t.bytes));
  mock.sendCode = -26; mock.sendMsg = "bad-txns-inputs-missingorspent";
  await assert.rejects(c.broadcast(bytesToHex(t.bytes)), /bad-txns-inputs-missingorspent/);
  reset(); mock.sendMsg = "f".repeat(64);
  await assert.rejects(c.broadcast(bytesToHex(t.bytes)), /alag txid/);
  await assert.rejects(c.broadcast("zz"), /hex/);
  c.close();
});

test("factory: mainnet ko URL zaroori; file chain mainnet block; testnet default public", () => {
  assert.throws(() => resolveLwdUrl("mainnet"), /LWD_URL/);
  assert.equal(resolveLwdUrl("testnet"), "https://testnet.zec.rocks:443");
  assert.equal(resolveLwdUrl("mainnet", "https://mine:9067"), "https://mine:9067");
  assert.throws(() => createChain({ network: "mainnet", chainBackend: "file", fakeChainFile: "x" }), /mainnet/);
  assert.throws(() => createChain({ network: "mainnet", chainBackend: "lightwalletd", fakeChainFile: "x" }), /LWD_URL/);
  const c = createLightwalletd({ network: "testnet" });
  assert.ok(c instanceof LightwalletdChain);
  c.close();
  assert.equal(loadConfig({ WALLET_XPUB: "x", CHAIN_BACKEND: "lightwalletd" } as any).chainBackend, "lightwalletd");
});

test("END-TO-END: asli-jaisa (mock) server se order -> payment -> paid -> mint", async () => {
  reset();
  const db = await openDb();
  await createCollection(db, { slug: "demo", name: "Demo", supply: 2, priceZats: parseZec("0.001"), maxPerWallet: 2 });
  const o = await createOrder(db, { network: "testnet", walletXpub: xpub, orderTtlMinutes: 30 }, {
    collectionSlug: "demo", quantity: 1, buyerAddress: A,
  });
  const c = client();
  const pay = v5([out(o.payAddress, "0.001")], "e2e");
  mock.txs.set(o.payAddress, [{ data: pay.bytes, height: 995 }]);
  mock.tip = 996; // 2 confirmations
  await scanOnce(db, c, { minConfirmations: 10, lateGraceHours: 168 });
  let x = (await getOrder(db, o.id))!;
  assert.equal(x.status, "pending");
  assert.equal(x.funded, true);
  mock.tip = 1004; // 10 confirmations
  await scanOnce(db, c, { minConfirmations: 10, lateGraceHours: 168 });
  x = (await getOrder(db, o.id))!;
  assert.equal(x.status, "paid");
  assert.equal(x.receivedZats, parseZec("0.001"));
  const m = await mintPaidOrders(db);
  assert.equal(m[0].outcome, "minted");
  // server down => order ki state nahi badalti
  mock.fail = true;
  const s = await scanOnce(db, c, { minConfirmations: 10, lateGraceHours: 168 });
  assert.equal(s.errors, 1);
  assert.equal((await getOrder(db, o.id))!.status, "minted");
  c.close();
});


// ======================= v6 (ZIP 229) =======================
const rnd = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
function orchardLike(nActions: number): Uint8Array {
  if (nActions === 0) return compactSize(0);
  return concat(
    compactSize(nActions),
    ...Array.from({ length: nActions }, (_, i) => rnd(820, 10 + i)),
    Uint8Array.from([0x03]), // flags
    i64le(0n), // valueBalance
    rnd(32, 9), // anchor
    compactSize(2720 + 2272 * nActions),
    rnd(2720 + 2272 * nActions, 3), // proofs
    rnd(64 * nActions, 4), // spend auth sigs
    rnd(64, 5) // binding sig
  );
}
/** v6 tx: transparent outputs + (khaali sapling) + orchard(nOrchard) + ironwood(nIronwood) */
function v6(outs: TxOut[], nOrchard = 0, nIronwood = 0, seed = "v6") {
  return concat(
    u32le(TX_HEADER_V6), u32le(VERSION_GROUP_ID_V6), u32le(0x37a5165b), u32le(0), u32le(4_371_100),
    compactSize(1), prev(seed), u32le(0), compactSize(0), u32le(0xffffffff), // ek transparent input
    compactSize(outs.length), ...outs.map((o) => concat(i64le(o.valueZats), compactSize(o.scriptPubKey.length), o.scriptPubKey)),
    compactSize(0), compactSize(0), // sapling: koi spend/output nahi
    orchardLike(nOrchard),
    orchardLike(nIronwood)
  );
}

test("v6 decode: outputs sahi; orchard khaali => 1 alternate; Ironwood bundle ke saath alag txid; galat vgid reject", () => {
  const bytes = v6([out(A, "0.001"), out(OTHER, "0.002")]);
  const d = decodeRawTx(bytes);
  assert.equal(d.version, 6);
  assert.equal(d.outputs.length, 2);
  assert.equal(d.outputs[0].valueZats, parseZec("0.001"));
  assert.equal(d.txid.length, 64);
  assert.equal(d.txidAlternatives.length, 1); // orchard khaali
  assert.notEqual(d.txidAlternatives[0], d.txid);

  // Ironwood action wali tx (Noir jaisi): parse ho, aur txid ironwood-khaali wale se alag
  const withIron = decodeRawTx(v6([out(A, "0.001")], 0, 1));
  const noIron = decodeRawTx(v6([out(A, "0.001")], 0, 0));
  assert.equal(withIron.outputs[0].valueZats, parseZec("0.001"));
  assert.notEqual(withIron.txid, noIron.txid);
  // Orchard non-empty => koi alternate nahi (spec mein ambiguity sirf khaali component par)
  assert.equal(decodeRawTx(v6([out(A, "0.001")], 1, 0)).txidAlternatives.length, 0);
  // dono pools ek saath
  assert.equal(decodeRawTx(v6([out(A, "0.001")], 2, 2)).version, 6);

  const bad = Uint8Array.from(v6([out(A, "0.001")]));
  bad[4] ^= 0x01; // version group id kharab
  assert.throws(() => decodeRawTx(bad), /version group/);
  assert.throws(() => decodeRawTx(v6([out(A, "0.001")]).subarray(0, 60)), /khatam/); // adhoori tx
});

test("v6 getReceived: server jo txid maane wahi milta hai (primary / alternate); bina server-match => THROW", async () => {
  reset();
  const bytes = v6([out(A, "0.001")]);
  const d = decodeRawTx(bytes);
  mock.txs.set(A, [{ data: bytes, height: 990 }]);

  // 1) server primary jaanta hai
  mock.truth.set(d.txid, bytes);
  let c = client();
  let r = await c.getReceived(A);
  assert.equal(r[0].txid, d.txid);
  assert.equal(r[0].amountZats, parseZec("0.001"));
  assert.equal(r[0].confirmations, 11);
  const calls = mock.txCalls;
  await c.getReceived(A); // cache: dobara server se nahi poochta
  assert.equal(mock.txCalls, calls);
  c.close();

  // 2) server alternate jaanta hai (spec ambiguity wala case)
  mock.truth = new Map([[d.txidAlternatives[0], bytes]]);
  c = client();
  r = await c.getReceived(A);
  assert.equal(r[0].txid, d.txidAlternatives[0]);
  c.close();

  // 3) server ke paas ye tx hi nahi => throw, galat txid nahi
  mock.truth = new Map();
  c = client();
  await assert.rejects(c.getReceived(A), /txid verify FAIL/);
  c.close();

  // 4) server ke paas wahi txid par ALAG bytes => match nahi
  mock.truth = new Map([[d.txid, rnd(200)]]);
  c = client();
  await assert.rejects(c.getReceived(A), /txid verify FAIL/);
  c.close();
});

test("v6 verify: display-order wale server par bhi chalta hai; server down => asli error (mismatch nahi)", async () => {
  reset();
  const bytes = v6([out(A, "0.001")]);
  const d = decodeRawTx(bytes);
  mock.txs.set(A, [{ data: bytes, height: 990 }]);
  mock.truth.set(d.txid, bytes);
  mock.hashOrder = "display";
  let c = client();
  assert.equal((await c.getReceived(A))[0].txid, d.txid);
  c.close();

  mock.hashOrder = "internal";
  mock.txFailCode = grpc.status.UNAVAILABLE;
  c = client();
  await assert.rejects(c.getReceived(A), (e: Error) => !/txid verify FAIL/.test(e.message) && /UNAVAILABLE/.test(e.message));
  c.close();
});

test("verify modes: off => server se nahi poochta; all => v5 bhi verify; default v5 verify nahi", async () => {
  reset();
  const t = v5([out(A, "0.5")], "vm");
  mock.txs.set(A, [{ data: t.bytes, height: 990 }]);
  let c = client(); // default: v5 verify nahi
  await c.getReceived(A);
  assert.equal(mock.txCalls, 0);
  c.close();

  c = client({ verifyTxids: "all" });
  await assert.rejects(c.getReceived(A), /txid verify FAIL/); // truth mein nahi
  mock.truth.set(t.txid, t.bytes);
  assert.equal((await c.getReceived(A))[0].txid, t.txid);
  c.close();

  reset();
  const b = v6([out(A, "0.001")]);
  mock.txs.set(A, [{ data: b, height: 990 }]);
  c = client({ verifyTxids: "off" });
  assert.equal((await c.getReceived(A))[0].txid, decodeRawTx(b).txid);
  assert.equal(mock.txCalls, 0);
  c.close();
});

test("getReceived: height field bhi milta hai (confirmed => block height, mempool => undefined)", async () => {
  reset();
  const a = v5([out(A, "0.01")], "ha");
  const b = v5([out(A, "0.02")], "hb");
  mock.txs.set(A, [{ data: a.bytes, height: 990 }, { data: b.bytes, height: 0 }]);
  const c = client();
  const r = await c.getReceived(A);
  assert.equal(r.find((o) => o.txid === a.txid)!.height, 990);
  assert.equal(r.find((o) => o.txid === b.txid)!.height, undefined);
  assert.equal(await c.tipHeight(), 1000);
  c.close();
});


test("getTxStatus: mined(height) / mempool / fork / unknown; display-order server; server down => THROW", async () => {
  reset();
  const t = v5([out(A, "0.5")], "gs");
  mock.truth.set(t.txid, t.bytes);
  const c = client();
  mock.truthHeights.set(t.txid, "777");
  assert.deepEqual(await c.getTxStatus(t.txid), { state: "mined", height: 777 });
  mock.truthHeights.set(t.txid, "0");
  assert.deepEqual(await c.getTxStatus(t.txid), { state: "mempool" });
  mock.truthHeights.set(t.txid, "18446744073709551615");
  assert.deepEqual(await c.getTxStatus(t.txid), { state: "fork" });
  assert.deepEqual(await c.getTxStatus("ab".repeat(32)), { state: "unknown" });
  mock.hashOrder = "display";
  mock.truthHeights.set(t.txid, "9");
  assert.deepEqual(await c.getTxStatus(t.txid), { state: "mined", height: 9 });
  await assert.rejects(c.getTxStatus("zz"), /64 hex/);
  mock.hashOrder = "internal";
  mock.txFailCode = grpc.status.UNAVAILABLE;
  await assert.rejects(c.getTxStatus(t.txid), /UNAVAILABLE/); // "unknown" nahi, asli error
  c.close();
});

test("decodeRawTx: expiryHeight v4/v5/v6 sab mein", () => {
  assert.equal(decodeRawTx(v5([out(A, "0.1")]).bytes).expiryHeight, 3_000_000);
  assert.equal(decodeRawTx(v6([out(A, "0.1")])).expiryHeight, 4_371_100);
  assert.equal(decodeRawTx(v4([out(A, "0.1")]).bytes).expiryHeight, 0);
});
