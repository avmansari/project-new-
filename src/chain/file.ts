import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChainClient, ReceivedOutput } from "./types.js";

interface State {
  tip: number;
  outputs: { address: string; txid: string; vout: number; amountZats: string; height: number }[];
}

/**
 * LOCAL DEMO ke liye nakli blockchain (ek JSON file). Asli paise se iska koi lena-dena nahi.
 * pay()  -> mempool mein payment (0 confirmations)
 * mine() -> blocks aage badhata hai (confirmations badhte hain)
 */
export class FileChain implements ChainClient {
  constructor(private path: string) {}

  private read(): State {
    if (!existsSync(this.path)) return { tip: 0, outputs: [] };
    return JSON.parse(readFileSync(this.path, "utf8")) as State;
  }
  private write(s: State) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(s, null, 2));
  }

  async getReceived(address: string): Promise<ReceivedOutput[]> {
    const s = this.read();
    return s.outputs
      .filter((o) => o.address === address)
      .map((o) => ({
        txid: o.txid,
        vout: o.vout,
        amountZats: BigInt(o.amountZats),
        confirmations: o.height <= s.tip ? s.tip - o.height + 1 : 0,
        height: o.height <= s.tip ? o.height : undefined,
      }));
  }

  async tipHeight(): Promise<number> {
    return this.read().tip;
  }

  pay(address: string, amountZats: bigint, txid: string = randomBytes(32).toString("hex")): string {
    const s = this.read();
    s.outputs.push({ address, txid, vout: 0, amountZats: amountZats.toString(), height: s.tip + 1 });
    this.write(s);
    return txid;
  }

  mine(blocks: number): number {
    const s = this.read();
    s.tip += blocks;
    this.write(s);
    return s.tip;
  }

  /** Mempool se tx gayab (replace/drop) simulate karta hai */
  drop(txid: string): void {
    const s = this.read();
    s.outputs = s.outputs.filter((o) => o.txid !== txid);
    this.write(s);
  }
}
