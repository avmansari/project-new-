import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import type { Network } from "../config.js";
import { addressToScriptPubKey } from "../zcash/address.js";
import { bytesToHex } from "../zcash/bytes.js";
import { sha256 } from "@noble/hashes/sha256";
import { decodeRawTx, type DecodedRawTx } from "../zcash/rawtx.js";
import type { ChainClient, ReceivedOutput, TxState } from "./types.js";

/**
 * lightwalletd protocol client (zcash/lightwallet-protocol). Wahi protocol:
 *   - public testnet server (testnet.zec.rocks)   -> TESTING ke liye free
 *   - apna lightwalletd / Zaino (Zebra ke saath)  -> PRODUCTION ke liye
 * Code same rehta hai, sirf LWD_URL badalta hai.
 */

const PROTO_DIR = fileURLToPath(new URL("../../proto/", import.meta.url));
const FORK_HEIGHT = 0xffffffffffffffffn; // "mined on a non-main-chain fork"

let cachedService: any;
export function lightwalletdService(): any {
  if (!cachedService) {
    const def = protoLoader.loadSync("service.proto", {
      includeDirs: [PROTO_DIR],
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    cachedService = (grpc.loadPackageDefinition(def) as any).cash.z.wallet.sdk.rpc.CompactTxStreamer;
  }
  return cachedService;
}

export interface ChainInfo {
  chainName: string;
  blockHeight: number;
  estimatedHeight: number;
  /** Consensus branch id (number). Signer ko chahiye. */
  branchId: number;
  taddrSupport: boolean;
  vendor: string;
  version: string;
}

/**
 * Txid ko server se cross-verify kab kare:
 *  - "unverified" (default): jin formats ke official test vectors nahi hain (v4, v6)
 *  - "all": har tx (v5 bhi)
 *  - "off": kabhi nahi (sirf tests/debug)
 */
export type VerifyMode = "unverified" | "all" | "off";

export interface LightwalletdOptions {
  /** "https://host:443" (TLS) ya "http://host:9067" (apna local server) */
  url: string;
  network: Network;
  /** Address ke kitne pichhle blocks dekhne hain (late payments ki grace ke hisaab se) */
  lookbackBlocks: number;
  timeoutMs?: number;
  verifyTxids?: VerifyMode;
}

export function parseServerUrl(url: string): { target: string; secure: boolean } {
  const m = /^(https?):\/\/([^/:]+)(?::(\d+))?\/?$/.exec(url.trim());
  if (!m) throw new Error(`LWD_URL galat hai: '${url}' (aisa hona chahiye: https://host:443)`);
  const secure = m[1] === "https";
  return { target: `${m[2]}:${m[3] ?? (secure ? "443" : "9067")}`, secure };
}

export function expectedChainName(network: Network): string {
  return network === "mainnet" ? "main" : "test";
}

export class LightwalletdChain implements ChainClient {
  private client: any;
  private readonly timeoutMs: number;
  private readonly verify: VerifyMode;
  /** raw tx ka sha256 -> server se confirm hua txid (baar-baar poochna nahi padta) */
  private readonly confirmed = new Map<string, string>();

  constructor(private readonly opts: LightwalletdOptions) {
    const { target, secure } = parseServerUrl(opts.url);
    const Svc = lightwalletdService();
    this.client = new Svc(target, secure ? grpc.credentials.createSsl() : grpc.credentials.createInsecure());
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.verify = opts.verifyTxids ?? "unverified";
  }

  close(): void {
    this.client.close();
  }

  private deadline(): Date {
    return new Date(Date.now() + this.timeoutMs);
  }

  private unary<T>(method: string, req: object): Promise<T> {
    return new Promise((resolve, reject) => {
      this.client[method](req, { deadline: this.deadline() }, (err: Error | null, res: T) => (err ? reject(err) : resolve(res)));
    });
  }

  async info(): Promise<ChainInfo> {
    const r: any = await this.unary("GetLightdInfo", {});
    return {
      chainName: r.chainName,
      blockHeight: Number(r.blockHeight),
      estimatedHeight: Number(r.estimatedHeight),
      branchId: parseInt(r.consensusBranchId || "0", 16),
      taddrSupport: !!r.taddrSupport,
      vendor: r.vendor,
      version: r.version,
    };
  }

  async tip(): Promise<number> {
    const r: any = await this.unary("GetLatestBlock", {});
    return Number(r.height);
  }

  tipHeight(): Promise<number> {
    return this.tip();
  }

  /**
   * Startup check: server sahi network ka hai, transparent support hai, aur sync mein peeche nahi hai.
   * (Galat network ke server se payment padhna = free NFT ya galat refund ka darwaza.)
   */
  async assertReady(): Promise<ChainInfo> {
    const i = await this.info();
    const want = expectedChainName(this.opts.network);
    if (i.chainName !== want) throw new Error(`server '${i.chainName}' chain ka hai, lekin NETWORK=${this.opts.network} ('${want}' chahiye)`);
    if (!i.taddrSupport) throw new Error("ye server transparent addresses support nahi karta (taddrSupport=false)");
    if (i.estimatedHeight > i.blockHeight + 10) {
      throw new Error(`server abhi sync ho raha hai (height ${i.blockHeight}, chain ${i.estimatedHeight})`);
    }
    return i;
  }

  /**
   * Is address pe aaye SAARE confirmed outputs (kharch ho chuke bhi). Har tx ka txid aur outputs khud
   * decode hote hain (v5 + v4). Error aaye to THROW: kabhi "khaali list" nahi.
   *
   * LIMIT: mempool (0-conf) payments abhi nahi dikhte; payment pehle block mein aane pe dikhti hai.
   */
  async getReceived(address: string): Promise<ReceivedOutput[]> {
    const script = addressToScriptPubKey(address, this.opts.network);
    const tip = await this.tip();
    const start = Math.max(1, tip - this.opts.lookbackBlocks);
    const raws = await this.collect<{ data: Buffer; height: string }>("GetTaddressTxids", {
      address,
      range: { start: { height: start }, end: { height: tip } },
    });

    const wantHex = bytesToHex(script);
    const seen = new Set<string>();
    const out: ReceivedOutput[] = [];
    for (const raw of raws) {
      const height = BigInt(raw.height);
      if (height === FORK_HEIGHT) continue; // side-fork pe hai, main chain mein nahi
      const rawBytes = Uint8Array.from(raw.data);
      const decoded = decodeRawTx(rawBytes);
      const tx = { ...decoded, txid: await this.confirmTxid(decoded, rawBytes) };
      const confirmations = height === 0n ? 0 : Math.max(0, tip - Number(height) + 1);
      for (const o of tx.outputs) {
        if (bytesToHex(o.scriptPubKey) !== wantHex || o.valueZats <= 0n) continue;
        const key = `${tx.txid}:${o.vout}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ txid: tx.txid, vout: o.vout, amountZats: o.valueZats, confirmations, height: height === 0n ? undefined : Number(height) });
      }
    }
    return out;
  }

  /** Signed transaction network pe bhejta hai. Return: txid (hamare hisaab se, aur server ke jawab se milaya hua). */
  async broadcast(hex: string): Promise<string> {
    if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) throw new Error("hex galat hai");
    const bytes = Buffer.from(hex, "hex");
    const expected = decodeRawTx(Uint8Array.from(bytes)).txid;
    const r: any = await this.unary("SendTransaction", { data: bytes });
    if (Number(r.errorCode) !== 0) throw new Error(`broadcast fail (code ${r.errorCode}): ${r.errorMessage}`);
    const echoed = String(r.errorMessage ?? "").replace(/["'\s]/g, "").toLowerCase();
    if (/^[0-9a-f]{64}$/.test(echoed) && echoed !== expected) {
      throw new Error(`server ne alag txid bataya (${echoed}), hamara ${expected}`);
    }
    return expected;
  }

  /**
   * Hamare nikale txid ko server se milata hai: server se GetTransaction(txid) maango aur bytes barabar hone chahiye.
   * Decoder galat hua to yahan pakda jaata hai (throw), chupchaap galat txid nahi jaata.
   * Network error (server down) alag hai: wo seedha throw hota hai, "mismatch" nahi maana jaata.
   */
  private async confirmTxid(tx: DecodedRawTx, raw: Uint8Array): Promise<string> {
    const needs = this.verify === "all" || (this.verify === "unverified" && tx.version !== 5);
    if (!needs) return tx.txid;
    const key = bytesToHex(sha256(raw));
    const hit = this.confirmed.get(key);
    if (hit) return hit;
    for (const cand of [tx.txid, ...tx.txidAlternatives]) {
      if (await this.serverHasTx(cand, raw)) {
        if (cand !== tx.txid) {
          console.warn(`[lwd] v${tx.version} txid ka ALTERNATE variant server se match hua (${cand}). Ye developer ko batao, decoder theek karna hai.`);
        }
        this.confirmed.set(key, cand);
        return cand;
      }
    }
    throw new Error(
      `txid verify FAIL: v${tx.version} tx ka hamara txid (${tx.txid}) server ko nahi mila. ` +
        `Decoder is tx-format ko galat padh raha ho sakta hai; payment ko galat txid se nahi jodunga.`
    );
  }

  /** GetTransaction(txid). Dono byte orders try. Nahi mili => null. Network error => THROW. */
  private async lookupTx(txid: string): Promise<{ data: Buffer; height: bigint } | null> {
    const display = Buffer.from(txid, "hex");
    const internal = Buffer.from(display).reverse();
    // servers alag byte order maan sakte hain, dono try
    for (const hash of [internal, display]) {
      try {
        const r: any = await this.unary("GetTransaction", { hash });
        if (r?.data && r.data.length > 0) return { data: Buffer.from(r.data), height: BigInt(r.height ?? "0") };
      } catch (e) {
        const code = (e as { code?: number }).code;
        const notFoundLike = [grpc.status.NOT_FOUND, grpc.status.UNKNOWN, grpc.status.INVALID_ARGUMENT, grpc.status.INTERNAL];
        if (code === undefined || !notFoundLike.includes(code)) throw e; // UNAVAILABLE, DEADLINE... => asli error
      }
    }
    return null;
  }

  private async serverHasTx(txid: string, raw: Uint8Array): Promise<boolean> {
    const r = await this.lookupTx(txid);
    return !!r && Buffer.compare(r.data, Buffer.from(raw)) === 0;
  }

  /** Broadcast ki hui tx ka haal: mempool / mined(height) / fork / unknown. */
  async getTxStatus(txid: string): Promise<TxState> {
    if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error("txid 64 hex hona chahiye");
    const r = await this.lookupTx(txid.toLowerCase());
    if (!r) return { state: "unknown" };
    if (r.height === FORK_HEIGHT) return { state: "fork" };
    if (r.height === 0n) return { state: "mempool" };
    return { state: "mined", height: Number(r.height) };
  }

  private collect<T>(method: string, req: object): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const items: T[] = [];
      const call = this.client[method](req, { deadline: this.deadline() });
      call.on("data", (d: T) => items.push(d));
      call.on("end", () => resolve(items));
      call.on("error", (e: Error) => reject(e));
    });
  }
}
