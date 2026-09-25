import { mkdirSync, writeFileSync } from "node:fs";
import * as grpc from "@grpc/grpc-js";
import { resolveLwdUrl } from "../src/chain/index.js";
import { lightwalletdService, parseServerUrl } from "../src/chain/lightwalletd.js";
import { loadConfig } from "../src/config.js";
import { addressToScriptPubKey } from "../src/zcash/address.js";
import { bytesToHex } from "../src/zcash/bytes.js";
import { decodeRawTx } from "../src/zcash/rawtx.js";

/**
 * DEBUG: kisi address ki raw transactions file mein likh deta hai (chain ka PUBLIC data hai, koi secret nahi).
 * Agar txid verify fail ho, to ye files developer ko bhejo.
 * usage: npm run chain:dump -- <address>
 */
const address = process.argv[2];
if (!address) {
  console.error("Usage: npm run chain:dump -- <address>");
  process.exit(1);
}
const cfg = loadConfig();
addressToScriptPubKey(address, cfg.network); // validate
const { target, secure } = parseServerUrl(resolveLwdUrl(cfg.network, cfg.lwdUrl));
const client = new (lightwalletdService())(target, secure ? grpc.credentials.createSsl() : grpc.credentials.createInsecure());
const call = (m: string, req: object) =>
  new Promise<any>((res, rej) => client[m](req, { deadline: new Date(Date.now() + cfg.lwdTimeoutMs) }, (e: Error | null, r: any) => (e ? rej(e) : res(r))));

const tip = Number((await call("GetLatestBlock", {})).height);
const raws: { data: Buffer; height: string }[] = await new Promise((res, rej) => {
  const items: any[] = [];
  const s = client.GetTaddressTxids(
    { address, range: { start: { height: Math.max(1, tip - cfg.lwdLookbackBlocks) }, end: { height: tip } } },
    { deadline: new Date(Date.now() + cfg.lwdTimeoutMs) }
  );
  s.on("data", (d: any) => items.push(d));
  s.on("end", () => res(items));
  s.on("error", rej);
});
mkdirSync("./data", { recursive: true });
console.log(`tip=${tip}  transactions mile: ${raws.length}`);
raws.forEach((r, i) => {
  const file = `./data/tx-dump-${i + 1}.hex`;
  writeFileSync(file, bytesToHex(Uint8Array.from(r.data)));
  const hdr = Buffer.from(r.data).readUInt32LE(0).toString(16);
  try {
    const d = decodeRawTx(Uint8Array.from(r.data));
    console.log(`#${i + 1} height=${r.height} header=0x${hdr} v${d.version} bytes=${r.data.length}`);
    console.log(`     hamara txid : ${d.txid}`);
    for (const a of d.txidAlternatives) console.log(`     alternate   : ${a}`);
  } catch (e) {
    console.log(`#${i + 1} height=${r.height} header=0x${hdr} bytes=${r.data.length}  DECODE FAIL: ${(e as Error).message}`);
  }
  console.log(`     file        : ${file}`);
});
client.close();
