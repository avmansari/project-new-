import type { Network } from "../config.js";
import { FileChain } from "./file.js";
import { LightwalletdChain } from "./lightwalletd.js";
import type { ChainClient } from "./types.js";

export const PUBLIC_TESTNET_LWD = "https://testnet.zec.rocks:443";

export interface ChainCfg {
  network: Network;
  chainBackend: "file" | "lightwalletd";
  fakeChainFile: string;
  lwdUrl?: string;
  lwdLookbackBlocks?: number;
  lwdTimeoutMs?: number;
  lwdVerifyTxids?: "unverified" | "all" | "off";
}

/** LWD_URL: mainnet ke liye ZAROORI (apna server). Testnet mein default public server. */
export function resolveLwdUrl(network: Network, url?: string): string {
  if (url) return url;
  if (network === "testnet") return PUBLIC_TESTNET_LWD;
  throw new Error("Mainnet ke liye LWD_URL zaroori hai (apna Zebra + Zaino/lightwalletd server). Public server pe real paise ka bharosa mat karo.");
}

export function createLightwalletd(cfg: Omit<ChainCfg, "chainBackend" | "fakeChainFile">): LightwalletdChain {
  return new LightwalletdChain({
    url: resolveLwdUrl(cfg.network, cfg.lwdUrl),
    network: cfg.network,
    lookbackBlocks: cfg.lwdLookbackBlocks ?? 30_000,
    timeoutMs: cfg.lwdTimeoutMs,
    verifyTxids: cfg.lwdVerifyTxids,
  });
}

export function createChain(cfg: ChainCfg): ChainClient {
  if (cfg.chainBackend === "file") {
    // Nakli chain pe mainnet chalana = free NFTs ka darwaza. Isliye hard block.
    if (cfg.network === "mainnet") {
      throw new Error("CHAIN_BACKEND=file (nakli blockchain) mainnet pe allowed nahi hai.");
    }
    return new FileChain(cfg.fakeChainFile);
  }
  if (cfg.chainBackend === "lightwalletd") return createLightwalletd(cfg);
  throw new Error(`Unknown CHAIN_BACKEND: ${cfg.chainBackend}`);
}
