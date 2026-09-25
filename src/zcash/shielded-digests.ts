import { concat, Reader } from "./bytes.js";
import { EMPTY_ORCHARD_DIGEST, EMPTY_SAPLING_DIGEST, H, type ShieldedDigests, type ShieldedDigestsV6 } from "./tx.js";

/**
 * Transparent bundle ke baad ke bytes (sapling + orchard) se ZIP 244 digests nikalta hai.
 * Isse HAR v5 transaction (shielded hisse ke saath bhi, jaise Noir ka "shielded -> transparent" payment)
 * ka txid nikala ja sakta hai. Official ZIP 244 test vectors se verified (test/zip244.test.ts).
 */
export function shieldedDigestsFromRest(rest: Uint8Array): ShieldedDigests {
  const r = new Reader(rest);

  // ---- Sapling (ZIP 225) ----
  const nSpends = r.compact();
  const spends: { cv: Uint8Array; nf: Uint8Array; rk: Uint8Array }[] = [];
  for (let i = 0; i < nSpends; i++) spends.push({ cv: r.take(32), nf: r.take(32), rk: r.take(32) });
  const nOutputs = r.compact();
  const outputs: { cv: Uint8Array; cmu: Uint8Array; epk: Uint8Array; enc: Uint8Array; out: Uint8Array }[] = [];
  for (let i = 0; i < nOutputs; i++) {
    outputs.push({ cv: r.take(32), cmu: r.take(32), epk: r.take(32), enc: r.take(580), out: r.take(80) });
  }
  let saplingValueBalance = new Uint8Array(8);
  let saplingAnchor = new Uint8Array(32);
  if (nSpends + nOutputs > 0) saplingValueBalance = Uint8Array.from(r.take(8));
  if (nSpends > 0) saplingAnchor = Uint8Array.from(r.take(32));
  r.take(192 * nSpends); // spend proofs
  r.take(64 * nSpends); // spend auth sigs
  r.take(192 * nOutputs); // output proofs
  if (nSpends + nOutputs > 0) r.take(64); // binding sig

  let sapling = EMPTY_SAPLING_DIGEST;
  if (nSpends + nOutputs > 0) {
    const spendsDigest =
      nSpends === 0
        ? H("ZTxIdSSpendsHash", new Uint8Array(0))
        : H(
            "ZTxIdSSpendsHash",
            concat(
              H("ZTxIdSSpendCHash", concat(...spends.map((s) => s.nf))),
              H("ZTxIdSSpendNHash", concat(...spends.map((s) => concat(s.cv, saplingAnchor, s.rk))))
            )
          );
    const outputsDigest =
      nOutputs === 0
        ? H("ZTxIdSOutputHash", new Uint8Array(0))
        : H(
            "ZTxIdSOutputHash",
            concat(
              H("ZTxIdSOutC__Hash", concat(...outputs.map((o) => concat(o.cmu, o.epk, o.enc.subarray(0, 52))))),
              H("ZTxIdSOutM__Hash", concat(...outputs.map((o) => o.enc.subarray(52, 564)))),
              H("ZTxIdSOutN__Hash", concat(...outputs.map((o) => concat(o.cv, o.enc.subarray(564, 580), o.out))))
            )
          );
    sapling = H("ZTxIdSaplingHash", concat(spendsDigest, outputsDigest, saplingValueBalance));
  }

  // ---- Orchard (ZIP 225) ----
  const nActions = r.compact();
  const actions: { cv: Uint8Array; nf: Uint8Array; rk: Uint8Array; cmx: Uint8Array; epk: Uint8Array; enc: Uint8Array; out: Uint8Array }[] = [];
  for (let i = 0; i < nActions; i++) {
    actions.push({ cv: r.take(32), nf: r.take(32), rk: r.take(32), cmx: r.take(32), epk: r.take(32), enc: r.take(580), out: r.take(80) });
  }
  let orchard = EMPTY_ORCHARD_DIGEST;
  if (nActions > 0) {
    const flags = Uint8Array.from(r.take(1));
    const valueBalance = Uint8Array.from(r.take(8));
    const anchor = Uint8Array.from(r.take(32));
    r.take(r.compact()); // proofs
    r.take(64 * nActions); // spend auth sigs
    r.take(64); // binding sig
    orchard = H(
      "ZTxIdOrchardHash",
      concat(
        H("ZTxIdOrcActCHash", concat(...actions.map((a) => concat(a.nf, a.cmx, a.epk, a.enc.subarray(0, 52))))),
        H("ZTxIdOrcActMHash", concat(...actions.map((a) => a.enc.subarray(52, 564)))),
        H("ZTxIdOrcActNHash", concat(...actions.map((a) => concat(a.cv, a.rk, a.enc.subarray(564, 580), a.out)))),
        flags,
        valueBalance,
        anchor
      )
    );
  }
  if (r.rest().length !== 0) throw new Error(`vector parse: ${r.rest().length} extra bytes bache`);
  return { sapling, orchard };
}


// =====================================================================================
// v6 (ZIP 229, NU6.3): sapling + orchard (v5 jaisa encoding) + naya Ironwood component.
// Digest badlav: anchors effecting data se hataye gaye (naye personalizations), Ironwood digest add hua.
// ZIP 229 Draft hai, official vectors nahi => runtime pe server se verify hota hai.
// =====================================================================================

interface Action {
  cv: Uint8Array; nf: Uint8Array; rk: Uint8Array; cmx: Uint8Array; epk: Uint8Array; enc: Uint8Array; out: Uint8Array;
}

function readOrchardLike(r: Reader) {
  const n = r.compact();
  const actions: Action[] = [];
  for (let i = 0; i < n; i++) {
    actions.push({ cv: r.take(32), nf: r.take(32), rk: r.take(32), cmx: r.take(32), epk: r.take(32), enc: r.take(580), out: r.take(80) });
  }
  let flags = new Uint8Array(0);
  let valueBalance = new Uint8Array(0);
  if (n > 0) {
    flags = Uint8Array.from(r.take(1));
    valueBalance = Uint8Array.from(r.take(8));
    r.take(32); // anchor: v6 mein auth data, txid mein nahi
    r.take(r.compact()); // proofs
    r.take(64 * n); // spend auth sigs
    r.take(64); // binding sig
  }
  return { n, actions, flags, valueBalance };
}

function actionsDigest(
  pers: { root: string; compact: string; memos: string; noncompact: string },
  b: { n: number; actions: Action[]; flags: Uint8Array; valueBalance: Uint8Array }
): Uint8Array {
  if (b.n === 0) return H(pers.root, new Uint8Array(0));
  return H(
    pers.root,
    concat(
      H(pers.compact, concat(...b.actions.map((a) => concat(a.nf, a.cmx, a.epk, a.enc.subarray(0, 52))))),
      H(pers.memos, concat(...b.actions.map((a) => a.enc.subarray(52, 564)))),
      H(pers.noncompact, concat(...b.actions.map((a) => concat(a.cv, a.rk, a.enc.subarray(564, 580), a.out)))),
      b.flags,
      b.valueBalance
    )
  );
}

export interface ShieldedDigestsV6Result extends ShieldedDigestsV6 {
  /** Orchard component khaali hai? (tab empty-digest ki personalization par spec mein thoda ambiguity hai) */
  orchardEmpty: boolean;
  /** Orchard khaali hone par ALTERNATE digest (v5 wali personalization). Sirf tab jab orchardEmpty. */
  orchardAlt: Uint8Array;
}

export function shieldedDigestsV6FromRest(rest: Uint8Array): ShieldedDigestsV6Result {
  const r = new Reader(rest);

  // ---- Sapling (encoding v5 wali) ----
  const nSpends = r.compact();
  const spends: { cv: Uint8Array; nf: Uint8Array; rk: Uint8Array }[] = [];
  for (let i = 0; i < nSpends; i++) spends.push({ cv: r.take(32), nf: r.take(32), rk: r.take(32) });
  const nOutputs = r.compact();
  const outputs: { cv: Uint8Array; cmu: Uint8Array; epk: Uint8Array; enc: Uint8Array; out: Uint8Array }[] = [];
  for (let i = 0; i < nOutputs; i++) {
    outputs.push({ cv: r.take(32), cmu: r.take(32), epk: r.take(32), enc: r.take(580), out: r.take(80) });
  }
  let saplingValueBalance = new Uint8Array(8);
  if (nSpends + nOutputs > 0) saplingValueBalance = Uint8Array.from(r.take(8));
  if (nSpends > 0) r.take(32); // anchorSapling (auth data)
  r.take(192 * nSpends);
  r.take(64 * nSpends);
  r.take(192 * nOutputs);
  if (nSpends + nOutputs > 0) r.take(64);

  let sapling = EMPTY_SAPLING_DIGEST; // "ZTxIdSaplingHash" v6 mein bhi wahi
  if (nSpends + nOutputs > 0) {
    const spendsDigest =
      nSpends === 0
        ? H("ZTxIdSSpendsHash", new Uint8Array(0))
        : H(
            "ZTxIdSSpendsHash",
            concat(
              H("ZTxIdSSpendCHash", concat(...spends.map((s) => s.nf))),
              H("ZTxIdSSpendNH_v6", concat(...spends.map((s) => concat(s.cv, s.rk)))) // anchor nahi
            )
          );
    const outputsDigest =
      nOutputs === 0
        ? H("ZTxIdSOutputHash", new Uint8Array(0))
        : H(
            "ZTxIdSOutputHash",
            concat(
              H("ZTxIdSOutC__Hash", concat(...outputs.map((o) => concat(o.cmu, o.epk, o.enc.subarray(0, 52))))),
              H("ZTxIdSOutM__Hash", concat(...outputs.map((o) => o.enc.subarray(52, 564)))),
              H("ZTxIdSOutN__Hash", concat(...outputs.map((o) => concat(o.cv, o.enc.subarray(564, 580), o.out))))
            )
          );
    sapling = H("ZTxIdSaplingHash", concat(spendsDigest, outputsDigest, saplingValueBalance));
  }

  // ---- Orchard + Ironwood ----
  const orchardB = readOrchardLike(r);
  const ironwoodB = readOrchardLike(r);
  if (r.rest().length !== 0) throw new Error(`v6 tx: ${r.rest().length} extra bytes bache`);

  const orchard = actionsDigest(
    { root: "ZTxIdOrchardH_v6", compact: "ZTxIdOrcActCHash", memos: "ZTxIdOrcActMHash", noncompact: "ZTxIdOrcActNHash" },
    orchardB
  );
  const ironwood = actionsDigest(
    { root: "ZTxIdIronwd_H_v6", compact: "ZTxIdIrnActCH_v6", memos: "ZTxIdIrnActMH_v6", noncompact: "ZTxIdIrnActNH_v6" },
    ironwoodB
  );
  return { sapling, orchard, ironwood, orchardEmpty: orchardB.n === 0, orchardAlt: orchardB.n === 0 ? EMPTY_ORCHARD_DIGEST : orchard };
}
