/**
 * Blockchain se data padhne ka interface. Koi bhi backend (file demo, hosted API, Zebra node)
 * bas ye ek function dega. Watcher ko is se matlab nahi ki data kahan se aaya.
 */
export interface ReceivedOutput {
  txid: string;
  vout: number;
  amountZats: bigint;
  /** 0 = mempool (abhi block mein nahi). */
  confirmations: number;
  /** Jis block mein mined hua. Unconfirmed (mempool) ke liye undefined. */
  height?: number;
}

/** Kisi transaction ka chain pe haal */
export type TxState =
  | { state: "unknown" } // server ko nahi mili
  | { state: "mempool" } // mempool mein, abhi block mein nahi
  | { state: "mined"; height: number } // main chain ke block mein
  | { state: "fork" }; // kisi side-fork pe mined, main chain mein nahi

export interface ChainClient {
  /**
   * Is address pe ab tak aaye SAARE outputs (mempool + confirmed).
   * Error aaye to THROW karo. Kabhi bhi error ko "khaali list" mat banao,
   * warna watcher samjhega ki payment gayab ho gayi.
   */
  getReceived(address: string): Promise<ReceivedOutput[]>;
  /**
   * Chain ka current tip height. Order banate waqt store hota hai: us se PEHLE mined payments
   * (address ka purana istemal, ya database restore) us order ke nahi ginte.
   */
  tipHeight?(): Promise<number>;
  /** Broadcast ki hui tx ka haal (refund tracker ke liye). Network error pe THROW (kabhi "unknown" nahi). */
  getTxStatus?(txid: string): Promise<TxState>;
}
